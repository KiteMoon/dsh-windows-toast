# Implementation

File-by-file internals, and the constraint each piece exists to satisfy. Read
[docs/ARCHITECTURE.md](ARCHITECTURE.md) first for how the parts fit together.

## `lib/index.js` — Host half

The Host half is an ESM module exporting the Cordis bundle contract:
`name`, optional `inject`, optional `Config`, and `apply(ctx, config)`.

```js
export const name = 'dsh-windows-toast'
export const inject = []
export const Config = /* schemastery schema */
export function apply(ctx, rawConfig) { /* ... */ }
```

`inject` is deliberately empty. Every hook is an event listener, so requiring a
service up front would disable turn-completion notifications in a profile that
composes no approval service — and a listener for an event nobody emits is simply
never called.

`apply()` returns early on non-Windows platforms and when PowerShell 5.1 is
missing, logging once. Everything else degrades independently: a failure to show a
toast, for example, leaves the approval to the browser listener.

### Startup

`apply()` builds one settings snapshot, derives the spool directory, and registers
a single `ctx.effect` that both registers the protocol handler and starts the
spool poller. Returning the disposer from that effect is what makes plugin unload
stop the timer and settle pending approvals.

### Config

`Config` is built at module scope from a **defensively resolved** schemastery
factory, because a bare `import` can fail outside the patched runtime:

```js
async function resolveSchemaFactory() {
  try { /* import('@deepseek-ai/schemastery') */ } catch {}
  try { /* createRequire(process.argv[1])('@deepseek-ai/schemastery') */ } catch {}
  return undefined
}
```

When it resolves to `undefined`, `Config` is `undefined` and the plugin runs on
`DEFAULT_CONFIG`. The cost is the editable settings page; nothing else changes.

Every user-tunable field is marked `.volatile()`, because `dsh-settings` exposes
*only* volatile fields — a field without it is silently absent from the form.

### Reading config

`.volatile()` wraps a value in a reference whose live value is read through
`.get()`. `readValue()` handles that transparently and is used everywhere, so no
call site has to know whether it holds a reference or a plain value:

```js
function readValue(source) {
  if (typeof source.get === 'function') { try { return source.get() } catch { return undefined } }
  return source
}
```

`normalizeConfig()` folds the possibly-reference-shaped config into a plain
snapshot once at startup. Downstream code reads `settings.events.approval.enabled`
rather than unwrapping at each use.

### Toast document

`showToast()` builds the XML and passes it to the sidecar as a **file**, never as
an argument. Two reasons:

- Text is XML-escaped (`xmlEscape`) and clipped (`clip`) before embedding, and
  control characters XML 1.0 cannot carry are dropped rather than escaped.
- Passing the document by file keeps arbitrary text out of a command line
  entirely, which is the same class of problem as the approval key.

The document is written with `mkdir` first, because a toast can be raised before
the startup effect finishes; the call is idempotent so the ordering does not
matter.

### Toast identity

The toast **tag** is a SHA-1 of the event key rather than the key itself, because
Windows requires a tag of at most 64 characters with no NUL. Hashing makes any
input legal. The tag is what a later withdrawal targets.

### Sidecar invocation

`runSidecar()` spawns PowerShell, captures stdout and stderr, and parses exactly
one line of the form `dsh-toast:<status>:<detail>`. It has its own timeout and
kills the child on expiry. Returning an error object rather than throwing keeps
every call site's failure path explicit and lets the approval listener distinguish
"toast shown" from "toast failed" — which changes its behavior.

### Decision spool

`DecisionSpool` polls a directory on an interval, reads each `.uri` file, deletes
it, and invokes the callback with its contents. Design points:

- **Polling, not `fs.watch`.** It needs no watcher dependency and the interval
  bounds click-to-effect latency, which is the property that matters here.
- **One file per activation.** A shared append log could be read half-written and
  discarded as malformed, silently dropping the click.
- **`seen` set.** A file is processed once even if the delete fails.
- **`unref()` on the timer**, so a pending poll can never hold the Host process
  open on shutdown.

The callback routes the URI: `<protocol>:<verb>:<key>`. `focus` raises the DSH
window; `approve` and `reject` look up a pending approval. Unknown protocols and
keys are ignored, so a stale click from a previous run cannot settle a new
request.

### The approval listener

Registered with `{ prepend: true }` so it runs before the Remote Event bridge's
listener and can install its signal on the request first. The body is documented
inline; the load-bearing lines are:

```js
request.signal = controller.signal          // mutation: next(replacement) is ignored
const first = await Promise.race([downstream, fromToast])
```

`downstream` is the rest of the chain (in practice, the browser). Its settlement
is captured as a value rather than raced directly, so a losing rejection cannot
surface as an unhandled rejection.

`finish()` is the single convergence point: it withdraws the toast and aborts the
signal. Calling it twice is harmless.

### Turn notifications

`session/event` with `turn/end` drives completion and failure. The title comes
from the `sessionTitle` service when available (it folds the whole log, including
titles written before this plugin loaded), falling back to a session field.

Subagent sessions are tracked in a `Set` populated from `subagent/start` and
`subagent/end`, so `notifyOnSubagents: false` can exclude them.

## `lib/client.js` — browser half

A DSH client plugin is a CJS factory registered into the page's module loader:

