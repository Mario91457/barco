@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cargar-firmware.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo La carga del firmware fallo. Revisa el mensaje anterior.
pause
exit /b %RESULT%
