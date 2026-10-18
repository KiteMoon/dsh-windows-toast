/**
 * dsh-windows-toast — Host half.
 *
 * Raises Windows toast notifications for four DeepSeek Harness review events
 * and, for approval requests only, lets the toast's own buttons decide the
 * pending approval without the user returning to the browser.
 *
 * Each mechanism below was verified against the shipped Harness rather than
 * assumed:
 *
 * 1. `approval/request` is an Agent-scoped waterfall. The browser consumer
 *    reaches it through the Remote Event bridge, and
 *    `projectRemoteEventRequest` (dsh-api-gateway) reads `request.signal` at the
 *    moment that bridge listener runs. This plugin registers with
 *    `prepend: true` and *mutates* `request.signal` before continuing the
 *    chain, so the browser panel binds to a signal this plugin owns.
 *
 * 2. Cordis `waterfall()` builds its `next` closure over the original argument
 *    list, so calling `next(value)` with a replacement request is ignored — the
 *    mutation in (1) is the only way to change what downstream listeners see.
 *
 * 3. Aborting that owned signal is what withdraws the browser panel: the
 *    Gateway watches it, calls `cancelRemoteEvent`, and pushes a `cancel` frame
 *    that aborts the Client's delivery signal, which makes `PendingApproval`
 *    call `abort()` and retire the panel. Consequently both orderings — toast
 *    first and browser first — converge with one mechanism.
 *
 * 4. Windows launches the protocol handler from Explorer, which inherits no
 *    environment from this process, so the handler's registered command line
 *    carries the spool directory explicitly (see `assets/toast.ps1`).
 *
 * @module dsh-windows-toast
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-windows-toast'

/**
 * No required services.
 *
 * Every hook is an event listener, so the plugin works in any composition that
 * emits the events it cares about. Requiring `approval` up front would disable
 * the turn-completion notifications in a profile that composes no approval
 * service, and a listener for an event nobody emits is simply never called.
 */
export const inject = []

/**
 * Settings namespace. This must equal the profile entry `id` this bundle's
 * patch inserts: `dsh-settings` keys forms by Loader entry id, and the Web
 * panel looks the namespace up by that same string.
 */
const SETTINGS_NS = 'dsh-windows-toast'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', 'assets')
const TOAST_SCRIPT = join(ASSETS, 'toast.ps1')
const DECISION_HANDLER = join(ASSETS, 'decision.vbs')

/**
 * Prefix of the single machine-readable line the sidecar prints.
 *
 * Shared by the emitter and the parser so the two cannot drift; the sidecar
 * prints `<prefix><status>:<detail>` and this file is the only reader.
 */
const RESULT_PREFIX = 'dsh-windows-toast:'

/**
 * Route the browser half polls for the session a toast click asked to reveal.
 *
 * Namespaced under the plugin name so it cannot collide with a shipped route,
 * and under a prefix the desktop shell forwards to the Host unchanged.
 */
const NAVIGATION_PATH = '/dsh-windows-toast/pending-navigation'

/** The event kinds this plugin notifies on, in the order the settings panel lists them. */
export const NOTIFY_KINDS = ['task-completed', 'task-failed', 'question', 'approval']

/**
 * Resolve the Windows PowerShell carrying the WinRT projections. PowerShell 7
 * cannot load `Windows.UI.Notifications`, so the in-box 5.1 binary is located
 * rather than assumed to be on PATH.
 * @returns the absolute path to powershell.exe, or `undefined` when absent.
 */
