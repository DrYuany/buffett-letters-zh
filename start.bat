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

rem 密钥可以在项目里的 _agent.key，也可以在用户目录下的 .buffett-agent.key。
rem 推荐放用户目录：项目目录要打包、要发布，少一个泄密口。
if not exist "_agent.key" if not exist "%USERPROFILE%\.buffett-agent.key" (
  echo 还没配置 DeepSeek 密钥。
  echo 请把密钥写进下面任意一个文件（内容只有一行 sk- 开头的那串）：
  echo   1^) %USERPROFILE%\.buffett-agent.key   （推荐，不随项目走）
  echo   2^) %~dp0_agent.key                    （项目目录内）
  echo 也可以设置环境变量 DEEPSEEK_API_KEY 代替。
  echo.
  echo 没有密钥也能用：站点本身可以离线阅读，只是问答会退回关键词检索。
  pause
)

echo.
echo 正在启动「巴菲特午餐会」Agent，浏览器会自动打开对话页。
echo 想停下来就把这个黑窗口关掉（Ctrl+C 也可以）。
echo.

start "" http://127.0.0.1:8099/index.html#/talk
"%NODE_BIN%" agent.js
pause
