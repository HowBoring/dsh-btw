import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BtwService } from '../lib/index.js'

// BtwHub is not exported from lib/index.js, so its revisioned fan-out is
// exercised through the only public surface that owns it: BtwService.watch.
function startService() {
  const ctx = new Context()
  const store = new Map()
  const table = {
    entries: () => store.entries(),
    get: (key) => store.get(key),
    put: async (key, value) => {
      store.set(key, value)
    },
    update: async (key, transform) => {
      const next = transform(store.get(key))
      store.set(key, next)
      return next
    },
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'main prompt' }] }]
  const session = { id: 'session-1', seq: 3, deriveMessages: () => messages }
  let ordinal = 0

  ctx.provide('llm', {
    async prepareCall() {
      const id = ++ordinal
      return {
        config: { provider: 'fake', model: 'fake' },
        retryPolicy: {
          mode: 'normal',
          maxRetries: 0,
          retryableCodes: [],
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        },
        stream: () =>
          (async function* () {
            yield { type: 'text-delta', index: 0, text: `ANSWER_${id}` }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })(),
      }
    },
  })
  ctx.provide('sessions', {})
  ctx.provide('agents', {
    get: (sessionId) =>
      sessionId === 'session-1' ? { session, options: { provider: 'fake', model: 'fake' } } : undefined,
  })
  ctx.provide('storageDomain', {
    open: async () => ({ table: () => table, close: async () => {} }),
  })
  ctx.provide('typert', {})

  return new BtwService(ctx)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached')
    await tick()
  }
}

async function pump(iterable, frames) {
  try {
    for await (const frame of iterable) frames.push(frame)
  } catch {
    // watcher abort is a normal shutdown
  }
}

test('watch fans out monotonic revisions to two subscribers and isolates unsubscribe', async () => {
  const svc = startService()
  const framesA = []
  const framesB = []
  const controllerA = new AbortController()
  const controllerB = new AbortController()

  const pumpA = pump(svc.watch({ sessionId: 'session-1' }, controllerA.signal), framesA)
  const pumpB = pump(svc.watch({ sessionId: 'session-1' }, controllerB.signal), framesB)

  await waitFor(() => framesA.length > 0 && framesB.length > 0)
  assert.equal(framesA[0].type, 'snapshot')
  assert.equal(framesA[0].revision, 0)

  const receipt = await svc.ask({ sessionId: 'session-1', question: 'Q1', requestId: 'request-1' })
  await waitFor(() => framesA.some((frame) => frame.type === 'settled'))

  const revisions = framesA.map((frame) => frame.revision)
  for (let index = 1; index < revisions.length; index += 1) {
    assert.ok(revisions[index] > revisions[index - 1], `revision ${index} is not monotonic`)
  }
  assert.deepEqual(framesA, framesB)
  assert.equal(framesA.at(-1).type, 'settled')
  assert.equal(framesA.at(-1).turnId, receipt.turnId)

  controllerA.abort()
  await pumpA
  const framesAtUnsubscribe = framesA.length

  const follow = await svc.ask({
    sessionId: 'session-1',
    topicId: receipt.topicId,
    question: 'Q2',
    requestId: 'request-2',
  })
  await waitFor(() => framesB.filter((frame) => frame.type === 'settled').length === 2)

  assert.equal(framesA.length, framesAtUnsubscribe)
  assert.ok(framesB.some((frame) => frame.type === 'settled' && frame.turnId === follow.turnId))

  controllerB.abort()
  await pumpB
})
