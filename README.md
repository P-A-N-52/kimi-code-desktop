<p align="center">
  <img src="public/logo.png" width="96" alt="Kimi Code Desktop logo" />
</p>

<h1 align="center">Kimi Code Desktop</h1>

<p align="center">
  为 Kimi Code CLI 打造的原生 Windows 与 macOS 桌面工作台。<br />
  A native Windows &amp; macOS workspace for Kimi Code CLI.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-111111" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-111111" />
  <img alt="React" src="https://img.shields.io/badge/React-19-111111" />
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111111" />
</p>

开发与提交约定见 [结构与开发规范](.github/DEVELOPMENT.md)。

Kimi Code Desktop 将 Kimi Code 的终端智能体能力带进一个专注、可视、可管理的桌面界面。它不是另一套 AI 运行时：会话、模型、工具调用与智能体能力仍由用户安装的 Kimi Code CLI 提供，桌面端通过 ACP（`kimi acp`）连接，并负责交互、工作区呈现与 Windows / macOS 系统集成。

> 当前源码版本为 `1.1.1`，面向 Windows 与 macOS（Intel 与 Apple Silicon）。

## 本次贡献 / This contribution

本次贡献以 `v1.1.1` 为基线，分为 macOS Intel 发布支持和桌面端 session 体验修复两部分。应用版本号保持上游版本策略，不把处理器架构写进版本号。

### 改善 / Improvements

- 恢复本地已有 session 的历史对话，并兼容旧版和新版 Kimi Code session/workspace 元数据。
- 根据 session 持久化的工作目录恢复项目分组，避免已有项目文件夹在桌面端显示为空。
- macOS 从 Finder 启动时自动探测常见的 Kimi CLI 安装路径，不依赖 Finder 继承的完整 shell `PATH`。
- 在旧版 macOS WebView 上检测 Mermaid 不兼容的正则能力，安全降级为普通代码块，保留现代 WebView 的图表渲染。

### 新增 / Added

- macOS Intel 原生构建目标 `x86_64-apple-darwin`，与 Apple Silicon 的 `aarch64-apple-darwin` 分开发布。
- Intel DMG、独立 SHA256 校验文件和 release manifest；CI 会验证 runner、目标架构和 DMG 内应用二进制架构。
- Session 右键菜单，支持复制完整 session ID、复制前 6 位短 ID、重命名、归档/恢复和删除。
- 项目级归档和恢复，按真实工作目录处理项目下的全部 session，不受当前搜索结果、分页或 active/archived 列表影响。
- 对 session 历史回放、工作区解析、归档刷新、项目归档和右键菜单的自动化测试。

### 修复 / Fixed

- 修复已有 session 打开后对话历史为空的问题。
- 修复 Intel Mac 点击带 Mermaid 内容的 session 时出现 `Invalid regular expression: invalid group specifier name` 的崩溃。
- 修复归档刷新竞态：后台预加载完成后不会覆盖更新后的 active/archived 列表，过期请求也不会恢复已归档 session。
- 修复单个、批量和项目归档只更新部分列表的问题。
- 修复项目归档只处理当前可见 session 的问题；归档只修改 session 状态，不移动、删除或修改项目文件。

### 边界与隐私 / Scope and privacy

- 桌面端仍通过用户单独安装的 `kimi acp` 工作，不替换 ACP、不捆绑 Python sidecar，也不改变模型和工具运行时。
- 不提交或保存 API key、Apple 签名凭据、Codex 配置、本机绝对路径或用户 session 内容。
- 没有 Apple 签名 secrets 时沿用 ad-hoc/unsigned 降级机制，实际签名和公证状态记录在 release manifest 中。

This contribution is based on upstream `v1.1.1` and covers native Intel macOS distribution plus session, history, workspace, archive, and context-menu fixes. The application version remains a standard `major.minor.patch` value; architecture is recorded in artifact names and manifests.

### Improvements

- Restore existing local session history and support old and new Kimi Code session/workspace metadata layouts.
- Recover project grouping from each session's persisted working directory.
- Detect common Kimi CLI installation paths when macOS starts the app from Finder.
- Guard Mermaid rendering on legacy macOS WebViews that do not support its regular-expression features.

