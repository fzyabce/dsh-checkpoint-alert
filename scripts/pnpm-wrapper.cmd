@echo off
REM 给 dsh-plugin-dev verify 用的 pnpm 包装：宿主自带的 pnpm 只有 .cjs/.mjs，没有 .cmd。
REM 用法：dsh-plugin-dev verify --pnpm "<本文件绝对路径>"
setlocal
set PNPM_CJS=D:\DeepSeekHarness\resources\runtime\pnpm\bin\pnpm.cjs
set NODE_EXE=D:\Node.js\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=D:\DeepSeekHarness\resources\runtime\bin\node.exe
"%NODE_EXE%" "%PNPM_CJS%" %*
exit /b %ERRORLEVEL%
