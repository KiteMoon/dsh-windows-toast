# dsh-windows-toast

Windows toast notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) review
events. Approval requests get **同意 / 拒绝** buttons that decide the pending request
straight from the notification; every other event gets a click that brings the DSH
window forward. Each event type has its own dismiss time.

> Third-party plugin. Not affiliated with or endorsed by DeepSeek.

```
┌──────────────────────────────────────────────┐
│  DeepSeek Harness                    now     │
│                                              │
│  DSH 请求授权                                │
│  工具 pwsh：需要放宽沙箱以访问 WSL           │
│                                              │
│         [ 同意 ]        [ 拒绝 ]             │
└──────────────────────────────────────────────┘
```

## Features

- **Answer approvals without leaving what you are doing.** The toast's own
  buttons settle the request. Whichever side answers first wins: if you click the
  toast, the browser panel closes itself; if you click the browser panel, the
  toast is withdrawn so no stale button is left behind.
- **Four event types, independently configurable.** Task completed, task failed,
  question / more information, and approval request — each with its own on/off,
  button toggle, and dismiss time.
- **No duplicate interruptions.** Notifications are suppressed while the DSH
  window already has focus, and subagent turns are excluded by default (they
  finish constantly).
- **Editable in the Web UI.** Settings → Plugins → Toast notifications. No config
  file editing required, though the same values work in `cordis.patch.yml`.
- **No runtime dependencies.** Uses the Windows PowerShell 5.1 and WScript that
  ship with Windows. Nothing to build, nothing to compile.

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 |
| DSH | `>=0.2.1-rc.2` |
| Shell | Windows PowerShell 5.1 (in-box) |

Windows PowerShell **5.1** is required, not PowerShell 7: only 5.1 carries the
`Windows.UI.Notifications` projection. The plugin locates it by absolute path and
never assumes `powershell.exe` is on `PATH`.

## Install

### From npm

```powershell
dsh plugin --profile <profile> add dsh-windows-toast
```

### From Git

```powershell
dsh plugin --profile <profile> add github:KiteMoon/dsh-windows-toast
```

### From a local checkout

```powershell
git clone https://github.com/KiteMoon/dsh-windows-toast.git
dsh plugin --profile <profile> add <absolute path to the cloned directory>
```

### From the DSH plugin market

Add the index URL in **Settings → Plugins → Discover**:

```
https://raw.githubusercontent.com/KiteMoon/dsh-windows-toast/main/market.json
```

Then search for “toast” and install from there.

Restart DSH after installing. The bundle can activate through HMR, but the
protocol handler is registered at startup, so a restart is what makes the buttons
live.

## Configuration

Open **Settings → Plugins → Toast notifications**, or edit your profile's
`cordis.patch.yml`:

