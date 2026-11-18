# Install or update Plyfold from the newest GitHub release (Windows 10/11, x64).
#   irm https://raw.githubusercontent.com/Tettu0530/plyfold/main/install.ps1 | iex
#
# A file fetched by PowerShell is not marked as downloaded from the internet, so SmartScreen does not stop the
# unsigned installer. It installs for the current user (no administrator rights) and adds a Start menu entry.
# The file is checked against the release's SHA256SUMS.txt (from 0.3.0 on).
#
# Set $env:PLYFOLD_VERSION (e.g. 0.3.0) to install that version instead of the newest release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest far slower

$repo = 'Tettu0530/plyfold'
if ($env:PLYFOLD_VERSION) {
    $tag = 'v' + $env:PLYFOLD_VERSION.TrimStart('v')
} else {
    # The newest release (pre-releases included) from the releases feed, which unlike the API has no rate limit
    # for shared addresses
    $feed = [string](Invoke-WebRequest "https://github.com/$repo/releases.atom" -UseBasicParsing).Content
    if ($feed -notmatch '/releases/tag/(v[0-9][^"<]*)"') { throw 'No release found' }
    $tag = $Matches[1]
}
$version = $tag.TrimStart('v')
$base = "https://github.com/$repo/releases/download/$tag"
$name = "Plyfold_${version}_x64-setup.exe"

if (Get-Process plyfold-desktop -ErrorAction SilentlyContinue) {
    throw 'Plyfold is running. Close it and run this again'
}

$dir = Join-Path ([IO.Path]::GetTempPath()) ("plyfold-" + [Guid]::NewGuid())
New-Item -ItemType Directory $dir | Out-Null
try {
    $file = Join-Path $dir $name
    Write-Host "Downloading $name"
    try {
        Invoke-WebRequest "$base/$name" -OutFile $file -UseBasicParsing
    } catch {
        throw "$tag has no Windows installer ($base/$name)"
    }

    # Releases from 0.3.0 on list their checksums (saved to a file: the server sends it as binary data)
    $sums = Join-Path $dir 'SHA256SUMS.txt'
    $hasSums = $true
    try { Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile $sums -UseBasicParsing } catch { $hasSums = $false }
    if ($hasSums) {
        $line = Get-Content $sums | Where-Object { $_ -match " $([regex]::Escape($name))\s*$" } | Select-Object -First 1
        $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
        $got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
        if ($want -ne $got) { throw "Checksum mismatch for $name" }
    }

    Write-Host 'Installing'
    $p = Start-Process $file -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "The installer exited with code $($p.ExitCode)" }
    Write-Host "Installed Plyfold $tag. Start it from the Start menu."
} finally {
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
