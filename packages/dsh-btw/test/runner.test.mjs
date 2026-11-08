import test from 'node:test'
import assert from 'node:assert/strict'
import { runSideCall } from '../lib/index.js'

const POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT'],
  initialDelayMs: 0,
  maxDelayMs: 0,
  jitterRatio: 0,
})

const FACTS = Object.freeze({ provider: 'fake', model: 'fake-model', maxTokens: 99_999 })

const NORMALIZED = Object.freeze({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'side question' }] }],
  system: 'side system',
  degraded: [],
})

const textChunk = (text) => ({ type: 'text-delta', index: 0, text })
const finish = (reason) => ({ type: 'finish', reason })
const stop = () => finish({ kind: 'stop' })
const failure = (code) => finish({ kind: 'error', failure: { code, message: `failure ${code}` } })

const streamOf = (...chunks) => (async function* () {
  for (const chunk of chunks) yield chunk
})()

/** Fake adapter that records each prepareCall and serves one scripted stream per call. */
function adapter(scripts, policy = POLICY) {
  const calls = []
  return {
    calls,
    llm: {
      async prepareCall(config, signal) {
        const record = { config, signal, streamOptions: undefined }
        const script = scripts[calls.length]
        calls.push(record)
        if (!script) throw new Error(`unexpected prepareCall #${calls.length}`)
        return {
          config: { provider: config.provider, model: config.model },
          retryPolicy: policy,
          stream(options) {
            record.streamOptions = options
            return script()
          },
        }
      },
    },
  }
}

const sideSignal = () => new AbortController()

test('side call carries no sessionId, purpose, or tools', async () => {
  const { calls, llm } = adapter([() => streamOf(textChunk('OK'), stop())])
  const controller = sideSignal()
  const deltas = []

  const result = await runSideCall({
    ctx: { llm },
    facts: FACTS,
    normalized: NORMALIZED,
    signal: controller.signal,
    onDelta: (text) => deltas.push(text),
  })

  assert.equal(result.status, 'complete')
  assert.equal(result.text, 'OK')
  assert.deepEqual(deltas, ['OK'])
  assert.equal(calls.length, 1)

  const config = calls[0].config
  assert.equal(config.sessionId, undefined)
  assert.equal(config.purpose, undefined)
  assert.equal(config.tools, undefined)
  assert.equal(config.maxTokens, 4096)

  const options = calls[0].streamOptions
  assert.equal(options.sessionId, undefined)
  assert.equal(options.purpose, undefined)
  assert.equal(options.tools, undefined)
  assert.deepEqual(options.messages, NORMALIZED.messages)
  assert.equal(options.system, 'side system')
  assert.notEqual(options.signal, controller.signal)
})

test('aborting the side signal cancels only the side call', async () => {
  const main = new AbortController()
  const side = new AbortController()
  let streamSignal
  const { llm } = adapter([
    () => {
      side.abort()
      return streamOf(textChunk('partial'), stop())
    },
  ])
  const prepareCall = llm.prepareCall
  llm.prepareCall = async (config, signal) => {
    const prepared = await prepareCall(config, signal)
    return {
      ...prepared,
      stream(options) {
        streamSignal = options.signal
        return prepared.stream(options)
      },
    }
  }

  const result = await runSideCall({
    ctx: { llm },
    facts: FACTS,
    normalized: NORMALIZED,
    signal: side.signal,
    onDelta: () => {},
  })

  assert.equal(result.status, 'cancelled')
  assert.equal(side.signal.aborted, true)
  assert.equal(main.signal.aborted, false)
  assert.notEqual(streamSignal, main.signal)
})

test('retryable failures retry with a fresh prepareCall; non-retryable codes do not', async () => {
  const retried = adapter([() => streamOf(failure('RATE_LIMIT')), () => streamOf(textChunk('RETRIED'), stop())])
  const retriedResult = await runSideCall({
    ctx: { llm: retried.llm },
    facts: FACTS,
    normalized: NORMALIZED,
    signal: sideSignal().signal,
    onDelta: () => {},
  })

  assert.equal(retriedResult.status, 'complete')
  assert.equal(retriedResult.text, 'RETRIED')
  assert.equal(retried.calls.length, 2)
  assert.notEqual(retried.calls[0], retried.calls[1])
  assert.notEqual(retried.calls[0].streamOptions, retried.calls[1].streamOptions)
  assert.deepEqual(retried.calls[0].config, retried.calls[1].config)

  const fatal = adapter([() => streamOf(failure('AUTH'))])
  const fatalResult = await runSideCall({
    ctx: { llm: fatal.llm },
    facts: FACTS,
    normalized: NORMALIZED,
    signal: sideSignal().signal,
    onDelta: () => {},
  })

  assert.equal(fatalResult.status, 'error')
  assert.equal(fatal.calls.length, 1)
})

test('no retry after partial text was already streamed', async () => {
  const { calls, llm } = adapter([
    () => streamOf(textChunk('PART'), failure('RATE_LIMIT')),
    () => streamOf(textChunk('SHOULD_NOT_RUN'), stop()),
  ])
  const deltas = []

  const result = await runSideCall({
    ctx: { llm },
    facts: FACTS,
    normalized: NORMALIZED,
    signal: sideSignal().signal,
    onDelta: (text) => deltas.push(text),
  })

  assert.equal(result.status, 'error')
  assert.equal(result.text, 'PART')
  assert.equal(calls.length, 1)
  assert.deepEqual(deltas, ['PART'])
})
