@echo off
REM 一条命令跑起来（Windows）：
REM   1) 把要干活的项目目录拖到窗口里，或者直接双击（默认用当前目录）
REM   2) 打开 http://127.0.0.1:5175
setlocal
set IMAGE=mini-harness
set PROJECT=%~1
if "%PROJECT%"=="" set PROJECT=%CD%

where docker >nul 2>nul
if errorlevel 1 (
  echo [!] 没找到 docker 命令。装好 Docker Desktop 再试，或者直接用 Node 跑：node server.js
  exit /b 1
)

echo [1/2] 构建镜像（本项目零依赖，构建很快，不用下载 npm 包）
docker build -t %IMAGE% "%~dp0" || exit /b 1

echo [2/2] 启动：工作区 = %PROJECT%
echo       界面   = http://127.0.0.1:5175   （Ctrl+C 停止）
docker run --rm -it -p 5175:5175 -v "%PROJECT%:/workspace" -v mini-harness-data:/data %IMAGE%
