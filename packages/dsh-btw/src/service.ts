import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LiveContextMirror } from './live.ts'
import type { MainRequestFacts } from './live.ts'
import { normalizeSideContext } from './normalize.ts'
import { BtwTopicRepository, btwDomainSpec } from './repository.ts'
import { runSideCall } from './runner.ts'
import { BtwHub } from './hub.ts'
import type {
  BtwAskReceipt,
  BtwAskRequest,
  BtwCancelRequest,
  BtwCancelValue,
  BtwContextCut,
  BtwFrame,
  BtwGetRequest,
  BtwGetValue,
  BtwListRequest,
  BtwListValue,
  BtwTopic,
  BtwTurn,
  BtwTurnStatus,
  BtwWatchRequest,
} from './types.ts'

interface ActiveTurn {
  readonly sessionId: string
  readonly topicId: string
  readonly turnId: string
  readonly requestId: string
  readonly controller: AbortController
  phase: 'admitting' | 'running' | 'finalizing'
}

const MAX_QUESTION_CHARS = 8_000

function now(): string {
  return new Date().toISOString()
}

function fail(code: ConstructorParameters<typeof RemoteError>[0], message: string, details = {}): never {
  throw new RemoteError(code, message, details as never)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side BTW Remote service. */
    btw: BtwService
  }
}

/** Host-side BTW service: admission, durable Topic history, and detached side calls. */
export class BtwService extends TypertRemoteService {
  static inject = ['llm', 'sessions', 'agents', 'storageDomain', 'typert']

  private readonly mirror: LiveContextMirror
  private readonly hubs = new Map<string, BtwHub>()
  private readonly active = new Map<string, ActiveTurn>()
  private readonly requestIndex = new Map<string, { readonly topicId: string; readonly turnId: string }>()
  private readonly ready: Promise<void>
  private repo: BtwTopicRepository | undefined
  private initError: unknown

  constructor(ctx: Context) {
    super(ctx, 'btw', { namespace: 'btw' })
    this.mirror = new LiveContextMirror(ctx)
    this.ready = this.initialize().catch((error: unknown) => {
      this.initError = error
    })
    ctx.effect(() => () => {
      for (const turn of this.active.values()) turn.controller.abort()
      this.active.clear()
      for (const hub of this.hubs.values()) hub.clear()
      void this.repo?.close()
    })
  }

