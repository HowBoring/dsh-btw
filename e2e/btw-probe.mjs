const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Resolve dsh-llm from the installed Host. Set DSH_LLM_ENTRY to its file URL
// (for example file:///.../node_modules/@deepseek-ai/dsh-llm/lib/index.js).
const LLM = process.env.DSH_LLM_ENTRY

export const name = 'btw-probe'
export const inject = ['btw', 'agents', 'llm']

export function apply(ctx) {
  let started = false
  let streamStarted = false
  let textChunks = 0
  ctx.on('llm/stream', (options, next) => {
    streamStarted = true
    console.log('PROBE-LLM', JSON.stringify({
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId,
      purpose: options.purpose,
      tools: Array.isArray(options.tools) ? options.tools.length : options.tools,
    }))
    return next()
  })
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') textChunks += 1
  })

  const timer = setInterval(() => {
    if (started) return
    started = true
    clearInterval(timer)
    void run()
  }, 500)

  async function waitFor(predicate, tries = 400, gap = 50) {
    for (let index = 0; index < tries; index += 1) {
      if (predicate()) return true
      await sleep(gap)
    }
    return predicate()
  }

  async function readTopic(sessionId, topicId) {
    return (await ctx.btw.get({ sessionId, topicId })).topic
  }

  async function run() {
    try {
      const llm = LLM === undefined ? await import('@deepseek-ai/dsh-llm') : await import(LLM)
      const { createUserMessage } = llm
      const sessionId = `session-${crypto.randomUUID()}`
      const handle = await ctx.agents.create({
        sessionId,
        agentOptions: { provider: 'kimi-coding', model: 'k3.1-pro' },
      })
      const agent = handle.agent
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Write a 200 word essay about the color blue. Plain text only, no tools.' }],
        source: { kind: 'user' },
      }))
      console.log('PROBE mainStatus', agent.status, JSON.stringify(agent.options))
      const streamed = await waitFor(() => streamStarted, 400, 50)
      console.log('PROBE mainStreamStarted', streamed)
      const chunks = await waitFor(() => textChunks >= 3, 400, 50)
      console.log('PROBE textChunksBeforeAsk', textChunks, chunks)

      const before = agent.session.deriveMessages().length
      const controller = new AbortController()
      const frames = []
      const stream = ctx.btw.watch({ sessionId }, controller.signal)
      const reader = (async () => { try { for await (const frame of stream) frames.push(frame) } catch {} })()
      await sleep(50)

      const startedAt = Date.now()
      const receipt = await ctx.btw.ask({
        sessionId,
        question: 'In one short sentence, what color is the essay about? Answer with exactly BTW-SIDE-OK.',
        requestId: 'probe-request-1',
      })
      console.log('PROBE receipt', JSON.stringify(receipt), 'ms', Date.now() - startedAt)

      let topic = null
      for (let index = 0; index < 600; index += 1) {
        topic = await readTopic(sessionId, receipt.topicId)
        if (topic && topic.turns.every((turn) => turn.status !== 'running')) break
        await sleep(100)
      }
      controller.abort()
      await reader
      const turn = topic?.turns.find((candidate) => candidate.turnId === receipt.turnId)
      const afterFirst = agent.session.deriveMessages().length
      const leaked = JSON.stringify(agent.session.deriveMessages()).includes('BTW-SIDE-OK')
      console.log('PROBE turn1', JSON.stringify({
        status: turn?.status,
        answer: turn?.answer,
        error: turn?.error,
        degraded: turn?.contextCut.degraded,
        eventSeq: turn?.contextCut.eventSeq,
        chunkIndex: turn?.contextCut.chunkIndex,
      }))
      console.log('PROBE frames1', JSON.stringify(frames.map((frame) => frame.type)))
      console.log('PROBE mainMessages1', JSON.stringify({ before, afterFirst, leaked }))

      if (!topic || turn?.status !== 'complete') {
        console.log('PROBE abort: first turn did not complete')
        await handle.dispose()
        return
      }

      await waitFor(() => agent.status !== 'running', 600, 100)
      const afterAdvance = agent.session.deriveMessages().length
      console.log('PROBE mainAdvance', JSON.stringify({ afterAdvance, status: agent.status }))

      const controller2 = new AbortController()
      const frames2 = []
      const stream2 = ctx.btw.watch({ sessionId, topicId: receipt.topicId }, controller2.signal)
      const reader2 = (async () => { try { for await (const frame of stream2) frames2.push(frame) } catch {} })()
      await sleep(50)
      const follow = await ctx.btw.ask({
        sessionId,
        topicId: receipt.topicId,
        question: 'And how many words did the essay have? One short sentence.',
        requestId: 'probe-request-2',
        expectedRevision: topic.revision,
      })
      console.log('PROBE followReceipt', JSON.stringify(follow))
      let topic2 = null
      for (let index = 0; index < 600; index += 1) {
        topic2 = await readTopic(sessionId, receipt.topicId)
        if (topic2 && topic2.turns.every((turn) => turn.status !== 'running')) break
        await sleep(100)
      }
      controller2.abort()
      await reader2
      const turn2 = topic2?.turns.find((candidate) => candidate.turnId === follow.turnId)
      console.log('PROBE turn2', JSON.stringify({
        status: turn2?.status,
        answer: turn2?.answer,
        error: turn2?.error,
        degraded: turn2?.contextCut.degraded,
        eventSeq: turn2?.contextCut.eventSeq,
        turns: topic2?.turns.length,
        revision: topic2?.revision,
      }))
      console.log('PROBE frames2', JSON.stringify(frames2.map((frame) => frame.type)))

      const dup = await ctx.btw.ask({
        sessionId,
        topicId: receipt.topicId,
        question: 'duplicate should be ignored',
        requestId: 'probe-request-2',
      })
      console.log('PROBE duplicate', JSON.stringify(dup), 'sameTurn', dup.turnId === follow.turnId)

      const finalMessages = JSON.stringify(agent.session.deriveMessages())
      console.log('PROBE finalLeak', finalMessages.includes('BTW-SIDE-OK') || finalMessages.includes('duplicate should be ignored'))
      await handle.dispose()
    } catch (error) {
      console.log('PROBE error', error?.stack ?? String(error))
    }
  }
}
