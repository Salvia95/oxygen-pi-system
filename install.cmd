@echo off
rem oxygen-pi-system installer (TUI). Uses the bundled Node runtime only.
setlocal
chcp 65001 >nul
rem Marker file: exists only while the screen program (bin\oxy-tui.exe) holds the alternate screen.
rem If Node is killed, the screen program dies with it and cannot restore the terminal; the marker
rem is then left behind and restore-terminal.mjs puts the terminal back. Without a marker nothing is
rem written (leaving the alternate screen twice would move the cursor over earlier output).
set "OXY_TUI_MARK=%TEMP%\oxy-tui-%RANDOM%%RANDOM%.mark"
rem Update handoff (docs/tui-spec.md section 13): when "update" in the install folder picks a new bundle,
rem install.mjs writes this script and exits. Control then passes to the new bundle's installer and never
rem comes back here, because the update replaces this very file.
set "OXY_UPDATE_HANDOFF=%TEMP%\oxygen-pi-update-%RANDOM%%RANDOM%.cmd"
"%~dp0runtime\node\node.exe" "%~dp0installer\install.mjs" %*
set "OXY_RC=%ERRORLEVEL%"
if exist "%OXY_TUI_MARK%" "%~dp0runtime\node\node.exe" "%~dp0installer\restore-terminal.mjs" "%OXY_TUI_MARK%"
if "%OXY_RC%"=="0" if exist "%OXY_UPDATE_HANDOFF%" "%OXY_UPDATE_HANDOFF%"
if not "%OXY_RC%"=="0" pause
exit /b %OXY_RC%
