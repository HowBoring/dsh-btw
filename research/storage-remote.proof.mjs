import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cp, mkdtemp, readFile, readdir, rename, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = process.env.DSH_ROOT
assert(dshRoot, 'set DSH_ROOT to the installed @deepseek-ai/dsh directory')
const load = (path) => import(pathToFileURL(join(dshRoot, path)).href)
const { Context } = await load('node_modules/@deepseek-ai/cordis/lib/index.js')
const { default: Storage } = await load('node_modules/@deepseek-ai/dsh-storage/lib/index.js')
const json = await load('node_modules/@deepseek-ai/dsh-storage-json/lib/index.js')
const domainPlugin = await load('node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js')
const { defineDomain, domainTable } = domainPlugin
const require = createRequire(join(dshRoot, 'node_modules/@deepseek-ai/dsh-storage-domain/package.json'))
const { z } = require('zod')

const root = await mkdtemp(join(tmpdir(), 'btw-storage-rc5-'))
const ctx = new Context()
const changes = []
ctx.on('domain/changed', (change) => changes.push(change))
const storageFiber = await ctx.plugin(Storage)
const jsonFiber = await ctx.plugin(json, { root })
const domainFiber = await ctx.plugin(domainPlugin, { backend: 'json' })

const record = z.object({
  sessionId: z.string(),
  topicId: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['running', 'complete', 'cancelled', 'error', 'interrupted']),
  answer: z.string(),
})
const spec = defineDomain({
  name: 'btw_proof',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { topics: domainTable(record) },
})
const key = 'session-1_topic-1'
const otherKey = 'session-2_topic-1'
const initial = { sessionId: 'session-1', topicId: 'topic-1', revision: 1, status: 'running', answer: '' }
const other = { sessionId: 'session-2', topicId: 'topic-1', revision: 1, status: 'complete', answer: 'other' }
const topicPath = (name = key) => join(root, 'btw_proof', 'topics', `${name}.json`)
const results = {}
let domain
try {
  domain = await ctx.storageDomain.open(spec)
  const topics = domain.table('topics')
  await topics.put(key, initial)
  await topics.put(otherKey, other)
  assert.deepEqual(topics.get(key), initial)
  assert.equal(await readFile(topicPath(otherKey), 'utf8'), JSON.stringify({ version: 1, record: other }, null, 2) + '\n')
  results.perRecordPaths = (await readdir(join(root, 'btw_proof', 'topics'))).sort()

  const seen = []
  await Promise.all([
    topics.update(key, (current) => {
      seen.push(current.revision)
      return { ...current, revision: current.revision + 1, answer: 'a' }
    }),
    topics.update(key, (current) => {
      seen.push(current.revision)
      return { ...current, revision: current.revision + 1, answer: current.answer + 'b' }
    }),
  ])
  assert.deepEqual(seen, [1, 2])
  assert.equal(topics.get(key).revision, 3)
  assert.equal(topics.get(key).answer, 'ab')
  assert.equal(await readFile(topicPath(otherKey), 'utf8'), JSON.stringify({ version: 1, record: other }, null, 2) + '\n')
  results.serializedUpdate = { seen, finalRevision: 3, answer: 'ab', otherFileUnchanged: true }

  await assert.rejects(topics.put('session-1:topic-2', initial), /not path-safe/)
  assert.equal(topics.get('session-1:topic-2'), undefined)
  results.unsafeColonKey = 'rejected; no in-memory record'

  assert(changes.length >= 4)
  const last = changes.at(-1)
  assert.equal(last.operation, 'put')
  assert.equal(last.value.revision, 3)
  const durableAtEvent = JSON.parse(await readFile(topicPath(), 'utf8')).record
  assert.equal(durableAtEvent.revision, 3)
  results.changeEvent = { operation: last.operation, revision: last.value.revision, durableRevisionAtObservation: durableAtEvent.revision }

  await domain.close()
  domain = await ctx.storageDomain.open(spec)
  const reopened = domain.table('topics')
  assert.equal(reopened.get(key).answer, 'ab')
  assert.equal(reopened.get(otherKey).answer, 'other')
  assert.equal(ctx.sessions, undefined)
  assert.equal(ctx.agents, undefined)
  const coldList = [...reopened.entries()].filter(([, value]) => value.sessionId === 'session-1')
  assert.equal(coldList.length, 1)
  assert.equal(reopened.get(key).topicId, 'topic-1')
  results.coldReopenWithoutAgent = { entries: reopened.size, session1Topics: coldList.length, getRevision: reopened.get(key).revision }

  await assert.rejects(reopened.update(key, (current) => {
    if (current.revision !== 2) throw new Error(`stale-revision: expected 2, got ${current.revision}`)
    return { ...current, revision: 3 }
  }), /stale-revision: expected 2, got 3/)
  assert.equal(reopened.get(key).revision, 3)
  results.revisionPrecondition = 'checked at the queued update slot; stale write rejected'

  const savedPath = topicPath() + '.saved'
  await rename(topicPath(), savedPath)
  await mkdir(topicPath())
  await assert.rejects(reopened.update(key, (current) => ({ ...current, revision: 4, answer: 'not-durable' })))
  assert.equal(reopened.get(key).revision, 3)
  assert.equal(reopened.get(key).answer, 'ab')
  await rm(topicPath(), { recursive: true })
  await rename(savedPath, topicPath())
  results.prePublishFailure = { memoryRevision: 3, memoryAnswer: 'ab', diskAfterRestore: JSON.parse(await readFile(topicPath(), 'utf8')).record.revision }

  const raceKey = 'session-1_race'
  await reopened.put(raceKey, { ...initial, topicId: 'race', revision: 1 })
  const queued = []
  const stopListening = ctx.on('domain/changed', (change) => {
    if (change.table === 'topics' && change.key === raceKey && change.operation === 'put') queued.push(structuredClone(change.value))
  })
  // Subscription and the opening get are synchronous: no Domain write can interleave here.
  const opening = structuredClone(reopened.get(raceKey))
  await reopened.update(raceKey, (current) => ({ ...current, revision: 2 }))
  await reopened.update(raceKey, (current) => ({ ...current, revision: 3 }))
  stopListening()
  await reopened.update(raceKey, (current) => ({ ...current, revision: 4 }))
  const frames = [
    { generation: 1, value: { type: 'snapshot', topic: opening } },
    ...queued.map((topic) => ({ generation: 1, value: { type: 'delta', topic } })),
    // A reconnect must reread: revision 4 was deliberately not delivered live.
    { generation: 2, value: { type: 'snapshot', topic: structuredClone(reopened.get(raceKey)) } },
  ]
  const { RemoteSnapshotStream } = await load('node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js')
  let published
  let failed
  let replacements = 0
  const applied = []
  const physical = {
    restart() {},
    async dispose() {},
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield { ...frame, accept() {} }
    },
  }
  const snapshots = new RemoteSnapshotStream(physical, {
    name: 'btw-proof',
    isSnapshot: (frame) => frame.type === 'snapshot',
    replace(frame) { published = frame.topic; replacements += 1 },
    update(frame) {
      assert.equal(frame.topic.revision, published.revision + 1)
      published = frame.topic
      applied.push(frame.topic.revision)
    },
    failed(error) { failed = error },
  })
  snapshots.start()
  await snapshots.dispose()
  assert.equal(failed, undefined)
  assert.equal(published.revision, 4)
  assert.deepEqual(applied, [2, 3])
  assert.equal(replacements, 2)
  results.snapshotDeltaRace = { openingRevision: opening.revision, liveRevisions: applied, reconnectReplacements: replacements, finalRevision: published.revision }

  const closeWrite = reopened.put(otherKey, { ...other, revision: 2, answer: 'close-drained' })
  const closing = domain.close()
  await Promise.all([closeWrite, closing])
  await assert.rejects(reopened.put(key, { ...initial, revision: 9 }), /closed/)
  assert.throws(() => reopened.get(key), /closed/)
  domain = await ctx.storageDomain.open(spec)
  assert.equal(domain.table('topics').get(otherKey).answer, 'close-drained')
  results.close = { drainedAnswer: domain.table('topics').get(otherKey).answer, laterWrite: 'rejected: closed', laterRead: 'throws: closed' }

  await domain.close()
  const invalid = JSON.parse(await readFile(topicPath(), 'utf8'))
  invalid.record.revision = 'invalid'
  await writeFile(topicPath(), JSON.stringify(invalid))
  domain = await ctx.storageDomain.open(spec)
  assert.equal(domain.table('topics').get(key), undefined)
  const files = await readdir(join(root, 'btw_proof', 'topics'))
  assert(files.some((name) => name.startsWith(`${key}.json.bak.`)))
  results.invalidRecordRecovery = { loadedAsAbsent: true, backups: files.filter((name) => name.includes('.bak.')) }
  await domain.close()
  domain = undefined

  const strictSpec = defineDomain({
    name: 'btw_proof',
    version: 1,
    layout: 'per-record',
    tables: { topics: domainTable(record) },
  })
  await writeFile(topicPath(), JSON.stringify(invalid))
  await assert.rejects(ctx.storageDomain.open(strictSpec), (error) => error.code === 'invalid-record')
  results.strictInvalidRecord = 'schema-invalid record rejects open; no backup-and-skip'

  await writeFile(topicPath(), '{')
  domain = await ctx.storageDomain.open(strictSpec)
  assert.equal(domain.table('topics').get(key), undefined)
  assert.equal(domain.table('topics').get(otherKey).answer, 'close-drained')
  results.malformedJson = 'parsed as absent by per-record backend; strict Domain open still succeeds'
  await domain.close()
  domain = undefined

  const accessHost = await load('node_modules/@deepseek-ai/dsh-api-remote-access/lib/typert.host.js')
  const accessClient = await load('node_modules/@deepseek-ai/dsh-api-remote-access/lib/typert.remote-client.js')
  const follow = accessHost.TYPERT.invocations.find((item) => item.id.endsWith('#remoteAccess/follow'))
  assert.equal(follow.mode, 'stream')
  assert.deepEqual(follow.cancellation, { parameter: 'signal' })
  assert.equal(follow.result.spec.mode, 'strict')
  assert.equal(accessClient.default.spec.methods['remoteAccess/follow'].mode, 'stream')
  results.generatedRemote = {
    hostExport: Object.keys(accessHost),
    clientExport: 'default',
    followMode: follow.mode,
    cancellation: follow.cancellation,
    resultCodec: follow.result.spec.mode,
  }

  results.gateway = await proveGateway(load)
  if (process.env.DSH_SOURCE && process.env.CODEGEN_ROOT) {
    results.customCodegen = await proveCodegen(root, load)
  }

  console.log(JSON.stringify({ ok: true, dshRoot, root, results }, null, 2))
} finally {
  if (domain) await domain.close()
  await domainFiber.dispose()
  await jsonFiber.dispose()
  await storageFiber.dispose()
  await rm(root, { recursive: true, force: true })
}

