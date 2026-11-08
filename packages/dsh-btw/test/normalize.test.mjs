import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CONTEXT_CHARS, normalizeSideContext } from '../lib/index.js'

const CAPTURED_AT = '2026-01-01T00:00:00.000Z'

const cut = (overrides = {}) => ({
  sessionId: 'session-1',
  eventSeq: 4,
  cutOffset: 5,
  capturedAt: CAPTURED_AT,
  degraded: [],
  ...overrides,
})

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (content) => ({
  role: 'assistant',
  content,
  source: { kind: 'model', provider: 'fake', model: 'fake' },
})
const tool = (toolCallId, text, isError = false) => ({
  role: 'tool',
  toolCallId,
  content: [{ type: 'text', text }],
  source: { kind: 'tool', callId: toolCallId },
  ...(isError ? { isError: true } : {}),
})
const toolCall = (id, name) => ({ type: 'tool-call', id, name, arguments: '{}' })

const normalize = (input = {}) =>
  normalizeSideContext({
    messages: [],
    cut: cut(),
    history: [],
    question: 'What happened?',
    ...input,
  })

const mainContextText = (result) => result.messages[0].content[0].text

test('partial tool batch keeps matched results and never fabricates a success', () => {
  const result = normalize({
    messages: [
      user('main question'),
      assistant([
        { type: 'text', text: 'Looking.' },
        toolCall('call-a', 'read'),
        toolCall('call-b', 'grep'),
      ]),
      tool('call-a', 'file content'),
    ],
  })
  const text = mainContextText(result)

  assert.match(text, /\[user\]\nmain question/)
  assert.match(text, /\[assistant\]\nLooking\./)
  assert.match(text, /\[tool result: read\]\nfile content/)
  assert.match(text, /\[tool call not executed in this side view: grep\]/)
  assert.match(text, /no result is available at capture time/)
  assert.doesNotMatch(text, /\[tool result: grep\]/)
  assert.doesNotMatch(text, /success/i)

  assert.ok(result.messages.every((message) => message.role !== 'tool'))
  assert.equal(result.messages.at(-1).role, 'user')
  assert.equal(result.messages.at(-1).content[0].text, 'What happened?')
})

test('fully matched tool batches survive as ordinary transcript text', () => {
  const result = normalize({
    messages: [
      user('main question'),
      assistant([toolCall('call-a', 'read')]),
      tool('call-a', 'file content'),
    ],
  })
  const text = mainContextText(result)

  assert.match(text, /\[tool result: read\]\nfile content/)
  assert.doesNotMatch(text, /not executed in this side view/)
})

test('system, developer, and reasoning messages are dropped', () => {
  const result = normalize({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM_SECRET' }] },
      { role: 'developer', content: [{ type: 'text', text: 'DEVELOPER_SECRET' }] },
      user('visible question'),
      assistant([
        { type: 'reasoning', text: 'REASONING_SECRET' },
        { type: 'text', text: 'visible answer' },
      ]),
    ],
  })
  const text = mainContextText(result)

  assert.match(text, /visible question/)
  assert.match(text, /visible answer/)
  assert.doesNotMatch(text, /SYSTEM_SECRET/)
  assert.doesNotMatch(text, /DEVELOPER_SECRET/)
  assert.doesNotMatch(text, /REASONING_SECRET/)
})

test('overlong context keeps the newest text and reports truncation', () => {
  const oldest = 'OLDEST_HEAD'
  const newest = 'NEWEST_TAIL'
  const longText = `${oldest}${'x'.repeat(MAX_CONTEXT_CHARS)}${newest}`
  const result = normalize({ messages: [user(longText)] })
  const text = mainContextText(result)

  assert.ok(text.includes(newest))
  assert.ok(!text.includes(oldest))
  assert.match(text, /\[\.\.\. older main context truncated \.\.\.\]/)
  assert.ok(result.degraded.includes('context-truncated'))
  assert.ok(text.length <= MAX_CONTEXT_CHARS + 120)
})

test('in-flight text is rendered as a separate streaming segment', () => {
  const result = normalize({
    messages: [user('committed question')],
    inFlightText: '  streaming words  ',
  })
  const text = mainContextText(result)

  assert.match(text, /\[assistant, still streaming at capture\]\nstreaming words/)
  assert.ok(text.indexOf('committed question') < text.indexOf('streaming words'))
})

test('selected-topic history is replayed as separate user/assistant messages', () => {
  const history = [
    {
      turnId: 'turn-1',
      requestId: 'request-1',
      question: 'Q1',
      answer: 'A1',
      status: 'complete',
      createdAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT,
      contextCut: cut(),
    },
    {
      turnId: 'turn-empty',
      requestId: 'request-empty',
      question: 'Q-EMPTY',
      answer: '   ',
      status: 'complete',
      createdAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT,
      contextCut: cut(),
    },
    {
      turnId: 'turn-partial',
      requestId: 'request-partial',
      question: 'QP',
      answer: 'AP',
      status: 'cancelled',
      createdAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT,
      contextCut: cut(),
    },
  ]
  const result = normalize({ history, question: 'Q2' })

  assert.deepEqual(
    result.messages.map((message) => message.role),
    ['user', 'user', 'assistant', 'user', 'assistant', 'user'],
  )
  assert.equal(result.messages[1].content[0].text, 'Q1')
  assert.equal(result.messages[2].content[0].text, 'A1')
  assert.equal(result.messages[2].source.provider, 'btw-history')
  assert.equal(result.messages[3].content[0].text, 'QP')
  assert.equal(result.messages[4].content[0].text, 'AP')
  assert.equal(result.messages[5].content[0].text, 'Q2')
  assert.ok(!result.messages.some((message) => message.content[0].text.includes('Q-EMPTY')))
  assert.ok(result.degraded.includes('history-partial'))
})
