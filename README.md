# Kimi Code Desktop

## 项目简介 / Project Overview

Kimi Code Desktop 是面向 Kimi CLI 运行时的 Windows 桌面外壳。桌面应用负责 React/Tauri 用户体验和进程编排；AI 会话逻辑、模型配置、工具调用和运行时行为仍保留在 Kimi CLI Python 栈中，并通过桌面 sidecar 适配器访问。

English: Kimi Code Desktop is the Windows desktop shell for the Kimi CLI runtime. The desktop app owns the React/Tauri user experience and process orchestration, while AI session logic, model configuration, tools, and runtime behavior stay in the Kimi CLI Python stack and are reached through the desktop sidecar adapter.

权威开发规则位于 `docs/DEVELOPMENT_STANDARD.md`。启动、构建、发布、sidecar 和版本相关变更都应与该文件保持一致。

English: The authoritative development rules live in `docs/DEVELOPMENT_STANDARD.md`. Keep launch, build, release, sidecar, and version changes aligned with that file.

## 标准工作流 / Canonical Workflow

以下命令是日常开发和发布工作的准入口：

English: Use these commands as the source of truth for development and release work:

```powershell
npm run desktop          # 日常开发应用 / Daily development app
npm run desktop:dev      # 明确进入 Tauri 开发模式并启用热重载 / Explicit Tauri dev mode with hot reload
npm run desktop:release  # 构建本地可运行的 release exe / Build the local runnable release exe
npm run release:msi      # 构建 MSI 安装包和发布元数据 / Build the MSI installer and release metadata
npm run release:preflight
npm run sidecar:build
```

根目录的 `start.bat` 和当前目录的 `start.bat` 默认都进入开发模式：

English: The root `start.bat` and this folder's `start.bat` both default to development mode:

```bat
start.bat
start.bat dev
```

只有在明确需要时才运行已构建的 release 可执行文件：

English: Run a built release executable only when you ask for it explicitly:

```bat
start.bat release
```

不要把 `cargo build --release` 当作可运行桌面 release 的构建路径。它会绕过 Tauri 前端构建流水线，可能生成一个启动后报 `asset not found: index.html` 的窗口。

English: Do not use `cargo build --release` as the runnable desktop release path. It bypasses Tauri's frontend build pipeline and can produce a window that fails with `asset not found: index.html`.

## 构建产物 / Build Artifacts

本地 release exe：

English: Local release exe:

```text
src-tauri\target\release\kimi-code-desktop.exe
```

MSI 安装包：

English: MSI installer:

```text
src-tauri\target\release\bundle\msi\Kimi Code_<version>_x64_en-US.msi
```

GitHub Releases 由 `.github/workflows/release.yml` 构建。推送 `v*` 标签或手动运行 `Release` 工作流后，会把 MSI、`SHA256SUMS.txt` 和 release manifest 发布到 GitHub Releases。

English: GitHub releases are built by `.github/workflows/release.yml`. Push a `v*` tag or run the `Release` workflow manually to publish the MSI, `SHA256SUMS.txt`, and release manifests to GitHub Releases.

应用可以作为常规 Windows 桌面应用交付，并提供一个面向用户的启动入口。内部架构目前仍包含 sidecar 可执行文件，因此安装后的文件不应被预期为单个独立便携文件。

English: The app can be shipped as a normal Windows desktop application with one user-facing launcher. Internally, the current architecture still includes a sidecar executable, so the installed files are not expected to be one single standalone portable file.

通过 MSI 安装后的应用会直接启动 Tauri 可执行文件，而不是 `start.bat`。因此，启动就绪检查必须在应用内部运行。首个窗口加载时，桌面应用会先验证随包 sidecar/Kimi CLI 运行时、`config.toml`、凭据来源，以及用于终端登录/设置的可选外部 `kimi` 命令，然后再加载会话。

English: The installed MSI launches the Tauri executable directly, not `start.bat`. Startup readiness checks therefore run inside the app itself. On first window load, the desktop app verifies the bundled sidecar/Kimi CLI runtime, `config.toml`, credential sources, and the optional external `kimi` command used for terminal login/setup before it loads sessions.

