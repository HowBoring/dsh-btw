import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NormalizedSideContext } from './normalize.ts'
import type { MainRequestFacts } from './live.ts'

export interface SideRunResult {
  readonly status: 'complete' | 'cancelled' | 'error'
  readonly text: string
  readonly error?: string
}

const MAX_ATTEMPTS = 3
const TIMEOUT_MS = 90_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function retryable(policy: ResolvedRetryPolicy | undefined, code: string): boolean {
  if (!policy) return false
  return policy.mode === 'always' || policy.retryableCodes.includes(code)
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const failure = (error as { failure?: { code?: unknown } }).failure
    if (failure && typeof failure.code === 'string') return failure.code
    if (typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code
  }
  return 'provider-error'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Execute one detached, tool-free side request. The caller owns the turn
 * AbortSignal; this runner never reuses the main request signal or session id.
 */
export async function runSideCall(input: {
  readonly ctx: Context
  readonly facts: MainRequestFacts
  readonly normalized: NormalizedSideContext
  readonly signal: AbortSignal
  readonly onDelta: (text: string) => void
}): Promise<SideRunResult> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const signal = AbortSignal.any([input.signal, deadline])
  let lastError: unknown

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) break
    const config: LlmCallConfig = {
      provider: input.facts.provider,
      model: input.facts.model,
      maxTokens: Math.min(input.facts.maxTokens ?? 4096, 4096),
      ...(input.facts.reasoningEffort === undefined ? {} : { reasoningEffort: input.facts.reasoningEffort }),
      ...(input.facts.temperature === undefined ? {} : { temperature: input.facts.temperature }),
    }
    let prepared
    try {
      prepared = await input.ctx.llm.prepareCall(config, signal)
    } catch (error) {
      lastError = error
      if (!retryable(undefined, failureCode(error))) break
      continue
    }
    let text = ''
    try {
      const stream = prepared.stream({
        ...prepared.config,
        messages: [...input.normalized.messages],
        system: input.normalized.system,
        signal,
      })
      let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
      for await (const chunk of stream as AsyncIterable<StreamChunk>) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
          input.onDelta(chunk.text)
        } else if (chunk.type === 'finish') {
          finish = chunk.reason
        }
      }
      if (finish?.kind === 'error') throw Object.assign(new Error('side provider returned an error'), { failure: finish.failure })
      if (finish?.kind === 'aborted' || signal.aborted) return { status: 'cancelled', text }
      if (!finish && !text) throw Object.assign(new Error('side provider returned no content'), { failure: { code: 'EMPTY_RESPONSE' } })
      return { status: 'complete', text }
    } catch (error) {
      lastError = error
      if (signal.aborted) return { status: 'cancelled', text }
      // A partial answer was already streamed to the reader; retrying would
      // duplicate it, so settle this attempt as an error instead.
      if (text) return { status: 'error', text, error: messageOf(error) }
      if (!retryable(prepared.retryPolicy, failureCode(error))) {
        return { status: 'error', text, error: messageOf(error) }
      }
    }
    if (attempt + 1 < MAX_ATTEMPTS) {
      const backoff = prepared.retryPolicy
      const base = Math.min(backoff.maxDelayMs, backoff.initialDelayMs * 2 ** attempt)
      const jitter = 1 + (Math.random() * 2 - 1) * backoff.jitterRatio
      await sleep(Math.round(base * jitter), signal)
    }
  }

  if (deadline.aborted && !input.signal.aborted) {
    return { status: 'error', text: '', error: 'provider-timeout: side request exceeded its deadline' }
  }
  if (signal.aborted) return { status: 'cancelled', text: '' }
  return { status: 'error', text: '', error: messageOf(lastError ?? 'provider-error') }
}
