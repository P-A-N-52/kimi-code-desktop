<p align="center">
  <img src="public/logo.png" width="96" alt="Kimi Code Desktop logo" />
</p>

<h1 align="center">Kimi Code Desktop</h1>

<p align="center">
  源码自有的 Kimi Code Windows 与 macOS 桌面工作台。<br />
  A source-owned Kimi Code workspace for Windows &amp; macOS.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-111111" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-111111" />
  <img alt="React" src="https://img.shields.io/badge/React-19-111111" />
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111111" />
</p>

开发与提交约定见 [结构与开发规范](.github/DEVELOPMENT.md)。Source Runtime 的已确认迁移契约见 [2026-08-06 Source Runtime 方案](docs/plans/2026-08-06-source-runtime-migration.md)。

Kimi Code Desktop 将 Kimi Code 的智能体能力带进一个专注、可视、可管理的桌面界面。`codex/source-runtime` 正在把 Kimi Code 0.33.0 源码纳入仓库并构建为唯一 Runtime；完成后发布包不依赖用户安装的 CLI，也不使用 ACP 或生产双 backend。

> 当前源码版本为 `1.1.3`。本分支尚在 M0：ACP 仍是可执行基线，Source Runtime 尚未完成真实切换，因此本分支不是可发布状态。

## 你可以用它做什么

- **完整的桌面对话体验**：流式 Markdown、代码高亮、工具调用卡片、文件差异、审批与追问均有专门界面。
- **真实还原会话进度**：统一处理实时事件与本地历史回放，保留附件、工具结果、任务状态和子智能体步骤。
- **掌握整个工作区**：在 Changes、Files、Agents 和 Tasks 面板之间切换，不离开对话即可查看改动和执行进度。
- **控制智能体行为**：支持权限模式、Plan、Swarm、模型状态、文件上传、Slash Commands，以及忙碌时的消息队列。
- **管理大量会话**：搜索、重命名、归档、恢复、批量处理，并可按 30 / 60 / 90 天一键归档长期未活跃会话；桌面端会为已访问会话保留独立 stream，切回运行中会话时自动回连补齐事件。
- **查看用量与上下文**：展示当前上下文窗口、Token 明细、平台额度，以及今日 / 7 天 / 30 天本地用量趋势；`/usage` 与 `/status` 会在 Composer 上方即时呈现结果。
- **任务状态一目了然**：状态条实时显示 `[N task running]`（与 CLI 一致）；后台任务与 Cron 调度在 Tasks 面板只读展示；子代理步骤支持任意层级嵌套，子代理派生的子代理也有独立可折叠视图。
- **融入 Windows**：提供系统托盘、任务完成与审批通知、全局快捷键，并确保重复启动时聚焦已有窗口。
- **原生 macOS 体验**：Apple Silicon 原生构建、Finder 中显示、`super+shift+k` 快捷键、原生菜单（含界面语言切换）、自动探测 Homebrew / uv 安装的 Kimi CLI。
- **中英界面即时切换**：界面语言支持跟随系统 / English / 简体中文，无需重启。
- **直接管理运行时配置**：在设置中切换深浅主题、编辑全局配置与原始 `config.toml`、管理 MCP Server，并可启用与配置实验性的 Secondary model。

## 设计与架构

界面采用 Monochrome V2 设计语言，以紧凑的信息密度、清晰的层级和低干扰动效服务长时间编码。深浅主题切换使用 View Transition 动画，并自动尊重系统的“减少动态效果”偏好。

当前迁移基线仍是 ACP；目标架构为 **Source-Runtime-only**，不捆绑或静默回退到 ACP、外部 CLI 或旧 Python sidecar：

```text
React 19 + Vite
  └─ stable Tauri 2 IPC / events
      ├─ RuntimeSupervisor
      │   └─ source-built desktop-runtime child
      │       └─ createKimiHarnessV2 / vendored Kimi source
      ├─ desktop metadata / replay adapter
      └─ session files / Git
```

Runtime 作为 Tauri 监管的独立 OS 子进程运行，通过 `runtime-v1` stdio JSONL 通信。React 不直接依赖 Kimi 内部类型；Rust 保留进程监管、桌面数据、文件和 Git 安全边界。

## 当前稳定版安装（ACP 基线）

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

外层 Desktop 需要 Node.js 24.15.0 以上、npm 和 Rust stable toolchain。M4 之前运行 ACP 基线仍需已安装的 Kimi Code CLI；`npm install` 会安装项目固定的 pnpm 10.33.0，用于 nested Source Runtime workspace，不依赖全局 pnpm 或 Corepack。

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
npm run runtime:install   # 安装固定 Kimi source workspace 依赖
npm run runtime:build     # 构建 Source Runtime skeleton
npm run smoke:runtime     # 构建并验证 runtime-v1 协议
```

## 参与贡献 / Contributing

欢迎提交 Bug 报告、功能建议、代码、测试和文档改进。开始前请阅读
[贡献指南 / Contributing Guide](CONTRIBUTING.md)，其中包含开发环境、架构边界、
验证矩阵以及 Pull Request 要求。

Bug reports, feature proposals, code, tests, and documentation improvements are
welcome. Before starting, read the
[Contributing Guide / 贡献指南](CONTRIBUTING.md) for development setup,
architecture boundaries, verification requirements, and pull request guidance.

## 构建与发布

```powershell
npm run desktop:release   # 本地可运行的 release exe
npm run release:msi       # MSI 与发布元数据
npm run release:macos     # Apple Silicon DMG（仅在 macOS）
npm run release:preflight # 完整发布前检查
```

### macOS Apple Silicon

macOS 桌面包当前仅支持 Apple Silicon（`aarch64-apple-darwin`）和 macOS 12
及以上版本。发布工作流会生成 DMG，并按以下顺序选择信任级别：

1. Apple Developer ID 签名并公证；
2. 缺少凭据或签名/公证失败时使用 ad-hoc 签名；
3. ad-hoc 构建失败时生成未签名包。

工作流产物中的 `release-manifest-macos-arm64.json` 会记录实际使用的
`signingMode`、`notarizationStatus` 和降级原因。ad-hoc 或未签名包可能需要用户在
macOS“隐私与安全性”中手动允许。

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
```

不要使用裸 `cargo build --release` 代替桌面构建；它会绕过 Tauri 的前端构建流程。

## 当前边界

- 目前支持 Windows 与 macOS（Apple Silicon）；macOS 构建默认不签名、不公证，正式分发需要配置 Apple 开发者凭据。
- 运行时必须能够访问已安装、已配置可用 provider 的 Kimi Code CLI，不要求 Kimi 账号登录，也不提供 legacy sidecar fallback。
- 当前提供手动深色 / 浅色切换；跟随系统主题尚未接入。
- ACP 尚不支持 fork-at-turn，因此桌面端不会伪造会话分叉能力。
- 工作区中的新能力仍需经过真实 Tauri + 可用 `kimi acp` provider 路径验收后，才会进入稳定发布说明。

## License

本项目基于 [Apache License 2.0](LICENSE) 开源。
