import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_ROOT
assert.ok(root, 'Set DSH_ROOT to the installed @deepseek-ai/dsh directory')
const load = (path) => import(pathToFileURL(join(root, path)).href)
const llm = await load('node_modules/@deepseek-ai/dsh-llm/lib/index.js')
const deepseek = await load('node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')
const piai = await load('node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
const pi = await load('node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js')
const { Context } = await load('node_modules/@deepseek-ai/cordis/lib/index.js')
const { deadline } = await load('node_modules/@deepseek-ai/dsh-timeout/lib/index.js')
const checkpoint = await load('node_modules/@deepseek-ai/dsh-session-checkpoint-policy/lib/index.js')
const sessionLog = await load('node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js')
const retryPlugin = await load('node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js')

const {
  BlockAssembler, LlmError, LlmRuntime, createAssistantMessage, createToolResultMessage,
  createUserMessage, isAgentLoopRequest,
} = llm
const results = []
const record = (name, detail) => { results.push({ name, ...detail }); console.error(`ok ${name}`) }
const text = (value) => ({ type: 'text', text: value })
const user = (value) => createUserMessage({ content: [text(value)], source: { kind: 'user' } })
const toolCall = (id, name, value) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(value) })
const toolResult = (id, value) => createToolResultMessage({ callId: id, content: [text(value)], isError: false })
const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
const assemble = (chunks) => {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { content: assembler.blocks() }
}
const drainError = async (stream) => {
  try { await collect(stream) } catch (error) { return error }
  throw new Error('Expected stream to reject')
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const installedTypes = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts'), 'utf8')
assert.match(installedTypes, /purpose\?: 'compaction' \| 'session-title'/)
assert.ok(!installedTypes.includes('LlmRequestPurposeMap'))
record('installed purpose typing contract', { version: manifest.version, purpose: "'compaction' | 'session-title'", augmentablePurposeMap: false })

const rawPartial = [
  user('Start the main task.'),
  createAssistantMessage({
    content: [text('Running two tools.'), toolCall('call-a', 'first', { value: 1 }), toolCall('call-b', 'second', { value: 2 })],
    source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  }),
  toolResult('call-a', 'first result committed'),
  user('What should happen next?'),
]
const partialObservation = user([
  'Side observation (uncommitted; not a tool result): the main attempt issued first and second. ',
  'first completed with visible result "first result committed"; second is still open with no result. ',
  'Do not infer completion.\n\nBTW question: What should happen next?',
].join(''))
const matchedToolPrefix = [
  user('Start the main task.'),
  createAssistantMessage({
    content: [text('Running two tools.'), toolCall('call-a', 'first', { value: 1 })],
    source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  }),
  toolResult('call-a', 'first result committed'),
  user('Side observation: the second call is still open and has no outcome. Do not infer completion.\n\nBTW question: What should happen next?'),
]
const liveBlocks = [
  { type: 'reasoning', text: 'SECRET IN-FLIGHT REASONING' },
  text('Visible provisional answer'),
  { type: 'tool-call', id: 'open-call', name: 'unfinished', arguments: '{"partial":' },
]
const visibleLiveText = liveBlocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
const cases = {
  idle: [user('Main request'), createAssistantMessage({ content: [text('Committed answer')], source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }), user('BTW question')],
  streaming: [user('Main request'), user(`Side observation (provisional; visible text only): ${visibleLiveText}\n\nBTW question`)],
  partialToolBatch: [user('Start the main task.'), partialObservation],
  matchedToolPrefix,
  retry: [user('Main request'), user('Side observation (provisional): a retry is pending; failed transient output is not admitted.\n\nBTW question')],
  compaction: [user('Coherent compacted main-context summary'), createAssistantMessage({ content: [text('Committed post-compaction answer')], source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }), user('BTW question')],
}
assert.ok(!JSON.stringify(cases.streaming).includes('SECRET IN-FLIGHT REASONING'))
assert.ok(!JSON.stringify(cases.streaming).includes('open-call'))
assert.ok(cases.partialToolBatch[1].content[0].text.includes('first result committed'))
assert.ok(cases.partialToolBatch[1].content[0].text.includes('second is still open'))
record('normalization fixtures', { states: Object.keys(cases), liveText: visibleLiveText })

const liveAssembler = new BlockAssembler()
liveAssembler.push({ type: 'block-start', index: 0, blockType: 'text' })
liveAssembler.push({ type: 'text-delta', index: 0, text: 'Visible provisional answer' })
liveAssembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
liveAssembler.push({ type: 'tool-call-delta', index: 1, id: 'open-call', name: 'unfinished', argumentsDelta: '{"partial":' })
assert.ok(liveAssembler.blocks().some((block) => block.type === 'tool-call'))
assert.deepEqual(liveAssembler.interruptedBlocks(), [text('Visible provisional answer')])
record('interrupted assembler drops open tool calls', { interrupted: liveAssembler.interruptedBlocks() })

const DS_MODEL = 'deepseek-v4-pro'
const dsConfig = deepseek.resolveAdapterOptions({ provider: 'deepseek-official', apiKey: 'proof-key' })
let dsExtensionRequests = []
const dsFiles = new deepseek.DeepSeekFileStore()
const dsAdapter = new deepseek.DeepSeekAdapter({
  options: () => dsConfig,
  resolveAuth: async () => ({ headers: { 'x-api-key': 'proof-key' } }),
  resolveUserId: () => 'side-proof',
  resolveAttachments: () => undefined,
  resolveImageAccess: () => undefined,
  resolveFiles: () => dsFiles,
  prepareExtensions: async (request) => {
    dsExtensionRequests.push(request)
    return { fields: {}, accept: async () => {} }
  },
})
const dsSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_proof","model":"deepseek-v4-pro","usage":{"input_tokens":1,"output_tokens":0}}}',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"side answer"}}',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":2}}',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n\n')
const dsRequests = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  dsRequests.push({ url: String(url), init, headers: new Headers(init.headers), body: JSON.parse(init.body), signalAborted: init.signal.aborted })
  return new Response(dsSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
try {
  const rawError = await drainError(dsAdapter.stream({ messages: rawPartial, maxTokens: 64 }))
  assert.ok(rawError instanceof LlmError)
  assert.equal(rawError.code, 'INVALID_REQUEST')
  assert.equal(dsRequests.length, 0)
  record('deepseek rejects raw partial tool batch', { code: rawError.code, message: rawError.message, networkCalls: 0 })

  for (const [name, messages] of Object.entries(cases)) {
    const before = dsRequests.length
    const side = new AbortController()
    const main = new AbortController()
    const chunks = await collect(dsAdapter.stream({ messages, maxTokens: 64, purpose: 'btw', signal: side.signal }))
    const message = assemble(chunks)
    assert.equal(message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), 'side answer')
    assert.ok(!message.content.some((block) => block.type === 'tool-call'))
    assert.equal(dsRequests.length, before + 1)
    const request = dsRequests.at(-1)
    assert.equal(request.body.max_tokens, 64)
    assert.ok(!Object.hasOwn(request.body, 'tools'))
    assert.ok(!Object.hasOwn(request.body, 'tool_choice'))
    if (name === 'partialToolBatch') assert.ok(!JSON.stringify(request.body.messages).includes('tool_use'))
    if (name === 'matchedToolPrefix') {
      assert.ok(JSON.stringify(request.body.messages).includes('call-a'))
      assert.ok(!JSON.stringify(request.body.messages).includes('call-b'))
    }
    assert.equal(request.signalAborted, false)
    main.abort()
    assert.equal(side.signal.aborted, false)
    assert.ok(!request.headers.has('x-deepseek-harness-session-id'))
    assert.ok(!request.headers.has('x-deepseek-harness-compact'))
    const extension = dsExtensionRequests.at(-1)
    assert.equal(extension.purpose, 'btw')
    assert.equal(extension.sessionId, undefined)
    record(`deepseek normalized ${name}`, { request: request.body, purpose: extension.purpose })
  }

  const replayed = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'committed reasoning' }, text('committed answer')],
    source: { provider: 'deepseek-official', model: DS_MODEL, replayState: {
      response: { kind: 'deepseek-messages', version: 1, model: DS_MODEL },
      blocks: [{ type: 'reasoning', signature: 'proof-signature' }, { type: 'text' }],
    } },
  })
  await collect(dsAdapter.stream({ provider: 'deepseek-official', model: DS_MODEL, messages: [user('Earlier'), replayed, user('BTW')], maxTokens: 64 }))
  const replayAssistant = dsRequests.at(-1).body.messages.find((message) => message.role === 'assistant')
  assert.deepEqual(replayAssistant.content[0], { type: 'thinking', thinking: 'committed reasoning', signature: 'proof-signature' })
  record('deepseek valid reasoning replay', { assistant: replayAssistant })

  // An unusable replay envelope degrades to unsigned thinking; it must not carry a signature.
  const foreignReplayed = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'foreign reasoning' }, text('foreign answer')],
    source: { provider: 'deepseek-official', model: DS_MODEL, replayState: {
      response: { kind: 'pi-ai', version: 2 },
      blocks: [{ type: 'reasoning' }, { type: 'text' }],
    } },
  })
  await collect(dsAdapter.stream({ provider: 'deepseek-official', model: DS_MODEL, messages: [user('Earlier'), foreignReplayed, user('BTW')], maxTokens: 64 }))
  const degradedAssistant = dsRequests.at(-1).body.messages.find((message) => message.role === 'assistant')
  assert.deepEqual(degradedAssistant.content[0], { type: 'thinking', thinking: 'foreign reasoning' })
  record('deepseek degrades unusable replay without signature', { assistant: degradedAssistant })

  const orphanedResult = [...matchedToolPrefix.slice(0, 2), toolResult('call-zzz', 'orphan')]
  const orphanError = await drainError(dsAdapter.stream({ provider: 'deepseek-official', model: DS_MODEL, messages: orphanedResult, maxTokens: 64 }))
  assert.equal(orphanError.code, 'INVALID_REQUEST')
  assert.equal(orphanError.message, 'DeepSeek Messages tool result has no matching call')
  record('deepseek rejects orphan tool result', { code: orphanError.code, message: orphanError.message })
} finally {
  globalThis.fetch = originalFetch
}

