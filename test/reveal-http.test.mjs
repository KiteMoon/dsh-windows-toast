/**
 * The reveal route over a REAL Node HTTP server and a REAL `fetch`.
 *
 * `host.test.mjs` drives the handler with a stub response, which proves the
 * logic but not that the handler is compatible with Node's `ServerResponse` —
 * status codes, headers, and body all have to survive a genuine round trip. This
 * suite mounts the plugin's actual route on an actual server and fetches it the
 * way the browser half does.
 *
 * The plugin is imported unmodified except for the sidecar, which is stubbed so
 * no toast is shown; the staged XML is read back to recover the click URI.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pluginPath = process.argv[2] ?? join(HERE, '..', 'lib', 'index.js')

const spool = mkdtempSync(join(tmpdir(), 'dtn-http-spool-'))

/** Staged toast documents, captured before the plugin deletes them. */
const staged = []

// `readFileSync` is not among index.js' own imports, so the stub brings its own
// binding rather than relying on one that happens to be in scope.
const source = readFileSync(pluginPath, 'utf8')
const patched = `import { readFileSync as __readStaged } from 'node:fs'\n${source.replace(
  'function runSidecar(args, { timeoutMs = 15_000 } = {}) {',
  `function runSidecar(args, { timeoutMs = 15_000 } = {}) {
    const action = args[args.indexOf('-Action') + 1]
    if (action === 'Show') {
      const i = args.indexOf('-XmlFile')
      if (i >= 0) { try { globalThis.__dtnHttpXml.push(__readStaged(args[i + 1], 'utf8')) } catch {} }
      return Promise.resolve({ status: 'shown', detail: 'stub' })
    }
    return Promise.resolve({ status: 'ok', detail: 'stub' })
  }
  function __unused(args, { timeoutMs = 15_000 } = {}) {`,
)}`

const work = mkdtempSync(join(tmpdir(), 'dtn-http-'))
const stagedPath = join(work, 'index.mjs')
writeFileSync(stagedPath, patched, 'utf8')
globalThis.__dtnHttpXml = staged

const mod = await import(`file://${stagedPath.replace(/\\/g, '/')}`)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

// ------------------------------------------------------------ the real server

const routes = new Map()
const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname)
  if (route === undefined) {
    res.statusCode = 404
    res.end()
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const PATH = '/dsh-windows-toast/pending-navigation'

const effects = []
const listeners = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on(name, handler, options) {
    const list = listeners.get(name) ?? []
    if (options?.prepend === true) list.unshift(handler)
    else list.push(handler)
    listeners.set(name, list)
    return () => {}
  },
  effect(fn) { const d = fn(); effects.push(d); return () => {} },
  get: () => undefined,
  inject(names, callback) {
    const wanted = typeof names === 'string' ? [names] : names
    const available = {
      webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
      // The fence itself is exercised by host.test.mjs; here it only has to let
      // a loopback fetch through, which is what the real fence does.
      connection: { requestRejection: () => undefined },
    }
    if (wanted.some((name) => available[name] === undefined)) return () => {}
    const d = callback({ ...ctx, ...Object.fromEntries(wanted.map((name) => [name, available[name]])) })
    if (typeof d === 'function') effects.push(d)
    return () => {}
  },
}

mod.apply(ctx, {
  enabled: true,
  onlyWhenUnfocused: false,
  focusProcessName: 'DeepSeek Harness',
  approvalsAnswerFromToast: true,
  notifyOnSubagents: false,
  showToolName: true,
  aumid: 'Test.Aumid',
  protocol: 'dsh-windows-toast',
  spoolDir: spool,
  events: {
    'task-completed': { enabled: true, timeoutSeconds: 0, actions: true },
    'task-failed': { enabled: true, timeoutSeconds: 0, actions: true },
    question: { enabled: true, timeoutSeconds: 0, actions: true },
    approval: { enabled: true, timeoutSeconds: 0, actions: true },
  },
})
await new Promise((resolve) => setTimeout(resolve, 80))

console.log('[http] the reveal route answers a real request')
const empty = await fetch(`${base}${PATH}`)
check('route answers 200', empty.status === 200, String(empty.status))
check('content-type is JSON', (empty.headers.get('content-type') ?? '').includes('application/json'), String(empty.headers.get('content-type')))
check('response is not cached', empty.headers.get('cache-control') === 'no-store', String(empty.headers.get('cache-control')))
const emptyBody = await empty.json()
check('queue is empty before any click', Array.isArray(emptyBody.sessionIds) && emptyBody.sessionIds.length === 0, JSON.stringify(emptyBody))

console.log('\n[http] a toast click travels the route end to end')
listeners.get('session/event')[0](
  { id: 'sess-http', title: '真实验证' },
  { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } },
)
await new Promise((resolve) => setTimeout(resolve, 80))
const xml = staged.at(-1) ?? ''
check('toast raised with the session subject', xml.includes('真实验证'), xml || '(no toast staged)')

const key = /focus:([0-9a-f]{8,})/u.exec(xml)?.[1]
check('click URI carries an opaque key', typeof key === 'string' && /^[0-9a-f]{8,}$/u.test(key), String(key))

// Deliver the click exactly as the WScript handler does, then read the route the
// way the browser half does.
mkdirSync(spool, { recursive: true })
writeFileSync(join(spool, `${Date.now()}-1.uri`), `dsh-windows-toast:focus:${key}`, 'utf8')
await new Promise((resolve) => setTimeout(resolve, 700))

const clicked = await fetch(`${base}${PATH}`)
const clickedBody = await clicked.json()
check('the click published its session over HTTP', clickedBody.sessionIds.includes('sess-http') === true, JSON.stringify(clickedBody))

const again = await (await fetch(`${base}${PATH}`)).json()
check('a consumed request does not repeat', again.sessionIds.length === 0, JSON.stringify(again))

console.log('\n[http] an unregistered path is not served')
check('unknown path 404s', (await fetch(`${base}/dsh-windows-toast/nope`)).status === 404)

server.close()
for (const disposer of effects) if (typeof disposer === 'function') disposer()

console.log(`\n${failures === 0 ? 'ALL HTTP CHECKS PASSED' : `${failures} HTTP CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
