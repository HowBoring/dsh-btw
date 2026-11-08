import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { LiveContextMirror } from '../lib/index.js'

function makeHarness() {
  const ctx = new Context()
  const mirror = new LiveContextMirror(ctx)
  const session = { id: 'session-1' }
  let frameIndex = 0
  const emitFrame = (frame) => ctx.emit('agent/assistant-stream', { agent: { session }, frame })
  return {
    ctx,
    mirror,
    session,
    start(attemptId = 'attempt-1', revision = 1) {
      emitFrame({ type: 'start', attemptId, revision, turn: 1, step: 1 })
      frameIndex = 0
      return this
    },
    chunk(chunk, attemptId = 'attempt-1', revision = 1) {
      emitFrame({ type: 'chunk', attemptId, revision, index: frameIndex, time: frameIndex, chunk })
      frameIndex += 1
      return this
    },
    rawChunk(frame) {
      emitFrame({ type: 'chunk', ...frame })
    },
    end(attemptId = 'attempt-1', revision = 1) {
      emitFrame({
        type: 'end',
        attemptId,
        revision,
        index: frameIndex,
        outcome: { kind: 'abandoned' },
      })
      return this
    },
    get nextFrameIndex() {
      return frameIndex
    },
  }
}

const emptyStream = () => (async function* () {})()

test('llm/stream captures the agent-loop request facts and initial attempt', () => {
  const h = makeHarness()
  let nextCalled = false
  const inner = emptyStream()
  const options = markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    temperature: 0.2,
    maxTokens: 1234,
    system: 'main system',
    sessionId: 'session-1',
  })

  const stream = h.ctx.waterfall('llm/stream', options, () => {
    nextCalled = true
    return inner
  })

  assert.equal(nextCalled, true)
  assert.equal(stream, inner)

  h.start('attempt-1', 7)
  const capture = h.mirror.capture(h.session)
  assert.deepEqual(capture.facts, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    temperature: 0.2,
    maxTokens: 1234,
    system: 'main system',
  })
  assert.equal(capture.attemptId, 'attempt-1')
  assert.equal(capture.attemptRevision, 7)
  assert.equal(capture.chunkIndex, 0)
  assert.deepEqual(capture.degraded, [])
})

test('side or unmarked llm/stream requests never become main-request facts', () => {
  const h = makeHarness()
  const sideOptions = { provider: 'fake', model: 'fake', messages: [] }
  h.ctx.waterfall('llm/stream', sideOptions, () => emptyStream())

  let capture = h.mirror.capture(h.session)
  assert.equal(capture.facts, undefined)
  assert.deepEqual(capture.degraded, ['missing-main-request'])

  const markedWithoutSession = markAgentLoopRequest({ provider: 'fake', model: 'fake', messages: [] })
  h.ctx.waterfall('llm/stream', markedWithoutSession, () => emptyStream())
  capture = h.mirror.capture(h.session)
  assert.equal(capture.facts, undefined)
})

test('assistant-stream builds a visible text prefix only; tool-call chunks are not text', () => {
  const h = makeHarness()
  h.start()
  h.chunk({ type: 'text-delta', index: 0, text: 'Visible ' })
  h.chunk({ type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{"path":"a"}' })
  h.chunk({ type: 'text-delta', index: 1, text: 'SECRET_TOOL_TEXT' })
  h.chunk({ type: 'reasoning-delta', index: 2, text: 'SECRET_REASONING' })
  h.chunk({ type: 'tool-call-delta', index: 3, id: 'call-2', name: 'grep', argumentsDelta: '{}' })
  h.chunk({ type: 'text-delta', index: 3, text: 'SECRET_MORE' })

  const capture = h.mirror.capture(h.session)
  assert.equal(capture.inFlightText, 'Visible ')
  assert.equal(capture.chunkIndex, 6)
  assert.deepEqual(capture.degraded, ['missing-main-request'])
})

test('a committed session/event clears the live prefix so the next request starts clean', () => {
  const h = makeHarness()
  h.start('attempt-1', 1)
  h.chunk({ type: 'text-delta', index: 0, text: 'partial answer' })
  assert.equal(h.mirror.capture(h.session).inFlightText, 'partial answer')

  h.ctx.emit('session/event', h.session, { type: 'assistant/message' })
  let capture = h.mirror.capture(h.session)
  assert.equal(capture.attemptId, undefined)
  assert.equal(capture.inFlightText, undefined)

  h.start('attempt-2', 1)
  h.chunk({ type: 'text-delta', index: 0, text: 'clean answer' }, 'attempt-2', 1)
  capture = h.mirror.capture(h.session)
  assert.equal(capture.attemptId, 'attempt-2')
  assert.equal(capture.inFlightText, 'clean answer')

  h.ctx.emit('session/event', h.session, { type: 'assistant/attempt' })
  assert.equal(h.mirror.capture(h.session).attemptId, undefined)
})

test('mismatched attempt/revision frames are ignored', () => {
  const h = makeHarness()
  h.start('attempt-1', 1)
  h.rawChunk({ attemptId: 'attempt-other', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'WRONG_ATTEMPT' } })
  h.rawChunk({ attemptId: 'attempt-1', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'WRONG_REVISION' } })

  let capture = h.mirror.capture(h.session)
  assert.equal(capture.inFlightText, undefined)
  assert.equal(capture.chunkIndex, 0)
  assert.deepEqual(capture.degraded, ['missing-main-request'])

  h.chunk({ type: 'text-delta', index: 0, text: 'accepted' })
  capture = h.mirror.capture(h.session)
  assert.equal(capture.inFlightText, 'accepted')
  assert.equal(capture.chunkIndex, 1)

  h.rawChunk({ attemptId: 'attempt-1', revision: 1, index: 5, time: 5, chunk: { type: 'text-delta', index: 1, text: 'OUT_OF_ORDER' } })
  capture = h.mirror.capture(h.session)
  assert.equal(capture.inFlightText, undefined)
  assert.equal(capture.chunkIndex, 1)
  assert.ok(capture.degraded.includes('missing-attempt-prefix'))
})

test('only a matching end frame retires the active attempt', () => {
  const h = makeHarness()
  h.start('attempt-1', 1)
  h.end('attempt-other', 1)
  assert.equal(h.mirror.capture(h.session).attemptId, 'attempt-1')

  h.end('attempt-1', 1)
  assert.equal(h.mirror.capture(h.session).attemptId, undefined)
})

test('late mount yields degraded markers and does not invent a partial', () => {
  const h = makeHarness()
  let capture = h.mirror.capture(h.session)
  assert.equal(capture.inFlightText, undefined)
  assert.deepEqual(capture.degraded, ['missing-main-request'])

  h.start('attempt-late', 1)
  capture = h.mirror.capture(h.session)
  assert.equal(capture.attemptId, 'attempt-late')
  assert.equal(capture.chunkIndex, 0)
  assert.equal(capture.inFlightText, undefined)
  assert.deepEqual(capture.degraded, ['missing-main-request'])
})