### Added

- Native Intel macOS builds for `x86_64-apple-darwin`, alongside `aarch64-apple-darwin` Apple Silicon builds.
- Intel DMG artifacts with independent SHA256 and release manifest files, plus CI checks for the runner, target, and packaged binary architecture.
- Session context-menu actions for copying the full or short ID, renaming, archiving/restoring, and deleting.
- Project-level archive and restore actions resolved from the persisted working directory.
- Automated coverage for history replay, workspace resolution, archive refresh, project archive, and context-menu behavior.

### Fixed

- Existing sessions opening with an empty conversation history.
- `Invalid regular expression: invalid group specifier name` crashes on Intel Macs when rendering Mermaid content.
- Stale archive refreshes overwriting newer active/archived session state.
- Single, bulk, and project archive actions updating only one side of the session lists.
- Project archive actions processing only the currently visible sessions.

### Scope and privacy

- The desktop app remains ACP-only and continues to use the user's separately installed `kimi acp`; no model, tool, or runtime contract is replaced.
- No API keys, Apple signing credentials, Codex configuration, local absolute paths, or user session content are included.
- Without Apple signing secrets, the existing ad-hoc/unsigned fallback is preserved and recorded in the release manifest.

## 你可以用它做什么

- **完整的桌面对话体验**：流式 Markdown、代码高亮、工具调用卡片、文件差异、审批与追问均有专门界面。
- **真实还原会话进度**：统一处理实时事件与本地历史回放，保留附件、工具结果、任务状态和子智能体步骤。
- **掌握整个工作区**：在 Changes、Files、Agents 和 Tasks 面板之间切换，不离开对话即可查看改动和执行进度。
- **控制智能体行为**：支持权限模式、Plan、Swarm、模型状态、文件上传、Slash Commands，以及忙碌时的消息队列。
- **管理大量会话**：搜索、重命名、归档、恢复、批量处理，并可按 30 / 60 / 90 天一键归档长期未活跃会话；桌面端会为已访问会话保留独立 stream，切回运行中会话时自动回连补齐事件。
- **查看用量与上下文**：展示当前上下文窗口、Token 明细、平台额度，以及今日 / 7 天 / 30 天本地用量趋势；`/usage` 与 `/status` 会在 Composer 上方即时呈现结果。
- **任务状态一目了然**：状态条实时显示 `[N task running]`（与 CLI 一致）；后台任务与 Cron 调度在 Tasks 面板只读展示；子代理步骤支持任意层级嵌套，子代理派生的子代理也有独立可折叠视图。
- **融入 Windows**：提供系统托盘、任务完成与审批通知、全局快捷键，并确保重复启动时聚焦已有窗口。
- **原生 macOS 体验**：Intel 与 Apple Silicon 原生构建、Finder 中显示、`super+shift+k` 快捷键、原生菜单（含界面语言切换）、自动探测 Homebrew / uv 安装的 Kimi CLI。
- **中英界面即时切换**：界面语言支持跟随系统 / English / 简体中文，无需重启。
- **直接管理运行时配置**：在设置中切换深浅主题、编辑全局配置与原始 `config.toml`、管理 MCP Server，并可启用与配置实验性的 Secondary model。

## 设计与架构

界面采用 Monochrome V2 设计语言，以紧凑的信息密度、清晰的层级和低干扰动效服务长时间编码。深浅主题切换使用 View Transition 动画，并自动尊重系统的“减少动态效果”偏好。

运行时保持 **ACP-only**，不捆绑或静默回退到旧 Python sidecar：

```text
React 19 + Vite
  └─ Tauri 2 IPC / events
      ├─ AcpProcessManager       实时会话、发送、审批与取消
      ├─ AcpDesktopClient        ACP 会话 RPC
      ├─ session_store.rs        本地元数据与历史回放
      ├─ global_config.rs        ~/.kimi-code 配置
      └─ session_files / git     当前会话工作区文件与差异
           └─ user-installed `kimi acp`
```

