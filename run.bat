@echo off
rem Darktide Map Viewer: starts the local server and opens the viewer in your browser (http://127.0.0.1:8740/).
cd /d "%~dp0"
python --version >nul 2>nul || (echo Python 3.10+ was not found on PATH. Install it from python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
if not exist "cache\raw" (
  if not exist "tools\limn.exe" (echo tools\limn.exe is missing. See tools\README.md. & pause & exit /b 1)
  echo First run: reading the Darktide game files into cache\ ^(close Darktide first^)...
  python pipeline\extract.py || (pause & exit /b 1)
)
python serve.py
pause
