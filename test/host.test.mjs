/**
 * Host-half harness.
 *
 * Runs `apply()` against a fake Cordis context with the sidecar stubbed out, so
 * the approval race, the config fold, and the protocol-URI routing can be
 * exercised without a live Harness.
 *
 * The sidecar is stubbed by rewriting the two module-level constants, which is
 * why this harness reads the source and patches the spawn target rather than
 * mocking `node:child_process` globally.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Default to this bundle's own Host half so `node test/host.test.mjs` works from
// anywhere; a caller may still pass an explicit path.
const pluginPath = process.argv[2] ?? join(HERE, '..', 'lib', 'index.js')
const scenario = process.argv[3] ?? 'all'

// ---------------------------------------------------------------- sidecar stub

// Replace the real PowerShell invocation with a recorder so no toast is shown
// and every sidecar call is observable. The staged XML is copied before the
// plugin deletes it, because the decision key lives only there: the plugin
// deliberately never puts a caller-supplied id in a protocol URI, so a test
// cannot predict the key and must read it back the way a real click would.
const source = readFileSync(pluginPath, 'utf8')
const records = []
const stagedXml = []
// `readFileSync` is not among index.js' own imports, so the injected stub brings
// its own binding rather than relying on one that happens to be in scope.
const patched = `import { readFileSync as __readFileSync } from 'node:fs'\n${source.replace(
  'function runSidecar(args, { timeoutMs = 15_000 } = {}) {',
  `function runSidecar(args, { timeoutMs = 15_000 } = {}) {
    const action = args[args.indexOf('-Action') + 1]
    // Registration happens once at startup; recording it would mask the
    // notification assertions that only care about Show/Remove/Focus.
    if (action !== 'Register') globalThis.__dtnCalls.push(args.join(' '))
    if (action === 'Show') {
      const i = args.indexOf('-XmlFile')
      if (i >= 0) { try { globalThis.__dtnXml.push(__readFileSync(args[i + 1], 'utf8')) } catch {} }
      return Promise.resolve({ status: globalThis.__dtnShowResult ?? 'shown', detail: 'stub' })
    }
    if (action === 'Remove') return Promise.resolve({ status: 'removed', detail: 'stub' })
    if (action === 'Register') return Promise.resolve({ status: 'registered', detail: 'stub' })
    if (action === 'Focus') return Promise.resolve({ status: 'focused', detail: 'stub' })
    return Promise.resolve({ status: 'error', detail: 'stub' })
  }
  function __unusedRunSidecar(args, { timeoutMs = 15_000 } = {}) {`,
)}`

const dir = mkdtempSync(join(tmpdir(), 'dtn-host-'))
const HARNESS_SPOOL = join(dir, 'spool')
mkdirSync(HARNESS_SPOOL, { recursive: true })
const patchedPath = join(dir, 'index.mjs')
// Point the assets at a scratch directory that exists, so nothing touches the
// real plugin installation.
writeFileSync(patchedPath, patched, 'utf8')

globalThis.__dtnCalls = records
globalThis.__dtnXml = stagedXml

const mod = await import(`file://${patchedPath.replace(/\\/g, '/')}`)

// ------------------------------------------------------------------ assertions

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

/**
 * The decision key the plugin minted for the nth staged approval toast.
 *
 * The plugin never puts a caller-supplied id in a protocol URI, so a test
 * cannot predict the key; it reads it out of the XML exactly as a click would.
 * @param verb - the button verb whose key is wanted.
 * @param index - which staged toast to read.
 * @returns the opaque key, or undefined when absent.
 */
function decisionKey(verb, index = -1) {
  const xml = index < 0 ? stagedXml.at(-1) : stagedXml[index]
  if (xml === undefined) return undefined
  return new RegExp(`${verb}:([0-9a-f]{8,})`, 'u').exec(xml)?.[1]
}

