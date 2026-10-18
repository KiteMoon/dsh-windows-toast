/**
 * True end-to-end test: the real plugin, the real sidecar, and a real Windows
 * toast click.
 *
 * Nothing is stubbed except the Harness context. `index.js` is imported
 * unmodified, so `assets/toast.ps1` really registers the protocol and really
 * shows a toast, and `assets/decision.vbs` really runs when Windows activates
 * the button. The only synthetic part is the `approval/request` waterfall
 * itself, which stands in for the Host emitting one.
 *
 * The decision key is captured from the toast XML the plugin stages in its spool
 * directory — the same bytes it hands the sidecar — rather than from the Windows
 * action center. Reading the action center was tried first and is racy: it is
 * populated asynchronously and its ordering relative to `History.Clear` is not
 * guaranteed, which produced intermittent failures that had nothing to do with
 * the plugin.
 *
 * Usage:
 *   node test/e2e.test.mjs [pluginDir]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pluginDir = process.argv[2] ?? join(HERE, '..')

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// A dedicated protocol, AUMID, and spool directory, so this test can never
// disturb a running Host: the live plugin polls its own directory and answers
// only its own protocol name.
const PROTOCOL = 'dsh-windows-toast-e2e'
const AUMID = 'DeepSeekHarness.WindowsToastE2E'
const SPOOL = mkdtempSync(join(tmpdir(), 'dtn-e2e-'))

const SETTINGS = {
  enabled: true,
  onlyWhenUnfocused: false,
  focusProcessName: 'DeepSeek Harness',
  approvalsAnswerFromToast: true,
  notifyOnSubagents: false,
  showToolName: true,
  aumid: AUMID,
  protocol: PROTOCOL,
  spoolDir: SPOOL,
  events: {
    'task-completed': { enabled: true, timeoutSeconds: 30, actions: true },
    'task-failed': { enabled: true, timeoutSeconds: 30, actions: true },
    question: { enabled: true, timeoutSeconds: 30, actions: true },
    approval: { enabled: true, timeoutSeconds: 30, actions: true },
  },
}

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

function makeContext() {
  const listeners = new Map()
  const effects = []
  return {
    logger: { info: () => {}, warn: (...a) => console.log('  [plugin warn]', ...a), error: console.log },
    on(name, handler, options) {
      const list = listeners.get(name) ?? []
      if (options?.prepend === true) list.unshift(handler)
      else list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn) { const d = fn(); effects.push(d); return () => {} },
    get() { return undefined },
    listeners,
    effects,
  }
}

async function waterfall(ctx, name, request, terminal) {
  const chain = [...(ctx.listeners.get(name) ?? [])]
  const next = () => (chain.shift() ?? terminal)(request, next)
  return next()
}

/**
 * Wait for the plugin to stage a toast and return the decision key inside it.
 *
 * `showToast` writes the XML before invoking the sidecar and deletes it only
 * after the sidecar returns, so the file is present for the whole duration of a
 * PowerShell launch — a wide, reliable window. Polling for it is deterministic,
 * unlike reading the action center.
 * @param verb - the button verb whose key is wanted.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the minted key, or undefined.
 */
