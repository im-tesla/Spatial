$ErrorActionPreference = 'Stop'

$toolsRoot = Join-Path $env:LOCALAPPDATA 'tauri'
$nsisRoot = Join-Path $toolsRoot 'NSIS'
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$archive = Join-Path $tempRoot 'nsis-3.11.zip'
$extractRoot = Join-Path $tempRoot 'nsis-extract'
$nsisUrl = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'
$nsisSha1 = 'EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D'
$utilsUrl = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
$utilsSha1 = '75197FEE3C6A814FE035788D1C34EAD39349B860'

function Get-RemoteFile {
    param([string]$Uri, [string]$OutFile, [int]$Attempts = 6)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -MaximumRedirection 5 -UseBasicParsing -TimeoutSec 90
            return
        } catch {
            if ($attempt -eq $Attempts) { throw }
            Write-Warning "Download failed (attempt $attempt of $Attempts): $($_.Exception.Message)"
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

function Assert-Hash {
    param([string]$Path, [string]$Expected, [string]$Label)
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash.ToUpperInvariant()
    if ($actual -ne $Expected) { throw "$Label SHA-1 mismatch: expected $Expected, got $actual" }
}

New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $archive) | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $nsisRoot 'makensis.exe'))) {
    if (Test-Path -LiteralPath $nsisRoot) { Remove-Item -LiteralPath $nsisRoot -Recurse -Force }
    Get-RemoteFile -Uri $nsisUrl -OutFile $archive
    Assert-Hash -Path $archive -Expected $nsisSha1 -Label 'NSIS archive'
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
    $extracted = Join-Path $extractRoot 'nsis-3.11'
    if (-not (Test-Path -LiteralPath $extracted)) { throw 'NSIS archive did not contain nsis-3.11.' }
    Move-Item -LiteralPath $extracted -Destination $nsisRoot
}

$utilsPath = Join-Path $nsisRoot 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll'
if (-not (Test-Path -LiteralPath $utilsPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $utilsPath) | Out-Null
    Get-RemoteFile -Uri $utilsUrl -OutFile $utilsPath
}
Assert-Hash -Path $utilsPath -Expected $utilsSha1 -Label 'NSIS Tauri utilities'

$required = @(
    'makensis.exe',
    'Bin/makensis.exe',
    'Stubs/lzma-x86-unicode',
    'Stubs/lzma_solid-x86-unicode',
    'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
    'Include/MUI2.nsh',
    'Include/FileFunc.nsh',
    'Include/x64.nsh',
    'Include/nsDialogs.nsh',
    'Include/WinMessages.nsh',
    'Include/Win/COM.nsh',
    'Include/Win/Propkey.nsh',
    'Include/Win/RestartManager.nsh'
)
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $nsisRoot $file))) { throw "NSIS cache is missing $file" }
}
Write-Output "NSIS toolchain is ready at $nsisRoot"
