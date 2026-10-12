@echo off
cd /d "%~dp0server"
echo A Chrome window opens with the harness profile (.profile). Log in to Zixel there,
echo then CLOSE that window to save the session.
call pnpm exec tsx scripts/login.ts
