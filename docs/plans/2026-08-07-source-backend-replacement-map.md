# Source Backend 替换地图

状态：已确认方向，待实施
日期：2026-08-07
配套：架构决策见 `2026-08-07-source-backend-architecture.md`，验收见 `2026-08-07-ui-compatibility-checklist.md`

## 0. 范围判断

本次迁移替换的是**后端链路整体**——`src-tauri` 内 ACP 相关的管理器、客户端、翻译、能力协商、readiness、provider 桥接、smoke 与发布门禁。React 前端、wire 契约、本地数据辅助模块保留。按代码量算超过 `src-tauri` 的一半，按产品行为算 UI 基本零改动。

## 1. 保留（不动）

| 范围 | 内容 |
| --- | --- |
| `src/modules/` | 会话、Composer、Workspace（Changes/Files/Agents/Tasks）、Settings、Sessions 侧栏全部组件 |
| `src/hooks/` | `useSessionStream`（live/replay 统一归一化入口）、`wireTypes.ts`（wire 契约）、`useSessions` |
| `src/lib/` | `tool-events/`（语义注册表 + generic fallback）、`agent-monitor`、其余纯前端逻辑 |
| Zustand stores | 现有状态结构 |
| `src-tauri` 本地辅助 | `session_store.rs`（metadata + replay 持久化）、`session_files.rs`、`git_diff.rs`、`global_config.rs`（读路径）、`goal_queue.rs` / `goal_store.rs`、`notify.rs`、`tray.rs`、`native_menu.rs`、`security.rs`（路径/URL 校验）、`usage_stats.rs`（本地统计） |
| 窗口/系统 | 单实例、快捷键、托盘、通知、更新、深浅色主题 |

## 2. 替换（一对一对应）

| 现有（ACP 时代） | 新（Source 时代） | 说明 |
| --- | --- | --- |
| `acp.rs`（`AcpProcessManager`，每会话 wire 流） | `runtime/supervisor.rs`（+ crate 私有 `runtime/pump.rs`） | 单 Runtime 子进程生命周期：spawn/handshake/请求表/超时/重启/崩溃报告 |
| `acp_desktop.rs`（`AcpDesktopClient`） | `runtime/client.rs`（+ `client_types.rs`） | runtime-v1 方法调用：sessions/turn/config/models/providers |
| `acp_translate.rs` | `runtime/translate.rs`（+ `translate/` 子模块） | runtime-v1 event → 同一份 desktop wire；未知事件继续进 generic fallback |
| `acp_capabilities.rs` | handshake capability snapshot | 能力以 `runtime.hello` 返回为准，UI 按 snapshot 开关功能 |
| `runtime_backend.rs` | 删除概念，单一后端 | 不再存在 backend 选择 |
| `provider_cli.rs`（外部 `kimi provider` 桥接） | runtime 配置 API | provider/model/MCP 写操作全部走 runtime-v1 `config.update`/`providers.*` |
| `runtime_check.rs`（PATH/`kimi acp --help` readiness） | source readiness | 校验 SEA artifact 存在、完整、source commit 与发布清单一致 |
| `wire_events.rs`（ACP 形状） | runtime-v1 帧形状 | 仅 Rust 内部；前端 wire 不变 |
| `smoke:acp`（`scripts/acp-smoke.mjs`） | `smoke:runtime` | golden protocol tests：hello/getInfo/未知方法错误/跨会话 seq 隔离/shutdown |

## 3. 删除

- ACP fixtures、ACP 探针（`spawn_acp_probe_worker`）、ACP 错误文案。
- `get_kimi_cli_version` 命令 → 由 `runtime.getInfo` 取代（UI 显示 source tag/commit）。
- 所有“静默回退到用户 CLI”的代码路径与文案。
- `KIMI_CODE_BIN` 环境变量解析（`acp.rs` 内）。

## 4. 新增

- `runtime/kimi-code/apps/desktop-runtime/`：adapter + codec + protocol + server + stdio（自有代码，上游永不触碰）。
- `runtime/PATCHES.md`：上游补丁登记表（已建）。
- Rust：`src-tauri/src/runtime/` 模块目录（`mod.rs` / `supervisor.rs` / `pump.rs` / `protocol.rs` / `codec.rs` / `client.rs` / `client_types.rs` / `translate.rs` / `translate/` / `readiness.rs`；M2 已落地）。
- golden protocol fixtures 与协议 fuzz 测试。
- 发布门禁：artifact source commit 校验、无 PATH `kimi` 依赖校验、无 ACP 入口校验、macOS 签名/公证与 Windows 签名覆盖 runtime sidecar。

