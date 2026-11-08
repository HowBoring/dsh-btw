import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BtwService, topicKey } from '../lib/index.js'

const AT = '2026-01-01T00:00:00.000Z'

const text = (value) => [{ type: 'text', text: value }]

const cut = (overrides = {}) => ({
  sessionId: 'session-1',
  eventSeq: 0,
  cutOffset: 1,
  capturedAt: AT,
  degraded: [],
  ...overrides,
})

async function makeHarness(options = {}) {
  const ctx = new Context()
  const store = new Map()
  const calls = []
  let ordinal = 0

  const table = {
    entries: () => store.entries(),
    get: (key) => store.get(key),
    put: async (key, value) => {
      if (options.put) return options.put(key, value, store)
      store.set(key, value)
    },
    update: async (key, transform) => {
      if (!store.has(key)) throw new Error(`missing record ${key}`)
      const next = transform(store.get(key))
      store.set(key, next)
      return next
    },
  }

  const messages = options.messages ?? [{ role: 'user', content: text('hello main') }]
  const session = {
    id: 'session-1',
    seq: options.seq ?? 5,
    deriveMessages: () => messages,
  }
  const agent = {
    session,
    options: { provider: 'fake', model: 'fake-model' },
  }

  const llm = {
    async prepareCall(config, signal) {
      const record = { config, signal, ordinal: ++ordinal, streamOptions: undefined }
      calls.push(record)
      return {
        config: { provider: 'fake', model: 'fake-model' },
        retryPolicy: {
          mode: 'normal',
          maxRetries: 0,
          retryableCodes: [],
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        },
        stream: (streamOptions) => {
          record.streamOptions = streamOptions
          const answer = `ANSWER_${record.ordinal}`
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: answer }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }

  ctx.provide('llm', llm)
  ctx.provide('sessions', {})
  ctx.provide('agents', { get: (sessionId) => (sessionId === 'session-1' ? agent : undefined) })
  ctx.provide('storageDomain', {
    open: async () => ({
      table: () => table,
      close: async () => {},
    }),
  })
  ctx.provide('typert', {})

  for (const seeded of options.seedTopics ?? []) {
    store.set(topicKey(seeded.sessionId, seeded.topicId), seeded)
  }

  const svc = new BtwService(ctx)
  await svc.list({ sessionId: 'session-1' })
  return { svc, calls, messages, session }
}

async function waitForTurn(svc, receipt, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const { topic } = await svc.get({ sessionId: 'session-1', topicId: receipt.topicId })
    const turn = topic?.turns.find((candidate) => candidate.turnId === receipt.turnId)
    if (turn && turn.status !== 'running') return { topic, turn }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('turn did not settle')
}

const messageTexts = (request) =>
  request.messages.map((message) => message.content.map((block) => block.text).join(''))

test('ask returns an admission receipt and eventually a complete turn', async () => {
  const h = await makeHarness()

  const receipt = await h.svc.ask({ sessionId: 'session-1', question: 'Why?', requestId: 'request-1' })
  assert.ok(receipt.topicId)
  assert.ok(receipt.turnId)
  assert.equal(receipt.status, 'running')
  assert.equal(receipt.revision, 1)

  const { topic, turn } = await waitForTurn(h.svc, receipt)
  assert.equal(turn.status, 'complete')
  assert.equal(turn.answer, 'ANSWER_1')
  assert.equal(topic.revision, 2)
  assert.ok(turn.contextCut.degraded.includes('late-mount'))
  assert.equal(h.calls.length, 1)

  const streamOptions = h.calls[0].streamOptions
  assert.equal(streamOptions.sessionId, undefined)
  assert.equal(streamOptions.purpose, undefined)
  assert.equal(streamOptions.tools, undefined)
  assert.ok(messageTexts(streamOptions)[0].includes('hello main'))
  assert.equal(messageTexts(streamOptions).at(-1), 'Why?')
})

test('duplicate requestId returns the same turn with a single dispatch', async () => {
  const h = await makeHarness()

  const first = h.svc.ask({ sessionId: 'session-1', question: 'Q', requestId: 'duplicate' })
  const second = h.svc.ask({ sessionId: 'session-1', question: 'Q', requestId: 'duplicate' })
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.turnId, b.turnId)
  assert.equal(a.topicId, b.topicId)

  const { topic } = await waitForTurn(h.svc, a)
  assert.equal(h.calls.length, 1)
  assert.equal(topic.turns.length, 1)
})

test('follow replays only the selected topic history and uses the new cut', async () => {
  const h = await makeHarness()

  const first = await h.svc.ask({ sessionId: 'session-1', question: 'Q1', requestId: 'request-1' })
  await waitForTurn(h.svc, first)

  const other = await h.svc.ask({ sessionId: 'session-1', question: 'TOPIC_B_QUESTION', requestId: 'request-2' })
  await waitForTurn(h.svc, other)
  assert.notEqual(other.topicId, first.topicId)

  h.session.seq = 9
  h.messages.push({ role: 'user', content: text('NEW_MAIN_EVENT') })

  const follow = await h.svc.ask({
    sessionId: 'session-1',
    topicId: first.topicId,
    question: 'Q2',
    requestId: 'request-3',
  })
  const { topic, turn } = await waitForTurn(h.svc, follow)

  assert.equal(turn.contextCut.eventSeq, 8)
  assert.equal(turn.contextCut.cutOffset, 9)

  const texts = messageTexts(h.calls[2].streamOptions)
  assert.ok(texts[0].includes('NEW_MAIN_EVENT'))
  assert.ok(texts.includes('Q1'))
  assert.ok(texts.includes('ANSWER_1'))
  assert.ok(!texts.some((value) => value.includes('TOPIC_B_QUESTION')))
  assert.equal(texts.at(-1), 'Q2')

  assert.equal(topic.turns.length, 2)
  assert.equal(topic.turns[0].answer, 'ANSWER_1')
})

test('cancel during admission persists cancelled and never dispatches', async () => {
  let releasePut
  let startedPut
  const putStarted = new Promise((resolve) => {
    startedPut = resolve
  })
  const gate = new Promise((resolve) => {
    releasePut = resolve
  })

  const h = await makeHarness({
    put: async (key, value, store) => {
      store.set(key, value)
      startedPut()
      await gate
    },
  })

  const pending = h.svc.ask({ sessionId: 'session-1', question: 'cancel me', requestId: 'request-cancel' })
  await putStarted

  const active = h.svc.active.get('session-1')
  assert.ok(active)
  const cancelled = await h.svc.cancel({
    sessionId: 'session-1',
    topicId: active.topicId,
    turnId: active.turnId,
  })
  assert.equal(cancelled.cancelled, true)

  releasePut()
  const receipt = await pending
  assert.equal(receipt.status, 'cancelled')
  assert.equal(h.calls.length, 0)

  const { topic } = await h.svc.get({ sessionId: 'session-1', topicId: active.topicId })
  assert.equal(topic.turns[0].status, 'cancelled')
  assert.equal(topic.turns[0].answer, '')
})

test('recovery turns a persisted running turn into interrupted without dispatch', async () => {
  const seeded = {
    sessionId: 'session-1',
    topicId: 'topic-running',
    title: 'old question',
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    turns: [
      {
        turnId: 'turn-running',
        requestId: 'request-old',
        question: 'old question',
        answer: '',
        status: 'running',
        createdAt: AT,
        updatedAt: AT,
        contextCut: cut(),
      },
    ],
  }
  const h = await makeHarness({ seedTopics: [seeded] })

  const { topics } = await h.svc.list({ sessionId: 'session-1' })
  assert.equal(topics.length, 1)
  assert.equal(topics[0].revision, 2)
  assert.equal(topics[0].turns[0].status, 'interrupted')
  assert.equal(topics[0].turns[0].error, 'host-crash')

  const { topic } = await h.svc.get({ sessionId: 'session-1', topicId: 'topic-running' })
  assert.equal(topic.turns[0].status, 'interrupted')
  assert.equal(h.calls.length, 0)
})

test('a storage admission failure prevents dispatch', async () => {
  const h = await makeHarness({
    put: async () => {
      throw new Error('disk full')
    },
  })

  await assert.rejects(
    h.svc.ask({ sessionId: 'session-1', question: 'Q', requestId: 'request-fail' }),
    (error) => {
      assert.equal(error.code, 'btw/storage-admission-failed')
      return true
    },
  )

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.calls.length, 0)
  assert.equal(h.svc.active.size, 0)
})
