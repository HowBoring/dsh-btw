import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BtwTopicRepository,
  btwDomainSpec,
  btwTopicSchema,
  topicKey,
} from '../lib/index.js'

const AT = '2026-01-01T00:00:00.000Z'

const cut = () => ({
  sessionId: 'session-1',
  eventSeq: 3,
  cutOffset: 4,
  capturedAt: AT,
  degraded: [],
})

const topic = (overrides = {}) => ({
  sessionId: 'session-1',
  topicId: 'topic-1',
  title: 'Why?',
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
  turns: [
    {
      turnId: 'turn-1',
      requestId: 'request-1',
      question: 'Why?',
      answer: 'Because.',
      status: 'complete',
      createdAt: AT,
      updatedAt: AT,
      contextCut: cut(),
    },
  ],
  ...overrides,
})

function fakeDomain(records = new Map()) {
  const table = {
    entries: () => records.entries(),
    get: (key) => records.get(key),
    put: async (key, value) => {
      records.set(key, value)
    },
    update: async (key, transform) => {
      if (!records.has(key)) throw new Error(`missing record ${key}`)
      const next = transform(records.get(key))
      records.set(key, next)
      return next
    },
  }
  return {
    records,
    domain: {
      table: () => table,
      close: async () => {
        records.closed = true
      },
    },
  }
}

test('topicKey is path-safe base64url and distinct across sessions and topics', () => {
  const key = topicKey('session/a b', 'topic/?=')
  assert.match(key, /^[A-Za-z0-9_-]+$/)
  assert.ok(!key.includes('/'))
  assert.ok(!key.includes('+'))
  assert.ok(!key.includes('='))
  assert.equal(Buffer.from(key, 'base64url').toString('utf8'), 'session/a b\u0000topic/?=')

  assert.notEqual(topicKey('session-1', 'topic-1'), topicKey('session-2', 'topic-1'))
  assert.notEqual(topicKey('session-1', 'topic-1'), topicKey('session-1', 'topic-2'))
})

test('put/get/update/entries/close round-trip through the domain table', async () => {
  const { records, domain } = fakeDomain()
  const repo = new BtwTopicRepository(domain)
  const first = topic()
  const second = topic({ topicId: 'topic-2', title: 'Other', updatedAt: '2026-01-02T00:00:00.000Z' })

  await repo.put(first)
  await repo.put(second)

  assert.deepEqual(repo.get('session-1', 'topic-1'), first)
  assert.equal(repo.get('session-2', 'topic-1'), undefined)
  assert.equal(repo.get('session-1', 'topic-3'), undefined)
  assert.equal(repo.all().length, 2)
  assert.deepEqual(
    repo.topics('session-1').map((entry) => entry.topicId),
    ['topic-2', 'topic-1'],
  )

  const updated = await repo.update('session-1', 'topic-1', (current) => ({
    ...current,
    revision: current.revision + 1,
    title: 'Updated',
  }))
  assert.equal(updated.revision, 2)
  assert.equal(repo.get('session-1', 'topic-1').title, 'Updated')

  await repo.close()
  assert.equal(records.closed, true)
})

test('update throws on a missing record and on an identity change', async () => {
  const { records, domain } = fakeDomain()
  const repo = new BtwTopicRepository(domain)

  await assert.rejects(repo.update('session-1', 'missing', (current) => current), /missing record/)

  records.set(topicKey('session-1', 'topic-1'), topic({ sessionId: 'session-2' }))
  await assert.rejects(
    repo.update('session-1', 'topic-1', (current) => current),
    /btw topic identity changed/,
  )
})

test('malformed records are rejected by the domain schema', () => {
  assert.doesNotThrow(() => btwTopicSchema.parse(topic()))

  assert.throws(() => btwTopicSchema.parse(topic({ revision: -1 })))
  assert.throws(() => btwTopicSchema.parse(topic({ turns: [{ ...topic().turns[0], status: 'weird' }] })))
  assert.throws(() => btwTopicSchema.parse(topic({ sessionId: '' })))

  const malformed = { ...topic(), turns: [{ ...topic().turns[0], contextCut: { ...cut(), eventSeq: -2 } }] }
  assert.throws(() => btwDomainSpec.tables.topics.valueSchema.parse(malformed))
})