async function proveGateway(load) {
  const { Context } = await load('node_modules/@deepseek-ai/cordis/lib/index.js')
  const { Peer } = await load('node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
  const { Remote, TypertRemoteService } = await load('node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js')
  const { default: TypertRegistry } = await load('node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js')
  const { default: RemoteAccessService } = await load('node_modules/@deepseek-ai/dsh-api-remote-access/lib/index.js')
  const { default: TypertGatewayService } = await load('node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js')
  const gatewayCtx = new Context()
  const state = { calls: [], admitted: 0, completed: 0, cancelled: 0, watchStarted: 0, watchClosed: 0 }
  const initializers = []

  class BtwFixture extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'btwProof')
      for (const initialize of initializers) initialize.call(this)
    }

    ask(request, signal) {
      void signal
      state.calls.push(`ask:${request.sessionId}`)
      state.admitted += 1
      state.work = Promise.withResolvers()
      void state.work.promise.then(() => { state.completed += 1 })
      return { topicId: request.topicId, status: 'running' }
    }

    list(request) {
      state.calls.push(`list:${request.sessionId}`)
      return [{ sessionId: request.sessionId, topicId: 'topic-1', revision: 1 }]
    }

    get(request) {
      state.calls.push(`get:${request.sessionId}`)
      return { sessionId: request.sessionId, topicId: request.topicId, revision: 1 }
    }

    async *watch(request, signal) {
      state.calls.push(`watch:${request.sessionId}`)
      state.watchStarted += 1
      try {
        yield { type: 'snapshot', sessionId: request.sessionId, topicId: request.topicId, revision: 1 }
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
      } finally {
        state.watchClosed += 1
      }
    }

    cancel(request) {
      state.calls.push(`cancel:${request.sessionId}`)
      state.cancelled += 1
      return { topicId: request.topicId, status: 'cancelled' }
    }
  }

  for (const [name, mode] of [['ask'], ['list'], ['get'], ['watch', 'stream'], ['cancel']]) {
    const options = { resources: { session: (request) => request.sessionId }, ...(mode ? { mode } : {}) }
    Remote(options)(BtwFixture.prototype[name], {
      kind: 'method', name, static: false, private: false,
      addInitializer(initializer) { initializers.push(initializer) },
    })
  }

  try {
    await gatewayCtx.plugin(TypertRegistry)
    await gatewayCtx.plugin(RemoteAccessService)
    await gatewayCtx.plugin(TypertGatewayService)
    gatewayCtx.typert.resources.register('session', { field: 'sessionId' })
    await gatewayCtx.plugin(BtwFixture)

    const actions = ['btwProof/ask', 'btwProof/list', 'btwProof/get', 'btwProof/watch', 'btwProof/cancel']
    const globalRole = { name: 'proof:global', resource: 'global', actions }
    const sessionRole = { name: 'proof:session', resource: 'session', actions }
    const grants = new Map([
      ['global', [{ role: globalRole, resource: { kind: 'global' } }]],
      ['a', []],
      ['b', [{ role: sessionRole, resource: { kind: 'session', id: 'session-2' } }]],
    ])
    gatewayCtx.remoteAccess.registerPolicy('guest', { bindings: (principal) => grants.get(principal.name) ?? [] })
    const peer = (name) => new Peer(gatewayCtx.root, { principal: { kind: 'guest', name } })
    const globalPeer = peer('global')
    const peerA = peer('a')
    const peerB = peer('b')
    const owner = new Peer(gatewayCtx.root, { principal: { kind: 'owner' } })
    const call = (target, method, sessionId, extra = {}) => gatewayCtx.typertGateway.invoke({
      peer: target, namespace: 'btwProof', method,
      args: { request: { sessionId, topicId: 'topic-1', ...extra } },
    })

    await assert.rejects(call(globalPeer, 'get', 'session-1'), /access denied/)
    assert.deepEqual(state.calls, [])
    grants.set('a', [{ role: sessionRole, resource: { kind: 'session', id: 'session-1' } }])
    gatewayCtx.remoteAccess.invalidate()
    assert.equal((await call(peerA, 'get', 'session-1')).revision, 1)
    await assert.rejects(call(peerA, 'get', 'session-2'), /access denied/)
    await assert.rejects(call(peerB, 'get', 'session-1'), /access denied/)
    assert.equal((await call(peerB, 'get', 'session-2')).sessionId, 'session-2')
    assert.equal((await call(owner, 'get', 'session-2')).sessionId, 'session-2')
    assert.deepEqual(state.calls, ['get:session-1', 'get:session-2', 'get:session-2'])
    assert.equal(gatewayCtx.sessions, undefined)
    assert.equal(gatewayCtx.agents, undefined)

    assert.equal((await call(peerA, 'list', 'session-1')).length, 1)
    assert.equal((await call(peerA, 'ask', 'session-1')).status, 'running')
    assert.equal(state.admitted, 1)
    assert.equal(state.completed, 0)

    const openWatch = async (target, sessionId) => {
      const stream = await gatewayCtx.typertGateway.stream({
        peer: target, namespace: 'btwProof', method: 'watch',
        args: { request: { sessionId, topicId: 'topic-1' } }, signal: new AbortController().signal,
      })
      return stream[Symbol.asyncIterator]()
    }
    const watchAbort = new AbortController()
    const stream = await gatewayCtx.typertGateway.stream({
      peer: peerA, namespace: 'btwProof', method: 'watch',
      args: { request: { sessionId: 'session-1', topicId: 'topic-1' } }, signal: watchAbort.signal,
    })
    const watcher = stream[Symbol.asyncIterator]()
    assert.equal((await watcher.next()).value.type, 'snapshot')
    const pending = watcher.next()
    watchAbort.abort(new Error('proof: reader disconnected'))
    await assert.rejects(pending, (error) => error.code === 'gateway/cancelled')
    await watcher.return?.()
    assert.equal(state.watchClosed, 1)
    assert.equal(state.completed, 0)
    await assert.rejects(openWatch(peerB, 'session-1'), /access denied/)
    assert.equal(state.watchStarted, 1)

    state.work.resolve()
    await state.work.promise
    assert.equal(state.completed, 1)
    assert.equal((await call(peerA, 'cancel', 'session-1')).status, 'cancelled')
    assert.equal(state.cancelled, 1)

    const secondWatcher = await openWatch(peerA, 'session-1')
    await secondWatcher.next()
    const disposedPending = secondWatcher.next()
    await peerA.dispose()
    await assert.rejects(disposedPending, (error) => error.code === 'gateway/cancelled')
    await secondWatcher.return?.()
    await assert.rejects(call(peerA, 'get', 'session-1'), /disposed/)

    grants.set('b', [])
    gatewayCtx.remoteAccess.invalidate()
    await assert.rejects(call(peerB, 'get', 'session-2'), /access denied/)

    return {
      globalGrantDoesNotImplySession: true,
      perPeerIsolation: 'A=session-1, B=session-2; cross-session and revoked calls denied',
      deniedCallsEnteredBusiness: 0,
      ownerBypass: true,
      agentServicesPresent: false,
      disconnect: { watchClosed: state.watchClosed >= 1, admittedWorkCompletedAfterDisconnect: state.completed === 1 },
      explicitCancelCalls: state.cancelled,
      peerDisposal: 'stream ended; later calls rejected as disposed',
      cacheInvalidation: 'revocation enforced after remoteAccess.invalidate()',
    }
  } finally {
    await gatewayCtx.fiber.dispose()
  }
}