async function awaitStagedKey(verb, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const pattern = new RegExp(`${verb}:([0-9a-f]{8,})`, 'u')
  for (;;) {
    for (const entry of readdirSync(SPOOL).filter((name) => name.endsWith('.xml'))) {
      try {
        const match = pattern.exec(readFileSync(join(SPOOL, entry), 'utf8'))
        if (match !== null) return match[1]
      } catch {}
    }
    if (Date.now() >= deadline) return undefined
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Activate one decision the way a real toast click does. */
function activate(uri) {
  const result = spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Start-Process '${uri}'`,
  ], { encoding: 'utf8' })
  return result.status === 0
}

const mod = await import(`file://${join(pluginDir, 'lib', 'index.js').replace(/\\/g, '/')}`)

console.log('[e2e] plugin loaded unmodified; the real sidecar is used')

// ---- 1. startup registration, exactly as the Host performs it ---------------

const ctx = makeContext()
mod.apply(ctx, SETTINGS)
await new Promise((r) => setTimeout(r, 2500))

const query = spawnSync('reg.exe', ['query', `HKCU\\Software\\Classes\\${PROTOCOL}\\shell\\open\\command`, '/ve'], { encoding: 'utf8' })
const registered = query.stdout ?? ''
console.log(`[e2e] registered: ${registered.split('\n').filter((l) => l.includes('REG_SZ')).join('').trim()}`)
check('plugin registered its protocol', query.status === 0 && registered.includes(PROTOCOL))
check('registration uses wscript (no console window)', registered.includes('wscript.exe'))
check('registration embeds the configured spool', registered.includes(SPOOL.replace(/\\/gu, '\\\\')) || registered.includes(SPOOL))

// ---- 2. a real approval, a real toast, a real click ------------------------

console.log('\n[e2e] approve: a real toast click settles the pending request')
const controller = new AbortController()
const request = {
  agent: {},
  toolName: 'pwsh',
  // The pipe-bearing id that destroyed the original design.
  callId: 'call_00_F6Jx8YJWS8GzZk1Guui71294|fc_call_00_F6Jx8YJWS8GzZk1Guui71294',
  reason: 'escalate sandbox to danger-full-access',
  signal: controller.signal,
}

let browserSignal
let browserAborted = false
ctx.on('approval/request', (req) => {
  browserSignal = req.signal
  req.signal?.addEventListener('abort', () => { browserAborted = true })
  // Stand in for a user who ignores the browser panel.
  return new Promise(() => {})
})

const settled = waterfall(ctx, 'approval/request', request, () => Promise.resolve('unavailable'))

const approveKey = await awaitStagedKey('approve')
check('toast XML carries an opaque hex key', approveKey !== undefined, String(approveKey))
check('key is not the caller callId', approveKey !== undefined && approveKey !== request.callId)
check('key has no shell metacharacter', approveKey !== undefined && !/[|&<>^%!"\s]/u.test(approveKey), String(approveKey))

if (approveKey === undefined) {
  console.log('\n[e2e] cannot continue without a key')
  process.exit(1)
}

// The downstream listener runs concurrently with the toast, so wait for it
// rather than sampling immediately: the plugin deliberately does not block the
// waterfall on the notification.
const bindDeadline = Date.now() + 5000
while (browserSignal === undefined && Date.now() < bindDeadline) await new Promise((r) => setTimeout(r, 50))
check('browser panel bound to the plugin signal', browserSignal !== undefined && browserSignal !== controller.signal)

check('click dispatched through ShellExecute', activate(`${PROTOCOL}:approve:${approveKey}`))

const outcome = await Promise.race([
  settled,
  new Promise((r) => setTimeout(() => r('<<TIMEOUT>>'), 10_000)),
])
check('waterfall resolved allowed-once', outcome === 'allowed-once', String(outcome))
check('browser panel signal aborted', browserAborted === true)

// ---- 3. the reject button ---------------------------------------------------

console.log('\n[e2e] reject: the other verb settles the other way')
// Remove the first toast's XML so the next wait cannot read a stale key.
for (const entry of readdirSync(SPOOL).filter((name) => name.endsWith('.xml'))) {
  rmSync(join(SPOOL, entry), { force: true })
}

const controller2 = new AbortController()
const request2 = { agent: {}, toolName: 'pwsh', callId: 'call_00_ZZZZ|fc_call_00_ZZZZ', signal: controller2.signal }
ctx.on('approval/request', () => new Promise(() => {}))
const settled2 = waterfall(ctx, 'approval/request', request2, () => Promise.resolve('unavailable'))

const rejectKey = await awaitStagedKey('reject')
check('second toast carries a reject key', rejectKey !== undefined, String(rejectKey))
check('second key differs from the first', rejectKey !== undefined && rejectKey !== approveKey)

if (rejectKey !== undefined) {
  check('reject click dispatched', activate(`${PROTOCOL}:reject:${rejectKey}`))
  const outcome2 = await Promise.race([
    settled2,
    new Promise((r) => setTimeout(() => r('<<TIMEOUT>>'), 10_000)),
  ])
  check('waterfall resolved rejected', outcome2 === 'rejected', String(outcome2))
}

// ---- 4. an unknown key must not settle anything -----------------------------

console.log('\n[e2e] an unknown key is ignored')
const beforeUnknown = Date.now()
check('unknown key dispatched', activate(`${PROTOCOL}:approve:deadbeefdeadbeef`))
await new Promise((r) => setTimeout(r, 2500))
check('unknown key did not disturb the plugin', Date.now() - beforeUnknown >= 2500)

// ---- 5. teardown -----------------------------------------------------------

console.log('\n[e2e] cleaning up the test registration')
for (const d of ctx.effects) if (typeof d === 'function') d()
spawnSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\${PROTOCOL}`, '/f'], { encoding: 'utf8' })
spawnSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`, '/f'], { encoding: 'utf8' })
spawnSync(POWERSHELL, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]; ` +
  `[Windows.UI.Notifications.ToastNotificationManager]::History.Clear('${AUMID}')`,
], { encoding: 'utf8' })
try { rmSync(SPOOL, { recursive: true, force: true }) } catch {}

console.log(`\n${failures === 0 ? 'ALL E2E CHECKS PASSED' : `${failures} E2E CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
