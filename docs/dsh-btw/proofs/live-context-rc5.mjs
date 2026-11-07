// Focused research proof for DSH 0.2.1-rc.5. No production implementation.
// Run: node docs/dsh-btw/proofs/live-context-rc5.mjs
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_RC5_ROOT
  ?? '/home/howboring/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh'
const load = (name) => import(pathToFileURL(join(
  root, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js',
)).href)

const [
  { Context },
  { default: AgentRegistry },
  { default: AgentLoop },
  {
    default: LlmRuntime, LlmAdapter, BlockAssembler, createUserMessage,
    isAgentLoopRequest,
  },
  { default: SessionStore, SessionId },
  { default: SessionProjectionRegistry },
  { default: SystemPrompt },
  { default: ToolRuntime },
] = await Promise.all([
  'cordis', 'dsh-agent', 'dsh-agent-loop', 'dsh-llm', 'dsh-session',
  'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools',
].map(load))

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

function snapshotCut(session, live, extra = {}) {
  return deepFreeze({
    sessionId: session.id,
    // Session.seq is the exclusive next-event offset, not the last event's seq.
    cutOffset: session.seq,
    surface: structuredClone(session.surface),
    history: structuredClone(session.deriveMessages()),
    ...live ? {
      attemptId: live.attemptId,
      attemptRevision: live.revision,
      chunkIndex: live.nextIndex - 1,
      liveContent: structuredClone(live.assembler.interruptedBlocks()),
    } : {},
    ...extra,
  })
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char) => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function failedTextResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: {
      kind: 'error', failure: { message: 'scripted retry', code: 'RATE_LIMIT' },
    } },
  ]
}

function toolCallResponse() {
  const args = '{"value":1}'
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'before' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'before' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'hold', argumentsDelta: args },
    { type: 'block-end', index: 1, block: {
      type: 'tool-call', id: 'call-1', name: 'hold', arguments: args,
    } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptAdapter extends LlmAdapter {
  requests = []
  constructor(script) {
    super()
    this.script = [...script]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    assert.notEqual(entry, undefined, 'script exhausted')
    if (typeof entry === 'function') yield* entry(options)
    else for (const chunk of entry) yield chunk
  }
}

async function harness(script) {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptAdapter(script)
    ctx.llm.registerAdapter(['proof'], adapter)
    return { ctx, adapter }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function createAgent(ctx, id) {
  return ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'proof', model: 'proof' },
  })
}

function followup(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }))
}

async function testAssembler() {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: 'safe' })
  assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  assembler.push({
    type: 'tool-call-delta', index: 1, id: 'open', name: 'hold', argumentsDelta: '{"x":',
  })
  assert.deepEqual(assembler.interruptedBlocks(), [{ type: 'text', text: 'safe' }])
  assert.deepEqual(assembler.finish, { kind: 'stop' })
  assert.equal(assembler.blocks().some((block) => block.type === 'tool-call'), true,
    'blocks() synthesizes the open call; interruptedBlocks() must be used for a safe prefix')
}

