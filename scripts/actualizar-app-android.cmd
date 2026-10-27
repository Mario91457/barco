@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0actualizar-app-android.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo La actualizacion de Android fallo. Revisa el mensaje anterior.
pause
exit /b %RESULT%