const provider = {
  id: 'proof-pi',
  name: 'Proof pi',
  baseUrl: 'https://proof.invalid/v1',
  api: pi.openAICompletionsApi(),
  authHeader: true,
  auth: { apiKey: { name: 'proof', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key ?? 'proof-key' }, source: 'proof' }) } },
  models: [{ id: 'proof-model', provider: 'proof-pi', baseUrl: 'https://proof.invalid/v1', name: 'Proof model', api: 'openai-completions', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048 }],
  getModels() { return this.models },
  streamSimple(model, context, options) { return this.api.streamSimple(model, context, options) },
}
const memoryAuth = { config: {}, async read() { return undefined }, async write(value) { this.config = value }, async delete() { this.config = undefined } }
const profiles = new Map([['proof-pi', { provider: 'proof-pi', displayName: 'Proof pi', piProvider: provider, modelErrors: new Map(), configuredMaxTokens: new Map(), retryPolicy: llm.resolveRetryPolicy(undefined, 'proof'), streamIdleTimeoutMs: 5000, maxRequestImageBytes: 1024, requestImagePixelBudget: 1024, requestImageMaxBytes: 1024 }]])
const piAdapter = new piai.PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'proof-key', auth: memoryAuth })
const piRequests = []
const piSse = [
  'data: {"id":"chatcmpl-proof","object":"chat.completion.chunk","created":0,"model":"proof-model","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"pi committed reasoning"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-proof","object":"chat.completion.chunk","created":0,"model":"proof-model","choices":[{"index":0,"delta":{"content":"side "},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-proof","object":"chat.completion.chunk","created":0,"model":"proof-model","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-proof","object":"chat.completion.chunk","created":0,"model":"proof-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
  'data: [DONE]',
  '',
].join('\n\n')
globalThis.fetch = async (url, init) => {
  piRequests.push({ url: String(url), init, body: JSON.parse(init.body) })
  return new Response(piSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
let piReplayState
try {
  for (const [name, messages] of Object.entries(cases)) {
    const before = piRequests.length
    const chunks = await collect(piAdapter.stream({ provider: 'proof-pi', messages, model: 'proof-model', maxTokens: 64, purpose: 'btw', signal: new AbortController().signal }))
    const message = assemble(chunks)
    assert.equal(message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), 'side answer')
    assert.ok(!message.content.some((block) => block.type === 'tool-call'))
    assert.equal(piRequests.length, before + 1)
    const request = piRequests.at(-1)
    assert.equal(request.body.max_completion_tokens, 64)
    assert.ok(!Object.hasOwn(request.body, 'max_tokens'))
    if (name === 'matchedToolPrefix') assert.deepEqual(request.body.tools, [])
    else assert.ok(!Object.hasOwn(request.body, 'tools'))
    assert.ok(!Object.hasOwn(request.body, 'tool_choice'))
    assert.ok(!Object.hasOwn(request.body, 'purpose'))
    if (name === 'partialToolBatch') assert.ok(!request.body.messages.some((message) => message.role === 'tool'))
    if (name === 'matchedToolPrefix') {
      assert.ok(JSON.stringify(request.body.messages).includes('call-a'))
      assert.ok(!JSON.stringify(request.body.messages).includes('call-b'))
      assert.deepEqual(request.body.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['call-a'])
    }
    if (name === 'idle') piReplayState = chunks.find((chunk) => chunk.type === 'finish')?.replayState
    record(`pi-ai normalized ${name}`, { request: request.body })
  }

  assert.ok(piReplayState)
  const piReplayed = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'pi committed reasoning' }, text('side answer')],
    source: { provider: 'proof-pi', model: 'proof-model', replayState: piReplayState },
  })
  await collect(piAdapter.stream({ provider: 'proof-pi', model: 'proof-model', messages: [user('Earlier'), piReplayed, user('BTW')], maxTokens: 64 }))
  const piReplayAssistant = piRequests.at(-1).body.messages.find((message) => message.role === 'assistant')
  assert.ok(JSON.stringify(piReplayAssistant).includes('pi committed reasoning'))
  record('pi-ai valid reasoning replay', { assistant: piReplayAssistant })

  const piForeignReplayed = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'committed reasoning' }, text('committed answer')],
    source: { provider: 'deepseek-official', model: DS_MODEL, replayState: {
      response: { kind: 'deepseek-messages', version: 1, model: DS_MODEL },
      blocks: [{ type: 'reasoning', signature: 'proof-signature' }, { type: 'text' }],
    } },
  })
  await collect(piAdapter.stream({ provider: 'proof-pi', model: 'proof-model', messages: [user('Earlier'), piForeignReplayed, user('BTW')], maxTokens: 64 }))
  const piForeignAssistant = piRequests.at(-1).body.messages.find((message) => message.role === 'assistant')
  assert.ok(!JSON.stringify(piForeignAssistant).includes('proof-signature'))
  // pi-ai drops cross-model thinking blocks entirely (transform-messages.js isSameModel gate).
  assert.ok(!JSON.stringify(piForeignAssistant).includes('committed reasoning'))
  record('pi-ai drops foreign replay reasoning', { assistant: piForeignAssistant })

  const rawBefore = piRequests.length
  let rawPiFailure
  try {
    const rawChunks = await collect(piAdapter.stream({ provider: 'proof-pi', model: 'proof-model', messages: rawPartial, maxTokens: 64 }))
    rawPiFailure = rawChunks.find((chunk) => chunk.type === 'finish')?.reason
  } catch (error) { rawPiFailure = { message: error.message, code: error.code } }
  const rawPiRequest = piRequests.length === rawBefore ? undefined : piRequests.at(-1).body
  assert.ok(rawPiRequest)
  assert.deepEqual(rawPiRequest.messages.filter((message) => message.role === 'tool').map((message) => ({ id: message.tool_call_id, content: message.content })), [
    { id: 'call-a', content: 'first result committed' },
    { id: 'call-b', content: 'No result provided' },
  ])
  record('pi-ai raw partial tool batch compatibility', { request: rawPiRequest, finish: rawPiFailure })
} finally {
  globalThis.fetch = originalFetch
}

