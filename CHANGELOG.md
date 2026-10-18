# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-18

First public release.

### Added

- Windows toast notifications for four DeepSeek Harness review events: task
  completed, task failed, question / more information, and approval request.
- **同意 / 拒绝** buttons on approval toasts that decide the pending request
  without returning to the browser. Whichever side answers first wins: a toast
  answer retires the browser panel, and a browser answer withdraws the toast.
- Per-event configuration for enable, button row, and dismiss time, editable in
  **Settings → Plugins → Toast notifications** or in `cordis.patch.yml`.
- Suppression while the DSH window has focus, and optional inclusion of subagent
  turns.
- A `Focus` action that raises the DSH window from a background process.
- A DSH plugin-market index (`market.json`) for installation through Discover.
- Test suites: `compat`, `host`, `client`, `e2e`, and `tokens`.

### Fixed during development

These were found by testing against real DSH data and are recorded because each
one is a trap a similar plugin would hit:

- **Approval decisions were silently dropped when the tool call id contained
  `|`.** DSH composes `callId` as `<call>|<fc_call>`, and `cmd` re-interprets a
  pipe even inside a quoted argument, so the handler never wrote a decision file.
  Fixed by minting an opaque hex token for the protocol URI instead of passing
  the caller's id.
- **A console window flashed on every button click.** The protocol handler was a
  `.cmd`; it is now a WScript file, which also stops the shell from parsing
  metacharacters at all.
- **Two instances sharing a spool directory consumed each other's decisions.**
  The spool is now keyed by installation path *and* protocol name.
- **The sidecar result line failed to parse.** Inside a .NET method-call argument
  list a comma separates arguments, so `"...{0}..." -f $a, $b` bound only the
  first value; the line is now assembled by concatenation.

[1.0.0]: https://github.com/KiteMoon/dsh-windows-toast/releases/tag/v1.0.0
