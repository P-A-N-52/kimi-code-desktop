# Kimi Desktop — 项目全景与架构指南

## 这是什么项目？

**Kimi Desktop** 是 [Kimi Code CLI](https://github.com/moonshot-ai/kimi-cli) 的独立桌面壳应用。它将命令行 AI 编程助手的完整能力封装进一个现代化的图形界面，让用户可以通过聊天窗口与 AI 协作编写代码、管理文件、执行命令，而无需在终端中操作。

项目的核心设计哲学是**"不重复造轮子"**：所有 AI 会话逻辑、模型配置、Agent Runtime 都复用 `kimi-cli` 的 Python 核心；桌面端只负责**呈现层**（React UI）和**进程编排层**（Rust + Python sidecar adapter）。

---

## 用户能做什么？

| 功能 | 说明 |
|------|------|
| **多会话管理** | 创建、归档、搜索、分叉会话，每个会话绑定一个工作目录 |
| **流式对话** | 与 AI 实时对话，支持文本、图片、视频附件 |
| **工具调用审批** | AI 执行文件编辑、Shell 命令前需要用户确认，支持快捷键一键通过/拒绝 |
| **计划模式** | AI 输出结构化执行计划，用户可以审视后再执行 |
| **工作区面板** | 实时查看会话产生的文件变更、Git diff、待办任务 |
| **模型配置** | 通过 UI 编辑 `~/.kimi/config.toml`，切换模型、配置 API Key、管理 MCP Servers |
| **系统托盘** | 最小化到托盘，全局快捷键 `Ctrl+Shift+K` 唤起窗口 |
| **侧边栏聊天** | 浮动侧边栏进行并行对话，不干扰主会话 |

---

## 技术架构（三层模型）

```
┌─────────────────────────────────────────────────────────────┐
│                      前端层 (Frontend)                       │
│  React 19 + TypeScript + Tailwind CSS + shadcn/ui          │
│  ├─ 三面板布局：会话列表 | 聊天工作区 | 工作区面板          │
│  ├─ useSessionStream.ts：实时流状态机（~3900 行）           │
│  └─ 双模式：Tauri IPC（桌面）/ WebSocket（浏览器）          │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri invoke / listen
┌──────────────────────────▼──────────────────────────────────┐
│                    中间层 (Rust Backend)                     │
│  src-tauri/src/                                             │
│  ├─ sidecar.rs：WireProcessManager + DesktopApiProcessMgr  │
│  ├─ commands.rs：Tauri command surface（~30+ 命令）         │
│  ├─ tray.rs：系统托盘与全局快捷键                           │
│  └─ notify.rs：桌面通知（审批请求、任务完成）               │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdin/stdout NDJSON
┌──────────────────────────▼──────────────────────────────────┐
│                运行时层 (Python Sidecar)                     │
│  sidecar-adapter/kimi_desktop_sidecar/                      │
│  ├─ worker.py：Wire worker，拦截 prompt 注入上传文件        │
│  ├─ api.py：Desktop API 分发器（session/file/config/git）   │
│  └─ __main__.py：CLI 入口，暴露 __desktop-worker / __desktop-api
│                                                             │
│              ↓ import kimi_cli.*（复用 CLI 核心）            │
│                                                             │
│                kimi-cli Python 运行时                       │
│                会话存储、模型调用、工具执行、MCP...          │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心概念

### 1. Wire 协议

前后端之间的实时通信协议，基于 **JSON-RPC 2.0 over NDJSON**（每行一个 JSON 对象）。

- **下行（Worker → Frontend）**：`TurnBegin`、`StepBegin`、`ContentPart`、`ToolCall`、`ToolResult`、`ApprovalRequest`、`QuestionRequest`、`SubagentEvent`、`StatusUpdate`...
- **上行（Frontend → Worker）**：`prompt`（用户输入）
- **Rust 缓冲**：Tauri shell stdout 返回的是任意字节块，不保证按行切割。Rust 层维护 8 MiB 缓冲区，按 `\n` 分割后逐行转发给前端。

### 2. 双通道通信

| 通道 | 用途 | 进程模型 |
|------|------|----------|
| **Wire Stream** | 实时会话聊天 | 每个 session 一个 `kimi-sidecar __desktop-worker` 长驻进程 |
| **Desktop API** | CRUD、文件、配置、Git | 一个共享的 `kimi-sidecar __desktop-api-server` 长驻进程 |

### 3. Session 生命周期

1. 用户在 UI 创建/选择会话
2. `ChatWorkspaceContainer` 调用 `useSessionStream(sessionId)`
3. Rust `WireProcessManager` 为该 session 启动 Python worker（如无）
4. 用户发送消息 → Rust 写入 worker stdin → Python 调用 `kimi_cli` 处理 → 流式事件返回 stdout → Rust 转发 Tauri event → 前端更新 React state
5. 会话数据持久化在 `~/.kimi/sessions/`，与 CLI/Web 版本完全兼容

---

## 关键文件索引

### 前端 (`src/`)

| 文件/目录 | 职责 |
|-----------|------|
| `src/App.tsx` | 顶层三面板布局 orchestrator，URL 同步，对话框管理 |
| `src/hooks/useSessionStream.ts` | **核心**：Wire 连接管理、流事件解析、React state 合并 |
| `src/hooks/useSessions.ts` | 会话列表 CRUD、搜索、归档、分叉 |
| `src/features/chat/` | 聊天工作区所有组件（消息列表、输入框、审批弹窗） |
| `src/features/workbench/` | 右侧面板：文件、Git diff、任务、待审批请求 |
| `src/features/settings/` | 设置对话框：config.toml / MCP / skills 编辑 |
| `src/features/agent-monitor/` | 子代理任务监控面板 |
| `src/features/side-chat/` | 浮动侧边栏聊天 |
| `src/components/ai-elements/` | AI 聊天设计系统（消息、输入、工具渲染、流式 Markdown） |
| `src/lib/tauri-api.ts` | Tauri IPC 封装层，提供类型化 API 调用 |
| `src/hooks/wireTypes.ts` | Wire 协议 TypeScript 类型定义 |

### Rust 后端 (`src-tauri/src/`)

| 文件 | 职责 |
|------|------|
| `sidecar.rs` | 进程管理：启动/停止 worker、stdin 写入、stdout 缓冲解析 |
| `commands.rs` | Tauri command surface：wire 操作、session、file、config、git、窗口 |
| `tray.rs` | 系统托盘菜单与事件 |
| `notify.rs` | OS 通知发送 |
| `lib.rs` | Tauri 应用初始化、状态注册、生命周期 |

### Python Sidecar (`sidecar-adapter/`)

| 文件 | 职责 |
|------|------|
| `kimi_desktop_sidecar/worker.py` | Wire worker：prompt 拦截、上传文件注入、启动 `kimi_cli.run_wire_stdio()` |
| `kimi_desktop_sidecar/api.py` | Desktop API 路由：session/file/config/git 等 action 分发 |
| `kimi_desktop_sidecar/__main__.py` | CLI 入口：`__desktop-worker`、`__desktop-api`、`__desktop-api-server` |
| `kimi_desktop_sidecar/windows_subprocess.py` | Windows 下阻止子进程弹出控制台窗口 |

---

## 与 kimi-cli 的关系

- **kimi-cli**：核心引擎，提供会话存储、配置管理、模型调用、工具执行、MCP 集成
- **kimi-desktop**：纯壳项目，不负责 AI 逻辑，只负责**进程管理 + UI 呈现**
- **sidecar-adapter**：薄层胶水代码，将 CLI 引擎包装成桌面可消费的 stdio NDJSON 服务
- **数据兼容**：会话、配置、历史记录完全共享，用户可以在 CLI / Web / Desktop 之间无缝切换

---

## 开发指引速查

### 启动开发
```bash
start.bat
# 或
npm run tauri:dev
```

### 验证构建
```bash
npm run build
cargo check --manifest-path src-tauri\Cargo.toml
cd sidecar-adapter
python -m compileall -q kimi_desktop_sidecar
```

### 添加新功能时的注意事项
1. **前端状态更新**：如果修改 Wire 事件类型，同步更新 `src/hooks/wireTypes.ts` 和 `useSessionStream.ts` 的 reducer
2. **后端命令**：新增 Tauri command 需在 `commands.rs` 注册，并在 `src/lib/tauri-api.ts` 添加前端封装
3. **Sidecar API**：新增 Desktop API action 需在 `api.py` 的 `ACTION_HANDLERS` 注册
4. **Windows sidecar 路径**：Tauri `externalBin` 期望 `src-tauri/sidecar/kimi-sidecar-x86_64-pc-windows-msvc.exe`
5. **不要**将桌面专属 helper 代码放入 `kimi_cli` Python 包内

---

## 子代理工作建议

如果由多个 AI 子代理协作修改本项目，建议按以下边界分工：

| 子代理 | 负责范围 |
|--------|----------|
| **Frontend Agent** | `src/` 下的 React/TS 代码，包括组件、hooks、features、状态管理 |
| **Rust Agent** | `src-tauri/src/` 下的 Rust 代码，包括命令、进程管理、托盘、通知 |
| **Sidecar Agent** | `sidecar-adapter/` 下的 Python 代码，包括 worker、api、Windows 补丁 |

**协作接口**：
- 前端 ↔ Rust：Tauri `invoke` 命令签名 + `wire:message` 事件格式
- Rust ↔ Sidecar：NDJSON 行协议（JSON-RPC 2.0）
- 三方共同契约：`src/hooks/wireTypes.ts` 与 `sidecar-adapter` 中的消息类型必须保持一致
