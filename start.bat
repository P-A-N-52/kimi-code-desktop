@echo off
setlocal EnableExtensions DisableDelayedExpansion

title Kimi Code Desktop Launcher

echo ============================================
echo   Kimi Code Desktop - Fast Native Launch
echo ============================================
echo.

set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%"
set "CONFIG_FILE=%USERPROFILE%\.kimi\config.toml"
set "SIDECAR_EXE=%APP_DIR%src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe"
set "DEBUG_EXE=%APP_DIR%src-tauri\target\debug\kimi-code-desktop.exe"
set "RELEASE_EXE=%APP_DIR%src-tauri\target\release\kimi-code-desktop.exe"
set "DIST_INDEX=%APP_DIR%dist\index.html"
set "START_LOG=%TEMP%\kimi-code-desktop-start.log"

if not exist "%APP_DIR%package.json" (
    echo [ERROR] Cannot find package.json.
    echo [ERROR] Please run this script from the kimi-desktop project root:
    echo         %SCRIPT_DIR%
    pause
    exit /b 1
)

if /i "%KIMI_DEV%"=="1" goto :dev_launch
if /i "%KIMI_MODE%"=="dev" goto :dev_launch

set "APP_EXE="
if exist "%RELEASE_EXE%" set "APP_EXE=%RELEASE_EXE%"
if not defined APP_EXE if /i "%KIMI_ALLOW_DEBUG_EXE%"=="1" if exist "%DEBUG_EXE%" if exist "%DIST_INDEX%" set "APP_EXE=%DEBUG_EXE%"

if defined APP_EXE goto :direct_launch

echo [INFO] No built desktop executable found; falling back to dev mode.
echo        Run npm run build and cargo build --release once to enable the no-console fast path.
echo        To force debug exe direct launch, set KIMI_ALLOW_DEBUG_EXE=1.
echo.
goto :dev_launch

:direct_launch
for %%P in ("%APP_EXE%") do set "APP_EXE_DIR=%%~dpP"

> "%START_LOG%" echo [start %TIME%] Starting Kimi Code Desktop
>> "%START_LOG%" echo App: %APP_EXE%
>> "%START_LOG%" echo Dir: %APP_EXE_DIR%

echo [1/4] Launch mode: built executable
echo [2/4] App: %APP_EXE%
if exist "%CONFIG_FILE%" (
    echo [3/4] Config: %CONFIG_FILE%
) else (
    echo [3/4] Config not found yet: %CONFIG_FILE%
)

if /i "%KIMI_CLEAN_START%"=="1" (
    echo [4/4] Clean start requested
    >> "%START_LOG%" echo Clean start requested
    call :cleanup_desktop
    goto :start_new_desktop
)

echo [4/4] Checking existing desktop process
call :focus_existing
set "FOCUS_RESULT=%ERRORLEVEL%"
if "%FOCUS_RESULT%"=="0" (
    >> "%START_LOG%" echo Reused existing desktop process
    echo.
    echo [OK] Kimi Code Desktop is already running. Existing window was brought to front.
    echo [OK] Startup log: %START_LOG%
    exit /b 0
)
if "%FOCUS_RESULT%"=="2" (
    >> "%START_LOG%" echo Existing process had no focusable window; cleaning before launch
    echo      Existing process had no focusable window; cleaning before launch
    call :cleanup_desktop
) else (
    >> "%START_LOG%" echo No existing desktop process found; cleaning orphan sidecars
    taskkill /F /IM kimi-sidecar.exe >nul 2>&1
)

:start_new_desktop
call :ensure_sidecar_sibling "%APP_EXE%"
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo [INFO] Starting Kimi Code Desktop...
echo        For hot-reload development, run with KIMI_DEV=1.
echo.

start "" /D "%APP_EXE_DIR%" "%APP_EXE%"
if errorlevel 1 (
    >> "%START_LOG%" echo Start command failed with errorlevel %ERRORLEVEL%
    echo [ERROR] Failed to launch:
    echo         %APP_EXE%
    echo [ERROR] Startup log:
    echo         %START_LOG%
    pause
    exit /b 1
)

>> "%START_LOG%" echo Start command returned successfully
echo [OK] Launch command sent. The desktop window should appear in a moment.
echo [OK] Startup log: %START_LOG%
exit /b 0

:dev_launch
set "NODE_EXE=%KIMI_NODE_EXE%"
set "NPM_CMD=%KIMI_NPM_CMD%"

if not defined NODE_EXE (
    for /f "delims=" %%p in ('where node.exe 2^>nul') do (
        if not defined NODE_EXE set "NODE_EXE=%%p"
    )
)