MSI 也会安装标准 Windows 卸载入口。用户可以通过 Windows 设置 > 应用，或开始菜单中的 `Uninstall Kimi Code` 快捷方式卸载。MSI 卸载会移除应用文件和快捷方式，但不会删除 `~\.kimi`，因为该配置和凭据目录属于 Kimi CLI 运行时，应在升级或重新安装后继续保留。

English: The MSI also installs normal Windows uninstall entry points. Users can remove the app from Windows Settings > Apps or from the Start Menu shortcut named `Uninstall Kimi Code`. MSI uninstall removes the app files and shortcuts, but it does not delete `~\.kimi` because that config and credential store belongs to the Kimi CLI runtime and should survive upgrades or reinstall attempts.

## Sidecar 组件 / Sidecar

Tauri external binary 的源文件必须位于：

English: The Tauri external binary source must exist here:

```text
src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe
```

使用以下命令构建或刷新它：

English: Build or refresh it with:

```powershell
npm run sidecar:build
```

当 `start.bat release` 启动工作区 release exe 时，它会先从该源二进制刷新旁边的 `kimi-sidecar.exe`，然后再启动应用。

English: When `start.bat release` launches the workspace release exe, it refreshes the neighboring `kimi-sidecar.exe` from this source binary before launch.

打包后的 sidecar 还提供隐藏的 `__desktop-runtime-info` 命令。已安装应用会用该命令验证随包运行时，而不是假设 PATH 上存在外部 `kimi` 命令。

English: The packaged sidecar also exposes a hidden `__desktop-runtime-info` command. The installed app uses that command to verify the bundled runtime instead of assuming an external `kimi` command is on PATH.

## 验证 / Validation

普通开发变更使用：

English: For normal development changes:

```powershell
npm test
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

发布前置信心检查使用：

English: For release confidence:

```powershell
npm run release:preflight
```

`release:preflight` 会检查 sidecar 二进制、前端测试、版本一致性、前端生产构建、Rust check/clippy、Tauri no-bundle release 构建、Python sidecar 编译/测试、npm 高危漏洞审计、密钥扫描和 git 可追溯性。

English: `release:preflight` checks the sidecar binary, frontend tests, version alignment, frontend production build, Rust check/clippy, Tauri no-bundle release build, Python sidecar compile/tests, npm audit for high severity advisories, secret scan, and git traceability.

## 项目结构 / Project Layout

```text
src/                      React/Vite 前端 / React/Vite frontend
src-tauri/                Tauri v2 Rust 外壳 / Tauri v2 Rust shell
sidecar-adapter/          Python sidecar 适配器 / Python sidecar adapter
src-tauri/sidecar/        Tauri externalBin 源位置 / Tauri externalBin source location
docs/DEVELOPMENT_STANDARD.md
docs/RELEASE.md
.github/workflows/ci.yml  仓库根目录 CI 检查 / CI checks for the repository root
.github/workflows/release.yml  Windows MSI 发布工作流 / Windows MSI release publisher
```

## 版本规则 / Versioning

桌面外壳版本必须在以下文件中保持一致：

English: The desktop shell version must stay aligned across:

```text
package.json
package-lock.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

检查版本一致性：

English: Check alignment:

```powershell
npm run version:sync
```

设置新的桌面外壳版本：

English: Set a new desktop shell version:

```powershell
npm run version:set 0.1.0
```

Kimi CLI 运行时版本是独立的。任何展示 CLI 版本的 UI 都必须读取已安装/运行中的 CLI 版本，而不是复用桌面外壳版本。

English: The Kimi CLI runtime version is separate. UI surfaces that show the CLI version must read the installed/runtime CLI, not the desktop shell version.

## 许可证 / License

本项目基于 Apache License, Version 2.0 授权。详情见 `LICENSE`。

English: Licensed under the Apache License, Version 2.0. See `LICENSE` for details.
