@echo off
setlocal
title Optical Link Power Budget ^& Attenuation Analyzer - 26ECE31H (Group 9)

:: Switch to the directory containing this batch file (supports non-C: drives)
cd /d "%~dp0"

echo ============================================================================
echo   Optical Link Power Budget ^& Attenuation Analyzer
echo   Course: 26ECE31H Fiber Optic Communications  ^|  Option 2  ^|  Group 9
echo ============================================================================
echo.

:: Auto-detect Python runtime: py -3.13 -> py -> python
set "PY_CMD="

py -3.13 -c "import sys" >nul 2>&1
if %errorlevel%==0 (
    set "PY_CMD=py -3.13"
    goto :found_python
)

py -c "import sys" >nul 2>&1
if %errorlevel%==0 (
    set "PY_CMD=py"
    goto :found_python
)

python -c "import sys" >nul 2>&1
if %errorlevel%==0 (
    set "PY_CMD=python"
    goto :found_python
)

echo [ERROR] Python 3 was not found on this machine.
echo         Please install Python 3.10+ from https://www.python.org/downloads/
echo         and ensure the Python Launcher ^(py^) or PATH option is checked.
echo.
pause
exit /b 1

:found_python
for /f "delims=" %%v in ('%PY_CMD% --version 2^>^&1') do set "PY_VER=%%v"
echo [OK] Using %PY_VER% ^(%PY_CMD%^)

:: Verify NumPy is installed
%PY_CMD% -c "import numpy" >nul 2>&1
if not %errorlevel%==0 goto :missing_numpy

echo [OK] NumPy detected.
echo.
echo Starting local workstation server and opening your browser...
echo Keep this window open while using the tool. Press Ctrl+C to stop.
echo.

%PY_CMD% app.py %*
set "EXIT_CODE=%errorlevel%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Application exited with error code %EXIT_CODE%.
) else (
    echo Local server stopped cleanly.
)
echo.
pause
exit /b %EXIT_CODE%

:missing_numpy
echo.
echo [ERROR] Required Python package 'numpy' is not installed for %PY_CMD%.
echo         Install it by running:
echo             %PY_CMD% -m pip install numpy
echo         To also regenerate 300 DPI report figures, run:
echo             %PY_CMD% -m pip install numpy matplotlib
echo.
pause
exit /b 1
