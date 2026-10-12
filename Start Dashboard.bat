@echo off
title UWCheck
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
echo Keep this window open while you use the dashboard. Close it to stop.
node server.js --open
if errorlevel 1 pause