function resolveWindowsPowerShell() {
  const candidates = [
    process.env.DSH_WINDOWS_TOAST_POWERSHELL,
    process.env.SystemRoot === undefined ? undefined : join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    process.env.WINDIR === undefined ? undefined : join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Load `@deepseek-ai/schemastery`.
 *
 * A profile-installed bundle usually resolves it through the patched runtime, but
 * a bare `import` can fail outside it, so this mirrors the defensive resolution
 * the shipped `dsh-claude-style` bundle uses. Returning `undefined` costs only
 * the editable settings panel; the plugin still runs on built-in defaults.
 * @returns the schemastery factory, or `undefined` when unresolvable.
 */
async function resolveSchemaFactory() {
  try {
    const module = await import('@deepseek-ai/schemastery')
    const factory = module?.default ?? module?.Schema
    if (typeof factory?.object === 'function') return factory
  } catch {}
  try {
    const { createRequire } = await import('node:module')
    const anchor = typeof process.argv[1] === 'string' && process.argv[1] !== '' ? process.argv[1] : process.execPath
    const factory = createRequire(anchor)('@deepseek-ai/schemastery')
    if (typeof factory?.object === 'function') return factory
  } catch {}
  return undefined
}

const SchemaFactory = await resolveSchemaFactory()

/**
 * Mark one field editable without a remount.
 * @param field - a schemastery field.
 * @returns the same field marked volatile, or the field unchanged.
 */
function volatileField(field) {
  return typeof field?.volatile === 'function' ? field.volatile() : field
}

/**
 * Per-event notification settings. Only `.volatile()` fields reach the settings
 * panel, so every user-tunable field is wrapped.
 * @param Schema - the resolved schemastery factory.
 * @returns the schema for one event kind's block.
 */
function kindSchema(Schema) {
  return Schema.object({
    enabled: volatileField(Schema.boolean().default(true)),
    timeoutSeconds: volatileField(Schema.number().step(1).min(0).max(86_400).default(0)),
    actions: volatileField(Schema.boolean().default(true)),
  })
}

/**
 * The row's `config`.
 *
 * `timeoutSeconds` is how long the toast remains on screen and in Action Center;
 * it bounds the notification only. It never cancels the underlying approval or
 * question, which keeps its own lifetime.
 */
export const Config = SchemaFactory === undefined ? undefined : SchemaFactory.object({
  enabled: volatileField(SchemaFactory.boolean().default(true)),
  onlyWhenUnfocused: volatileField(SchemaFactory.boolean().default(true)),
  focusProcessName: volatileField(SchemaFactory.string().default('DeepSeek Harness')),
  approvalsAnswerFromToast: volatileField(SchemaFactory.boolean().default(true)),
  notifyOnSubagents: volatileField(SchemaFactory.boolean().default(false)),
  showToolName: volatileField(SchemaFactory.boolean().default(true)),
  aumid: volatileField(SchemaFactory.string().default('DeepSeekHarness.WindowsToast')),
  protocol: volatileField(SchemaFactory.string().default('dsh-windows-toast')),
  spoolDir: volatileField(SchemaFactory.string().default('')),
  events: SchemaFactory.object({
    'task-completed': kindSchema(SchemaFactory),
    'task-failed': kindSchema(SchemaFactory),
    question: kindSchema(SchemaFactory),
    approval: kindSchema(SchemaFactory),
  }),
})

/** Built-in defaults, used when schemastery is unavailable or a field is absent. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  onlyWhenUnfocused: true,
  focusProcessName: 'DeepSeek Harness',
  approvalsAnswerFromToast: true,
  notifyOnSubagents: false,
  showToolName: true,
  aumid: 'DeepSeekHarness.WindowsToast',
  protocol: 'dsh-windows-toast',
  spoolDir: '',
  events: {
    'task-completed': { enabled: true, timeoutSeconds: 0, actions: true },
    'task-failed': { enabled: true, timeoutSeconds: 0, actions: true },
    question: { enabled: true, timeoutSeconds: 0, actions: true },
    approval: { enabled: true, timeoutSeconds: 0, actions: true },
  },
})

/**
 * Read one config value, transparently unwrapping a `.volatile()` reference.
 * @param source - a config object or a field inside one.
 * @returns the live value, or `undefined` when absent.
 */
function readValue(source) {
  if (source === null || source === undefined) return undefined
  if (typeof source.get === 'function') {
    try {
      return source.get()
    } catch {
      return undefined
    }
  }
  return source
}

/**
 * Fold a raw config object into a plain, fully-populated settings snapshot.
 * @param raw - the row's `config`, possibly holding volatile references.
 * @returns a plain object plus the namespaces the settings panel needs.
 */
export function normalizeConfig(raw) {
  const source = readValue(raw) ?? {}
  const events = readValue(source.events) ?? {}
  const normalized = {
    enabled: readValue(source.enabled) ?? DEFAULT_CONFIG.enabled,
    onlyWhenUnfocused: readValue(source.onlyWhenUnfocused) ?? DEFAULT_CONFIG.onlyWhenUnfocused,
    focusProcessName: readValue(source.focusProcessName) ?? DEFAULT_CONFIG.focusProcessName,
    approvalsAnswerFromToast: readValue(source.approvalsAnswerFromToast) ?? DEFAULT_CONFIG.approvalsAnswerFromToast,
    notifyOnSubagents: readValue(source.notifyOnSubagents) ?? DEFAULT_CONFIG.notifyOnSubagents,
    showToolName: readValue(source.showToolName) ?? DEFAULT_CONFIG.showToolName,
    aumid: readValue(source.aumid) ?? DEFAULT_CONFIG.aumid,
    protocol: readValue(source.protocol) ?? DEFAULT_CONFIG.protocol,
    spoolDir: readValue(source.spoolDir) ?? DEFAULT_CONFIG.spoolDir,
    events: {},
  }
  for (const kind of NOTIFY_KINDS) {
    const fallback = DEFAULT_CONFIG.events[kind]
    const block = readValue(events[kind]) ?? {}
    normalized.events[kind] = {
      enabled: readValue(block.enabled) ?? fallback.enabled,
      timeoutSeconds: readValue(block.timeoutSeconds) ?? fallback.timeoutSeconds,
      actions: readValue(block.actions) ?? fallback.actions,
    }
  }
  return normalized
}

/**
 * Escape one string for XML character data or an attribute value.
 * @param value - untrusted text.
 * @returns text safe to embed in the toast document.
 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
    // XML 1.0 cannot carry these even escaped; dropping them beats emitting a
    // document `LoadXml` would reject after the user has already been notified.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
}

/**
 * Collapse whitespace and clip to a displayable length.
 * @param value - untrusted text.
 * @param max - maximum characters to keep.
 * @returns the clipped text.
 */
function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Derive a stable, format-legal toast tag from an arbitrary key.
 *
 * Windows requires a non-empty tag of at most 64 characters, and it must be
 * stable so a later withdrawal targets the same toast. Hashing keeps the tag
 * legal regardless of what the event supplied.
 * @param key - the event's identity.
 * @returns a legal toast tag.
 */
function toastTag(key) {
  return createHash('sha1').update(String(key)).digest('hex').slice(0, 32)
}

/**
 * Run the sidecar and resolve with its single machine-readable result line.
 * @param args - arguments passed to `assets/toast.ps1`.
 * @param options - optional timeout override.
 * @returns the parsed `<prefix><status>:<detail>` result.
 */
function runSidecar(args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const powershell = resolveWindowsPowerShell()
    if (powershell === undefined) {
      resolve({ status: 'error', detail: 'windows-powershell-not-found' })
      return
    }
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ status: 'error', detail: 'sidecar-timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { finish({ status: 'error', detail: String(error?.message ?? error) }) })
    child.on('close', () => {
      const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(RESULT_PREFIX))
      if (line === undefined) {
        finish({ status: 'error', detail: clip(stderr, 200) || 'no-result' })
        return
      }
      // `<prefix>:<status>:<detail>` — the detail may itself contain colons, so
      // only the first two separators are structural.
      const [status, ...rest] = line.slice(RESULT_PREFIX.length).split(':')
      finish({ status, detail: rest.join(':') })
    })
  })
}