async function proveCodegen(root, load) {
  const codegenRoot = process.env.CODEGEN_ROOT
  const { WorkspaceTypertGenerator, writePackageArtifacts } = await import(pathToFileURL(join(
    codegenRoot, 'node_modules/@deepseek-ai/dsh-typert-generator/lib/index.js',
  )).href)
  const fixture = join(root, 'codegen')
  await cp(join(process.env.DSH_SOURCE, 'packages/typert/generator/tests/fixtures/remote-model'), fixture, { recursive: true })
  await writeFile(join(fixture, 'packages/remote/src/index.ts'), `import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { BtwAskRequest, BtwCancelResult, BtwFrame, BtwReceipt, BtwSessionSelector, BtwTopicSelector, BtwTopic } from './types.ts'

export class BtwService extends TypertRemoteService {
  constructor() { super(undefined, 'btw') }

  @Remote({ resources: { session: (request: BtwAskRequest) => request.sessionId } })
  async ask(request: BtwAskRequest, signal: AbortSignal): Promise<BtwReceipt> { throw new Error('fixture') }

  @Remote({ resources: { session: (request: BtwSessionSelector) => request.sessionId } })
  async list(request: BtwSessionSelector): Promise<readonly BtwTopic[]> { throw new Error('fixture') }

  @Remote({ resources: { session: (request: BtwTopicSelector) => request.sessionId } })
  async get(request: BtwTopicSelector): Promise<BtwTopic | null> { throw new Error('fixture') }

  @Remote({ mode: 'stream', resources: { session: (request: BtwTopicSelector) => request.sessionId } })
  async *watch(request: BtwTopicSelector, signal: AbortSignal): AsyncIterable<BtwFrame> { throw new Error('fixture') }

  @Remote({ resources: { session: (request: BtwTopicSelector) => request.sessionId } })
  async cancel(request: BtwTopicSelector): Promise<BtwCancelResult> { throw new Error('fixture') }
}

export type { BtwAskRequest, BtwCancelResult, BtwFrame, BtwReceipt, BtwSessionSelector, BtwTopicSelector, BtwTopic } from './types.ts'
`)
  await writeFile(join(fixture, 'packages/remote/src/types.ts'), `export interface BtwSessionSelector {
  readonly sessionId: string
}
export interface BtwTopicSelector extends BtwSessionSelector {
  readonly topicId: string
}
export interface BtwAskRequest extends BtwTopicSelector {
  readonly requestId: string
  readonly question: string
}
export interface BtwTopic {
  readonly sessionId: string
  readonly topicId: string
  readonly revision: number
  readonly status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'
  readonly answer: string
}
export interface BtwReceipt {
  readonly topicId: string
  readonly revision: number
  readonly status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'
  readonly idempotent: boolean
}
export interface BtwCancelResult {
  readonly topicId: string
  readonly status: 'cancelled'
}
export type BtwFrame =
  | { readonly type: 'snapshot'; readonly topic: BtwTopic }
  | { readonly type: 'delta'; readonly topic: BtwTopic }
`)
  const [artifact] = new WorkspaceTypertGenerator(fixture).generate(['@fixture/remote'], ['host'])
  assert(artifact?.remote)
  const packageRoot = join(fixture, 'packages/remote')
  writePackageArtifacts(packageRoot, [artifact])
  const files = (await readdir(join(packageRoot, 'lib'))).sort()
  assert.deepEqual(files, [
    'typert.host.d.ts', 'typert.host.js', 'typert.remote-client.d.ts',
    'typert.remote-client.d.ts.map', 'typert.remote-client.js',
  ])
  const zodUrl = pathToFileURL(require.resolve('zod')).href
  const remoteInfoUrl = pathToFileURL(join(
    process.env.DSH_ROOT, 'node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.js',
  )).href
  const source = (await readFile(join(packageRoot, 'lib/typert.remote-client.js'), 'utf8'))
    .replace(/from (['"])zod\1/g, `from ${JSON.stringify(zodUrl)}`)
    .replace(/from (['"])@deepseek-ai\/dsh-typert-protocol\/remote-info\1/g, `from ${JSON.stringify(remoteInfoUrl)}`)
  const generated = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default
  const methods = Object.fromEntries(['ask', 'list', 'get', 'watch', 'cancel'].map((name) => {
    const descriptor = generated.methods[`btw/${name}`]
    assert(descriptor)
    return [name, {
      mode: descriptor.mode ?? 'unary',
      cancellation: descriptor.cancellation,
      resultCodec: descriptor.result.spec?.mode ?? descriptor.result.mode,
      wires: descriptor.parameters.map((parameter) => parameter.wire),
    }]
  }))
  assert.equal(methods.watch.mode, 'stream')
  assert.deepEqual(methods.watch.cancellation, { parameter: 'signal' })
  assert.equal(methods.get.resultCodec, 'strict')
  const get = generated.methods['btw/get']
  assert.equal(get.result.create().safeParse(null).success, true)
  assert.equal(get.result.create().safeParse({}).success, false)
  assert(artifact.remote.dts.includes('RemoteStreamHandle'))
  assert(artifact.remote.dtsMap.includes('src/index.ts'))

  return {
    files,
    methods,
    strictGetRejectsMalformedRecord: true,
    clientDeclarationHasStreamHandle: true,
    declarationMapTargetsHostSource: true,
  }
}
