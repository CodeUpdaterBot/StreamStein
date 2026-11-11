@echo off
REM Comments catch-up launcher (Windows).
REM
REM   1. Re-captures the videos an earlier run had to cap, at today's 10k ceiling.
REM   2. Then runs the library catch-up, skipping everything already captured.
REM
REM Run this DETACHED, not through Hermes's background runner (that wrapper kills the
REM job with "stdin is not a tty"):
REM
REM   powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' ^
REM     -ArgumentList '/c', 'C:\Users\PC\Documents\Coding Projects\StreamStein\scripts\run-comments-catchup.cmd' ^
REM     -WorkingDirectory 'C:\Users\PC\Documents\Coding Projects\StreamStein' -WindowStyle Hidden"
REM
REM Uses the SYSTEM node, not Hermes's bundled one, so a Hermes update cannot break a
REM multi-hour run. Progress: %APPDATA%\streamstein\comments-catchup\{summary.json,catchup.log}

setlocal
cd /d "C:\Users\PC\Documents\Coding Projects\StreamStein"
set NODE="C:\Program Files\nodejs\node.exe"

echo [launcher] capped re-capture pass at %DATE% %TIME%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-comments-catchup.ps1" %*

echo [launcher] main library pass at %DATE% %TIME%
rem sharded workers are launched by run-comments-catchup.ps1 above

echo [launcher] finished at %DATE% %TIME%
endlocal
