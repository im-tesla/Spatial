$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$downloadRoot = Join-Path $PSScriptRoot 'downloads'
$extractRoot = Join-Path $downloadRoot 'mpv'
$binaryRoot = Join-Path $workspaceRoot 'apps/desktop/src-tauri/binaries'
$archive = Join-Path $downloadRoot 'mpv.7z'
$url = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261007/mpv-x86_64-20261007-git-eb0ee10315.7z'
$expectedHash = '6720298e1c32dc9ee60970db1c94c8170dbf33520e48eb9d3258584835c96f81'

function Get-RemoteFile {
    param([string]$Uri, [string]$OutFile)
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -MaximumRedirection 5 -UseBasicParsing
            return
        } catch {
            if ($attempt -eq 4) { throw }
            Write-Warning "Download failed (attempt $attempt of 4): $($_.Exception.Message)"
            Start-Sleep -Seconds (3 * $attempt)
        }
    }
}

function Get-RemoteText {
    param([string]$Uri)
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            return (Invoke-WebRequest -Uri $Uri -MaximumRedirection 5 -UseBasicParsing).Content
        } catch {
            if ($attempt -eq 4) { throw }
            Write-Warning "Download failed (attempt $attempt of 4): $($_.Exception.Message)"
            Start-Sleep -Seconds (3 * $attempt)
        }
    }
}

New-Item -ItemType Directory -Force -Path $downloadRoot,$extractRoot,$binaryRoot | Out-Null
if (Test-Path -LiteralPath $archive) {
    $existingHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existingHash -ne $expectedHash) { Remove-Item -LiteralPath $archive -Force }
}
if (-not (Test-Path -LiteralPath $archive)) { Get-RemoteFile -Uri $url -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Downloaded mpv archive does not match the pinned SHA-256 digest.'
}
tar -xf $archive -C $extractRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot extract mpv archive with Windows tar.' }
Copy-Item -LiteralPath (Join-Path $extractRoot 'mpv.exe') -Destination (Join-Path $binaryRoot 'mpv-x86_64-pc-windows-msvc.exe') -Force
$licensePath = Join-Path $extractRoot 'doc/Copyright.txt'
if (-not (Test-Path -LiteralPath $licensePath)) {
    $licenseText = Get-RemoteText -Uri 'https://raw.githubusercontent.com/mpv-player/mpv/eb0ee10315/Copyright'
} else { $licenseText = Get-Content -LiteralPath $licensePath -Raw }
Set-Content -LiteralPath (Join-Path $binaryRoot 'mpv-license.txt') -Value $licenseText -Encoding utf8
foreach ($licenseName in @('GPL','LGPL')) {
    $fullLicense = Get-RemoteText -Uri "https://raw.githubusercontent.com/mpv-player/mpv/eb0ee10315/LICENSE.$licenseName"
    Set-Content -LiteralPath (Join-Path $binaryRoot "mpv-$licenseName.txt") -Value $fullLicense -Encoding utf8
}
Set-Content -LiteralPath (Join-Path $binaryRoot 'mpv-source.txt') -Encoding utf8 -Value @"
Spatial bundles mpv build mpv-x86_64-20261007-git-eb0ee10315.
Binary archive: $url
Archive SHA-256: $expectedHash
Player source: https://github.com/mpv-player/mpv/tree/eb0ee10315
Build scripts and dependency source configuration: https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261007
mpv licensing: https://github.com/mpv-player/mpv/blob/eb0ee10315/Copyright
This build is pinned because Spatial relies on --ad=- to disallow PCM fallback.
For public redistribution, supply the corresponding source for the complete binary
and its linked dependencies as required by the licenses in this build.
"@
Write-Output 'Pinned mpv engine is ready.'