const flushCalls = []
const mainSession = { id: 'main-proof' }
const runtimeCtx = new Context().extend({
  sessions: {
    get: (id) => id === 'main-proof' ? mainSession : undefined,
    flush: async (session) => { flushCalls.push(session.id) },
  },
  sessionProjections: { register: () => {} },
})
const runtime = new LlmRuntime(runtimeCtx)
runtime.registerAdapter(['deepseek-official'], dsAdapter)
checkpoint.apply(runtimeCtx)
const intercepted = []
runtimeCtx.on('llm/stream', (options, next) => {
  intercepted.push({ purpose: options.purpose, sessionId: options.sessionId, agentLoop: isAgentLoopRequest(options) })
  return next()
})
const runtimeRequests = []
globalThis.fetch = async (url, init) => {
  runtimeRequests.push({ url: String(url), init, headers: new Headers(init.headers), body: JSON.parse(init.body) })
  return new Response(dsSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
try {
  const side = new AbortController()
  const main = new AbortController()
  const prepared = await runtime.prepareCall({ provider: 'deepseek-official', model: DS_MODEL, maxTokens: 64 }, side.signal)
  assert.equal(prepared.config.maxTokens, 64)
  const options = { ...prepared.config, messages: [user('BTW')], purpose: 'btw', signal: side.signal }
  const chunks = await collect(prepared.stream(options))
  assert.equal(chunks.find((chunk) => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.throws(() => prepared.stream(options), (error) => error.code === 'INVALID_PREPARED_CALL')
  main.abort()
  assert.equal(side.signal.aborted, false)
  assert.deepEqual(flushCalls, [])
  assert.equal(runtimeRequests.at(-1).headers.has('x-deepseek-harness-session-id'), false)
  assert.equal(intercepted.at(-1).agentLoop, false)
  record('prepareCall independent identity and one-shot dispatch', { maxTokens: prepared.config.maxTokens, flushCalls: [...flushCalls], intercepted: intercepted.at(-1) })

  const withIdentity = await runtime.prepareCall({ provider: 'deepseek-official', model: DS_MODEL, maxTokens: 64 })
  await collect(withIdentity.stream({ ...withIdentity.config, messages: [user('BTW')], purpose: 'btw', sessionId: 'main-proof', signal: new AbortController().signal }))
  assert.deepEqual(flushCalls, ['main-proof'])
  assert.equal(runtimeRequests.at(-1).headers.get('x-deepseek-harness-session-id'), 'main-proof')
  record('main sessionId triggers checkpoint and provider identity', { flushCalls: [...flushCalls], intercepted: intercepted.at(-1) })

  globalThis.fetch = async (url, init) => {
    runtimeRequests.push({ url: String(url), init, headers: new Headers(init.headers), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ error: { message: 'proof transient', type: 'server_error' } }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
  retryPlugin.apply(runtimeCtx)
  const directBefore = runtimeRequests.length
  const directCall = await runtime.prepareCall({ provider: 'deepseek-official', model: DS_MODEL, maxTokens: 64 })
  const directChunks = await collect(directCall.stream({ ...directCall.config, messages: [user('BTW')], purpose: 'btw', signal: new AbortController().signal }))
  assert.equal(runtimeRequests.length - directBefore, 1)
  assert.equal(directChunks.find((chunk) => chunk.type === 'finish')?.reason.failure.code, 'SERVER')
  record('dsh-llm-retry does not retry direct side stream', { networkCalls: 1, configuredMaxRetries: directCall.retryPolicy.maxRetries })

  const retryBefore = runtimeRequests.length
  const retryOutcomes = []
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const call = await runtime.prepareCall({ provider: 'deepseek-official', model: DS_MODEL, maxTokens: 64 })
    const retryChunks = await collect(call.stream({ ...call.config, messages: [user('BTW')], purpose: 'btw', signal: new AbortController().signal }))
    const reason = retryChunks.find((chunk) => chunk.type === 'finish')?.reason
    retryOutcomes.push(reason)
    const eligible = call.retryPolicy.mode === 'normal' && call.retryPolicy.retryableCodes.includes(reason?.failure?.code)
    if (reason?.kind !== 'error' || !eligible || attempt === maxAttempts) break
  }
  assert.equal(retryOutcomes.length, maxAttempts, JSON.stringify(retryOutcomes))
  assert.equal(runtimeRequests.length - retryBefore, maxAttempts)
  assert.ok(retryOutcomes.every((reason) => reason.kind === 'error' && reason.failure.code === 'SERVER'))
  record('explicit bounded retry needs fresh prepareCall per attempt', { maxAttempts, retries: maxAttempts - 1, outcomes: retryOutcomes })

  globalThis.fetch = async (_url, init) => {
    runtimeRequests.push({ init, signal: init.signal })
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason)
      else init.signal.addEventListener('abort', () => reject(new DOMException('proof abort', 'AbortError')), { once: true })
    })
  }
  const mainTimeout = new AbortController()
  const sideTimeout = new AbortController()
  const total = deadline(sideTimeout.signal, 20, 'BTW_SIDE_DEADLINE')
  try {
    mainTimeout.abort('main cancelled')
    const call = await runtime.prepareCall({ provider: 'deepseek-official', model: DS_MODEL, maxTokens: 64 }, total.signal)
    const timeoutChunks = await collect(call.stream({ ...call.config, messages: [user('BTW')], purpose: 'btw', signal: total.signal }))
    const reason = timeoutChunks.find((chunk) => chunk.type === 'finish')?.reason
    assert.equal(reason?.kind, 'aborted')
    assert.equal(total.signal.aborted, true)
    assert.equal(sideTimeout.signal.aborted, false)
    assert.equal(runtimeRequests.at(-1).signal.aborted, true)
    record('independent overall deadline aborts side fetch only', { reason, sideCallerAborted: sideTimeout.signal.aborted, deadlineAborted: total.signal.aborted, fetchAborted: runtimeRequests.at(-1).signal.aborted })
  } finally {
    total[Symbol.dispose]()
  }
} finally {
  globalThis.fetch = originalFetch
}

let logProvider
const logGets = []
const logAppends = []
const canonicalEvent = { seq: 0, time: '2026-01-01T00:00:00.000Z', type: 'user/message', data: {}, surfaceOp: 'append' }
const logSession = {
  id: 'main-proof', seq: 1, inheritedEventCount: 0,
  header: { version: 1, id: 'main-proof', createdAt: '2026-01-01T00:00:00.000Z' },
  eventAt: (index) => index === 0 ? canonicalEvent : undefined,
  snapshotEvents: () => [canonicalEvent],
  append: (type, data) => { logAppends.push({ type, data }) },
}
const logCtx = new Context().extend({
  deepseekLlmApiExtensions: { register: (name, provider) => { assert.equal(name, 'dsh_session_log'); logProvider = provider } },
  sessions: { get: (id) => { logGets.push(id); return id === 'main-proof' ? logSession : undefined } },
})
sessionLog.apply(logCtx, { enabled: { get: () => true }, maxBytes: 65536 })
assert.ok(logProvider)
const anonymousLog = logProvider.prepare({ body: {}, signal: new AbortController().signal })
assert.equal(anonymousLog, undefined)
assert.deepEqual(logGets, [])
const identifiedLog = logProvider.prepare({ body: {}, sessionId: 'main-proof', purpose: 'btw', signal: new AbortController().signal })
assert.equal(identifiedLog.value.events.length, 1)
await identifiedLog.accept()
assert.equal(logAppends[0]?.type, 'session-log-deepseek/delivery-accepted')
record('session-log omission versus main identity', { anonymousContribution: anonymousLog ?? null, identifiedValue: identifiedLog.value, appended: logAppends })

console.log(JSON.stringify({ proof: 'side-llm', results }, null, 2))
console.error(`PASS ${results.length} checks on ${manifest.version}`)
