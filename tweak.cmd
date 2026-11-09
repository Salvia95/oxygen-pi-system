@echo off
rem oxygen-pi-system comprehensive settings (Tweak TUI). Uses the bundled Node runtime only.
setlocal
chcp 65001 >nul
"%~dp0runtime\node\node.exe" "%~dp0installer\tweak.mjs" %*
set "OXY_RC=%ERRORLEVEL%"
if not "%OXY_RC%"=="0" pause
exit /b %OXY_RC%
