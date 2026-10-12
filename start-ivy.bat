@echo off
setlocal
cd /d "%~dp0"
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
if not defined IVY_BIN set "IVY_BIN=C:\zixel\ivyproject\build\built\bin"
if not defined MDA_DIR set "MDA_DIR=C:\zixel\mda"
if not exist "%IVY_BIN%\zcad_service.exe" (echo ERROR: %IVY_BIN%\zcad_service.exe not found & exit /b 1)
set "CONANRUN=%IVY_BIN%\..\..\conanrun.bat"
echo Starting zcad_service...
start "ivy-backend" cmd /k "(if exist "%CONANRUN%" call "%CONANRUN%") & cd /d "%IVY_BIN%" & zcad_service.exe"
echo Starting frontend (pnpm dev:pc)...
start "ivy-frontend" cmd /k "cd /d "%MDA_DIR%" & pnpm dev:pc"
echo Both started in separate windows. Frontend: %FRONTEND_URL%
endlocal
