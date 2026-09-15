@echo off
REM Windows launcher. All logic lives in scripts\run.ps1 (this file stays ASCII-only
REM because cmd.exe parses .cmd files with the OEM codepage).
REM
REM   run.cmd                 use current directory as workspace
REM   run.cmd D:\my-project   use the given directory as workspace
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
exit /b %errorlevel%
