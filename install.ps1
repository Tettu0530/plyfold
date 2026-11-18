# Install or update Plyfold from the newest GitHub release (Windows 10/11, x64).
#   irm https://raw.githubusercontent.com/Tettu0530/plyfold/main/install.ps1 | iex
#
# A file fetched by PowerShell is not marked as downloaded from the internet, so SmartScreen does not stop the
# unsigned installer. It installs for the current user (no administrator rights) and adds a Start menu entry.
# The file is checked against the release's SHA256SUMS.txt when the release has one.
#
# Set $env:PLYFOLD_VERSION (e.g. 0.3.0) to install that version instead of the newest release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest far slower

$repo = 'Tettu0530/plyfold'
$api = "https://api.github.com/repos/$repo/releases"
if ($env:PLYFOLD_VERSION) {
    $release = Invoke-RestMethod "$api/tags/v$($env:PLYFOLD_VERSION.TrimStart('v'))"
} else {
    # The newest release, pre-releases included
    $release = (Invoke-RestMethod "$api`?per_page=1")[0]
}
if (-not $release) { throw 'No release found' }

$asset = $release.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
if (-not $asset) { throw "$($release.tag_name) has no Windows installer" }

if (Get-Process plyfold-desktop -ErrorAction SilentlyContinue) {
    throw 'Plyfold is running. Close it and run this again'
}

$dir = Join-Path ([IO.Path]::GetTempPath()) ("plyfold-" + [Guid]::NewGuid())
New-Item -ItemType Directory $dir | Out-Null
try {
    $file = Join-Path $dir $asset.name
    Write-Host "Downloading $($asset.name)"
    Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing

    $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
    if ($sums) {
        $lines = (Invoke-WebRequest $sums.browser_download_url -UseBasicParsing).Content -split "`n"
        $want = ($lines | Where-Object { $_ -match " $([regex]::Escape($asset.name))\s*$" } | Select-Object -First 1) -replace ' .*', ''
        $got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
        if (-not $want -or $want.Trim().ToLower() -ne $got) { throw "Checksum mismatch for $($asset.name)" }
    }

    Write-Host 'Installing'
    $p = Start-Process $file -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "The installer exited with code $($p.ExitCode)" }
    Write-Host "Installed Plyfold $($release.tag_name). Start it from the Start menu."
} finally {
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
