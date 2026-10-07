$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$downloadRoot = Join-Path $PSScriptRoot 'downloads'
$extractRoot = Join-Path $downloadRoot 'mpv'
$binaryRoot = Join-Path $workspaceRoot 'apps/desktop/src-tauri/binaries'
$archive = Join-Path $downloadRoot 'mpv.7z'
$url = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261007/mpv-x86_64-20261007-git-eb0ee10315.7z'
$expectedHash = '6720298e1c32dc9ee60970db1c94c8170dbf33520e48eb9d3258584835c96f81'
New-Item -ItemType Directory -Force -Path $downloadRoot,$extractRoot,$binaryRoot | Out-Null
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $url -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Downloaded mpv archive does not match the pinned SHA-256 digest.'
}
tar -xf $archive -C $extractRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot extract mpv archive with Windows tar.' }
Copy-Item -LiteralPath (Join-Path $extractRoot 'mpv.exe') -Destination (Join-Path $binaryRoot 'mpv-x86_64-pc-windows-msvc.exe') -Force
$licensePath = Join-Path $extractRoot 'doc/Copyright.txt'
if (-not (Test-Path -LiteralPath $licensePath)) {
    $licenseText = (Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/mpv-player/mpv/eb0ee10315/Copyright').Content
} else { $licenseText = Get-Content -LiteralPath $licensePath -Raw }
Set-Content -LiteralPath (Join-Path $binaryRoot 'mpv-license.txt') -Value $licenseText -Encoding utf8
foreach ($licenseName in @('GPL','LGPL')) {
    $fullLicense = (Invoke-WebRequest -Uri "https://raw.githubusercontent.com/mpv-player/mpv/eb0ee10315/LICENSE.$licenseName").Content
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
