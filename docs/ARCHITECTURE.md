# Architecture

How `dsh-windows-toast` fits into DeepSeek Harness, and why each piece exists in
the form it does.

## Where it sits

DSH is a Cordis-based plugin host. A **bundle** is an npm package that declares
`dsh.bundle.patch`; installing it adds a patch layer that inserts plugin rows into
the running profile. A bundle may also have a **client half** — browser code
served to the Web UI as an ES module.

This plugin uses both halves:

```
                    DSH Host process                          Browser
  ┌──────────────────────────────────────────┐   ┌───────────────────────────┐
  │  lib/index.js  (Host half)               │   │  lib/client.js            │
  │                                          │   │  (settings page)          │
  │  • approval/request waterfall listener   │   │                           │
  │  • session/event  (turn/end)             │   │  plugins.item slot        │
  │  • user-questions/request                │   │  configForms namespace    │
  │  • settings Config schema                │   │                           │
  └───────────────┬──────────────────────────┘   └─────────────▲─────────────┘
                  │ spawn                                      │
                  ▼                                            │ settings RPC
  ┌──────────────────────────────────────────┐                 │
  │  assets/toast.ps1   (PowerShell 5.1)     │                 │
  │  Register / Show / Remove / Focus        │                 │
  └───────────────┬──────────────────────────┘                 │
                  │ WinRT ToastNotificationManager              │
                  ▼                                            │
  ┌──────────────────────────────────────────┐                 │
  │  Windows Action Center                   │                 │
  └───────────────┬──────────────────────────┘                 │
                  │ user clicks a button                        │
                  ▼                                            │
  ┌──────────────────────────────────────────┐                 │
  │  assets/decision.vbs   (WScript)         │                 │
  │  writes one .uri file per activation     │                 │
  └───────────────┬──────────────────────────┘                 │
                  │ spool directory (filesystem)                │
                  ▼                                            │
         back into lib/index.js, which polls and applies ──────┘
```