```js
window.__ModuleLoader__.load({
  id: 'dsh-windows-toast',
  factory: (require) => { /* ... */ return module.exports },
})
```

The `id` must equal the package name. `apply` and `inject` are properties of the
returned exports object, not ESM exports.

### Why the controls are hand-written

The shipped settings pages `require('@deepseek-ai/dsh-client-ui-primitives')`, but
that package is **not on disk** — the shell publishes it through an internal seed
table. It works today (a real third-party plugin relies on it), but it is not a
stable contract, and the plugin-development guidance is explicit that plugins
should write their own controls.

What *is* stable is the pair the Plugins page hands a `plugins.item`
registration: `props.form` carrying `{ state, mutate }`, and `props.view`
selecting summary vs page. That is all this file uses.

### Component structure

```
ToastNotifyPage          view === 'summary' ? one line : <WindowsToastForm>
  └─ WindowsToastForm    state, draft, save/reset, ops collection
       ├─ Switch         one labelled toggle
       ├─ NumberField    one labelled integer
       └─ EventBlock     per-kind enable / timeout / buttons
```

`ToastNotifyPage` and `WindowsToastForm` are separate components rather than one
branching component, because the slot renders the same registration twice with
different `view` values — branching inside one component would call hooks
conditionally.

Edits are staged in local state and diffed against the accepted value at save
time, so a refused write leaves the user's draft intact. `events.<kind>` is
written as one whole block rather than three field paths, so a first-ever write
creates it in a single atomic operation.

### Styling

Only `--dsw-alias-*` tokens the shipped theme actually defines are referenced.
A guessed token name renders as an invalid declaration — visibly broken rather
than gracefully degraded — so `test/tokens.test.cjs` asserts every one exists.

## `assets/toast.ps1` — the sidecar

Windows PowerShell **5.1 only**: PowerShell 7 cannot load the
`Windows.UI.Notifications` projection. The script is located by absolute path from
`$env:SystemRoot`, never from `PATH`, with `DSH_WINDOWS_TOAST_POWERSHELL` as an
override.

Four actions, each printing one machine-readable result line:

| Action | Notes |
|---|---|
| `Register` | HKCU-only: AppUserModelId display metadata, plus the protocol handler. No elevation. |
| `Show` | Reads the staged XML, sets tag/group, sets `ExpirationTime`, optionally skips when focused. |
| `Remove` | Withdraws one toast by tag so a decision made elsewhere leaves no stale button. |
| `Focus` | Raises the DSH window. |

Two implementation details worth knowing:

- **`ExpirationTime`, not `duration`.** The `duration` attribute only selects the
  short/long banner window; `ExpirationTime` is what actually bounds how long the
  toast survives on screen and in Action Center.
- **The foreground check uses P/Invoke** (`GetForegroundWindow` +
  `GetWindowThreadProcessId`) rather than `Get-Process`, because the question is
  which window is focused, not which process is running.

`Focus` needs `SetForegroundWindow`, which Windows refuses from a process that
does not own the current foreground. A synthetic ALT press and release satisfies
that check — the only reliable way for a background helper to raise another
application's window.

Result lines are assembled by string concatenation, not `-f`: inside a .NET
method-call argument list a comma separates arguments, so `"...{0}..." -f $a, $b`
would bind only `$a` to the format string. That bug was real and produced a
constant error in early testing.

## `assets/decision.vbs` — the protocol handler

Invoked as:

```
wscript.exe //B //Nologo ...\decision.vbs "<spool dir>" "%1"
```

WScript rather than a `.cmd` for two reasons that both caused real bugs: a `.cmd`
launched by Explorer flashes a console window, and `cmd` parses metacharacters
such as `|` even inside a quoted argument — which silently corrupted every
decision whose identity contained one. WScript receives the argument as inert
data and shows no window.

The spool directory is passed as an argument rather than read from the
environment, because Explorer launches this process and it inherits none of the
Host's.

The file name is drawn from two `Randomize`d 31-bit values with a retry on
collision, rather than from `%DATE%`/`%TIME%`: those are locale-dependent, and a
non-Gregorian locale yields a name the redirect cannot open.

## `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-windows-toast
      name: dsh-windows-toast
```

The `id` **is** the settings namespace. It must match `SETTINGS_NS` in both
halves. The loader assigns a random id when one is omitted, which would make the
namespace unpredictable and the settings page impossible to key — so it is always
declared explicitly.

## Tests

| File | Scope |
|---|---|
| `test/compat.test.mjs` | `engines.dsh` placement and range, using a real `semver` |
| `test/host.test.mjs` | Host half against a fake Cordis context, sidecar stubbed |
| `test/client.test.cjs` | Settings page deep-rendered in three states |
| `test/e2e.test.mjs` | Real sidecar, real toast, real `ShellExecute` activation |
| `test/tokens.test.cjs` | Every theme token used is defined by the shipped theme |

The host suite stubs the sidecar by rewriting `runSidecar` in the source before
importing it, so no toast is shown and every call is observable. It reads the
decision key out of the staged XML rather than predicting it — the plugin
deliberately never puts a caller-supplied id in a protocol URI, so a test cannot
know the key in advance.

The e2e suite reads the key the same way, from the staged XML. An earlier version
read it from the Windows Action Center, which is populated asynchronously and
whose ordering against `History.Clear` is not guaranteed; that produced
intermittent failures unrelated to the plugin.
