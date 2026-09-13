param([string]$ReleaseRoot = 'D:\VPN\release')
$ErrorActionPreference='Stop'
$source=Join-Path $ReleaseRoot 'Nivora-Desktop-1.2.0'
$zip=Join-Path $ReleaseRoot 'Nivora-Desktop-1.2.0.zip'
$stage=Join-Path $ReleaseRoot 'installer-stage-1.2.0'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.cmd') -Destination (Join-Path $source 'uninstall.cmd') -Force
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $zip -Force
Copy-Item -LiteralPath $zip -Destination (Join-Path $stage 'Nivora-Desktop-1.2.0.zip') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.cmd') -Destination (Join-Path $stage 'install.cmd') -Force
$sed=Join-Path $stage 'nivora.sed'
$output=Join-Path $ReleaseRoot 'Nivora-Windows-Setup-1.2.0.exe'
@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$output
FriendlyName=Nivora VPN 1.2.0
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=install.cmd
UserQuietInstCmd=install.cmd
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=Nivora-Desktop-1.2.0.zip
%FILE1%=install.cmd
[Strings]
FILE0=Nivora-Desktop-1.2.0.zip
FILE1=install.cmd
"@ | Set-Content -LiteralPath $sed -Encoding Ascii
& "$env:WINDIR\System32\iexpress.exe" /N $sed
$deadline=(Get-Date).AddSeconds(20)
while(!(Test-Path -LiteralPath $output) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 250}
if(!(Test-Path -LiteralPath $output)){throw 'Installer build failed'}
Get-Item $output
