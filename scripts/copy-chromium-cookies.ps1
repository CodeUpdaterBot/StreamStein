<#
    Copy Chromium's cookie database into a throwaway profile that yt-dlp can read.

    Chromium (unlike Chrome) has no App-Bound Encryption: its cookies are plain DPAPI
    "v10" values, so yt-dlp decrypts them normally. The only obstacle is that Chromium
    holds the Cookies file open while it runs (yt-dlp issue #7271), which is why the file
    is copied here with FileShare::ReadWrite instead of being read in place - that means
    the user can stay signed in with the browser open.

    The copy is a live credential store: delete it once yt-dlp has used it.

    NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
    unless they have a BOM, so a non-ASCII character (an em dash, a smart quote) gets
    mis-decoded and breaks parsing with a confusing "Missing closing '}'" error.

    Usage:
        powershell -NoProfile -ExecutionPolicy Bypass -File copy-chromium-cookies.ps1 `
            -Dest <folder> [-ProfileName 'Profile 3']
#>
param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$ProfileName = 'Profile 3'
)

$ErrorActionPreference = 'Stop'

function Copy-Locked {
    param([string]$Src, [string]$Dst)
    if (-not (Test-Path -LiteralPath $Src)) { throw "missing source: $Src" }
    $fs = [System.IO.File]::Open($Src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $out = [System.IO.File]::Create($Dst)
        try { $fs.CopyTo($out) } finally { $out.Close() }
    } finally { $fs.Close() }
    Write-Output ("  copied {0} ({1:N0} bytes)" -f (Split-Path -Leaf $Src), (Get-Item -LiteralPath $Dst).Length)
}

$userData = Join-Path $env:LOCALAPPDATA 'Chromium\User Data'
Write-Output "chromium user data: $userData"
if (-not (Test-Path -LiteralPath $userData)) { throw "Chromium user data not found at $userData" }

New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'Default\Network') | Out-Null
Copy-Locked -Src (Join-Path $userData 'Local State') -Dst (Join-Path $Dest 'Local State')
Copy-Locked -Src (Join-Path $userData "$ProfileName\Network\Cookies") -Dst (Join-Path $Dest 'Default\Network\Cookies')

# Report session cookies BY NAME only - never values.
Write-Output "source profile: $ProfileName"
Write-Output "dest: $Dest"
