param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$signingHome = Join-Path $env:USERPROFILE '.nivora-signing'
$credentialPath = Join-Path $signingHome 'credentials.xml'
$keystorePath = Join-Path $signingHome 'nivora-release.jks'
if (!(Test-Path -LiteralPath $credentialPath) -or !(Test-Path -LiteralPath $keystorePath)) {
    throw 'Nivora signing key is not initialized on this computer.'
}
$credential = Import-Clixml -LiteralPath $credentialPath
$env:NIVORA_KEYSTORE_PATH = $keystorePath
$env:NIVORA_KEYSTORE_PASSWORD = $credential.GetNetworkCredential().Password
$env:NIVORA_KEY_ALIAS = $credential.UserName
$env:NIVORA_KEY_PASSWORD = $credential.GetNetworkCredential().Password
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
Push-Location $PSScriptRoot
try {
    & .\gradlew.bat :app:assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
    if (!$BuildOnly) {
        Get-ChildItem app\build\outputs\apk\release\*.apk | Select-Object FullName,Length
    }
} finally {
    Pop-Location
    Remove-Item Env:NIVORA_KEYSTORE_PASSWORD,Env:NIVORA_KEY_ALIAS,Env:NIVORA_KEY_PASSWORD -ErrorAction SilentlyContinue
}
