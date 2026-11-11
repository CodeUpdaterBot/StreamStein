<#
    Park a delayed resume of the comments catch-up.

    Why this exists as its own script: launching run-comments-catchup.ps1 directly through
    Start-Process -ArgumentList with a path that contains spaces fails, because
    -ArgumentList splits each element on whitespace:
        Processing -File 'C:\Users\PC\Documents\Coding' failed because the file does not
        have a '.ps1' extension.
    The fix is to hand Start-Process ONE pre-quoted argument STRING, which keeps the quotes
    around the path intact. Doing it here means the caller cannot get it wrong.

    Usage:
        powershell -NoProfile -ExecutionPolicy Bypass -File park-comments-catchup.ps1 -Workers 2 -DelayMinutes 50
#>
param(
    [int]$Workers = 2,
    [int]$DelayMinutes = 50
)

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\PC\Documents\Coding Projects\StreamStein'
$launcher = Join-Path $repo 'scripts\run-comments-catchup.ps1'
$stateDir = Join-Path $env:APPDATA 'streamstein\comments-catchup'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher not found: $launcher" }

# ONE string, with the path quoted inside it. This is the whole point of the script.
$argString = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Workers {1} -DelayMinutes {2}' -f $launcher, $Workers, $DelayMinutes

$out = Join-Path $stateDir 'parked-resume.out.log'
$err = Join-Path $stateDir 'parked-resume.err.log'
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argString -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

Start-Sleep -Seconds 6
$alive = -not $p.HasExited
Write-Output ("parked launcher pid={0} alive={1} workers={2} delay={3}min" -f $p.Id, $alive, $Workers, $DelayMinutes)
if (-not $alive) {
    Write-Output "LAUNCHER DIED - stderr:"
    if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Tail 6 }
}
