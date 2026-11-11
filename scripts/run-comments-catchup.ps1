<#
    Launch the StreamStein comments catch-up as N sharded workers.

    Usage (from anywhere):
        powershell -NoProfile -ExecutionPolicy Bypass -File run-comments-catchup.ps1

    Workers are DETACHED (Start-Process + hidden window), so they survive this script
    exiting, the Hermes session, and the app restarting. Run them this way rather than
    through a background shell wrapper: the wrapper kills the job with
    "stdin is not a tty".

    Sharding: worker i takes videos where (index in the full, sorted video list) % N == i.
    The assignment is computed from the full list, never from "what is left", so a video
    always belongs to the same worker no matter what has been captured meanwhile — the
    workers cannot collide. Each worker keeps its own state/summary/log
    (state-shard1of3.json, catchup-shard1of3.log, ...), and catalog writes are serialised
    by a lock file (withCatalogLock in src/ipc/youtubeComments.js).

    Progress lives in %APPDATA%\streamstein\comments-catchup — read it, don't poll a process.
#>

param(
    # Number of parallel workers. 3 is the sweet spot measured on this machine: ~413
    # videos/h combined versus ~47 videos/h single, without tripping YouTube's throttling.
    [int]$Workers = 3,
    # Per-video comment ceiling and library-wide budget (see comments-catchup.cjs).
    [int]$MaxPerVideo = 10000,
    [int]$MaxTotal = 10000000,
    # 0 = run all shards in this session; >0 = re-capture just that many capped videos first.
    [int]$CappedPass = 0
)

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\PC\Documents\Coding Projects\StreamStein'
# System node on purpose: a Hermes update must not break a multi-hour run.
$node = 'C:\Program Files\nodejs\node.exe'
$stateDir = Join-Path $env:APPDATA 'streamstein\comments-catchup'

if (-not (Test-Path $node)) { throw "node not found at $node" }
if (-not (Test-Path (Join-Path $repo 'scripts\comments-catchup.cjs'))) { throw "comments-catchup.cjs not found in $repo" }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if ($CappedPass -gt 0) {
    Write-Output "re-capturing up to $CappedPass capped videos first..."
    & $node (Join-Path $repo 'scripts\comments-catchup.cjs') --only-capped --max $MaxPerVideo --max-total $MaxTotal
}

Write-Output "launching $Workers sharded workers..."
for ($i = 0; $i -lt $Workers; $i++) {
    $args = @(
        (Join-Path $repo 'scripts\comments-catchup.cjs'),
        '--shard', "$i/$Workers",
        '--max', "$MaxPerVideo",
        '--max-total', "$MaxTotal"
    )
    Start-Process -FilePath $node -ArgumentList $args `
        -WorkingDirectory $repo -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $stateDir "shard$i.out.log") `
        -RedirectStandardError  (Join-Path $stateDir "shard$i.err.log")
    Write-Output "  worker $($i + 1)/$Workers started (shard $i/$Workers)"
}

Start-Sleep -Seconds 5
$live = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*comments-catchup*' })
Write-Output "workers alive: $($live.Count)"
Write-Output "logs: $stateDir\catchup-shard*of$Workers.log"
