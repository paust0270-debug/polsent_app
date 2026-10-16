@echo off
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title 셀러딜
if not exist ".env" (
  echo .env 가 없습니다. .env.example 을 복사해 파트너스 키를 넣어 주세요.
  pause
  exit /b 1
)
if not exist "node_modules" (
  call npm install
)
echo 셀러딜  http://127.0.0.1:3780
echo.
npx tsx coupang-partners/web/server.ts
pause
