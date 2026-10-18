// Deep render of the client page: recursively invoke function components so the
// whole tree is exercised, since createElement only records the element.
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
let captured
const sandbox = { window: { __ModuleLoader__: { load: (e) => { captured = e } } }, document: undefined, console, Symbol, Object, JSON, Number, String, Array, Math, Date, Error, Promise, setInterval, clearInterval, setTimeout, clearTimeout }
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

const out = walk(Page({ t: (k) => k, view: 'page', form: { state: { status: 'ready', writable: true, revision: 3, value }, mutate: async () => true } }), 0)
console.log('leaf count: ' + out.length)
console.log('leaves: ' + out.join(' | '))
const required = ['groupGeneral','enabled','groupBehaviour','onlyWhenUnfocused','approvalsAnswerFromToast','showToolName','notifyOnSubagents','groupEvents','kindTaskCompleted','kindTaskFailed','kindQuestion','kindApproval','eventTimeout','eventActions','save','reset']
let missing = required.filter((k) => !out.includes(k))
console.log(missing.length === 0 ? 'ALL EXPECTED LABELS RENDERED' : 'MISSING: ' + missing.join(','))

// Read-only deployment path.
const ro = walk(Page({ t: (k) => k, view: 'page', form: { state: { status: 'ready', writable: false, revision: 1, value }, mutate: async () => true } }), 0)
console.log('readOnly note rendered: ' + ro.includes('readOnly'))
const un = walk(Page({ t: (k) => k, view: 'page', form: { state: { status: 'unavailable' } } }), 0)
console.log('unavailable path: ' + un.join(','))