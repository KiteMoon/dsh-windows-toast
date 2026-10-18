// Deep render of the client page: recursively invoke function components so the
// whole tree is exercised, since createElement only records the element.
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')

/** Every URL the plugin fetched, so the reveal poll is observable. */
const fetched = []
/** Focus listeners the plugin registered, so a click-triggered refresh is testable. */
const focusListeners = []
let captured
const sandbox = {
  window: {
    __ModuleLoader__: { load: (e) => { captured = e } },
    // The reveal poll also refreshes on focus; record the listener so the test can
    // fire it, which is what a toast click actually triggers.
    addEventListener: (type, fn) => { focusListeners.push({ type, fn }) },
    removeEventListener: () => {},
  },
  document: undefined,
  console, Symbol, Object, JSON, Number, String, Array, Math, Date, Error, Promise,
  setInterval, clearInterval, setTimeout, clearTimeout,
  // The reveal poll uses `fetch`. Record the call and answer with an empty queue,
  // which is what the Host returns when no toast has been clicked.
  fetch: (url) => {
    fetched.push(url)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionIds: [] }) })
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const exportsObj = captured.factory((spec) => { if (spec === 'react') return React; throw new Error('unexpected require ' + spec) })

let registered
const ctx = {
  locale: { bind: () => (k) => k, register: () => () => {} },
  effect: (fn) => { fn(); return () => {} },
  configForms: { whileServed: (ns, reg) => reg(new Set(ns)) },
  slots: { inject: (o, reg) => reg(), register: (opts, comp) => { registered = { opts, comp }; return () => {} } },
}
exportsObj.apply(ctx)

// Walk the tree, rendering every function component to a string-ish summary.
function walk(node, depth) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((c) => walk(c, depth))
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...node.props, children: node.children })
    return walk(rendered, depth + 1)
  }
  return node.children.flatMap((c) => walk(c, depth))
}

const value = {
  enabled: true, onlyWhenUnfocused: true, approvalsAnswerFromToast: true,
  notifyOnSubagents: false, showToolName: true, aumid: 'A', protocol: 'p', spoolDir: '',
  events: {
    'task-completed': { enabled: true, timeoutSeconds: 0, actions: true },
    'task-failed': { enabled: true, timeoutSeconds: 0, actions: true },
    question: { enabled: true, timeoutSeconds: 0, actions: true },
    approval: { enabled: true, timeoutSeconds: 0, actions: true },
  },
}
const Page = registered.comp

// --------------------------------------------------------------- assertions

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

const out = walk(Page({ t: (k) => k, view: 'page', form: { state: { status: 'ready', writable: true, revision: 3, value }, mutate: async () => true } }), 0)
const required = ['groupGeneral','enabled','groupBehaviour','onlyWhenUnfocused','approvalsAnswerFromToast','showToolName','notifyOnSubagents','groupEvents','kindTaskCompleted','kindTaskFailed','kindQuestion','kindApproval','eventTimeout','eventActions','save','reset']
const missing = required.filter((k) => !out.includes(k))
check('every expected label renders', missing.length === 0, missing.join(','))
check('summary view returns the description', Page({ t: (k) => k, view: 'summary', form: {} }) === 'description')

// Read-only deployment path.
const ro = walk(Page({ t: (k) => k, view: 'page', form: { state: { status: 'ready', writable: false, revision: 1, value }, mutate: async () => true } }), 0)
check('read-only deployment shows its note', ro.includes('readOnly'))
const un = walk(Page({ t: (k) => k, view: 'page', form: { state: { status: 'unavailable' } } }), 0)
check('unavailable deployment renders without a form', un.length > 0)

/**
 * The reveal poll runs from `apply`, so it must have started and asked the Host
 * for a pending navigation. Nothing else in this suite would notice if the poll
 * silently stopped being installed.
 */
async function checkRevealPoll() {
  console.log('\n[reveal] the client poll asks the Host for pending navigations')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('poll fetched the reveal route', fetched.includes('/dsh-windows-toast/pending-navigation'), JSON.stringify(fetched))

  // A click raises the window, so focus arrives with the request already waiting.
  // Firing the listener proves the reveal does not have to wait out the interval.
  const focus = focusListeners.find((entry) => entry.type === 'focus')
  check('poll refreshes on window focus', focus !== undefined)
  const before = fetched.length
  focus?.fn()
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('focus triggers an immediate check', fetched.length > before, `${before} -> ${fetched.length}`)
}

checkRevealPoll().then(() => {
  console.log(`\n${failures === 0 ? 'ALL CLIENT CHECKS PASSED' : `${failures} CLIENT CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
})