if defined NODE_EXE if not defined NPM_CMD (
    for %%P in ("%NODE_EXE%") do (
        if exist "%%~dpPnpm.cmd" set "NPM_CMD=%%~dpPnpm.cmd"
    )
)

if not defined NPM_CMD (
    for /f "delims=" %%p in ('where npm.cmd 2^>nul') do (
        if not defined NPM_CMD set "NPM_CMD=%%p"
    )
)

if not defined NODE_EXE if exist "D:\program\node\node.exe" set "NODE_EXE=D:\program\node\node.exe"
if not defined NPM_CMD if exist "D:\program\node\npm.cmd" set "NPM_CMD=D:\program\node\npm.cmd"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NPM_CMD if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"

if not defined NODE_EXE set "NODE_EXE=node.exe"
if not defined NPM_CMD set "NPM_CMD=npm.cmd"

echo [1/6] Checking Node.js...
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js ^(v20+^) or set KIMI_NODE_EXE.
    pause
    exit /b 1
)

call "%NPM_CMD%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Please ensure Node.js is fully installed in PATH or set KIMI_NPM_CMD.
    pause
    exit /b 1
)

echo [2/6] Checking Rust/Tauri toolchain...
call cargo --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Cargo not found. Please install Rust and reopen the terminal.
    pause
    exit /b 1
)

echo [3/6] Checking desktop sidecar...
if not exist "%SIDECAR_EXE%" (
    echo [ERROR] Sidecar not found:
    echo   %SIDECAR_EXE%
    echo.
    echo Please build or copy kimi-sidecar to src-tauri\sidecar\.
    pause
    exit /b 1
)
echo [INFO] Sidecar: %SIDECAR_EXE%

echo [4/6] Checking Kimi CLI config...
if exist "%CONFIG_FILE%" (
    echo [INFO] Config file: %CONFIG_FILE%
) else (
    echo [NOTICE] Config file not found: %CONFIG_FILE%
    echo         Login is not mandatory. You may configure any provider/model/API key in this file.
    echo         If using official account login, 'kimi login' is optional.
)

echo [5/6] Cleaning up dev processes...
call :cleanup_all
ping -n 2 127.0.0.1 >nul
echo [INFO] Dev processes cleaned.

echo [6/6] Checking frontend dependencies...
if not exist "%APP_DIR%node_modules" (
    echo [INFO] First run, installing frontend dependencies...
    pushd "%APP_DIR%"
    call "%NPM_CMD%" install
    if errorlevel 1 (
        popd
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    popd
) else (
    echo [INFO] Frontend dependencies exist.
)

echo.
echo ============================================
echo   Launching Tauri dev desktop window...
echo   Communication: Tauri IPC/events to Rust WireProcessManager to sidecar stdio Wire
echo   Worker: kimi-sidecar __desktop-worker [session_id]
echo   API:    kimi-sidecar __desktop-api-server
echo.
echo   Model/API config from %CONFIG_FILE%
echo   No separate local HTTP backend needed; login not required.
echo ============================================
echo.

pushd "%APP_DIR%"
call "%NPM_CMD%" run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"
popd

echo.
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Tauri launch failed, exit code: %EXIT_CODE%
) else (
    echo Exited.
)
echo Press any key to close...
pause >nul
exit /b %EXIT_CODE%

:ensure_sidecar_sibling
set "EXE_PATH=%~1"
for %%P in ("%EXE_PATH%") do set "EXE_DIR=%%~dpP"
if exist "%EXE_DIR%kimi-sidecar.exe" exit /b 0

if not exist "%SIDECAR_EXE%" (
    echo [ERROR] Sidecar not found:
    echo   %SIDECAR_EXE%
    pause
    exit /b 1
)

copy /Y "%SIDECAR_EXE%" "%EXE_DIR%kimi-sidecar.exe" >nul
if errorlevel 1 (
    echo [ERROR] Failed to copy sidecar to:
    echo   %EXE_DIR%kimi-sidecar.exe
    pause
    exit /b 1
)
exit /b 0

:cleanup_desktop
taskkill /F /IM kimi-code-desktop.exe >nul 2>&1
taskkill /F /IM kimi-sidecar.exe >nul 2>&1
exit /b 0

:focus_existing
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\focus-kimi-window.ps1"
exit /b %ERRORLEVEL%

:cleanup_all
call :cleanup_desktop
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1420" ^| findstr "LISTENING"') do (
    echo [INFO] Killing process %%a occupying port 1420...
    taskkill /F /PID %%a >nul 2>&1
)
exit /b 0
