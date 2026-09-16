@echo off
REM Secure Bun-container launcher. All logic is in an ASCII PowerShell script.
REM Usage: docker-run.cmd D:\path\to\project
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-run.ps1" %*
exit /b %errorlevel%
