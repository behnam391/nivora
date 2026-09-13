@echo off
setlocal
taskkill /IM Nivora.exe /F >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Nivora VPN.lnk" >nul 2>&1
del "%USERPROFILE%\Desktop\Nivora VPN.lnk" >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\NivoraVPN" /f >nul 2>&1
start "" /min cmd.exe /c "timeout /t 2 /nobreak >nul & rmdir /s /q "%LOCALAPPDATA%\Programs\Nivora VPN""
exit /b 0
