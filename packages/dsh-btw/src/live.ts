import type { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

export interface MainRequestFacts {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: GenerateOptions['reasoningEffort']
  readonly temperature?: number
  readonly maxTokens?: number
  readonly system?: string
}

export interface LiveCapture {
  readonly facts?: MainRequestFacts
  readonly inFlightText?: string
  readonly attemptId?: string
  readonly attemptRevision?: number
  readonly chunkIndex?: number
  readonly degraded: readonly string[]
}

interface AttemptState {
  readonly attemptId: string
  readonly revision: number
  nextIndex: number
  invalid: boolean
  readonly assembler: BlockAssembler
}

/**
 * Process-local mirror of main-Agent model requests and live assistant chunks.
 * It observes only public waterfall/event payloads and never interrupts them.
 */
export class LiveContextMirror {
  private readonly requests = new Map<string, MainRequestFacts>()
  private readonly attempts = new Map<string, AttemptState>()

  constructor(ctx: Context) {
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      if (isAgentLoopRequest(options) && options.sessionId !== undefined) {
        this.requests.set(options.sessionId, {
          provider: options.provider,
          model: options.model,
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.system === undefined ? {} : { system: options.system }),
        })
      }
      return next()
    })

    ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: { session: Session }; frame: AssistantStreamFrame }) => {
      this.observe(agent.session.id, frame)
    })

    // Durable settlement can land before the committed stream `end` frame. Clear the
    // live prefix on the Event so a cut between the two never duplicates the answer.
    ctx.on('session/event', (session: Session, event: { type: string }) => {
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        this.attempts.delete(session.id)
      }
    })
    ctx.on('agent/disposed', ({ agent }: { agent: { session: Session } }) => {
      this.attempts.delete(agent.session.id)
      this.requests.delete(agent.session.id)
    })
    ctx.on('session/disposed', (session: Session) => {
      this.attempts.delete(session.id)
      this.requests.delete(session.id)
    })
  }

  private observe(sessionId: string, frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.attempts.set(sessionId, {
        attemptId: frame.attemptId,
        revision: frame.revision,
        nextIndex: 0,
        invalid: false,
        assembler: new BlockAssembler(),
      })
      return
    }
    const state = this.attempts.get(sessionId)
    if (frame.type === 'end') {
      if (state?.attemptId === frame.attemptId) this.attempts.delete(sessionId)
      return
    }
    if (!state || state.attemptId !== frame.attemptId || state.revision !== frame.revision) return
    if (frame.index !== state.nextIndex) {
      state.invalid = true
      return
    }
    state.nextIndex += 1
    state.assembler.push(frame.chunk)
  }

  capture(session: Session): LiveCapture {
    const degraded: string[] = []
    const facts = this.requests.get(session.id)
    if (!facts) degraded.push('missing-main-request')
    const state = this.attempts.get(session.id)
    if (!state) return { ...(facts ? { facts } : {}), degraded }
    if (state.invalid) {
      degraded.push('missing-attempt-prefix')
      return {
        ...(facts ? { facts } : {}),
        attemptId: state.attemptId,
        attemptRevision: state.revision,
        chunkIndex: state.nextIndex,
        degraded,
      }
    }
    const text = state.assembler
      .interruptedBlocks()
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
    return {
      ...(facts ? { facts } : {}),
      ...(text.trim() ? { inFlightText: text } : {}),
      attemptId: state.attemptId,
      attemptRevision: state.revision,
      chunkIndex: state.nextIndex,
      degraded,
    }
  }
}
