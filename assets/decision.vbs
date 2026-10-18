' ===========================================================================
'  dsh-windows-toast decision handler.
'
'  Windows runs this when a toast body or button is activated, passing the
'  protocol URI. The plugin's Host half watches a spool directory and applies
'  the decision, so this handler only writes one file per activation holding
'  exactly the URI.
'
'  WScript rather than a .cmd, for two reasons that both caused real bugs:
'
'   1. No console window. A .cmd launched by Explorer flashes a black window.
'   2. No shell parsing. cmd re-interprets characters such as `|` and `&` even
'      inside an argument, which silently corrupted decisions whose identity
'      contained one, and a bare `echo` of such a value also failed to write.
'      WScript takes the argument as data and never parses it.
'
'  Invocation (the registered protocol command):
'    wscript.exe //B //Nologo <this file> "<spool dir>" "%1"
'
'  The spool directory is passed explicitly because Explorer launches this
'  process and it inherits none of the Host's environment.
' ===========================================================================
Option Explicit

Dim allArgs, spool, uri, fso, attempt, name, stream

Set allArgs = WScript.Arguments
If allArgs.Count < 2 Then WScript.Quit 1

spool = allArgs(0)
uri = allArgs(1)

' An empty URI is not a decision; exit quietly rather than writing junk.
If Len(uri) = 0 Then WScript.Quit 0

Set fso = CreateObject("Scripting.FileSystemObject")

If Not fso.FolderExists(spool) Then
  On Error Resume Next
  fso.CreateFolder spool
  On Error Goto 0
  If Not fso.FolderExists(spool) Then WScript.Quit 1
End If

' One file per activation, never a shared append log: a partially written
' append would be read as malformed and silently drop the user's click.
'
' The name only has to be unique among files present at the same instant, and
' the Host deletes each one as it consumes it. Retry on the rare collision.
Randomize
name = ""
For attempt = 1 To 100
  Dim candidate
  candidate = spool & "\" & CStr(Int(Rnd() * 2147483647)) & "-" & CStr(Int(Rnd() * 2147483647)) & ".uri"
  If Not fso.FileExists(candidate) Then
    name = candidate
    Exit For
  End If
Next

If name = "" Then WScript.Quit 1

' ASCII is correct here: the URI is a protocol name, a verb, and a hex token.
On Error Resume Next
Set stream = fso.CreateTextFile(name, True, False)
If Err.Number <> 0 Then WScript.Quit 1
stream.Write uri
stream.Close
If Err.Number <> 0 Then WScript.Quit 1
On Error Goto 0

WScript.Quit 0