/**
 * Owns the spool directory the decision handler writes into.
 *
 * One file per activation rather than a shared append log: a partially written
 * append would be read as malformed and silently drop the user's click.
 */
class DecisionSpool {
  #directory
  #onDecision
  #logger
  #seen = new Set()
  #timer
  #disposed = false

  /**
   * @param directory - the spool directory to watch and drain.
   * @param onDecision - invoked once per activation with the raw protocol URI.
   * @param logger - Host logger for contained failures.
   */
  constructor(directory, onDecision, logger) {
    this.#directory = directory
    this.#onDecision = onDecision
    this.#logger = logger
  }

  get directory() {
    return this.#directory
  }

  /**
   * Begin polling. Polling a directory is deliberate: it needs no watcher
   * dependency, and the interval bounds click-to-effect latency.
   * @param intervalMs - polling interval.
   */
  start(intervalMs = 400) {
    this.#timer = setInterval(() => { void this.drain() }, intervalMs)
    // A pending timer must never hold the Host process open on shutdown.
    this.#timer.unref?.()
    void this.drain()
  }

  /** Read and remove every pending decision file exactly once. */
  async drain() {
    if (this.#disposed) return
    let entries
    try {
      entries = await readdir(this.#directory)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.uri')) continue
      const path = join(this.#directory, entry)
      if (this.#seen.has(path)) continue
      this.#seen.add(path)
      try {
        const raw = await readFile(path, 'utf8')
        await rm(path, { force: true })
        this.#seen.delete(path)
        const uri = raw.trim()
        if (uri !== '') this.#onDecision(uri)
      } catch (error) {
        this.#logger?.warn?.(`dsh-windows-toast: could not read decision file ${entry}: ${String(error)}`)
      }
    }
  }

  /** Stop polling. Files already written are left for the next run. */
  dispose() {
    this.#disposed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
  }
}

/**
 * Install toast notifications for review events.
 * @param ctx - the Host plugin context.
 * @param rawConfig - the row's validated config.
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? console
  if (process.platform !== 'win32') {
    logger.info?.('dsh-windows-toast: Windows-only plugin, inactive on this platform')
    return
  }
  if (resolveWindowsPowerShell() === undefined) {
    logger.warn?.('dsh-windows-toast: Windows PowerShell 5.1 not found; toast notifications are unavailable')
    return
  }

  let settings = normalizeConfig(rawConfig)
  // The spool directory is the rendezvous between this process and the protocol
  // handler Windows launches. It is keyed by BOTH the installation path and the
  // protocol name, which is what makes it a private channel:
  //
  //   * the install path separates two checkouts or profiles, and
  //   * the protocol separates two instances that share a checkout.
  //
  // Without the protocol in the key, a second instance (a test, a second profile
  // launched from the same directory) polls the first instance's decisions and
  // consumes them as unknown, silently dropping the user's click. That is not
  // hypothetical: it is exactly how this was found.
  const spoolDir = settings.spoolDir !== ''
    ? settings.spoolDir
    : join(tmpdir(), `dsh-windows-toast-${createHash('sha1').update(`${HERE}\u0000${settings.protocol}`).digest('hex').slice(0, 12)}`)

  /** Live toasts by tag, so a decision made elsewhere can withdraw the right one. */
  const liveToasts = new Set()
  /** Approvals awaiting a toast decision: request key -> settle callback. */
  const pendingApprovals = new Map()
  /** Session ids owned by subagents, for the `notifyOnSubagents` filter. */
  const subagentSessions = new Set()

  /**
   * Recent tool calls by call id, so an approval can say what it is asking about.
   *
   * An `approval/request` carries no tool arguments — only the tool name, a
   * reason, and the call id. The arguments live on the `tool/call` event, which
   * the agent loop appends before it runs the tool, so by the time an approval
   * is raised the matching event has already been published and recorded here.
   *
   * Bounded, because a long-lived Host would otherwise retain every call it has
   * ever seen. Insertion order is iteration order, so the oldest is evicted.
   */
  const toolCalls = new Map()
  const TOOL_CALL_LIMIT = 200

  /**
   * Sessions a toast click asked the Web UI to open, oldest first.
   *
   * There is no deep link into a DSH session — selection is browser-local state
   * and the `dsh://` protocol only focuses the window — so the click records its
   * target here and the client half polls for it and calls
   * `uiWorkspace.openSession`. Entries expire so a click cannot yank the view
   * long after the fact.
   */
  const pendingNavigation = []
  const NAVIGATION_TTL_MS = 120_000
  const NAVIGATION_LIMIT = 8

  /**
   * Session behind each live notification key, so a click can reveal it.
   *
   * Kept Host-side rather than encoded in the protocol URI, for the same reason
   * the tool call id is: the URI reaches a registry value and a command line.
   */
  const toastTargets = new Map()
  const TOAST_TARGET_LIMIT = 200

  /**
   * Show one toast.
   * @param kind - the notify kind, selecting the settings block.
   * @param key - this event's identity, used as the withdrawal tag.
   * @param title - the toast heading.
   * @param body - the toast body line.
   * @param options - optional decision buttons and the session to reveal on click.
   * @returns whether the platform showed it.
   */
  async function showToast(kind, key, title, body, options = {}) {
    if (!settings.enabled) return false
    const block = settings.events[kind]
    if (block === undefined || block.enabled !== true) return false

    const tag = toastTag(key)
    // Remember which session this notification belongs to, so a click can reveal
    // it. The URI itself carries only the opaque `key`: keeping the session id
    // out of the registry value and the handler's command line is the same rule
    // that keeps the tool call id out of it.
    const sessionId = options.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') {
      toastTargets.delete(key)
      toastTargets.set(key, sessionId)
      while (toastTargets.size > TOAST_TARGET_LIMIT) {
        const oldest = toastTargets.keys().next()
        if (oldest.done === true) break
        toastTargets.delete(oldest.value)
      }
    }

    const actions = []
    // Only an approval is a real decision; every other kind gets one button that
    // merely returns the user to the session that produced it.
    if (block.actions === true && options.decision === true) {
      actions.push(`<action content="${xmlEscape('同意')}" arguments="${xmlEscape(`${settings.protocol}:approve:${key}`)}" activationType="protocol"/>`)
      actions.push(`<action content="${xmlEscape('拒绝')}" arguments="${xmlEscape(`${settings.protocol}:reject:${key}`)}" activationType="protocol"/>`)
    } else if (block.actions === true) {
      actions.push(`<action content="${xmlEscape('打开会话')}" arguments="${xmlEscape(`${settings.protocol}:focus:${key}`)}" activationType="protocol"/>`)
    }

    // Clicking the toast body also reveals the session. This matters most for an
    // approval, whose buttons are 同意/拒绝: without it there would be no way to
    // reach the conversation from the notification.
    const reveal = typeof sessionId === 'string' && sessionId !== ''
      ? ` activationType="protocol" launch="${xmlEscape(`${settings.protocol}:focus:${key}`)}"`
      : ' activationType="foreground"'

    // A ToastGeneric binding renders one `<text>` element per line, so a body
    // carrying newlines becomes several lines rather than one run-on string.
    // The first element is the heading; Windows styles the rest as body text.
    const bodyLines = String(body).split('\n').map((line) => line.trim()).filter((line) => line !== '')

    const xml = [
      `<toast${reveal}>`,
      '<visual><binding template="ToastGeneric">',
      `<text>${xmlEscape(title)}</text>`,
      ...bodyLines.map((line) => `<text>${xmlEscape(line)}</text>`),
      '</binding></visual>',
      actions.length > 0 ? `<actions>${actions.join('')}</actions>` : '',
      '</toast>',
    ].join('')

    const xmlPath = join(spoolDir, `${tag}.xml`)
    try {
      // Idempotent, and it removes any race with the startup effect: a toast
      // raised before that effect finished must still find its staging ground.
      await mkdir(spoolDir, { recursive: true })
      await writeFile(xmlPath, xml, 'utf8')
    } catch (error) {
      logger.warn?.(`dsh-windows-toast: could not stage toast xml: ${String(error)}`)
      return false
    }

    const args = ['-Action', 'Show', '-XmlFile', xmlPath, '-Tag', tag, '-Aumid', settings.aumid]
    if (block.timeoutSeconds > 0) args.push('-TtlSeconds', String(block.timeoutSeconds))
    if (settings.onlyWhenUnfocused) args.push('-OnlyWhenUnfocused', '-FocusProcessName', settings.focusProcessName)

    const result = await runSidecar(args)
    // The staged XML is consumed either way; the platform copies what it needs.
    void rm(xmlPath, { force: true }).catch(() => {})
    if (result.status === 'error') {
      logger.warn?.(`dsh-windows-toast: toast failed for ${kind}: ${result.detail}`)
      return false
    }
    if (result.status === 'shown') {
      liveToasts.add(tag)
      return true
    }
    return false
  }

  /**
   * Withdraw one toast so a decision made elsewhere leaves no stale button.
   * @param key - the event identity the toast was shown for.
   */
  async function withdrawToast(key) {
    const tag = toastTag(key)
    if (!liveToasts.delete(tag)) return
    await runSidecar(['-Action', 'Remove', '-Tag', tag, '-Aumid', settings.aumid], { timeoutMs: 8_000 })
  }

  /**
   * Summarize one `tool/call` event's arguments into a single toast line.
   *
   * Deliberately reads only the fields DSH's own tools use for presentation, so
   * the line says what the tool is about to do rather than dumping a JSON blob.
   * `arguments` is a JSON *string* on the event, and a malformed one costs the
   * summary, never the notification.
   * @param name - the tool name.
   * @param rawArguments - the event's argument field, as recorded.
   * @returns a short summary, or `undefined` when nothing useful can be said.
   */
  function describeToolCall(name, rawArguments) {
    let parsed = rawArguments
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        // Not JSON: fall back to the raw text, which is still more informative
        // than the tool name alone.
        return typeof rawArguments === 'string' && rawArguments.trim() !== '' ? clip(rawArguments, 160) : undefined
      }
    }
    if (parsed === null || typeof parsed !== 'object') return undefined

    // The first present of these wins: they are ordered by how directly each
    // one describes the action, not by tool.
    for (const field of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      const value = readValue(parsed[field])
      if (typeof value === 'string' && value.trim() !== '') {
        // `command` is the fallback when a tool sent no description, and a shell
        // command is often multi-line; the first line carries the intent.
        return clip(value.split(/\r?\n/u)[0].trim(), 160)
      }
    }
    const keys = Object.keys(parsed)
    return keys.length > 0 ? `参数：${clip(keys.join('、'), 120)}` : undefined
  }

