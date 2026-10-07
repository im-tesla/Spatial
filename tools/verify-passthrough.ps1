param([Parameter(Mandatory = $true)][string]$MediaFile)
$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $workspaceRoot 'apps/desktop/src-tauri/binaries/mpv-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path -LiteralPath $engine)) { throw 'Run tools/setup-mpv.ps1 first.' }
$sourceFile = (Resolve-Path -LiteralPath $MediaFile).Path
$common = @('--no-config','--load-scripts=no','--vid=no','--audio-spdif=eac3,truehd','--ad=-','--length=0.2')
# These checks never play sound: one uses a null sink and one a nonexistent endpoint.
$encodedOutput = (& $engine @common '--ao=null' $sourceFile 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $encodedOutput -notmatch 'AO: \[null\].*spdif-(eac3|truehd)') {
    throw "The engine did not establish compressed Dolby output to the null sink: $encodedOutput"
}
$rejectedOutput = (& $engine @common '--audio-device=wasapi/spatial-deliberately-missing-endpoint' $sourceFile 2>&1 | Out-String)
if ($LASTEXITCODE -eq 0 -or $rejectedOutput -notmatch 'Failed to initialize a decoder' -or $rejectedOutput -match 'AO: \[wasapi\].*(s16|s32|float)') {
    throw "PCM fallback was not rejected as expected: $rejectedOutput"
}
Write-Output 'PASS: compressed Dolby packets reach the null sink; an unavailable endpoint fails without PCM output.'
Write-Output 'Hardware compatibility should be checked on the intended HDMI/AVR setup.'