```yaml
- id: dsh-windows-toast
  name: dsh-windows-toast
  config:
    enabled: true
    onlyWhenUnfocused: true          # suppress while the DSH window has focus
    approvalsAnswerFromToast: true   # put 同意/拒绝 on approval toasts
    notifyOnSubagents: false         # subagent turns finish constantly
    showToolName: true               # name the tool in an approval toast
    events:
      task-completed: { enabled: true, timeoutSeconds: 0, actions: true }
      task-failed:    { enabled: true, timeoutSeconds: 0, actions: true }
      question:       { enabled: true, timeoutSeconds: 0, actions: true }
      approval:       { enabled: true, timeoutSeconds: 0, actions: true }
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for every notification. |
| `onlyWhenUnfocused` | `true` | Suppress a toast while the DSH window has focus. |
| `focusProcessName` | `DeepSeek Harness` | Process whose window counts as “focused”. |
| `approvalsAnswerFromToast` | `true` | Let the toast decide approvals. When off, approvals are answered only in the browser. |
| `notifyOnSubagents` | `false` | Include subagent turns. |
| `showToolName` | `true` | Name the requesting tool in an approval toast. |
| `aumid` | `DeepSeekHarness.WindowsToast` | AppUserModelId the toasts are shown under. |
| `protocol` | `dsh-windows-toast` | Protocol the toast buttons activate. |
| `spoolDir` | *(derived)* | Override the decision directory. Leave empty unless you have a reason. |
| `events.<kind>.enabled` | `true` | Notify on this event type. |
| `events.<kind>.timeoutSeconds` | `0` | How long the notification stays in Action Center. `0` means until Windows or the user dismisses it. |
| `events.<kind>.actions` | `true` | Show the button row. |

`events.<kind>.timeoutSeconds` bounds **the notification only**. It never cancels
the underlying approval or question, which keeps its own lifetime.

## How the approval buttons work

The browser's approval panel and the toast are two consumers of one Cordis
waterfall (`approval/request`). This plugin registers with `prepend: true` and
installs **its own** `AbortSignal` on the request before continuing the chain.
That single mutation is what makes both orderings work:

- **Toast answered first** — the plugin resolves the waterfall, then aborts its
  signal. The DSH API gateway watches that signal and pushes the cancel frame
  that retires the browser's pending panel.
- **Browser answered first** — the waterfall settles and the plugin withdraws the
  toast, so no stale button remains on screen.

If no browser client is connected at all, the request would normally fail closed
as `unavailable`; the toast stays live as the decision source instead, bounded so
an ignored toast cannot hang a turn forever.

Full details are in [docs/ARCHITECTURE.md](https://github.com/KiteMoon/dsh-windows-toast/blob/main/docs/ARCHITECTURE.md), including why
the decision key is never the tool call id — spoiler: a real `callId` contains
`|`, and the Windows shell reads that as a pipe.

## Uninstall

```powershell
dsh plugin --profile <profile> remove dsh-windows-toast
```

The plugin also registers an `AppUserModelId` and a protocol handler under
`HKCU\Software\Classes`. Nothing there needs elevation, and removing it is
optional, but to leave no trace:

```powershell
Remove-Item 'HKCU:\Software\Classes\AppUserModelId\DeepSeekHarness.WindowsToast' -Recurse -Force
Remove-Item 'HKCU:\Software\Classes\dsh-windows-toast' -Recurse -Force
```

## Troubleshooting

**No notifications at all.** Check that Focus Assist / Do Not Disturb is off, and
that notifications are enabled for the app in Windows Settings. The plugin
suppresses toasts while DSH is focused — set `onlyWhenUnfocused: false` to check.

**The buttons do nothing.** Re-run the registration by restarting DSH. Confirm the
protocol handler exists:

```powershell
(Get-ItemProperty 'HKCU:\Software\Classes\dsh-windows-toast\shell\open\command').'(default)'
```

It should point at `wscript.exe` and `assets/decision.vbs`.

**A black window flashes when clicking a button.** That means an old registration
is still pointing at the removed `.cmd` handler. Restart DSH to re-register.

**Toasts appear for subagent work.** Set `notifyOnSubagents: false` (the default).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](https://github.com/KiteMoon/dsh-windows-toast/blob/main/docs/ARCHITECTURE.md) | How it fits into DSH: components, the approval race, data flow, failure modes |
| [docs/IMPLEMENTATION.md](https://github.com/KiteMoon/dsh-windows-toast/blob/main/docs/IMPLEMENTATION.md) | File-by-file internals and the constraints each one exists to satisfy |
| [CHANGELOG.md](https://github.com/KiteMoon/dsh-windows-toast/blob/main/CHANGELOG.md) | Release history |

## Development

```powershell
node test/run-all.mjs                      # compat + host + client (+ e2e on Windows)
node test/run-all.mjs --no-e2e             # skip the suite that touches the registry
node test/e2e.test.mjs                     # real toast, real click
node test/run-all.mjs --theme <path>       # also check theme tokens
```

| Suite | What it proves |
|---|---|
| `compat` | `engines.dsh` is declared where DSH actually reads it, and the range admits the current runtime while still refusing older ones. |
| `host` | The config fold, turn outcomes, and the approval race in both directions — including a real pipe-bearing `callId`. |
| `client` | The settings page renders in all three states (ready, read-only, unavailable). |
| `e2e` | The real sidecar registers its protocol, shows a real toast, and a real `ShellExecute` activation settles a real approval — both verbs. |
| `tokens` | Every `--dsw-alias-*` variable used exists in the shipped theme. |

The `e2e` suite is the only one that touches the machine's registry and Action
Center. It uses its own protocol and AUMID and cleans up after itself.

## License

[MIT](https://github.com/KiteMoon/dsh-windows-toast/blob/main/LICENSE)