async function testRetryOrderingAndCompaction() {
  const { ctx, adapter } = await harness([failedTextResponse('bad'), textResponse('ok')])
  try {
    const { agent } = await createAgent(ctx, 'retry-compaction')
    const session = agent.session
    const trace = []
    const requests = []
    const attempts = []
    const cuts = []
    let current

    ctx.on('llm/stream', (options, next) => {
      if (options.sessionId !== session.id) return next()
      trace.push('llm/stream')
      assert.equal(isAgentLoopRequest(options), true)
      assert.equal(Object.isFrozen(options), true)
      assert.equal(Object.isFrozen(options.messages), true)
      assert.equal(isAgentLoopRequest(structuredClone({ ...options, signal: undefined })), false)
      assert.equal(options.provider, 'proof')
      assert.equal(options.model, 'proof')
      requests.push(options)
      return next()
    })
    ctx.on('agent/request-error', ({ agent: subject, failure }) => {
      if (subject !== agent) return
      trace.push(`request-error:${failure.code}`)
      return { kind: 'retry' }
    })
    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      trace.push(`session:${event.type}`)
      assert.equal(session.seq, event.seq + 1)
      assert.equal(session.deriveEventMessage(event) !== null,
        ['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type))
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        assert.ok(current, 'live Attempt exists at durable settlement')
        assert.equal(current.turn, event.data.turn)
        assert.equal(current.step, event.data.step)
        current = undefined // prevents double-appending content before the committed end frame
      }
      cuts.push(snapshotCut(session, current, { eventSeq: event.seq, eventType: event.type }))
    })
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent) return
      if (frame.type === 'start') {
        trace.push('stream:start')
        assert.equal(current, undefined)
        current = {
          ...frame, assembler: new BlockAssembler(), nextIndex: 0, revision: frame.revision,
        }
        attempts.push(current)
      } else if (frame.type === 'chunk') {
        trace.push(`stream:chunk:${frame.index}`)
        assert.equal(frame.attemptId, current.attemptId)
        assert.equal(frame.revision, current.revision + 1)
        assert.equal(frame.index, current.nextIndex)
        current.revision = frame.revision
        current.nextIndex++
        current.assembler.push(frame.chunk)
        cuts.push(snapshotCut(session, current))
      } else {
        trace.push(`stream:end:${frame.outcome.kind}`)
        assert.equal(frame.attemptId, current?.attemptId ?? attempts.at(-1).attemptId)
        assert.equal(frame.index, attempts.at(-1).nextIndex)
        if (frame.outcome.kind === 'committed') {
          assert.equal(current, undefined, 'session/event clears live prefix before committed end')
          assert.ok(trace.lastIndexOf(`session:${frame.outcome.eventType}`) >
            trace.lastIndexOf('stream:start'))
        }
        current = undefined
      }
    })

    followup(agent, 'go')
    await agent.whenIdle()

    assert.deepEqual(attempts.map((attempt) => attempt.attemptId), [
      `${session.id}:1`, `${session.id}:2`,
    ])
    assert.ok(attempts[1].revision > attempts[0].revision,
      'frame revision is Agent-lifecycle monotone across retries')
    const firstLlm = trace.indexOf('llm/stream')
    assert.deepEqual(trace.slice(firstLlm, firstLlm + 4), [
      'llm/stream', 'stream:start', 'stream:chunk:0', 'stream:chunk:1',
    ])
    const failedEnd = trace.indexOf('stream:end:committed')
    assert.ok(trace.indexOf('session:assistant/attempt') < failedEnd)
    assert.ok(trace.indexOf('request-error:RATE_LIMIT') > failedEnd)
    assert.ok(trace.indexOf('llm/stream', firstLlm + 1) > trace.indexOf('request-error:RATE_LIMIT'))
    assert.equal(adapter.requests.length, 2)
    assert.equal(requests[0].messages.at(-1).content[0].text, 'go')
    assert.deepEqual(requests[1].messages, requests[0].messages,
      'a failed Attempt does not alter the next main request history')
    assert.equal(JSON.stringify(session.deriveMessages()).includes('bad'), false,
      'failed Attempt content is not committed model history')
    assert.equal(session.deriveMessages().at(-1).content[0].text, 'ok')

    const liveCuts = cuts.filter((cut) => cut.liveContent?.length)
    assert.ok(liveCuts.length > 0)
    assert.ok(liveCuts.every((cut) => cut.history.every((message) =>
      !JSON.stringify(message).includes('bad') && !JSON.stringify(message).includes('ok'))))
    const held = JSON.stringify(cuts[0])
    assertDeepFrozen(cuts[0])

    const beforeCompaction = snapshotCut(session)
    const beforeCompactionHeld = JSON.stringify(beforeCompaction)
    const beforeGeneration = session.surface.contentGeneration
    const nodes = [...session.surface.nodes]
    const compactedNodes = nodes.slice(1) // node 0 is the protected system-prompt head
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }], source: { kind: 'user' },
    }), {
      surfaceOp: {
        op: 'replace', startSeq: compactedNodes[0], endSeq: compactedNodes.at(-1),
      },
      sourceEventSeqs: compactedNodes,
    })
    assert.equal(session.seq, replacement.seq + 1)
    assert.ok(session.surface.contentGeneration > beforeGeneration)
    assert.deepEqual(session.deriveMessages().map((message) => message.role), ['system', 'user'])
    assert.equal(session.deriveMessages().at(-1).content[0].text, 'compacted')
    assert.equal(JSON.stringify(beforeCompaction), beforeCompactionHeld)
    assert.equal(JSON.stringify(cuts[0]), held)
    assertDeepFrozen(beforeCompaction)
    return {
      attempts: attempts.map((attempt) => attempt.attemptId),
      requestCount: requests.length,
      finalHistory: session.deriveMessages().map((message) => message.content[0].text),
      cutCount: cuts.length,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function testOpenToolCall() {
  const { ctx, adapter } = await harness([toolCallResponse(), textResponse('after')])
  const toolStarted = Promise.withResolvers()
  const releaseTool = Promise.withResolvers()
  try {
    ctx.tools.register({
      name: 'hold', description: 'Hold one scripted call',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        render: (_args, value) => [{ type: 'text', text: `held:${value.ok}` }],
      },
      execute: async () => {
        toolStarted.resolve()
        await releaseTool.promise
        return { ok: true }
      },
    })
    const { agent } = await createAgent(ctx, 'open-tool')
    followup(agent, 'call')
    await toolStarted.promise

    const session = agent.session
    const openCut = snapshotCut(session)
    const assistant = openCut.history.at(-1)
    assert.equal(assistant.role, 'assistant')
    assert.ok(assistant.content.some((block) => block.type === 'tool-call' && block.id === 'call-1'))
    assert.equal(openCut.history.some((message) => message.role === 'tool'), false)
    assert.equal(JSON.stringify(openCut.history).includes('held:true'), false)

    // A side call must not inherit an unmatched tool call. Keep only its safe text.
    const normalized = structuredClone(openCut.history)
    const tail = normalized.at(-1)
    tail.content = tail.content.filter((block) => block.type !== 'tool-call')
    assert.deepEqual(tail.content, [{ type: 'text', text: 'before' }])
    assert.equal(normalized.some((message) => message.role === 'tool'), false)

    const held = JSON.stringify(openCut)
    releaseTool.resolve()
    await agent.whenIdle()
    assert.equal(JSON.stringify(openCut), held)
    assertDeepFrozen(openCut)
    assert.equal(adapter.requests.length, 2)
    assert.ok(adapter.requests[1].messages.some((message) => message.role === 'tool'))
    assert.equal(session.deriveMessages().at(-1).content[0].text, 'after')
    return { openTail: assistant.content, finalRoles: session.deriveMessages().map((m) => m.role) }
  } finally {
    releaseTool.resolve()
    await ctx.fiber.dispose()
  }
}