  /**
   * Summarize a session's own subject for a notification line.
   *
   * Reads the folded title service rather than scanning the log: `snapshotEvents`
   * and `eventAt` are deprecated, and new production calls are prohibited. The
   * service is mounted by the base bundle (`session-title`), so it is present in
   * any ordinary composition; when it is not, the session's own fields are the
   * fallback and the toast simply omits the subject line.
   * @param session - the live session.
   * @returns a short subject, or `undefined`.
   */
  function sessionSubject(session) {
    return sessionTitle(session)
  }

  /**
   * Record a session a toast click asked to open, for the client half to collect.
   * @param sessionId - the session to reveal.
   */
  function requestNavigation(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const now = Date.now()
    // Drop expired entries first so the queue cannot grow while idle.
    while (pendingNavigation.length > 0 && now - pendingNavigation[0].at > NAVIGATION_TTL_MS) pendingNavigation.shift()
    // A repeated click on the same session should not queue twice.
    if (pendingNavigation.some((entry) => entry.sessionId === sessionId)) return
    pendingNavigation.push({ sessionId, at: now })
    if (pendingNavigation.length > NAVIGATION_LIMIT) pendingNavigation.shift()
  }

  /**
   * Take every unexpired navigation request, clearing the queue.
   *
   * Destructive by design: the client asks once per activation, and a consumed
   * request must not re-navigate the view on the next poll.
   * @returns the session ids to reveal, oldest first.
   */
  function takeNavigation() {
    const now = Date.now()
    const fresh = pendingNavigation.filter((entry) => now - entry.at <= NAVIGATION_TTL_MS)
    pendingNavigation.length = 0
    return fresh.map((entry) => entry.sessionId)
  }

