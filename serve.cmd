@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "PROJECT_ROOT=%~dp0"
set "PYTHON_EXE="

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PYTHON_EXE=python"
)

if not defined PYTHON_EXE (
  where py >nul 2>nul
  if !ERRORLEVEL!==0 set "PYTHON_EXE=py -3"
)

if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
  set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)

if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
  set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
)

if not defined PYTHON_EXE (
  echo Python was not found. Install Python or add it to PATH.
  exit /b 1
)

cd /d "%PROJECT_ROOT%"
%PYTHON_EXE% server.py --host 127.0.0.1 --port 8099 %*
exit /b %ERRORLEVEL%
