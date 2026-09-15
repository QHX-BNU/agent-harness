@echo off
REM Windows launcher. All logic lives in scripts\run.ps1 (this file stays ASCII-only
REM because cmd.exe parses .cmd files with the OEM codepage).
REM
REM   run.cmd                 use current directory as workspace
REM   run.cmd D:\my-project   use the given directory as workspace
REM   run.cmd --jail          real sandbox: Node permission model, no shell tool
REM   run.cmd --jail --allow-shell   jail but keep the shell tool (isolation degrades)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
exit /b %errorlevel%