  /**
   * Route one protocol activation from the decision handler.
   * @param uri - the raw URI Windows passed to the handler.
   */
  function handleDecision(uri) {
    try {
      // `<protocol>:<verb>:<key>`; the key is everything after the second colon.
      const first = uri.indexOf(':')
      if (first < 0) return
      const second = uri.indexOf(':', first + 1)
      if (second < 0) return
      const protocol = uri.slice(0, first)
      const verb = uri.slice(first + 1, second)
      const key = uri.slice(second + 1)
      if (protocol !== settings.protocol || key === '') return

      if (verb === 'focus') {
        // Raise the window first: the reveal is collected by a client that may
        // currently be behind other windows, and a hidden page makes no sense.
        void runSidecar(['-Action', 'Focus', '-FocusProcessName', settings.focusProcessName], { timeoutMs: 8_000 })
        requestNavigation(toastTargets.get(key))
        return
      }
      if (verb !== 'approve' && verb !== 'reject') return
      const settle = pendingApprovals.get(key)
      if (settle === undefined) return
      settle(verb === 'approve' ? 'allowed-once' : 'rejected')
    } catch (error) {
      logger.warn?.(`dsh-windows-toast: could not route activation: ${String(error)}`)
    }
  }

  const spool = new DecisionSpool(spoolDir, handleDecision, logger)

