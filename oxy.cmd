@echo off
rem oxygen-pi-system launcher for cmd / Windows Terminal. Delegates to the bash launcher via Git Bash.
setlocal
set "OXY_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%OXY_BASH%" (
  echo [oxy] Git Bash not found: %OXY_BASH%
  exit /b 1
)
"%OXY_BASH%" "%~dp0oxy" %*
exit /b %ERRORLEVEL%