  private async initialize(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(btwDomainSpec)
    this.repo = new BtwTopicRepository(domain)
    for (const topic of this.repo.all()) {
      this.indexTopic(topic)
      if (!topic.turns.some((turn) => turn.status === 'running')) continue
      await this.repo.update(topic.sessionId, topic.topicId, (current) => {
        const at = now()
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: at,
          turns: current.turns.map((turn) =>
            turn.status === 'running'
              ? { ...turn, status: 'interrupted', error: 'host-crash', updatedAt: at }
              : turn,
          ),
        }
      })
    }
  }

  private indexTopic(topic: BtwTopic): void {
    for (const turn of topic.turns) {
      this.requestIndex.set(this.requestKey(topic.sessionId, turn.requestId), {
        topicId: topic.topicId,
        turnId: turn.turnId,
      })
    }
  }

  private requestKey(sessionId: string, requestId: string): string {
    return `${sessionId}\u0000${requestId}`
  }

  private async repository(): Promise<BtwTopicRepository> {
    await this.ready
    if (this.initError !== undefined || !this.repo) {
      throw new RemoteError('btw/internal', 'BTW storage is unavailable', {})
    }
    return this.repo
  }

  private hub(sessionId: string): BtwHub {
    let hub = this.hubs.get(sessionId)
    if (!hub) {
      hub = new BtwHub()
      this.hubs.set(sessionId, hub)
    }
    return hub
  }

  private validateSession(sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionId) fail('btw/invalid-input', 'sessionId is required', { field: 'sessionId' })
  }

  private ensureAgent(sessionId: string): { session: Session; facts: MainRequestFacts; degraded: readonly string[]; inFlightText?: string; attemptId?: string; attemptRevision?: number; chunkIndex?: number } {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (!agent) fail('btw/context-unavailable', 'The main Agent is not live in this Host process', {})
    const session = agent.session
    const live = this.mirror.capture(session)
    let facts = live.facts
    const degraded = [...live.degraded]
    if (!facts) {
      const { provider, model } = agent.options
      if (provider && model) {
        facts = {
          provider,
          model,
          ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort }),
          ...(agent.options.maxTokens === undefined ? {} : { maxTokens: agent.options.maxTokens }),
        }
        degraded.push('late-mount')
      }
    }
    if (!facts) fail('btw/no-model', 'No main model route is observable yet', {})
    return { session, facts, degraded, ...(live.inFlightText === undefined ? {} : { inFlightText: live.inFlightText }), ...(live.attemptId === undefined ? {} : { attemptId: live.attemptId }), ...(live.attemptRevision === undefined ? {} : { attemptRevision: live.attemptRevision }), ...(live.chunkIndex === undefined ? {} : { chunkIndex: live.chunkIndex }) }
  }

  @Remote({ resources: { session: (request: BtwAskRequest) => request.sessionId as SessionId } })
  async ask(request: BtwAskRequest, signal?: AbortSignal): Promise<BtwAskReceipt> {
    this.validateSession(request.sessionId)
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (!question) fail('btw/invalid-input', 'question is required', { field: 'question' })
    if (question.length > MAX_QUESTION_CHARS) fail('btw/invalid-input', 'question is too long', { field: 'question' })
    if (typeof request.requestId !== 'string' || !request.requestId) {
      fail('btw/invalid-input', 'requestId is required', { field: 'requestId' })
    }
    signal?.throwIfAborted()

    const duplicate = this.requestIndex.get(this.requestKey(request.sessionId, request.requestId))
    if (duplicate) {
      const repo = await this.repository()
      const topic = repo.get(request.sessionId, duplicate.topicId)
      const turn = topic?.turns.find((candidate) => candidate.turnId === duplicate.turnId)
      return {
        topicId: duplicate.topicId,
        turnId: duplicate.turnId,
        status: turn?.status ?? 'running',
        revision: topic?.revision ?? 0,
      }
    }
    if (this.active.has(request.sessionId)) fail('btw/busy', 'Another BTW turn is active in this Session', {})

    const repoBeforeCapture = this.repo
    if (!repoBeforeCapture) fail('btw/internal', 'BTW storage is not ready', {})
    const existing = request.topicId ? repoBeforeCapture.get(request.sessionId, request.topicId) : undefined
    if (request.topicId && !existing) fail('btw/invalid-input', 'Unknown BTW topic for this Session', { field: 'topicId' })
    if (
      request.expectedRevision !== undefined &&
      existing &&
      request.expectedRevision !== existing.revision
    ) {
      fail('btw/revision-conflict', 'BTW topic revision changed', {
        expected: request.expectedRevision,
        actual: existing.revision,
      })
    }
    if (existing?.turns.some((turn) => turn.status === 'running')) {
      fail('btw/busy', 'This BTW topic already has a running turn', { topicId: existing.topicId })
    }

    const topicId = existing?.topicId ?? randomUUID()
    const turnId = randomUUID()
    const controller = new AbortController()
    const active: ActiveTurn = {
      sessionId: request.sessionId,
      topicId,
      turnId,
      requestId: request.requestId,
      controller,
      phase: 'admitting',
    }
    this.active.set(request.sessionId, active)
    this.requestIndex.set(this.requestKey(request.sessionId, request.requestId), { topicId, turnId })

    let cut: BtwContextCut
    let messages
    let facts: MainRequestFacts
    try {
      const captured = this.ensureAgent(request.sessionId)
      const session = captured.session
      messages = session.deriveMessages()
      facts = captured.facts
      cut = {
        sessionId: request.sessionId,
        eventSeq: session.seq - 1,
        cutOffset: session.seq,
        capturedAt: now(),
        ...(captured.attemptId === undefined ? {} : { attemptId: captured.attemptId }),
        ...(captured.attemptRevision === undefined ? {} : { attemptRevision: captured.attemptRevision }),
        ...(captured.chunkIndex === undefined ? {} : { chunkIndex: captured.chunkIndex }),
        degraded: captured.degraded,
      }
      const at = now()
      const turn: BtwTurn = {
        turnId,
        requestId: request.requestId,
        question,
        answer: '',
        status: 'running',
        createdAt: at,
        updatedAt: at,
        contextCut: cut,
      }
      const topic: BtwTopic = existing
        ? {
            ...existing,
            revision: existing.revision + 1,
            updatedAt: at,
            turns: [...existing.turns, turn],
          }
        : {
            sessionId: request.sessionId,
            topicId,
            title: question.length > 60 ? `${question.slice(0, 57)}...` : question,
            revision: 1,
            createdAt: at,
            updatedAt: at,
            turns: [turn],
          }
      const repo = await this.repository()
      if (controller.signal.aborted) {
        this.release(active)
        this.requestIndex.delete(this.requestKey(request.sessionId, request.requestId))
        fail('btw/invalid-input', 'BTW request was cancelled before admission', {})
      }
      await repo.put(topic)
      if (controller.signal.aborted) {
        await this.finalize(active, 'cancelled', '', 'cancelled before dispatch')
        return { topicId, turnId, status: 'cancelled', revision: topic.revision + 1 }
      }
      this.hub(request.sessionId).publish({ type: 'topic', topic })
      void this.run(active, topic, messages, facts, captured.inFlightText)
      return { topicId, turnId, status: 'running', revision: topic.revision }
    } catch (error) {
      this.active.delete(request.sessionId)
      this.requestIndex.delete(this.requestKey(request.sessionId, request.requestId))
      if (error instanceof RemoteError) throw error
      throw new RemoteError('btw/storage-admission-failed', 'BTW turn could not be admitted durably', {
        cause: error,
      } as never)
    }
  }

  private async run(
    active: ActiveTurn,
    topic: BtwTopic,
    messages: readonly Message[],
    facts: MainRequestFacts,
    inFlightText?: string,
  ): Promise<void> {
    const signal = active.controller.signal
    try {
      active.phase = 'running'
      const current = topic.turns.find((turn) => turn.turnId === active.turnId)
      if (!current) return
      const history = topic.turns.filter((turn) => turn.turnId !== active.turnId)
      const normalized = normalizeSideContext({ messages, cut: current.contextCut, history, question: current.question, facts, ...(inFlightText === undefined ? {} : { inFlightText }) })
      if (signal.aborted) {
        await this.finalize(active, 'cancelled', '', 'cancelled before dispatch')
        return
      }
      const result = await runSideCall({
        ctx: this.ctx,
        facts,
        normalized,
        identity: `btw-${active.turnId}`,
        signal,
        onDelta: (text) => this.hub(active.sessionId).publish({ type: 'delta', topicId: active.topicId, turnId: active.turnId, text }),
      })
      await this.finalize(active, result.status, result.text, result.error)
    } catch (error) {
      await this.finalize(
        active,
        'error',
        '',
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined)
    }
  }

  private release(active: ActiveTurn): void {
    const current = this.active.get(active.sessionId)
    if (current?.turnId === active.turnId) this.active.delete(active.sessionId)
  }

  private async finalize(active: ActiveTurn, status: BtwTurnStatus, answer: string, error?: string): Promise<void> {
    active.phase = 'finalizing'
    const repo = this.repo
    if (!repo) return
    let changed = false
    try {
      const updated = await repo.update(active.sessionId, active.topicId, (current) => {
        const index = current.turns.findIndex((turn) => turn.turnId === active.turnId)
        if (index < 0) return current
        const turn = current.turns[index]
        if (!turn || turn.status !== 'running') {
          return current
        }
        const at = now()
        const next: BtwTurn = {
          ...turn,
          status,
          answer: answer || turn.answer,
          updatedAt: at,
          ...(error === undefined ? {} : { error }),
        }
        changed = true
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: at,
          turns: current.turns.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate)),
        }
      })
      if (changed) {
        this.hub(active.sessionId).publish({ type: 'topic', topic: updated })
        this.hub(active.sessionId).publish({
          type: 'settled',
          topicId: active.topicId,
          turnId: active.turnId,
          status,
          ...(error === undefined ? {} : { error }),
        })
      }
    } catch (cause) {
      this.hub(active.sessionId).publish({
        type: 'settled',
        topicId: active.topicId,
        turnId: active.turnId,
        status: 'interrupted',
        error: `storage-terminal-unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    } finally {
      this.release(active)
    }
  }

  @Remote({ resources: { session: (request: BtwListRequest) => request.sessionId as SessionId } })
  async list(request: BtwListRequest): Promise<BtwListValue> {
    this.validateSession(request.sessionId)
    const repo = await this.repository()
    return { topics: repo.topics(request.sessionId) }
  }

  @Remote({ resources: { session: (request: BtwGetRequest) => request.sessionId as SessionId } })
  async get(request: BtwGetRequest): Promise<BtwGetValue> {
    this.validateSession(request.sessionId)
    const repo = await this.repository()
    return { topic: repo.get(request.sessionId, request.topicId) ?? null }
  }

  @Remote({
    mode: 'stream',
    resources: { session: (request: BtwWatchRequest) => request.sessionId as SessionId },
  })
  async *watch(request: BtwWatchRequest, signal?: AbortSignal): AsyncIterable<BtwFrame> {
    this.validateSession(request.sessionId)
    const repo = await this.repository()
    const hub = this.hub(request.sessionId)
    const queue: BtwFrame[] = []
    let wake: (() => void) | undefined
    const unsubscribe = hub.subscribe((frame) => {
      queue.push(frame)
      wake?.()
    })
    try {
      yield { type: 'snapshot', revision: hub.revision, topics: repo.topics(request.sessionId) }
      while (!signal?.aborted) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          const done = (): void => {
            signal?.removeEventListener('abort', done)
            resolve()
          }
          wake = done
          signal?.addEventListener('abort', done, { once: true })
        })
        wake = undefined
      }
    } finally {
      unsubscribe()
    }
  }

  @Remote({ resources: { session: (request: BtwCancelRequest) => request.sessionId as SessionId } })
  async cancel(request: BtwCancelRequest): Promise<BtwCancelValue> {
    this.validateSession(request.sessionId)
    const repo = await this.repository()
    const active = this.active.get(request.sessionId)
    if (!active || active.topicId !== request.topicId || active.turnId !== request.turnId) {
      return { cancelled: false, topic: repo.get(request.sessionId, request.topicId) ?? null }
    }
    active.controller.abort()
    return { cancelled: true, topic: repo.get(request.sessionId, request.topicId) ?? null }
  }
}

export default BtwService