async function testLateMountAndDisposal() {
  const firstChunk = Promise.withResolvers()
  const releaseSecond = Promise.withResolvers()
  const secondChunk = Promise.withResolvers()
  const hanging = async function* (options) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'a' }
    firstChunk.resolve()
    await releaseSecond.promise
    yield { type: 'text-delta', index: 0, text: 'b' }
    secondChunk.resolve()
    await new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(new Error('aborted'))
      else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  const { ctx } = await harness([hanging])
  let handle
  try {
    handle = await createAgent(ctx, 'late-dispose')
    const { agent } = handle
    const lateFrames = []
    const lateSessionEvents = []
    const lateRequests = []
    const disposal = []
    let lateAssembler
    let latePrefix
    followup(agent, 'go')
    await firstChunk.promise

    // Mount only after llm/stream, stream start, and chunk 0 have passed.
    ctx.on('llm/stream', (options, next) => { lateRequests.push(options); return next() })
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent) return
      lateFrames.push(frame)
      if (frame.type === 'chunk') {
        lateAssembler ??= new BlockAssembler()
        lateAssembler.push(frame.chunk)
      }
    })
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      lateSessionEvents.push(event.type)
      if (event.type === 'assistant/message') latePrefix = lateAssembler.interruptedBlocks()
    })
    ctx.on('agent/disposed', ({ agent: subject }) => {
      if (subject === agent) disposal.push('agent/disposed')
    })
    ctx.on('session/disposed', (session) => {
      if (session === agent.session) disposal.push('session/disposed')
    })

    releaseSecond.resolve()
    await secondChunk.promise
    await handle.dispose()
    handle = undefined

    assert.deepEqual(lateFrames.map((frame) => frame.type), ['chunk', 'end'])
    assert.equal(lateFrames[0].chunk.text, 'b')
    assert.equal(lateRequests.length, 0, 'llm/stream is not replayed for a late listener')
    assert.equal(lateSessionEvents.includes('user/message'), false)
    assert.deepEqual(latePrefix, [{ type: 'text', text: 'b' }])
    const interrupted = lateSessionEvents.includes('assistant/message')
    assert.equal(interrupted, true)
    assert.ok(lateSessionEvents.indexOf('assistant/message') >= 0)
    assert.equal(lateFrames.at(-1).outcome.kind, 'committed')
    assert.equal(lateFrames.at(-1).outcome.eventType, 'assistant/message')
    assert.deepEqual(disposal, ['agent/disposed', 'session/disposed'])
    assert.equal(ctx.agents.get(agent.id), undefined)
    assert.equal(ctx.sessions.get(agent.id), undefined)
    return {
      lateFrames: lateFrames.map((frame) => frame.type),
      lateSessionEvents, lateRequestCount: lateRequests.length, disposal,
      limitation: 'late live prefix is only b; full interrupted committed content is ab',
    }
  } finally {
    releaseSecond.resolve()
    await handle?.dispose()
    await ctx.fiber.dispose()
  }
}

const results = {}
await testAssembler()
results.assembler = 'interruptedBlocks drops open ToolCall; blocks does not'
results.retryCompaction = await testRetryOrderingAndCompaction()
results.openTool = await testOpenToolCall()
results.lateDisposal = await testLateMountAndDisposal()
console.log(JSON.stringify({ ok: true, results }, null, 2))
