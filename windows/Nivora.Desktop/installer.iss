#define MyAppName "Nivora VPN"
#define MyAppVersion "1.2.0"
#define MyAppExeName "Nivora.exe"
[Setup]
AppId={{B54FD947-7AA3-4F52-A334-7623B693DA16}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\Nivora VPN
DefaultGroupName=Nivora VPN
OutputBaseFilename=Nivora-Windows-Setup-1.2.0
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=nivora.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
PrivilegesRequired=admin
[Files]
Source: "dist\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\Nivora VPN"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Nivora VPN"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
[Tasks]
Name: "desktopicon"; Description: "ساخت میانبر روی دسکتاپ"; GroupDescription: "میانبرها:"; Flags: checkedonce
[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "اجرای Nivora VPN"; Flags: nowait postinstall skipifsilent
