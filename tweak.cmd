@echo off
rem oxygen-pi-system comprehensive settings (Tweak TUI). Uses the bundled Node runtime only.
setlocal
chcp 65001 >nul
rem Marker file: exists only while the screen program (bin\oxy-tui.exe) holds the alternate screen.
rem If Node is killed, the screen program dies with it and cannot restore the terminal; the marker
rem is then left behind and restore-terminal.mjs puts the terminal back. Without a marker nothing is
rem written (leaving the alternate screen twice would move the cursor over earlier output).
set "OXY_TUI_MARK=%TEMP%\oxy-tui-%RANDOM%%RANDOM%.mark"
"%~dp0runtime\node\node.exe" "%~dp0installer\tweak.mjs" %*
set "OXY_RC=%ERRORLEVEL%"
if exist "%OXY_TUI_MARK%" "%~dp0runtime\node\node.exe" "%~dp0installer\restore-terminal.mjs" "%OXY_TUI_MARK%"
if not "%OXY_RC%"=="0" pause
exit /b %OXY_RC%
