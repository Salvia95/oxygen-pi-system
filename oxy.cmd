@echo off
rem oxygen-pi-system launcher for cmd / PowerShell / Windows Terminal. Delegates to the bash launcher via Git Bash.
rem Git Bash: OXY_GIT_BASH in agent\oxy.env (written by the installer), otherwise %ProgramFiles%\Git\bin\bash.exe
setlocal
set "OXY_BASH="
if exist "%~dp0agent\oxy.env" for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0agent\oxy.env") do if "%%A"=="OXY_GIT_BASH" set "OXY_BASH=%%B"
if defined OXY_BASH set "OXY_BASH=%OXY_BASH:'=%"
if not defined OXY_BASH set "OXY_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%OXY_BASH%" goto nobash
"%OXY_BASH%" "%~dp0oxy" %*
exit /b %ERRORLEVEL%

:nobash
echo [oxy] Git Bash not found: %OXY_BASH%
echo [oxy] Install Git for Windows, or set OXY_GIT_BASH in agent\oxy.env
exit /b 1