  // Registration and the spool are both prerequisites for a working button, so
  // their failure is reported once at startup rather than per notification.
  ctx.effect(() => {
    void (async () => {
      try {
        await mkdir(spoolDir, { recursive: true })
      } catch (error) {
        logger.warn?.(`dsh-windows-toast: could not create spool directory: ${String(error)}`)
        return
      }
      const result = await runSidecar([
        '-Action', 'Register',
        '-Aumid', settings.aumid,
        '-Protocol', settings.protocol,
        '-HandlerCmd', DECISION_HANDLER,
        '-SpoolDir', spoolDir,
      ])
      if (result.status !== 'registered') {
        logger.warn?.(`dsh-windows-toast: could not register toast activation: ${result.detail}`)
      }
    })()
    spool.start()
    return () => {
      spool.dispose()
      for (const settle of [...pendingApprovals.values()]) settle(undefined)
      pendingApprovals.clear()
    }
  }, 'dsh-windows-toast: decision spool and activation registration')

  // ------------------------------------------------------- session reveal route

  /**
   * Publish the click's navigation request to the browser half.
   *
   * DSH has no deep link into a session: selection is browser-local state, and
   * the `dsh://` protocol the desktop registers handles only `dsh://open`, which
   * merely focuses the window. The mechanism that does exist is the client
   * service `uiWorkspace.openSession(id)`, reachable only from browser code, so
   * the click is handed across on a route the client polls.
   *
   * Reading is destructive: a request must reveal the session once, not on every
   * poll. It is registered only when `webServer` is present, because a headless
   * composition without it has no browser to reveal anything to.
   */
  ctx.inject(['webServer', 'connection'], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: NAVIGATION_PATH,
      handler: (req, res) => {
        // The same fence the shipped open-in-app routes use. `connection` is
        // required by the inject above, so this route does not exist in a
        // composition that cannot vouch for a caller: a route revealing which
        // session the user is viewing must not answer anyone who asks.
        const rejection = serverCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        const body = JSON.stringify({ sessionIds: takeNavigation() })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      },
    }), 'dsh-windows-toast: GET session reveal route')
  })

  // ---------------------------------------------------------------- approvals

  ctx.on('approval/request', async (request, next) => {
    if (!settings.enabled || settings.events.approval.enabled !== true || !settings.approvalsAnswerFromToast) return next()
    if (request === null || typeof request !== 'object') return next()

    // The wire key carried in the protocol URI is ALWAYS a fresh opaque token,
    // never the tool call id. A real callId looks like
    // `call_00_ab…|fc_call_00_ab…`: it contains `|`, which the Windows shell
    // re-interprets as a pipe however the handler is written. Minting our own
    // hex token keeps the URI inert by construction, and also keeps
    // third-party identifiers out of a registry value and a temp file name.
    const key = randomUUID().replace(/-/gu, '')

    const controller = new AbortController()
    // Preserve the caller's cancellation: a turn abort must still reach the
    // browser panel and settle this request.
    const upstream = request.signal
    if (upstream !== undefined) {
      if (upstream.aborted) controller.abort(upstream.reason)
      else upstream.addEventListener('abort', () => controller.abort(upstream.reason), { once: true })
    }

    // Cordis builds `next` over the original argument list, so passing a
    // replacement object would be ignored. Mutating in place is what lets the
    // Remote bridge downstream bind the browser panel to the signal this plugin
    // owns — and aborting that signal is what withdraws the panel.
    request.signal = controller.signal

    let settled = false
    let carryDecision
    const decision = new Promise((resolve) => { carryDecision = resolve })
    pendingApprovals.set(key, (outcome) => {
      if (settled) return
      settled = true
      pendingApprovals.delete(key)
      carryDecision(outcome)
    })

    const toolName = clip(readValue(request.toolName) ?? 'unknown', 80)
    const reason = readValue(request.displayReason) ?? readValue(request.reason)

    // `agent.id` is the session id (the agent loop is constructed with
    // `options.sessionId`), so the request itself names the session to reveal.
    const agent = readValue(request.agent)
    const sessionId = readValue(agent?.id) ?? readValue(agent?.session?.id)
    const subject = typeof agent === 'object' && agent !== null ? sessionSubject(agent.session) : undefined

    // What the tool is asking to do, recovered from the matching `tool/call`
    // event, because an approval request carries no arguments of its own.
    const callId = readValue(request.callId)
    const call = typeof callId === 'string' ? toolCalls.get(callId) : undefined

    const lines = []
    if (subject !== undefined) lines.push(`会话：${subject}`)
    lines.push(`工具：${toolName}${call?.summary === undefined ? '' : ` — ${call.summary}`}`)
    if (settings.showToolName && typeof reason === 'string' && reason.trim() !== '') lines.push(clip(reason, 160))
    if (call?.summary === undefined && lines.length === 2) lines.push('请求越权执行')

    const shown = await showToast('approval', key, 'DSH 请求授权', lines.join('\n'), { decision: true, sessionId })
    if (!shown) {
      // No toast to race. Hand the request on untouched — the mutation above is
      // already in place, but no listener will ever settle it, so restore the
      // caller's original signal and behave as if this listener were absent.
      pendingApprovals.delete(key)
      request.signal = upstream
      return next()
    }

    // Continue the chain concurrently so the browser panel appears as usual.
    // Its settlement is captured rather than raced directly, because a losing
    // rejection would otherwise surface as an unhandled rejection.
    const downstream = Promise.resolve().then(() => next()).then(
      (outcome) => ({ kind: 'outcome', outcome }),
      (error) => ({ kind: 'error', error }),
    )
    const fromToast = decision.then((outcome) => ({ kind: 'toast', outcome }))

    const finish = (outcome) => {
      pendingApprovals.delete(key)
      void withdrawToast(key)
      // Retire the browser panel: the Gateway watches this signal and pushes the
      // `cancel` frame that makes the Client's PendingApproval abort.
      controller.abort(new Error('dsh-windows-toast: approval settled'))
      return outcome
    }

    const first = await Promise.race([downstream, fromToast])

    if (first.kind === 'toast') {
      if (first.outcome === undefined) {
        // Disposed while the toast was showing: fall back to the browser answer.
        const fallback = await downstream
        if (fallback.kind === 'error') throw fallback.error
        return finish(fallback.outcome)
      }
      return finish(first.outcome)
    }
    if (first.kind === 'error') {
      pendingApprovals.delete(key)
      void withdrawToast(key)
      throw first.error
    }
    if (first.outcome !== 'unavailable') return finish(first.outcome)

    // No answering browser client. The toast is already on screen, so let it be
    // the decision source instead of failing closed — but only within a bounded
    // window, so a toast the user ignores can never hang the turn forever.
    const timeoutSeconds = settings.events.approval.timeoutSeconds
    const deadlineSeconds = timeoutSeconds > 0 ? timeoutSeconds : 600
    const late = await Promise.race([
      fromToast,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'expired' }), deadlineSeconds * 1000)
        timer.unref?.()
      }),
    ])
    if (late.kind === 'toast' && late.outcome !== undefined) return finish(late.outcome)
    return finish('unavailable')
  }, { prepend: true })

  // -------------------------------------------------- turn completion / failure

  ctx.on('subagent/start', (info) => {
    const id = info?.id
    if (typeof id === 'string' && id !== '') subagentSessions.add(id)
  })
  ctx.on('subagent/end', (info) => {
    const id = info?.id
    if (typeof id === 'string' && id !== '') subagentSessions.add(id)
  })
  ctx.on('session/disposed', (session) => {
    const id = session?.id
    if (typeof id === 'string' && id !== '') subagentSessions.delete(id)
  })

  /**
   * A session's display title, from the folded title service when present.
   * @param session - the live session.
   * @returns the title, or `undefined` when none is set.
   */
  function sessionTitle(session) {
    try {
      const service = ctx.get('sessionTitle')
      const snapshot = typeof service?.get === 'function' ? service.get(session) : undefined
      const title = readValue(snapshot?.title)
      if (typeof title === 'string' && title.trim() !== '') return clip(title, 60)
    } catch {}
    const direct = session?.title ?? session?.name
    return typeof direct === 'string' && direct.trim() !== '' ? clip(direct, 60) : undefined
  }

  ctx.on('session/event', (session, event) => {
    if (!settings.enabled) return

    // Record tool calls for approval toasts. An `approval/request` carries no
    // tool arguments, so this is the only place they can be observed — and the
    // agent loop appends `tool/call` before running the tool, so the record is
    // always present by the time the approval races the toast.
    if (event?.type === 'tool/call') {
      const callId = readValue(event.data?.callId)
      if (typeof callId !== 'string' || callId === '') return
      const name = clip(readValue(event.data?.name) ?? 'unknown', 80)
      const summary = describeToolCall(name, readValue(event.data?.arguments))
      toolCalls.delete(callId)
      toolCalls.set(callId, { name, summary })
      while (toolCalls.size > TOOL_CALL_LIMIT) {
        const oldest = toolCalls.keys().next()
        if (oldest.done === true) break
        toolCalls.delete(oldest.value)
      }
      return
    }

    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (!settings.notifyOnSubagents && subagentSessions.has(sessionId)) return

    const reason = readValue(event.data?.reason) ?? {}
    const kind = String(readValue(reason.kind) ?? '')
    const title = sessionSubject(session) ?? 'DSH 会话'
    // Opaque, like every other kind. An earlier version used
    // `${sessionId}:${event.seq}`, which put a real session identifier into a
    // protocol URI that reaches a registry value and a handler command line —
    // exactly what the opaque-key rule exists to prevent. The session is kept
    // Host-side in `toastTargets` instead, and each toast still needs its own
    // tag so a later withdrawal is unambiguous.
    const key = randomUUID().replace(/-/gu, '')

    if (kind === 'completed') {
      void showToast('task-completed', key, 'DSH 任务完成', `${title} 已完成本轮工作`, { sessionId })
      return
    }
    if (kind === 'error' || kind === 'aborted' || kind === 'interrupted') {
      const failure = readValue(reason.error) ?? {}
      const detail = clip(readValue(failure.message) ?? readValue(reason.reason) ?? kind, 160)
      void showToast('task-failed', key, 'DSH 任务失败', `${title}：${detail}`, { sessionId })
    }
  })

  // --------------------------------------------------------------- questions

  ctx.on('user-questions/request', (request, next) => {
    if (settings.enabled && settings.events.question.enabled === true) {
      const questions = Array.isArray(request?.questions) ? request.questions : []
      const first = readValue(questions[0]) ?? {}
      // Same rule as approvals: the key becomes a protocol URI and a toast tag,
      // so it is generated here rather than borrowed from the caller's id.
      const key = randomUUID().replace(/-/gu, '')
      const headline = clip(readValue(first.header) ?? readValue(first.question) ?? '需要你的补充信息', 120)
      const extra = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
      const agent = readValue(request?.agent)
      const sessionId = readValue(agent?.id) ?? readValue(agent?.session?.id)
      const subject = typeof agent === 'object' && agent !== null ? sessionSubject(agent.session) : undefined
      const body = subject === undefined ? `${headline}${extra}` : `会话：${subject}\n${headline}${extra}`
      void showToast('question', key, 'DSH 请求补充信息', body, { sessionId })
    }
    return next()
  })
}