The loop closes through the **filesystem**, not through a socket. That is a
deliberate consequence of how Windows activates a protocol handler — see
[The decision channel](#the-decision-channel).

## Components

| Component | Role |
|---|---|
| `lib/index.js` | Host half: config, event listeners, the approval race, spool polling, sidecar invocation |
| `lib/client.js` | Browser half: the settings page, registered into the `plugins.item` slot |
| `assets/toast.ps1` | Projects WinRT in Windows PowerShell 5.1; four subcommands |
| `assets/decision.vbs` | The protocol handler Windows launches; one file per activation |
| `cordis.patch.yml` | Inserts the Host row; its `id` **is** the settings namespace |

## Event sources

The plugin observes three DSH events and derives four notification kinds.

| Notification | Source | Buttons |
|---|---|---|
| Task completed | `turn/end` with `reason.kind === 'completed'` | 打开会话 |
| Task failed | `turn/end` with `reason.kind` of `error`, `aborted`, or `interrupted` | 打开会话 |
| Question | `user-questions/request` | 打开会话 |
| Approval | `approval/request` | **同意 / 拒绝** |

`turn/end` is a committed session event, so completion and failure are durable
facts rather than inferred state. Every notification gets its own fresh opaque
token as its identity, which makes each turn's toast distinct and withdrawals
unambiguous. Clicking any notification — the body, or the 打开会话 button — opens
the session it came from; see
[Opening the session a notification came from](#opening-the-session-a-notification-came-from).

Subagent sessions are tracked through `subagent/start` and `subagent/end` so their
turns can be excluded — a subagent finishes every few seconds, and announcing each
one would make the feature useless.

## The approval race

This is the interesting part, and it is where the design is load-bearing rather
than incidental.

`approval/request` is an **Agent-scoped Cordis waterfall**. The browser's approval
panel is not a local listener: it is reached through the DSH Remote Event bridge,
which serializes the request across the wire to the browser. So both the panel and
this plugin are consumers of one waterfall, and exactly one of them should win.

Three facts about the shipped implementation make the race solvable:

1. **The bridge reads `request.signal` when the Remote listener runs.**
   `projectRemoteEventRequest` in `dsh-api-gateway` extracts `signal` from the
   request object at the point the downstream listener receives it.

2. **Cordis `waterfall()` builds its `next` closure over the original argument
   list.** Calling `next(replacement)` is silently ignored — the replacement never
   reaches downstream listeners. The request must be **mutated in place**.

3. **Aborting that signal is what retires the panel.** The gateway registers an
   `abort` listener on it; aborting calls `cancelRemoteEvent`, which pushes a
   `cancel` frame that aborts the browser's delivery signal, which makes
   `PendingApproval.abort()` run and unmount the panel.

So the plugin registers with `prepend: true` and installs its **own**
`AbortController`'s signal on the request before continuing the chain:

```js
request.signal = controller.signal   // mutation, not next(replacement)
```

That single mutation gives both orderings for free:

```
        ┌─────────────────────────┐
        │  approval/request       │
        │  waterfall              │
        └───────────┬─────────────┘
                    │ prepend: install own signal
        ┌───────────▼─────────────┐
        │  dsh-windows-toast      │
        │  Race(toast, browser)   │
        └─────┬─────────────┬─────┘
              │             │
     toast answers    browser answers
              │             │
              ▼             ▼
   resolve waterfall   waterfall settles
   then abort signal   then withdraw toast
              │             │
              ▼             ▼
   browser panel      nothing left
   receives cancel    on screen
```

Both losing paths converge on `finish()`, which withdraws the toast and aborts the
signal — idempotent, so a late second answer is a no-op.

### The `unavailable` fallback

If no answering browser client exists, the waterfall's terminal answerer returns
`unavailable` and the request would fail closed. But the toast is already on
screen and the user can still answer it, so the plugin keeps the toast as the
decision source — bounded by a deadline (the configured `timeoutSeconds`, or ten
minutes) so an ignored toast cannot hang a turn forever. When the deadline passes
it returns `unavailable`, preserving the fail-closed default.

## Opening the session a notification came from

Clicking a notification opens the **session that produced it**, not merely the DSH
window. This is not a deep link, because DSH has none, and the reason is worth
recording.

### There is no session URL

Session selection is browser-local state, persisted to `localStorage` under
`dsh.sessions.current`. The Web frontend has **no router at all** — no
`location.hash`, no `history.pushState`, no query parameter, no pathname route.
The shipped `dsh-host-frontend-static` documentation states it directly: *"the
current client enters through the root or configured index path and has no History
API pathname routes."*

The desktop shell does register a `dsh://` protocol, but the handler matches one
URL and ignores everything else:

```js
if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
});
```

That is focus-only, and `open-url` is a macOS event besides. On Windows the
registration makes the shell launch the executable with `"%1"` as an argument, and
the single-instance handler drops argv entirely — `application.on("second-instance",
focusOwner)` where `focusOwner` takes no parameters. So `dsh://session/<id>` would
launch a second process, lose the single-instance lock, and do nothing beyond what
`SetForegroundWindow` already did.

### The mechanism that does exist

Session navigation belongs to exactly one API, the client-side Cordis service
`uiWorkspace`:

```js
ctx.uiWorkspace.openSession(sessionId)   // replaces the main view, clears any panel
```

Shipped plugins call it this way (`ui-schedule`, `ui-chat`, `ui-workflow-run`), and
`uiSession` is a **read-only projection** with no select method — navigation is
`uiWorkspace` alone. But it is browser code, and a toast click arrives in the Host
process. Something has to carry the request across.

### The bridge

The plugin owns both halves, so it supplies the missing leg itself:

```
   click (Host side)                         browser
  ┌──────────────────────┐              ┌──────────────────────┐
  │ handleDecision()     │              │ poll (1.5s + onfocus) │
  │  verb === 'focus'    │              │                      │
  │  ↓                   │              │  ↓                   │
  │ requestNavigation()  │              │ uiWorkspace          │
  │  ↓                   │   GET        │   .openSession(id)   │
  │ pendingNavigation[] ─┼──────────────▶                      │
  │  (TTL 120s, cap 8)   │  destructive │                      │
  └──────────────────────┘              └──────────────────────┘
```

A three-way split makes this safe:

- **The queue is Host-side, keyed by an opaque token.** The protocol URI carries
  only the key — never a session id — because that URI reaches a registry value and
  a handler command line. `toastTargets` maps key to session inside the process.
- **Reading is destructive.** A request reveals the session once, not on every
  poll. Entries also expire (120 s) and the queue is bounded, so a click cannot
  yank the view long after the fact.
- **The route is fenced, or absent.** It requires the `connection` service and
  calls `requestRejection(req)` exactly as the shipped open-in-app routes do. The
  service is a hard dependency of the route rather than an optional read: a route
  that reveals which session the user is viewing must not answer anyone who asks,
  so a composition that cannot vouch for a caller does not publish it at all.

The poll runs `unref()`ed on an interval and again on window focus. Focus is the
common case, since the click raises the window first — checking on focus makes the
reveal feel immediate instead of waiting out the interval.

### Saying what an approval is about

An `approval/request` carries no tool arguments — only the tool name, a reason,
and the call id. The arguments live on the `tool/call` event, which the agent loop
appends *before* it runs the tool, so by the time an approval races the toast the
matching event has already been published. The plugin records those calls in a
bounded map keyed by call id and looks the request's call id up in it.

The summary reads the first present of `description`, `command`, `file_path`,
`path`, `pattern`, `query`, `url` — ordered by how directly each describes the
action, not by tool — and falls back to the raw text if `arguments` is not JSON. A
malformed payload costs the summary line, never the notification.

## The decision channel

Windows activates a protocol handler through `ShellExecute`, launching the
registered command with the URI as an argument. That process is a **child of
Explorer**, so:

- it inherits **none** of the Host's environment, and
- there is no live channel back to the Host.

Two consequences follow directly.

**The spool directory travels in the registered command line.** Since the handler
cannot read an environment variable the Host sets, the directory is written into
the registry value itself:

```
wscript.exe //B //Nologo "...\decision.vbs" "C:\...\Temp\dsh-windows-toast-<hash>" "%1"
```

**The spool is keyed by installation path *and* protocol name.** It is a
rendezvous point, so two instances sharing a directory would consume each other's
decisions and discard them as unknown. Hashing both inputs makes the channel
private per instance.

One file per activation, never a shared append log: a partially written append
would be read as malformed and silently drop the user's click. The Host reads and
deletes each file, and an in-memory `seen` set prevents double-processing.

## Why the decision key is not the tool call id

A real DSH approval `callId` looks like this:

```
call_00_F6Jx8YJWS8GzZk1Guui71294|fc_call_00_F6Jx8YJWS8GzZk1Guui71294
```

It contains `|`. Any `cmd`-based handler re-interprets that as a **pipe** no
matter how the argument is quoted — the original implementation wrote the URI with
`echo`, so the shell tried to execute the right-hand side as a command, no file
was written, and every decision was silently lost. The only visible symptom was a
black console window flashing.

The plugin therefore mints a fresh opaque hex token for every request:

```js
const key = randomUUID().replace(/-/gu, '')
```

This is a structural fix rather than escaping. It also keeps third-party
identifiers out of a registry value and a temp file name.

The handler is a **WScript** file rather than a `.cmd` for the same reason: `cmd`
parses metacharacters even inside quoted arguments, and a `.cmd` launched by
Explorer always flashes a console window. WScript receives the URI as inert data
and shows no window.

## Configuration and the settings namespace

DSH's `dsh-settings` exposes only fields a plugin marks `.volatile()`, and keys
each form by the **Loader entry id** — not the package name, and not the entry's
`name`. So:

```
cordis.patch.yml:  - id: dsh-windows-toast      ← this string is the namespace
lib/index.js:        const SETTINGS_NS = 'dsh-windows-toast'
lib/client.js:       const SETTINGS_NS = 'dsh-windows-toast'
```

All three must agree. The client registers its page through
`configForms.whileServed([namespace])`, so a deployment that never loaded the Host
half shows no trace of the page.

`lib/index.js` reads `.volatile()` references through a `readValue()` helper that
calls `.get()` when present, and folds them into a plain snapshot once at startup.

## Failure modes

| Failure | Behavior |
|---|---|
| Not Windows | Logged once, plugin stays inactive. |
| PowerShell 5.1 missing | Logged once, notifications unavailable. Everything else still loads. |
| `schemastery` unresolvable | Plugin runs on built-in defaults; only the settings page is lost. |
| Toast fails to show | Logged; the approval is handled entirely by the browser, as if the listener were absent. |
| Sidecar times out | Treated as a failure; the staged XML is cleaned up. |
| Unknown decision key | Ignored. A stale click cannot settle an unrelated request. |
| Plugin disposed mid-approval | Pending approvals settle as `unavailable`; the spool poller stops. |
| Registry write denied | Logged at startup; toasts still show, but their buttons cannot route back. |

## Verified behavior

The end-to-end suite (`test/e2e.test.mjs`) imports the Host half unmodified, lets
it really register its protocol and show a real toast, then activates a button
through `ShellExecute` — the path a real click takes — and asserts the approval
settles `allowed-once` and `rejected`. It uses its own protocol and AUMID so it
cannot disturb a running DSH.

Not covered by the suite: the browser panel's own rendering, which is the shipped
`dsh-client-ui-approval` behavior and is not this plugin's code.
