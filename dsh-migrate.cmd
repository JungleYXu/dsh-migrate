@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

rem dsh-migrate launcher: prefer the Node runtime bundled with DSH, then system Node.
rem Keep this file ASCII-only: cmd.exe reads it in the OEM code page.

set "NODE_EXE="
if defined DSH_HOME (
  for /d %%D in ("%DSH_HOME%\dsh-runtimes\*") do (
    if exist "%%D\dependencies\node\bin\node.exe" set "NODE_EXE=%%D\dependencies\node\bin\node.exe"
  )
)
if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%D\dependencies\node\bin\node.exe" set "NODE_EXE=%%D\dependencies\node\bin\node.exe"
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE_EXE=%%~$PATH:N"

if not defined NODE_EXE (
  echo [x] Node runtime not found.
  echo     Start DeepSeek Harness once ^(it downloads the bundled runtime^), or install Node.js, then retry.
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  "%NODE_EXE%" "%~dp0dsh-migrate.mjs"
  set "RC=!ERRORLEVEL!"
  echo.
  pause
  exit /b !RC!
)

"%NODE_EXE%" "%~dp0dsh-migrate.mjs" %*
exit /b %ERRORLEVEL%
