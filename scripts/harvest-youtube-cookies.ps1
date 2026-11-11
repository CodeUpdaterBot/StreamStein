<#
    Export the user's YouTube cookies for the comment fetcher, then hand them to yt-dlp.

    The chain, and why each link is necessary:
      Chrome 157 (App-Bound Encryption) -> no outside process can decrypt the cookie DB, so
      yt-dlp's --cookies-from-browser cannot work.
      Chrome 136+                       -> --remote-debugging-port is ignored on the real
      profile, so CDP read-back cannot work either.
      An unpacked extension             -> asks CHROME for the cookies through the supported
      chrome.cookies API and posts them to a local listener. Chrome decrypts them itself,
      which is the only thing that works.

    Requires Chrome to be CLOSED (the extension is only loaded at browser start, and one
    profile serves one browser). The user has approved closing it.

    Usage: powershell -NoProfile -ExecutionPolicy Bypass -File harvest-youtube-cookies.ps1
#>
param(
    [int]$TimeoutSeconds = 90,
    [switch]$KeepChromeOpen
)

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\PC\Documents\Coding Projects\StreamStein'
$node = 'C:\Program Files\nodejs\node.exe'
$chromeExe = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
$ext = Join-Path $repo 'scripts\cookie-harvest\extension'
$stateDir = Join-Path $env:APPDATA 'streamstein'
$out = Join-Path $stateDir 'youtube-cookies.txt'
$logOut = Join-Path $stateDir 'cookie-harvest.out.log'
$logErr = Join-Path $stateDir 'cookie-harvest.err.log'
$profile = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'

if (-not (Test-Path -LiteralPath $ext)) { throw "extension not found: $ext" }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $logOut -ErrorAction SilentlyContinue

# Listener starts first so the extension's first attempt already has somewhere to post.
$server = Start-Process -FilePath $node -ArgumentList 'scripts/cookie-harvest-server.cjs', '--out', $out, '--timeout', $TimeoutSeconds `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru
Start-Sleep -Seconds 2

# ONE pre-quoted argument string: Start-Process splits a multi-element -ArgumentList on
# whitespace, which would break the extension path ("Coding Projects").
$chromeArgs = '--user-data-dir="{0}" --load-extension="{1}" --no-first-run --no-default-browser-check "{2}"' -f $profile, $ext, 'https://www.youtube.com/'
$chrome = Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $out) {
        if ((Get-Item -LiteralPath $out).Length -gt 512) { break }
    }
    Start-Sleep -Seconds 3
}

Write-Output ("server exited early: {0}" -f $server.HasExited)
if (Test-Path -LiteralPath $logOut) { Get-Content -LiteralPath $logOut -Tail 4 }
if (Test-Path -LiteralPath $out) {
    $rows = Get-Content -LiteralPath $out | Where-Object { $_ -notmatch '^#' -and $_ -match "`t" }
    $names = $rows | ForEach-Object { ($_ -split "`t")[5] }
    Write-Output ("cookies.txt: {0} rows, {1:N0} bytes" -f $rows.Count, (Get-Item -LiteralPath $out).Length)
    Write-Output ("has SID: {0} | has LOGIN_INFO: {1} | has __Secure-1PSID: {2}" -f `
        ($names -contains 'SID'), ($names -contains 'LOGIN_INFO'), ($names -contains '__Secure-1PSID'))
} else {
    Write-Output "NO cookies.txt produced - extension did not post"
    if (Test-Path -LiteralPath $logErr) { Write-Output "stderr:"; Get-Content -LiteralPath $logErr -Tail 6 }
}

if (-not $KeepChromeOpen) {
    Stop-Process -Id $chrome.Id -Force -ErrorAction SilentlyContinue
}
if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
