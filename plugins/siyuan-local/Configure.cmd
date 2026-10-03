@echo off
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then reopen this file.
  pause
  exit /b 1
)
node "%~dp0server\configure.mjs"
if errorlevel 1 pause
