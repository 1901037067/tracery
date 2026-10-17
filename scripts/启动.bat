@echo off
chcp 65001 >nul
cd /d %~dp0..
echo ============================================
echo   Tracery - Obsidian 复刻学习版
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 20+
    pause
    exit /b 1
)

if not exist node_modules (
    echo [首次运行] 正在安装依赖...
    call npm install --no-audit --no-fund
)

if not exist tracery.config.json (
    echo {"currentVault":null,"recentVaults":[],"theme":"dark"} > tracery.config.json
)

echo [启动] http://localhost:9520
start "" http://localhost:9520
node server/server.js
pause
