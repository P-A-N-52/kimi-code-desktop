@echo off
setlocal EnableExtensions DisableDelayedExpansion

title Kimi Code Desktop Launcher

echo ============================================
echo   Kimi Code Desktop - Development Launcher
echo ============================================
echo.

set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%"
set "APP_ROOT=%SCRIPT_DIR:~0,-1%"
set "CONFIG_FILE=%USERPROFILE%\.kimi-code\config.toml"
set "DEBUG_EXE=%APP_DIR%src-tauri\target\debug\kimi-code-desktop.exe"
set "RELEASE_EXE=%APP_DIR%src-tauri\target\release\kimi-code-desktop.exe"
set "RELEASE_MANIFEST=%APP_DIR%src-tauri\target\release\kimi-code-desktop.release.json"
set "DIST_INDEX=%APP_DIR%dist\index.html"
set "START_LOG=%TEMP%\kimi-code-desktop-start.log"
set "REQUESTED_MODE=%~1"
set "RUNTIME_CHECK_GUI=-Gui"
if /i "%KIMI_NO_STARTUP_GUI%"=="1" set "RUNTIME_CHECK_GUI="
set "RUNTIME_CHECK_LOADING=-ShowLoading"
if /i "%KIMI_NO_STARTUP_GUI%"=="1" set "RUNTIME_CHECK_LOADING="
if /i "%KIMI_SHOW_STARTUP_LOADING%"=="0" set "RUNTIME_CHECK_LOADING="
if /i "%KIMI_SHOW_STARTUP_LOADING%"=="1" set "RUNTIME_CHECK_LOADING=-ShowLoading"

if not exist "%APP_DIR%package.json" (
    echo [ERROR] Cannot find package.json.
    echo [ERROR] Please run this script from the kimi-desktop project root:
    echo         %SCRIPT_DIR%
    pause
    exit /b 1
)

if defined REQUESTED_MODE (
    if /i "%REQUESTED_MODE%"=="dev" set "KIMI_MODE=dev"
    if /i "%REQUESTED_MODE%"=="release" set "KIMI_MODE=release"
    if not defined KIMI_MODE (
        echo [ERROR] Unsupported launch argument: %REQUESTED_MODE%
        echo         Supported arguments: dev, release
        pause
        exit /b 1
    )
)

if /i "%KIMI_DEV%"=="1" set "KIMI_MODE=dev"
if not defined KIMI_MODE set "KIMI_MODE=dev"

if /i "%KIMI_MODE%"=="dev" goto :dev_launch
if /i "%KIMI_MODE%"=="release" goto :select_built_exe

echo [ERROR] Unsupported KIMI_MODE: %KIMI_MODE%
echo         Supported modes: dev, release
pause
exit /b 1

:select_built_exe
set "APP_EXE="
if exist "%RELEASE_EXE%" set "APP_EXE=%RELEASE_EXE%"

if defined APP_EXE goto :direct_launch

echo [ERROR] Release mode requested, but no built desktop executable was found.
echo        Run npm run desktop:release once to build the runnable release executable.
echo        Do not use cargo build --release for a runnable desktop release; it can miss frontend assets.
echo.
pause
exit /b 1

:direct_launch
for %%P in ("%APP_EXE%") do set "APP_EXE_DIR=%%~dpP"

echo [INFO] Validating release manifest...
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\validate-release-manifest.ps1" -ProjectRoot "%APP_ROOT%"
if errorlevel 1 (
    echo [ERROR] Release executable is not from a verified desktop release build.
    echo         Run npm run desktop:release
    pause
    exit /b 1
)

> "%START_LOG%" echo [start %TIME%] Starting Kimi Code Desktop
>> "%START_LOG%" echo App: %APP_EXE%
>> "%START_LOG%" echo Dir: %APP_EXE_DIR%

echo [1/4] Launch mode: built executable
echo [2/4] App: %APP_EXE%
echo [3/4] Checking Kimi runtime readiness...
call :runtime_check "release"
if errorlevel 1 (
    echo [ERROR] Startup check failed.
    if not defined RUNTIME_CHECK_GUI pause
    exit /b 1
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
)

:start_new_desktop
echo.
echo [5/5] Starting Kimi Code Desktop...
echo        Release mode was requested explicitly. Default launch mode is dev.
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

echo [3/6] Checking Kimi runtime readiness...
call :runtime_check "dev"
if errorlevel 1 (
    echo [ERROR] Startup check failed.
    if not defined RUNTIME_CHECK_GUI pause
    exit /b 1
)

echo [4/6] Cleaning up dev processes...
call :cleanup_all
ping -n 2 127.0.0.1 >nul
echo [INFO] Dev processes cleaned.

echo [5/6] Checking frontend dependencies...
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
echo   Startup check: passed
echo   Default launch mode: dev
echo   Communication: Tauri IPC/events to Rust AcpProcessManager to kimi acp
echo   Runtime: user-installed Kimi Code CLI (``kimi acp``)
echo.
echo   Config checked from %CONFIG_FILE%
echo   No separate local HTTP backend needed.
echo ============================================
echo.

pushd "%APP_DIR%"
call "%NPM_CMD%" run desktop:dev
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

:cleanup_desktop
taskkill /F /IM kimi-code-desktop.exe >nul 2>&1
exit /b 0

:focus_existing
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\focus-kimi-window.ps1"
exit /b %ERRORLEVEL%

:runtime_check
set "CHECK_MODE=%~1"
if /i "%KIMI_FAST_STARTUP_CHECK%"=="1" goto :runtime_check_fast
goto :runtime_check_full

:runtime_check_fast
if not exist "%CONFIG_FILE%" goto :runtime_check_full
echo [INFO] Fast startup check passed. Full startup check is the default; unset KIMI_FAST_STARTUP_CHECK to restore it.
exit /b 0

:runtime_check_full
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\check-runtime.ps1" -ProjectRoot "%APP_ROOT%" -Mode "%CHECK_MODE%" %RUNTIME_CHECK_GUI% %RUNTIME_CHECK_LOADING%
exit /b %ERRORLEVEL%

:cleanup_all
call :cleanup_desktop
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:"127.0.0.1:1420" ^| findstr "LISTENING"') do (
    echo [INFO] Killing process %%a occupying port 1420...
    taskkill /F /PID %%a >nul 2>&1
)
exit /b 0
