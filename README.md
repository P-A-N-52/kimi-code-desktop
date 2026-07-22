<p align="center">
  <img src="public/logo.png" width="96" alt="Kimi Code Desktop logo" />
</p>

<h1 align="center">Kimi Code Desktop</h1>

<p align="center">
  为 Kimi Code CLI 打造的原生 Windows 桌面工作台。<br />
  A native Windows workspace for Kimi Code CLI.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-111111" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-111111" />
  <img alt="React" src="https://img.shields.io/badge/React-19-111111" />
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111111" />
</p>

Kimi Code Desktop 将 Kimi Code 的终端智能体能力带进一个专注、可视、可管理的桌面界面。它不是另一套 AI 运行时：会话、模型、工具调用与智能体能力仍由用户安装的 Kimi Code CLI 提供，桌面端通过 ACP（`kimi acp`）连接，并负责交互、工作区呈现与 Windows 集成。

> 项目仍在快速迭代中。当前源码版本为 `0.1.5`，面向 Windows。

## 你可以用它做什么

- **完整的桌面对话体验**：流式 Markdown、代码高亮、工具调用卡片、文件差异、审批与追问均有专门界面。
- **真实还原会话进度**：统一处理实时事件与本地历史回放，保留附件、工具结果、任务状态和子智能体步骤。
- **掌握整个工作区**：在 Changes、Files、Agents 和 Tasks 面板之间切换，不离开对话即可查看改动和执行进度。
- **控制智能体行为**：支持权限模式、Plan、Swarm、模型状态、文件上传、Slash Commands，以及忙碌时的消息队列。
- **管理大量会话**：搜索、重命名、归档、恢复、批量处理，并可按 7 / 14 / 30 / 60 / 90 天一键归档长期未活跃会话。
- **查看用量与上下文**：展示当前上下文窗口、Token 明细、平台额度，以及今日 / 7 天 / 30 天本地用量趋势；`/usage` 与 `/status` 会在 Composer 上方即时呈现结果。
- **融入 Windows**：提供系统托盘、任务完成与审批通知、全局快捷键，并确保重复启动时聚焦已有窗口。
- **直接管理运行时配置**：在设置中切换深浅主题、编辑全局配置与原始 `config.toml`、管理 MCP Server，并查看桌面端与 CLI 版本。

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

### 1. 安装并登录 Kimi Code CLI

确保 `kimi` 命令位于 `PATH`：

```powershell
uv tool install kimi-cli
kimi login
```

从旧版 `~/.kimi` 迁移时，运行：

```powershell
kimi migrate
```

### 2. 安装桌面应用

从 [GitHub Releases](https://github.com/P-A-N-52/kimi-code-desktop/releases) 下载最新 MSI。安装包只包含桌面外壳，不会复制、覆盖或删除你的 Kimi Code CLI 配置与会话数据。

首次启动时，应用会检查 `kimi`、`kimi acp`、`~/.kimi-code/config.toml` 和登录状态，再加载本地会话。

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
npm run release:preflight # 完整发布前检查
```

产物位置：

```text
src-tauri\target\release\kimi-code-desktop.exe
src-tauri\target\release\bundle\msi\Kimi Code_<version>_x64_en-US.msi
```

不要使用裸 `cargo build --release` 代替桌面构建；它会绕过 Tauri 的前端构建流程。

## 当前边界

- 目前仅面向 Windows。
- 运行时必须能够访问已安装且已登录的 Kimi Code CLI，不提供 legacy sidecar fallback。
- 当前提供手动深色 / 浅色切换；跟随系统主题尚未接入。
- ACP 尚不支持 fork-at-turn，因此桌面端不会伪造会话分叉能力。
- 工作区中的新能力仍需经过真实 Tauri + 已认证 `kimi acp` 路径验收后，才会进入稳定发布说明。

## License

本项目基于 [Apache License 2.0](LICENSE) 开源。
