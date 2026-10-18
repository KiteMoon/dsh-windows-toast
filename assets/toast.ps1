<#
  dsh-windows-toast sidecar.

  One-shot Windows toast helper for the DSH Host plugin. The Host writes the
  toast XML (already escaped, UTF-8 without BOM) and invokes this script; the
  script only projects WinRT and never composes user text, so no text ever
  round-trips through PowerShell's own script encoding.

  Actions:
    Register - create the HKCU AUMID display metadata and the protocol handler
               that toast buttons and body clicks activate.
    Show     - display one toast, optionally skipped while DSH is foreground.
    Remove   - withdraw one toast from the screen and Action Center.
    Focus    - bring the DeepSeek Harness window to the foreground.

  Windows PowerShell 5.1 is required: the WinRT type projections and the
  `Windows.UI.Notifications` namespace are not available on PowerShell 7.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Show', 'Remove', 'Register', 'Focus')][string]$Action,

  # Show
  [string]$XmlFile,
  [int]$TtlSeconds = 0,
  [switch]$OnlyWhenUnfocused,
  [string]$FocusProcessName = 'DeepSeek Harness',

  # Show / Remove
  [string]$Tag = '',
  [string]$Group = 'dsh-windows-toast',

  # Register
  [string]$Aumid = 'DeepSeekHarness.WindowsToast',
  [string]$Protocol = 'dsh-windows-toast',
  [string]$HandlerCmd = '',
  [string]$SpoolDir = '',
  [string]$DisplayName = 'DeepSeek Harness',
  [string]$IconUri = ''
)

$ErrorActionPreference = 'Stop'

# Emit one machine-readable line so the caller never parses prose.
# The parts are concatenated rather than formatted with `-f`: inside a .NET
# method-call argument list a comma separates arguments, so `"...{0}..." -f $a,
# $b` would bind only `$a` to the format string.
function Write-Result([string]$Status, [string]$Detail) {
  [Console]::Out.WriteLine('dsh-windows-toast:' + $Status + ':' + $Detail)
}

function Initialize-WinRt {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
}

function Test-ForegroundMatches([string]$ProcessName) {
  if ([string]::IsNullOrWhiteSpace($ProcessName)) { return $false }
  Initialize-Native
  $handle = [DshToast.Native]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return $false }
  $owner = 0
  [void][DshToast.Native]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -eq 0) { return $false }
  $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  return ($process.ProcessName -eq $ProcessName)
}

function Initialize-Native {
  if ('DshToast.Native' -as [type]) { return }
  Add-Type -Namespace DshToast -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
}

function Invoke-Focus([string]$ProcessName) {
  Initialize-Native
  $target = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $target) {
    Write-Result 'error' 'target-window-not-found'
    exit 1
  }
  $hwnd = $target.MainWindowHandle
  if ([DshToast.Native]::IsIconic($hwnd)) { [void][DshToast.Native]::ShowWindow($hwnd, 9) }
  if (Test-ForegroundMatches $ProcessName) {
    Write-Result 'focused' 'already'
    return
  }
  # Windows refuses SetForegroundWindow from a process that does not own the
  # current foreground, unless the caller received the last input event. A
  # synthetic ALT press and release satisfies that check, which is the only
  # reliable way for a background helper to raise another app's window.
  [DshToast.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [DshToast.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [void][DshToast.Native]::BringWindowToTop($hwnd)
  $raised = [DshToast.Native]::SetForegroundWindow($hwnd)
  Write-Result 'focused' ($(if ($raised) { 'raised' } else { 'attempted' }))
}

function Invoke-Register {
  # AUMID display metadata: without this the toast shows the raw AUMID as its
  # source name. This is a per-user key, so no elevation is needed.
  $aumidKey = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
  New-Item -Path $aumidKey -Force | Out-Null
  New-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value $DisplayName -PropertyType String -Force | Out-Null
  if (-not [string]::IsNullOrWhiteSpace($IconUri)) {
    New-ItemProperty -Path $aumidKey -Name 'IconUri' -Value $IconUri -PropertyType String -Force | Out-Null
  }

  if ([string]::IsNullOrWhiteSpace($HandlerCmd)) {
    Write-Result 'registered' 'aumid-only'
    return
  }

  # Protocol activation. Toast buttons and body clicks carry their intent in the
  # protocol URI; Windows launches this command with the full URI as %1.
  #
  # The spool directory is written into the registered command rather than read
  # from the handler's environment: Explorer launches the handler, so it does
  # not inherit any variable this Host process exports.
  $protoKey = "HKCU:\Software\Classes\$Protocol"
  New-Item -Path $protoKey -Force | Out-Null
  New-ItemProperty -Path $protoKey -Name '(default)' -Value "URL:$Protocol" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $protoKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  New-Item -Path "$protoKey\shell\open\command" -Force | Out-Null
  # The handler is a WScript file, not a .cmd. A .cmd launched by Explorer
  # flashes a console window, and — decisively — cmd re-interprets characters
  # such as `|` even inside a quoted argument, which silently corrupted any
  # decision whose identity contained one. WScript treats the argument as data
  # and shows no window.
  if ([string]::IsNullOrWhiteSpace($SpoolDir)) {
    Write-Result 'error' 'spool-dir-required'
    exit 1
  }
  $scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path $scriptHost)) {
    Write-Result 'error' 'wscript-not-found'
    exit 1
  }
  # //B = batch mode (suppress prompts), //Nologo = no banner. Every operand is
  # quoted, so any character in a decision identity stays inert.
  $command = "`"$scriptHost`" //B //Nologo `"$HandlerCmd`" `"$SpoolDir`" `"%1`""
  New-ItemProperty -Path "$protoKey\shell\open\command" -Name '(default)' `
    -Value $command -PropertyType String -Force | Out-Null
  Write-Result 'registered' 'aumid+protocol'
}

function Invoke-Show {
  if ($OnlyWhenUnfocused -and (Test-ForegroundMatches $FocusProcessName)) {
    Write-Result 'skipped' 'foreground'
    return
  }

  $xmlText = [IO.File]::ReadAllText($XmlFile, (New-Object Text.UTF8Encoding($false)))
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)

  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  if (-not [string]::IsNullOrWhiteSpace($Tag)) { $toast.Tag = $Tag }
  if (-not [string]::IsNullOrWhiteSpace($Group)) { $toast.Group = $Group }

  # `duration` only selects the short/long banner window; ExpirationTime is what
  # actually bounds how long the toast survives on screen and in Action Center.
  if ($TtlSeconds -gt 0) {
    $toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($TtlSeconds)
  }

  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
  Write-Result 'shown' $Tag
}

function Invoke-Remove {
  if ([string]::IsNullOrWhiteSpace($Tag)) {
    [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($Aumid)
    Write-Result 'cleared' 'all'
    return
  }
  [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($Tag, $Group, $Aumid)
  Write-Result 'removed' $Tag
}

try {
  switch ($Action) {
    'Register' { Initialize-WinRt; Invoke-Register }
    'Show' { Initialize-WinRt; Invoke-Show }
    'Remove' { Initialize-WinRt; Invoke-Remove }
    'Focus' { Invoke-Focus $FocusProcessName }
  }
  exit 0
}
catch {
  Write-Result 'error' ($_.Exception.Message -replace '[\r\n]+', ' ')
  exit 1
}
