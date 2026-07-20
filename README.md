# Kimi Code Desktop

## 项目简介 / Project Overview

Kimi Code Desktop 是面向 Kimi Code CLI 的 Windows 桌面外壳。桌面应用负责 React/Tauri 用户体验与进程编排；AI 会话逻辑、模型配置、工具调用和运行时行为保留在用户已安装的 Kimi Code CLI 中，通过 ACP（`kimi acp`）访问。配置与本地文件操作由 Rust 辅助模块直接读写 `~/.kimi-code`。

English: Kimi Code Desktop is the Windows desktop shell for the Kimi Code CLI. The desktop app owns the React/Tauri user experience and process orchestration; AI session logic, model configuration, tools, and runtime behavior stay in the user-installed Kimi Code CLI and are reached through ACP (`kimi acp`). Config and local file operations use Rust helpers that read and write `~/.kimi-code`.

权威开发规则位于 `docs/DEVELOPMENT_STANDARD.md`。启动、构建、发布和版本相关变更都应与该文件保持一致。

English: The authoritative development rules live in `docs/DEVELOPMENT_STANDARD.md`. Keep launch, build, release, and version changes aligned with that file.

## 架构 / Architecture

```text
React/Tauri
  -> AcpProcessManager (wire) + AcpDesktopClient (session API)
  -> user `kimi acp`
Config / files / git
  -> ~/.kimi-code via Rust helpers (global_config, session_files, git_diff, …)
```

Legacy Python sidecar（`kimi-sidecar`、`sidecar-adapter/`、bundled externalBin）已移除。桌面应用为 ACP-only。

English: The legacy Python sidecar (`kimi-sidecar`, `sidecar-adapter/`, bundled externalBin) has been removed. The desktop app is ACP-only.

## 前置条件 / Prerequisites

- Node.js 和 npm / Node.js and npm
- Rust stable toolchain（MSVC target）/ Rust stable toolchain (MSVC target)
- 用户已安装的 **Kimi Code CLI**（PATH 上的 `kimi` 命令）/ User-installed **Kimi Code CLI** (`kimi` on PATH)

安装示例 / Example install:

```powershell
uv tool install kimi-cli
kimi login
```

若从旧版 `~/.kimi` 迁移，运行 `kimi migrate`。

English: If migrating from legacy `~/.kimi`, run `kimi migrate`.

## 标准工作流 / Canonical Workflow

以下命令是日常开发和发布工作的准入口：

English: Use these commands as the source of truth for development and release work:

```powershell
npm run desktop          # 日常开发应用 / Daily development app
npm run desktop:dev      # 明确进入 Tauri 开发模式并启用热重载 / Explicit Tauri dev mode with hot reload
npm run desktop:release  # 构建本地可运行的 release exe / Build the local runnable release exe
npm run release:msi      # 构建 MSI 安装包和发布元数据 / Build the MSI installer and release metadata
npm run release:preflight
npm run smoke:acp        # ACP smoke against installed `kimi acp`
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

MSI 安装包仅包含 Tauri 桌面外壳，不再 bundled Kimi Code CLI。用户需在安装后自行安装并登录 Kimi Code CLI。

English: The MSI bundles only the Tauri desktop shell; it no longer bundles the Kimi Code CLI. Users must install and log in to the Kimi Code CLI after installing the app.

通过 MSI 安装后的应用会直接启动 Tauri 可执行文件，而不是 `start.bat`。因此，启动就绪检查必须在应用内部运行。首个窗口加载时，桌面应用会验证 PATH 上的 Kimi Code CLI、`kimi acp` 入口、`~/.kimi-code/config.toml` 与凭据状态，然后再加载会话。

English: The installed MSI launches the Tauri executable directly, not `start.bat`. Startup readiness checks therefore run inside the app itself. On first window load, the desktop app verifies the Kimi Code CLI on PATH, the `kimi acp` entrypoint, `~/.kimi-code/config.toml`, and credential state before loading sessions.

MSI 也会安装标准 Windows 卸载入口。用户可以通过 Windows 设置 > 应用，或开始菜单中的 `Uninstall Kimi Code` 快捷方式卸载。MSI 卸载会移除应用文件和快捷方式，但不会删除 `~/.kimi-code`（或旧版 `~/.kimi`），因为这些目录属于 Kimi Code CLI 运行时，应在升级或重新安装后继续保留。

English: The MSI also installs normal Windows uninstall entry points. Users can remove the app from Windows Settings > Apps or from the Start Menu shortcut named `Uninstall Kimi Code`. MSI uninstall removes the app files and shortcuts, but it does not delete `~/.kimi-code` (or legacy `~/.kimi`) because those directories belong to the Kimi Code CLI runtime and should survive upgrades or reinstall attempts.

## 验证 / Validation

普通开发变更使用：

English: For normal development changes:

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

ACP-only 迁移完成度门禁（期望零匹配）：

English: ACP-only migration acceptance gate (expect zero matches):

```powershell
rg -n "kimi-sidecar|kimi_cli|KIMI_CLI_BIN|call_desktop_api|WireProcessManager|\.kimi[^-]" src-tauri src sidecar-adapter package.json scripts
```

发布前置信心检查使用：

English: For release confidence:

```powershell
npm run release:preflight
```

`release:preflight` 会检查前端测试、版本一致性、前端生产构建、Rust check/clippy/test、npm 高危漏洞审计、密钥扫描和 git 可追溯性。

English: `release:preflight` checks frontend tests, version alignment, frontend production build, Rust check/clippy/test, npm audit for high severity advisories, secret scan, and git traceability.

## 项目结构 / Project Layout

```text
src/                      React/Vite 前端 / React/Vite frontend
src-tauri/                Tauri v2 Rust 外壳 / Tauri v2 Rust shell
  src/acp.rs              AcpProcessManager (wire)
  src/acp_desktop.rs      AcpDesktopClient (session API)
  src/acp_translate.rs    ACP <-> wire event translation
  src/runtime_check.rs    Kimi Code CLI readiness
  src/global_config.rs    ~/.kimi-code config helpers
docs/DEVELOPMENT_STANDARD.md
docs/RELEASE.md
docs/acp-contract.md
.github/workflows/ci.yml
.github/workflows/release.yml
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

Kimi Code CLI 运行时版本是独立的。任何展示 CLI 版本的 UI 都必须读取已安装/运行中的 CLI 版本，而不是复用桌面外壳版本。

English: The Kimi Code CLI runtime version is separate. UI surfaces that show the CLI version must read the installed/runtime CLI, not the desktop shell version.

## 许可证 / License

本项目基于 Apache License, Version 2.0 授权。详情见 `LICENSE`。

English: Licensed under the Apache License, Version 2.0. See `LICENSE` for details.
