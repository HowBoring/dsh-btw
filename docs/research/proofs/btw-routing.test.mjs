import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const dshRoot = process.env.DSH_ROOT ?? resolve(dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh')
const machinePath = process.env.BTW_MACHINE_PATH ?? resolve(
  dshRoot,
  'node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/input/machine.ts',
)
const { SubmitMachine } = await import(pathToFileURL(machinePath))

// Evaluate the installed browser modules without rendering UI. UI primitives and
// the tiny snapshot-store adapter are stubbed; the registry, controller, command
// runtime, and Cordis base class are the real rc.5 implementations.
function createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set: (next) => { value = next; for (const listener of listeners) listener() },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
}
function loadClientModule(name) {
  const root = resolve(dshRoot, 'node_modules/@deepseek-ai', name)
  const require = createRequire(resolve(root, 'package.json'))
  let definition
  const window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  vm.runInNewContext(readFileSync(resolve(root, 'lib/client.js'), 'utf8'), { window, console })
  assert.equal(definition.id, `@deepseek-ai/${name}`)
  return definition.factory((id) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { rankByName: (rows) => rows }
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    if (id === 'react') return { Fragment: 'fragment' }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    return require(id)
  })
}

const { InputTriggerController, InputTriggerService } = loadClientModule('dsh-client-ui-input-trigger')
const { CommandUiRuntime } = loadClientModule('dsh-client-ui-commands')
const inputTriggers = Object.create(InputTriggerService.prototype)
inputTriggers.live = { sources: [], controllers: { values: [] } }
const consumed = []
const actx = {
  sessionId: 'session-A',
  bail: (_self, event, payload) => {
    if (event === 'slash/input-consume-token') consumed.push(payload.guard)
    return true
  },
}
const commandUi = Object.create(CommandUiRuntime.prototype)
commandUi.live = { contributions: new Map(), decorations: new Map(), popups: { values: [] } }
commandUi.t = (key) => key
commandUi.directory = { ensureReady: async () => {}, resolve: () => undefined }
commandUi.ctx = { effect: (setup) => setup() }
commandUi.scopeFor = () => actx

const opened = []
commandUi.register({
  name: 'btw',
  available: () => true,
  ui: { kind: 'action', run: ({ sessionId }) => opened.push(sessionId) },
})
inputTriggers.registerSource({
  trigger: '/',
  name: 'command',
  matchEnter: (session, line, signal, envelope) => commandUi.matchEnter(session, line, signal, envelope),
  matchClaim: (session, token, signal) => commandUi.matchClaim(session, token, signal),
})

const asks = []
const claim = {
  name: 'btw',
  token: '/btw ',
  submit: async (args, scope, attachments) => {
    asks.push({ args, sessionId: scope.sessionId, attachments })
    return { kind: 'success' }
  },
}
const btwSource = {
  trigger: '/',
  name: 'btw',
  matchEnter: async (_session, line, _signal, envelope) => {
    if (!/^\/btw\s+\S/u.test(line)) return undefined
    if (envelope.attachments > 0) throw new Error('/btw does not accept attachments')
    return { claim }
  },
  matchClaim: async (_session, token) => token === '/btw' ? claim : undefined,
}
inputTriggers.registerSource(btwSource)
const controller = new InputTriggerController({
  actx,
  sessionId: 'session-A',
  roster: {
    sources: (trigger) => inputTriggers.live.sources.filter((source) => source.trigger === trigger),
    all: () => inputTriggers.live.sources,
  },
})

const defaultSinks = []
async function route(draft, attachmentCount = 0) {
  const machine = new SubmitMachine()
  const entered = machine.dispatch({ type: 'enter', mode: 'queue', draft })
  assert.equal(entered[0]?.type, 'adjudicate')
  const attempt = entered[0].attempt
  let outcome
  try {
    outcome = await controller.adjudicate(draft.trim(), attempt.signal, { attachments: attachmentCount })
  } catch (error) {
    const failed = machine.dispatch({ type: 'adjudication-failed', attempt, message: error.message })
    assert.deepEqual(failed.map((effect) => effect.type), ['notice'])
    return failed
  }
  const effects = [...machine.dispatch({ type: 'adjudicated', attempt, outcome })]
  for (const effect of effects) {
    if (effect.type === 'default-sink') defaultSinks.push(effect.draft)
    if (effect.type === 'begin-submit') {
      const result = await effect.claim.submit(effect.args, actx, [])
      effects.push(...machine.dispatch({ type: 'submit-settled', attempt, ok: true, outcome: result }))
    }
  }
  return effects
}

assert.deepEqual(await route('/btw'), [])
assert.deepEqual(await route('/btw', 1), [])
assert.deepEqual(opened, ['session-A', 'session-A'])
assert.equal(consumed.length, 2)
assert.equal(consumed[0].kind, 'bare-token')
assert.equal(consumed[0].token, '/btw')
assert.deepEqual((await route('/btw why is this failing?')).map((effect) => effect.type), ['begin-submit', 'commit-draft'])
assert.deepEqual(asks, [{ args: 'why is this failing?', sessionId: 'session-A', attachments: [] }])
assert.deepEqual((await route('/btwow not BTW')).map((effect) => effect.type), ['default-sink', 'commit-draft'])
await route('/btw retain my draft', 1)
assert.equal(asks.length, 1)
assert.deepEqual(defaultSinks, ['/btwow not BTW'])

const beforeRestore = { opened: opened.length, asks: asks.length }
assert.equal(await controller.resolveClaim('/btw', new AbortController().signal), claim)
assert.equal(await controller.resolveClaim('/btwow', new AbortController().signal), undefined)
assert.deepEqual({ opened: opened.length, asks: asks.length }, beforeRestore)
assert.throws(() => inputTriggers.registerSource(btwSource), /already registered/)
assert.throws(() => commandUi.register({ name: 'btw', available: () => true, ui: { kind: 'action', run() {} } }), /duplicate contribution/)
commandUi.directory.ensureReady = async () => [{ name: 'btw', description: 'host collision' }]
await assert.rejects(
  commandUi.candidates({ sessionId: 'session-A' }, { query: '', position: 'leading', signal: new AbortController().signal }),
  /collides with a host command/,
)

const decorated = []
const hostDescriptor = { name: 'host', description: 'host command', input: { hint: 'question' } }
commandUi.directory.ensureReady = async () => [{ name: 'btw', description: 'host collision' }, hostDescriptor]
commandUi.directory.resolve = (_sessionId, name) => name === 'host' ? hostDescriptor : undefined
commandUi.decorate({
  name: 'host',
  available: () => true,
  ui: { kind: 'action', run: ({ sessionId }) => decorated.push(sessionId) },
})
const session = { sessionId: 'session-A' }
const signal = new AbortController().signal
assert.equal(await commandUi.matchEnter(session, '/host', signal, { attachments: 0 }), 'handled')
const hostOutcome = await commandUi.matchEnter(session, '/host still host-owned', signal, { attachments: 0 })
assert.equal(hostOutcome.claim.name, 'host')
assert.deepEqual(decorated, ['session-A'])

const stale = new SubmitMachine()
const entered = stale.dispatch({ type: 'enter', mode: 'queue', draft: '/btw late' })
const attempt = entered[0].attempt
stale.dispatch({ type: 'release' })
assert.deepEqual(stale.dispatch({ type: 'adjudicated', attempt, outcome: { claim } }), [])
assert.equal(attempt.signal.aborted, true)
controller.dispose()
console.log('PASS: real rc.5 registry/controller/command runtime + SubmitMachine; bare and argued /btw bypass default sink')
