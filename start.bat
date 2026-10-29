@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 找一个能用的 node：优先用 PATH 里的，找不到就用 WorkBuddy 自带的那个
set "NODE_BIN=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" (
    set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  ) else (
    echo 没找到 node.exe。请先安装 Node.js 18 以上版本，再双击本文件。
    pause
    exit /b 1
  )
)

if not exist "_agent.key" (
  echo 缺少 _agent.key —— 请把 DeepSeek 密钥写进这个文件，再双击启动。
  echo 也可以设置环境变量 DEEPSEEK_API_KEY 代替。
  pause
  exit /b 1
)

echo.
echo 正在启动「巴菲特午餐会」Agent，浏览器会自动打开对话页。
echo 想停下来就把这个黑窗口关掉（Ctrl+C 也可以）。
echo.

start "" http://127.0.0.1:8099/index.html#/talk
"%NODE_BIN%" agent.js
pause
