@echo off
rem Builds every Darktide mission in one resumable queue; missions that already have a pack are skipped.
rem Close Darktide first. Set the game and source folders in config.local.json (see config.example.json) if needed.
cd /d "%~dp0.."
python --version >nul 2>nul || (echo Python 3.10+ was not found on PATH. & pause & exit /b 1)
if not exist "cache\raw" (
  echo cache\raw is missing: run run.bat once first, or python pipeline\extract.py
  pause & exit /b 1
)
cd pipeline
python build_all.py --missing --tex-max 1024
pause