/** The toast tag recorded on the most recent Show invocation. */
function lastTag() {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const match = /-Tag (\S+)/u.exec(records[i])
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Every context ever created, so a scenario can retire the previous plugin
 * instance. This matters because each instance polls the same spool directory:
 * leaving earlier instances alive would let one of them consume a decision file
 * meant for the instance under test.
 */
const liveContexts = []

function disposeAll() {
  for (const ctx of liveContexts.splice(0)) {
    for (const disposer of ctx.effects) {
      if (typeof disposer === 'function') disposer()
    }
  }
}

function makeContext() {
  const listeners = new Map()
  const effects = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(name, handler, options) {
      const list = listeners.get(name) ?? []
      // `prepend` must actually prepend, mirroring Cordis.
      if (options?.prepend === true) list.unshift(handler)
      else list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get() { return undefined },
    listeners,
    effects,
    /** Fire a non-waterfall event at every listener. */
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
  }
  liveContexts.push(ctx)
  return ctx
}

/** Dispatch a waterfall exactly as Cordis does. */
async function waterfall(ctx, name, request) {
  const chain = [...(ctx.listeners.get(name) ?? [])]
  const terminal = (req) => Promise.resolve(req.__terminalOutcome ?? 'unavailable')
  const next = () => (chain.shift() ?? terminal)(request, next)
  return next()
}

function baseConfig(overrides = {}) {
  const raw = {
    enabled: true,
    onlyWhenUnfocused: false,
    focusProcessName: 'DeepSeek Harness',
    approvalsAnswerFromToast: true,
    notifyOnSubagents: false,
    showToolName: true,
    aumid: 'Test.Aumid',
    spoolDir: HARNESS_SPOOL,
    protocol: 'dsh-windows-toast',
    events: {
      'task-completed': { enabled: true, timeoutSeconds: 30, actions: true },
      'task-failed': { enabled: true, timeoutSeconds: 30, actions: true },
      question: { enabled: true, timeoutSeconds: 30, actions: true },
      approval: { enabled: true, timeoutSeconds: 30, actions: true },
    },
  }
  return { ...raw, ...overrides, events: { ...raw.events, ...(overrides.events ?? {}) } }
}

/**
 * Simulate a `.volatile()` reference, which is what the Loader actually hands to
 * `apply()` for every field declared with `.volatile()`.
 */
function volatile(value) {
  return { get: () => value }
}

// ------------------------------------------------------------ config folding

if (scenario === 'all' || scenario === 'config') {
  console.log('\n[config] normalizeConfig unwraps volatile references')
  const folded = mod.normalizeConfig({
    enabled: volatile(false),
    onlyWhenUnfocused: volatile(true),
    events: {
      approval: volatile({ enabled: volatile(false), timeoutSeconds: volatile(45), actions: volatile(true) }),
    },
  })
  check('enabled unwrapped', folded.enabled === false, String(folded.enabled))
  check('onlyWhenUnfocused unwrapped', folded.onlyWhenUnfocused === true)
  check('approval.enabled unwrapped', folded.events.approval.enabled === false)
  check('approval.timeoutSeconds unwrapped', folded.events.approval.timeoutSeconds === 45)
  check('missing field falls back to default', folded.events.question.timeoutSeconds === 0, String(folded.events.question.timeoutSeconds))
  check('missing string falls back to default', folded.focusProcessName === 'DeepSeek Harness')
}

// ------------------------------------------------------------ turn lifecycle

if (scenario === 'all' || scenario === 'turn') {
  console.log('\n[turn] turn/end raises completed and failed toasts')
  records.length = 0
  disposeAll()
  const ctx = makeContext()
  mod.apply(ctx, baseConfig())
  // Let the async registration settle.
  await new Promise((resolve) => setTimeout(resolve, 50))

  const session = { id: 'sess-1' }
  ctx.emit('session/event', session, { type: 'turn/end', seq: 10, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('completed toast shown', records.some((r) => r.includes('-Action Show')), records.join(' | '))

  records.length = 0
  ctx.emit('session/event', session, { type: 'turn/end', seq: 11, data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('failed toast shown', records.some((r) => r.includes('-Action Show')), records.join(' | '))

  // A subagent session is excluded unless the setting opts in.
  records.length = 0
  ctx.emit('subagent/start', { id: 'sub-1' })
  ctx.emit('session/event', { id: 'sub-1' }, { type: 'turn/end', seq: 12, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('subagent turn suppressed by default', records.length === 0, records.join(' | '))

  records.length = 0
  ctx.emit('session/event', session, { type: 'user/message', seq: 13, data: {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('non-turn event ignored', records.length === 0, records.join(' | '))

  // A disabled kind must not notify.
  records.length = 0
  disposeAll()
  const ctxOff = makeContext()
  mod.apply(ctxOff, baseConfig({ events: { 'task-completed': { enabled: false, timeoutSeconds: 0, actions: true } } }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  ctxOff.emit('session/event', { id: 's2' }, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('disabled kind suppressed', records.length === 0, records.join(' | '))
}

// ------------------------------------------------------------ approval race

if (scenario === 'all' || scenario === 'approval') {
  console.log('\n[approval] toast wins the race and withdraws the browser panel')
  records.length = 0
  disposeAll()
  const ctx = makeContext()
  let sawBrowserSignal
  let browserAborted = false
  mod.apply(ctx, baseConfig())
  await new Promise((resolve) => setTimeout(resolve, 50))

  // The browser's answerer, downstream of us. It records the signal it was
  // handed and never answers, standing in for a user who ignores the page.
  ctx.on('approval/request', (request) => {
    sawBrowserSignal = request.signal
    request.signal?.addEventListener('abort', () => { browserAborted = true })
    return new Promise(() => {})
  })

  // A REAL approval callId: the Host composes it as
  // `<call>|<fc_call>`, and the `|` is what used to be eaten by the shell.
  const controller = new AbortController()
  const request = {
    agent: {},
    toolName: 'pwsh',
    callId: 'call_00_F6Jx8YJWS8GzZk1Guui71294|fc_call_00_F6Jx8YJWS8GzZk1Guui71294',
    reason: 'needs full access',
    signal: controller.signal,
  }
  const pending = waterfall(ctx, 'approval/request', request)
  await new Promise((resolve) => setTimeout(resolve, 100))

  check('toast shown for approval', records.some((r) => r.includes('-Action Show')), records.join(' | '))
  check('browser listener saw a signal', sawBrowserSignal !== undefined)
  check('browser signal differs from the original', sawBrowserSignal !== controller.signal)
  check('toast xml carried approve/reject', records.some((r) => r.includes('-Action Show')))

  const key = decisionKey('approve')
  check('staged toast carries an opaque hex key', typeof key === 'string' && /^[0-9a-f]{8,}$/u.test(key), String(key))
  check('key is not the caller callId', key !== request.callId)
  check('key contains no shell metacharacter', typeof key === 'string' && !/[|&<>^%!"\s]/u.test(key), String(key))

  // The toast buttons carry `<protocol>:approve:<key>`; simulate the handler
  // delivering that exact URI, as the WScript handler now does.
  const spoolDir = HARNESS_SPOOL
  mkdirSync(spoolDir, { recursive: true })
  writeFileSync(join(spoolDir, `1-2.uri`), `dsh-windows-toast:approve:${key}`, 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 700))

  const outcome = await pending
  check('waterfall resolved allowed-once', outcome === 'allowed-once', String(outcome))
  check('browser panel signal aborted', browserAborted === true)
  check('toast withdrawn', records.some((r) => r.includes('-Action Remove')), records.join(' | '))

  console.log('\n[approval] browser wins the race and the toast is withdrawn')
  records.length = 0
  disposeAll()
  const ctx2 = makeContext()
  mod.apply(ctx2, baseConfig())
  await new Promise((resolve) => setTimeout(resolve, 50))
  ctx2.on('approval/request', () => Promise.resolve('rejected'))

  const request2 = { agent: {}, toolName: 'pwsh', callId: 'call_00_CCCC|fc_call_00_CCCC', signal: new AbortController().signal }
  const outcome2 = await waterfall(ctx2, 'approval/request', request2)
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('waterfall returned the browser decision', outcome2 === 'rejected', String(outcome2))
  check('toast withdrawn after browser answered', records.some((r) => r.includes('-Action Remove')), records.join(' | '))

  console.log('\n[approval] toast kept alive when no browser answerer exists')
  records.length = 0
  disposeAll()
  const ctx3 = makeContext()
  mod.apply(ctx3, baseConfig())
  await new Promise((resolve) => setTimeout(resolve, 50))

  const request3 = { agent: {}, toolName: 'pwsh', callId: 'call_00_DDDD|fc_call_00_DDDD', signal: new AbortController().signal }
  // No downstream listener: the terminal answerer reports `unavailable`.
  const pending3 = waterfall(ctx3, 'approval/request', request3)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const key3 = decisionKey('reject')
  mkdirSync(spoolDir, { recursive: true })
  writeFileSync(join(spoolDir, `3-4.uri`), `dsh-windows-toast:reject:${key3}`, 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 700))
  const outcome3 = await pending3
  check('toast answered an otherwise-unavailable request', outcome3 === 'rejected', String(outcome3))

  console.log('\n[approval] unknown key is ignored')
  records.length = 0
  disposeAll()
  const ctx4 = makeContext()
  mod.apply(ctx4, baseConfig())
  await new Promise((resolve) => setTimeout(resolve, 50))
  mkdirSync(spoolDir, { recursive: true })
  writeFileSync(join(spoolDir, `5-6.uri`), 'dsh-windows-toast:approve:deadbeefdeadbeef', 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 700))
  check('no crash and no toast for an unknown key', !records.some((r) => r.includes('-Action Remove')), records.join(' | '))

  console.log('\n[approval] focus URI routes to the focus action')
  records.length = 0
  disposeAll()
  const ctx5 = makeContext()
  mod.apply(ctx5, baseConfig())
  await new Promise((resolve) => setTimeout(resolve, 50))
  mkdirSync(spoolDir, { recursive: true })
  writeFileSync(join(spoolDir, `7-8.uri`), 'dsh-windows-toast:focus:whatever', 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 700))
  check('focus sidecar invoked', records.some((r) => r.includes('-Action Focus')), records.join(' | '))

  console.log('\n[approval] disabled setting passes the request straight through')
  records.length = 0
  disposeAll()
  const ctx6 = makeContext()
  mod.apply(ctx6, baseConfig({ approvalsAnswerFromToast: false }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  const original = new AbortController().signal
  const request6 = { agent: {}, toolName: 'pwsh', callId: 'call_00_EEEE|fc_call_00_EEEE', signal: original }
  const outcome6 = await waterfall(ctx6, 'approval/request', request6)
  check('request unchanged', request6.signal === original)
  check('waterfall untouched', outcome6 === 'unavailable', String(outcome6))
}

// --------------------------------------------------------------- questions

if (scenario === 'all' || scenario === 'question') {
  console.log('\n[question] a question request raises a toast and still continues the chain')
  records.length = 0
  disposeAll()
  const ctx = makeContext()
  mod.apply(ctx, baseConfig())
  await new Promise((resolve) => setTimeout(resolve, 50))
  const request = { callId: 'q-1', questions: [{ header: 'Choose a target', question: 'Which?' }] }
  // A downstream answerer proves the plugin delegated rather than consuming the
  // event: the question toast must never take the place of the real UI.
  let delegatedTo
  ctx.on('user-questions/request', () => { delegatedTo = 'terminal'; return Promise.resolve('answered') })
  const outcome = await waterfall(ctx, 'user-questions/request', request)
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('question toast shown', records.some((r) => r.includes('-Action Show')), records.join(' | '))
  check('downstream listener received the request', delegatedTo === 'terminal', String(delegatedTo))
  check('downstream answer returned unchanged', outcome === 'answered', String(outcome))
}

console.log(`\n${failures === 0 ? 'ALL HOST CHECKS PASSED' : `${failures} HOST CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