## 5. Tauri 命令迁移分类（68 个，2026-08-07 盘点）

### 5.1 保留（本地数据/系统能力，不改语义）

窗口与系统：`show_window`、`hide_window`、`get_app_version`、`open_external`、`open_in_explorer`、`open_in_editor`、`pick_files`、`pick_folder`、`save_text_file_dialog`
会话本地数据：`list_sessions`、`get_session`、`create_session`、`delete_session`、`update_session`、`generate_title`（本地 metadata 部分）
Goal/队列：`get_session_goal_snapshot`、`get_session_goal_queue`、`append_session_goal_queue`、`update_session_goal_queue`、`remove_session_goal_queue`、`move_session_goal_queue`、`control_session_goal`、`get_session_swarm_mode`、`get_session_goal_mode`、`get_session_runtime_modes`、`migrate_session_swarm_mode`、`migrate_session_goal_mode`
文件与 Git：`list_session_directory`、`get_session_file`、`get_session_upload_file`、`delete_uploaded_file`、`list_work_dir_directory`、`list_work_dirs`、`get_startup_dir`、`get_git_diff_stats`
配置读：`get_global_config`、`get_config_toml`、`get_mcp_config`、`list_available_skills`
其他：`get_session_influence_snapshot`、`fetch_usage_stats`（本地统计）

### 5.2 改接 runtime-v1（命令名不变，实现换）

| 命令 | 新实现 |
| --- | --- |
| `wire_connect` / `wire_disconnect` / `wire_send` / `wire_status` / `wire_list_workers` | runtime supervisor 的 session open/close/turn.start/status |
| `replay_session_history` | replay adapter 读 transcript/minidb 持久化记录 |
| `fork_session` | 等 capability snapshot 支持才启用，否则保持显式错误 |
| `upload_session_file` | runtime 附件 API |
| `get_providers_overview` / `list_provider_catalog` / `get_provider_catalog_entry` / `import_provider_from_catalog` / `import_provider_registry` | `providers.*` 方法 |
| `update_config_toml` / `update_global_config` / `update_mcp_config` | `config.update`（写后刷新 snapshot） |
| `fetch_managed_usage` | runtime 用量 API |
| `get_agent_runtime_capabilities` | handshake capability snapshot |
| `get_session_config_state` | `session.config` / `config.get` |
| `open_kimi_login` / `start_kimi_login` / `poll_kimi_login` / `cancel_kimi_login` / `kimi_credentials_status` / `logout_kimi` | runtime auth 流程（oauth 包在 runtime 进程内） |
| `check_runtime_readiness` | source readiness（artifact + commit + handshake） |
| `get_kimi_cli_version` | 删除，UI 改读 `runtime.getInfo` |

## 6. 数据所有权（最终只允许一个 writer）

| 数据 | Writer | Reader |
| --- | --- | --- |
| Kimi session/journal（transcript/minidb） | Source Runtime | Runtime、Rust replay adapter |
| provider/model/MCP 配置 | Source Runtime | Runtime、Settings snapshot |
| Desktop title/archive/UI metadata | Rust Desktop store | Rust/React |
| Worktree 文件/Git | 用户工具或 Runtime | Rust read helpers |
| Runtime 日志/崩溃报告 | Rust supervisor | Desktop 诊断 |

迁移纪律：首启只读扫描 `~/.kimi-code` 出预检；0.33.0 能原生读的保持原位，Desktop metadata 继续 overlay；需 schema 迁移时先备份 + migration marker 再原子提交；测试只用临时 `KIMI_CODE_HOME`。

## 7. 分阶段

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| M0 | 源码入库（已完成，`runtime/kimi-code` @ `53c832df`）+ 本文档集 | 文档齐、源码可构建 |
| M1 | `apps/desktop-runtime`：codec/handshake/router/lifecycle + adapter 接 klient + M1 最小方法集 | `smoke:runtime` 绿 |
| M2 | Rust supervisor/client/translate + fixture worker 集成测试 | `cargo test` 绿 |
| M3 | 行为对齐：live/replay、工具、审批、追问、Plan/Goal/Swarm、usage、provider/MCP、会话迁移 | UI 兼容清单全绿 |
| M4 | 一次性切换：命令改接 supervisor，删 ACP 生产路径，换 readiness/smoke/发布门禁 | 无 ACP 入口残留 |
| M5 | 发布验收：构建/协议 fuzz/迁移/preflight + 真实桌面验收 | 三状态分别记录：代码完成/自动化通过/真实桌面验收 |

M1 最小方法集与最小事件集沿用旧契约 §5.3/§5.4（存档于 `origin/codex/source-runtime`），实施时抄入 adapter 测试。
