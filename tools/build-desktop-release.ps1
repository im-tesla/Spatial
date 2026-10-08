param(
    [string]$SigningKeyPath = '',
    [string]$PasswordPath = '',
    [string]$TargetDirectory = ''
)
$ErrorActionPreference = 'Stop'
$taskWorkspaceRoot = Split-Path -Parent $PSScriptRoot
if (-not $SigningKeyPath) { $SigningKeyPath = Join-Path $taskWorkspaceRoot 'config/private/updater.key' }
if (-not $PasswordPath) { $PasswordPath = Join-Path $taskWorkspaceRoot 'config/private/updater.password' }
if (-not (Test-Path -LiteralPath $SigningKeyPath) -or -not (Test-Path -LiteralPath $PasswordPath)) {
    throw 'Provide the release signing key and password file.'
}
$taskPreviousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$taskPreviousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$taskPreviousInstaller = $env:SPATIAL_UPDATE_INSTALLER
$taskPreviousTarget = $env:CARGO_TARGET_DIR
if (-not $TargetDirectory) { $TargetDirectory = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $taskWorkspaceRoot 'target' } }
$taskBuildRoot = [IO.Path]::GetFullPath($TargetDirectory)
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $SigningKeyPath).Path
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $PasswordPath).Path).TrimEnd("`r", "`n")
    $env:CARGO_TARGET_DIR = $taskBuildRoot
    Push-Location (Join-Path $taskWorkspaceRoot 'apps/desktop')
    try {
        npm run tauri -- build --config src-tauri/tauri.release.conf.json -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'Signed desktop build failed.' }
        $taskVersion = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
        $env:SPATIAL_UPDATE_INSTALLER = Join-Path $taskBuildRoot "release/bundle/nsis/Spatial_${taskVersion}_x64-setup.exe"
        cargo test --locked --target-dir (Join-Path $taskWorkspaceRoot 'target') -p spatial-desktop update_tests::built_installer_has_valid_versioned_signature -- --ignored
        if ($LASTEXITCODE -ne 0) { throw 'Signed installer verification failed.' }
    } finally { Pop-Location }
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $taskPreviousKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $taskPreviousPassword
    $env:SPATIAL_UPDATE_INSTALLER = $taskPreviousInstaller
    $env:CARGO_TARGET_DIR = $taskPreviousTarget
}