桌面应用只负责 UI、进程编排和本地集成；Kimi Code CLI 仍是模型、工具及智能体运行行为的唯一来源。

## 安装

### 1. 安装并配置 Kimi Code CLI

确保 `kimi` 命令位于 `PATH`，并在 `~/.kimi-code/config.toml` 中配置可用的模型与 provider：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

可以使用 provider API key、Kimi Code 账号凭据或 Kimi Code CLI 支持的其他配置来源；桌面端不要求执行 `kimi login`。

从旧版 `~/.kimi` 迁移时，运行：

```powershell
kimi migrate
```

### 2. 安装桌面应用

从 [GitHub Releases](https://github.com/P-A-N-52/kimi-code-desktop/releases) 下载最新 MSI。安装包只包含桌面外壳，不会复制、覆盖或删除你的 Kimi Code CLI 配置与会话数据。

首次启动时，应用会检查 `kimi`、`kimi acp` 和 `~/.kimi-code/config.toml`，再加载本地会话；不会把 Kimi 账号登录状态作为启动条件。

## 本地开发

需要 Node.js、npm、Rust stable toolchain（MSVC target）以及已安装的 Kimi Code CLI。

```powershell
git clone https://github.com/P-A-N-52/kimi-code-desktop.git
cd kimi-code-desktop
npm install
npm run desktop
```

常用命令：

```powershell
npm run desktop:dev       # Tauri 开发模式与热重载
npm test                  # 前端测试
npm run build             # TypeScript + 前端生产构建
npm run rust:test         # Rust 测试
npm run rust:check        # Rust 编译检查
npm run check:quick       # 日常快速门禁
npm run smoke:acp         # 验证本机 kimi acp
```

## 构建与发布

```powershell
npm run desktop:release   # 本地可运行的 release exe
npm run release:msi       # MSI 与发布元数据
npm run release:macos     # Intel / Apple Silicon DMG（仅在 macOS）
npm run release:preflight # 完整发布前检查
```

### macOS Intel 与 Apple Silicon

macOS 桌面包支持 Intel（`x86_64-apple-darwin`）、Apple Silicon
（`aarch64-apple-darwin`）和 macOS 12 及以上版本。发布工作流会分别生成两种架构的
DMG，并按以下顺序选择信任级别：

1. Apple Developer ID 签名并公证；
2. 缺少凭据或签名/公证失败时使用 ad-hoc 签名；
3. ad-hoc 构建失败时生成未签名包。

工作流产物中的 `release-manifest-macos-arm64.json` 和
`release-manifest-macos-x64.json` 会记录实际使用的 `signingMode`、
`notarizationStatus` 和降级原因。ad-hoc 或未签名包可能需要用户在 macOS“隐私与
安全性”中手动允许。

完整签名和公证使用以下 GitHub Actions secrets：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_CONTENT`

也可以用 `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 替代 API Key
公证凭据。`KEYCHAIN_PASSWORD` 可选。

产物位置：

```text
src-tauri\target\release\kimi-code-desktop.exe
src-tauri\target\release\bundle\msi\Kimi Code_<version>_x64_en-US.msi
```

macOS 产物位置：

```text
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Kimi Code_<version>_aarch64.dmg
src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Kimi Code.app
src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Kimi Code_<version>_x64.dmg
src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Kimi Code.app
```

不要使用裸 `cargo build --release` 代替桌面构建；它会绕过 Tauri 的前端构建流程。

## 当前边界

- 目前支持 Windows 与 macOS（Intel、Apple Silicon）；macOS 构建默认不签名、不公证，正式分发需要配置 Apple 开发者凭据。
- 运行时必须能够访问已安装、已配置可用 provider 的 Kimi Code CLI，不要求 Kimi 账号登录，也不提供 legacy sidecar fallback。
- 当前提供手动深色 / 浅色切换；跟随系统主题尚未接入。
- ACP 尚不支持 fork-at-turn，因此桌面端不会伪造会话分叉能力。
- 工作区中的新能力仍需经过真实 Tauri + 可用 `kimi acp` provider 路径验收后，才会进入稳定发布说明。

## License

本项目基于 [Apache License 2.0](LICENSE) 开源。
