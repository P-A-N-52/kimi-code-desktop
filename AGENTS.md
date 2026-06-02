# Kimi Code Desktop 代理指南 / Agent Guide

## 项目定位 / Project Role

本仓库是 Kimi Code 的独立桌面外壳，不是 `kimi-cli` 源码树。桌面应用通过 Python sidecar 适配器复用已安装的 Kimi CLI 运行时。

English: This repository is an independent desktop shell for Kimi Code. It is not the `kimi-cli` source tree. The desktop app reuses the installed Kimi CLI runtime through a Python sidecar adapter.

权威开发规则位于 `docs/DEVELOPMENT_STANDARD.md`。本文件和所有交接说明都应与该标准保持一致。

English: Authoritative development rules are in `docs/DEVELOPMENT_STANDARD.md`. Keep this file and every handoff aligned with that standard.

## 运行链路 / Runtime Chain

```text
React/Tauri frontend
  -> Tauri IPC/events
  -> Rust WireProcessManager in src-tauri/src/sidecar.rs
  -> kimi-sidecar __desktop-worker <session_id>
  -> stdio NDJSON Wire protocol
  -> Kimi CLI Python runtime
```

原生桌面辅助调用使用：

English: Native desktop helper calls use:

```text
Tauri command
  -> Rust call_desktop_api()
  -> shared kimi-sidecar __desktop-api-server
```

## 硬性规则 / Hard Rules

- 默认将日常工作保持在开发模式。 / Keep daily work in development mode by default.
- 日常启动使用 `npm run desktop` 或 `start.bat`。 / Use `npm run desktop` or `start.bat` for daily launch.
- 本地可运行 release exe 使用 `npm run desktop:release`。 / Use `npm run desktop:release` for a local runnable release exe.
- 可分发 MSI 使用 `npm run release:msi`。 / Use `npm run release:msi` for a distributable MSI.
- sidecar 源二进制使用 `npm run sidecar:build` 构建。 / Use `npm run sidecar:build` to build the sidecar source binary.
- MSI 启动就绪检查和卸载行为必须位于打包应用和安装器路径中，不能只放在 `start.bat`。 / Keep MSI startup readiness and uninstall behavior inside the packaged app and installer path, not only in `start.bat`.
- 不要推荐 `cargo build --release` 作为可运行桌面构建。 / Do not recommend `cargo build --release` as a runnable desktop build.
- 不要让旧 release exe、旧 MSI 或旧 sidecar 静默替代当前源码树。 / Do not let an old release exe, old MSI, or old sidecar silently stand in for the current source tree.
- 不要把桌面专用辅助代码移入 `kimi_cli` Python 包。 / Do not move desktop-only helper code into the `kimi_cli` Python package.
- 不要回退无关的未提交改动。 / Do not revert unrelated uncommitted work.

## 标准命令 / Canonical Commands

```powershell
npm run desktop
npm run desktop:dev
npm run desktop:release
npm run release:preflight
npm run release:msi
npm run sidecar:build
npm run version:sync
```

兼容别名仍然存在：

English: Compatibility aliases exist:

```powershell
npm run tauri:dev      # delegates to desktop:dev
npm run tauri:build    # delegates to release:msi
```

在文档和交接中优先使用 `desktop:*` 与 `release:*` 命名。

English: Prefer the `desktop:*` and `release:*` names in docs and handoffs.

## 关键文件 / Files To Know

```text
src/lib/tauri-api.ts
src/hooks/useSessionStream.ts
src/hooks/wireTypes.ts
src-tauri/src/commands.rs
src-tauri/src/sidecar.rs
sidecar-adapter/kimi_desktop_sidecar/
scripts/desktop-release.ps1
scripts/release-preflight.ps1
scripts/release-msi.ps1
scripts/build-sidecar.ps1
docs/DEVELOPMENT_STANDARD.md
docs/RELEASE.md
```

## 验证 / Verification

普通代码变更使用：

English: For normal code changes:

```powershell
npm test
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

发布相关变更使用：

English: For release-related changes:

```powershell
npm run release:preflight
```

MSI 打包变更使用：

English: For MSI packaging changes:

```powershell
npm run release:msi
```

## 版本契约 / Version Contract

桌面外壳版本一致性由以下命令检查：

English: Desktop shell version alignment is checked by:

```powershell
npm run version:sync
```

它覆盖以下文件：

English: It covers:

```text
package.json
package-lock.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

桌面外壳版本与运行时 Kimi CLI 版本不是同一个概念。展示 CLI 版本的 UI 必须探测已安装 CLI 的运行时版本。

English: The desktop shell version is not the same thing as the runtime Kimi CLI version. UI that displays the CLI version must use runtime probing of the installed CLI.

## 子代理边界 / Sub-Agent Boundaries

使用多个编码代理时，按所有权拆分工作：

English: When using multiple coding agents, split work by ownership:

```text
Frontend agent: src/ and React state/UI behavior
Rust agent: src-tauri/src/ commands, sidecar process orchestration, tray/notify
Sidecar agent: sidecar-adapter/ Python adapter code
Release agent: package scripts, PowerShell release scripts, docs, Tauri config
```

代理并不是这个工作区里的唯一操作者。它们必须先检查当前状态，避免回退无关改动，并让命令名称与上面的标准工作流保持一致。

English: Agents are not alone in this worktree. They must inspect current status, avoid reverting unrelated edits, and keep command names aligned with the canonical workflow above.
