# Kimi Code Desktop 代理指南 / Agent Guide

## 项目定位 / Project Role

本仓库是 Kimi Code CLI 的独立 Windows 桌面外壳，不是 CLI 源码树。React/Tauri 负责桌面体验和进程编排；AI 会话、模型、工具及运行时行为由用户安装的 Kimi Code CLI 通过 `kimi acp` 提供。配置、MCP、会话文件和 Git 信息由 Rust 本地辅助模块读写 `~/.kimi-code` 与当前工作区。

English: This repository is an independent Windows desktop shell for Kimi Code CLI, not the CLI source tree. React/Tauri owns the desktop UX and process orchestration; the user-installed Kimi Code CLI provides sessions, models, tools, and runtime behavior through `kimi acp`. Rust helpers handle config, MCP, session files, and Git data in `~/.kimi-code` and the active workspace.

当前事实来源按优先级为：正在运行的源码和测试、`package.json` 脚本、本文件、`README.md`、`docs/plans/`。不要引用已删除的 `docs/DEVELOPMENT_STANDARD.md`、`docs/RELEASE.md` 或 `docs/acp-contract.md`。

English: Sources of truth, in order, are the running source and tests, `package.json` scripts, this file, `README.md`, and `docs/plans/`. Do not reference the removed `docs/DEVELOPMENT_STANDARD.md`, `docs/RELEASE.md`, or `docs/acp-contract.md`.

## 当前进度（2026-07-20）/ Current Progress

### 已提交基线 / Committed Baseline

- Monochrome V2 视觉系统、AppShell、会话侧栏、消息流、Composer、Changes 面板、设置页和快捷键已在 2026-07-18 的 V2 提交序列中落地。
- 当前 `master` 比 `origin/master` 超前；不要把“尚未推送”误判成“尚未实现”。

English:

- The Monochrome V2 visual system, AppShell, session sidebar, message stream, composer, Changes panel, settings shell, and shortcuts landed in the 2026-07-18 V2 commit series.
- Local `master` is ahead of `origin/master`; do not confuse “not pushed” with “not implemented.”

### 工作区内已实现、仍待收口 / Implemented In The Worktree, Pending Integration

- 后端已迁移到 ACP-only：`AcpProcessManager` 负责会话 wire 流，`AcpDesktopClient` 负责会话 RPC；Python sidecar、`sidecar.rs` 和 bundled `kimi-sidecar` 正在删除。
- V2 已重新接入单一活动 `useSessionStream`、历史回放、附件、状态消息、工具 display blocks、子代理步骤，以及通用未知 payload fallback。
- Workspace 已接入 Changes、Files、Agents、Tasks；Composer 已接入 slash 命令、文件上传、忙碌时队列和全局模型显示。
- `/usage` / `/status` 由桌面本地拉取平台额度（5h / 7d）；未知斜杠指令会拦截提示。详见 `docs/SLASH_COMMAND_PARITY.md`。
- 会话侧栏已接入 active/archived 分页、归档/恢复、标题生成、批量归档/恢复/删除；设置已接入 dark/light 主题、全局配置、原始 `config.toml` 和 MCP。
- 发送反馈已具备通用状态：立即显示“消息发送中”，首个可见响应后移除；空终态或 ACP 错误显示持久错误。

English:

- The backend worktree is ACP-only: `AcpProcessManager` owns session wire streams and `AcpDesktopClient` owns session RPC. The Python sidecar, `sidecar.rs`, and bundled `kimi-sidecar` are being removed.
- V2 reconnects a single active `useSessionStream`, replay, attachments, status messages, tool display blocks, subagent steps, and a generic fallback for unknown payloads.
- Workspace exposes Changes, Files, Agents, and Tasks. Composer exposes slash commands, uploads, busy-state queueing, and the global model label.
- `/usage` / `/status` are handled locally with platform quotas (5h / 7d); unknown slash commands are blocked with a desktop hint. See `docs/SLASH_COMMAND_PARITY.md`.
- Sessions expose active/archived pagination, archive/restore, title generation, and bulk archive/restore/delete. Settings expose dark/light theme, global config, raw `config.toml`, and MCP.
- Generic send feedback shows “消息发送中” immediately, clears on the first visible response, and preserves empty-terminal or ACP failures as visible errors.

这些内容横跨 staged、unstaged 和 untracked 文件。除非完整验证通过并完成提交，否则在交接中称为“工作区已实现”或“集成中”，不要称为稳定发布能力。

English: This work spans staged, unstaged, and untracked files. Until full verification and commit are complete, describe it as “implemented in the worktree” or “in integration,” not as a stable release capability.

### 尚未完成的验收 / Remaining Acceptance

- 按 `docs/plans/2026-07-18-webview2-acceptance.md` 在真实 Tauri + 已认证 `kimi acp` 路径上验证会话、prompt、工具、Workspace 和 Settings；浏览器 mock 不等于桌面验收。
- 完成 `docs/plans/2026-07-18-v2-ui-integration.md` 的剩余差距审计，特别检查桌面完成通知和所有真实运行时入口；不要仅按文件存在判断完成。`fork_session` 当前因 ACP 不支持而明确返回错误，不得伪造 fork-at-turn UI 或静默改走旧 API。
- 补齐 Settings、Sessions sidebar 和 Workspace 的集成测试；system theme 尚未接入，不能把 dark/light 切换描述为完整的三态主题支持。
- Share 没有真实后端契约时应保持移除或禁用，不要制作假入口。
- 发布脚本和 MSI 只有在 `release:preflight` / `release:msi` 通过后才能声明可发布。

English:

- Follow `docs/plans/2026-07-18-webview2-acceptance.md` against real Tauri plus an authenticated `kimi acp`. Browser mocks are not desktop acceptance.
- Audit remaining gaps in `docs/plans/2026-07-18-v2-ui-integration.md`, especially desktop completion notifications and all real runtime entry points. `fork_session` currently returns an explicit error because ACP does not support it; do not fake fork-at-turn UI or silently route it through a legacy API.
- Add integration coverage for Settings, Sessions sidebar, and Workspace. System theme is not wired yet, so do not describe the dark/light toggle as complete three-state theme support.
- Keep Share removed or disabled until a real backend contract exists.
- Do not claim release readiness until `release:preflight` and, when relevant, `release:msi` pass.

## 运行链路 / Runtime Chain

桌面应用为 **ACP-only**；不要恢复 Python sidecar 或新增 legacy runtime fallback。

```text
React app shell / useSessionStream
  -> Tauri IPC / events
     -> AcpProcessManager                              # live connect/send/status/approval
        -> per-session user-installed `kimi acp`
     -> AcpDesktopClient                               # shared non-wire ACP session RPC
     -> session_store.rs                               # local metadata + wire.jsonl replay
     -> global_config.rs / mcp_config.rs               # ~/.kimi-code config
     -> session_files.rs / git_diff.rs                 # selected session worktree
```

会话 list/get/update/delete 是 ACP 结果与本地 metadata/session state 的组合，不是单一 client 的纯远程 CRUD。历史回放由 `session_store.rs` 直接翻译本地新格式记录；Git diff 针对选中会话的 worktree。

English: Session list/get/update/delete combine ACP results with local metadata and session state rather than using one pure remote CRUD client. `session_store.rs` translates persisted new-format records directly for replay; Git diff targets the selected session worktree.

ACP 到现有前端 wire 事件的兼容翻译集中在 `src-tauri/src/acp_translate.rs`。这里的 `legacy` 命名通常表示前端数据形状，不代表允许恢复 legacy runtime。

English: ACP-to-frontend wire compatibility translation lives in `src-tauri/src/acp_translate.rs`. A `legacy` name here usually describes the frontend data shape; it does not authorize restoring the legacy runtime.

## 硬性规则 / Hard Rules

- 开始前运行 `git status --short --branch`，区分 staged、unstaged、untracked 和本地已提交状态。
- 工作区包含大规模并行改动；不要 reset、checkout 或重写无关文件，也不要未经确认重新暂存全部内容。
- 修复用户可见事件时，沿完整链路检查 ACP 翻译、live dispatcher、history replay、state store 和语义 UI，不要只检查 TypeScript union。
- 未知事件、工具和 display payload 必须保留通用 fallback；新增语义 UI 不得破坏 fallback。
- `useSessionStream` 是 live/replay wire 的统一归一化入口，AppShell 只持有一个 active-session stream。新增 wire/tool/media/subagent/steering 事件时必须同时核对类型契约、live dispatcher、`session_store` replay、state store、语义 UI 与 generic fallback。
- 不要恢复已删除的 legacy component tree；V2 `src/modules/` 组件与现有 Zustand stores 是当前 UI 主路径。
- `~/.kimi-code` 属于用户运行时数据；测试不得覆盖真实配置、凭据或历史会话。
- 日常启动使用 `npm run desktop` 或 `start.bat`；本地 release exe 使用 `npm run desktop:release`；MSI 使用 `npm run release:msi`。
- 不要把 `cargo build --release` 当成可运行桌面构建，也不要让旧 exe/MSI 代替当前源码。
- 运行时需要 PATH 上的 `kimi` 和可用的 `kimi acp`；不得静默回退到 sidecar。

English:

- Start with `git status --short --branch` and distinguish staged, unstaged, untracked, and locally committed work.
- This worktree contains large parallel changes. Do not reset, check out, or rewrite unrelated files, and do not restage everything without confirmation.
- For user-visible events, inspect the complete path: ACP translation, live dispatcher, history replay, state store, and semantic UI. A TypeScript union is not coverage.
- Preserve generic fallbacks for unknown events, tools, and display payloads.
- `useSessionStream` is the shared live/replay normalization point, and AppShell owns exactly one active-session stream. For wire/tool/media/subagent/steering changes, verify the type contract, live dispatcher, `session_store` replay, state store, semantic UI, and generic fallback together.
- Do not restore the deleted legacy component tree; V2 components under `src/modules/` and the existing Zustand stores are the current UI path.
- Treat `~/.kimi-code` as user runtime data; tests must not overwrite real config, credentials, or history.
- Use `npm run desktop` or `start.bat` for daily launch, `npm run desktop:release` for a local release executable, and `npm run release:msi` for MSI packaging.
- Do not use `cargo build --release` as the runnable desktop path or substitute stale artifacts for the source tree.
- Runtime requires `kimi` on PATH and a usable `kimi acp`; never silently fall back to a sidecar.

## 标准命令 / Canonical Commands

```powershell
npm run desktop
npm run desktop:dev
npm run check:quick
npm run lint:check
npm run smoke:acp
npm run smoke:mcp
npm run smoke:skill
npm run desktop:release
npm run release:preflight
npm run release:msi
npm run version:sync
```

兼容别名 `npm run tauri:dev` 和 `npm run tauri:build` 仍存在，但文档和交接优先使用 `desktop:*` 与 `release:*`。

## 关键文件 / Files To Know

```text
src/app/app.tsx                              # app-level wiring and the single active stream
src/hooks/useSessionStream.ts                # live/replay event reducer and prompt lifecycle
src/hooks/wireTypes.ts                       # frontend wire contract
src/hooks/useSessions.ts                     # session CRUD, paging, archive, upload, fork API
src/modules/conversation/                    # message, attachment, tool, question, status UI
src/modules/composer/composer.tsx            # prompt, slash commands, upload, queue controls
src/modules/workspace/changes-panel.tsx      # Changes / Files / Agents / Tasks shell
src/modules/settings/settings-dialog.tsx     # theme, global config, config.toml, MCP
src/lib/tool-events/                         # semantic tool registry, side effects, fallback data
src-tauri/src/acp.rs                         # per-session ACP wire manager
src-tauri/src/acp_desktop.rs                 # ACP session RPC client
src-tauri/src/acp_translate.rs               # ACP -> frontend wire translation
src-tauri/src/session_store.rs               # persisted new-format replay and local metadata
src-tauri/src/runtime_check.rs               # installed CLI/auth/config readiness
scripts/check-quick.mjs
scripts/acp-smoke.mjs
docs/plans/2026-07-18-v2-ui-integration.md
docs/plans/2026-07-18-webview2-acceptance.md
docs/plans/2026-07-19-generic-send-feedback.md
```

## 验证 / Verification

文档或小范围前端变更至少运行相关 focused tests 和 `git diff --check`。常规集成门禁：

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

快速门禁可使用：

```powershell
npm run check:quick
```

若单体命令因超时或管道中断失败，分别运行上面的测试，不要把进程被终止产生的 `BrokenPipe` 当成代码失败。

ACP runtime 变更还需运行：

```powershell
npm run smoke:acp
```

该命令依赖本机 CLI 与认证状态；报告时把环境阻塞与代码回归分开。UI 完成度必须再走真实 Tauri/WebView2 验收并检查可见 DOM、控制台错误和真实 IPC。

ACP-only 代码门禁应确认旧 runtime 标识没有重新进入生产路径。搜索命中注释、测试或“legacy wire shape”时需人工分类，不要机械要求全仓零匹配：

```powershell
rg -n "kimi-sidecar|KIMI_CLI_BIN|call_desktop_api|WireProcessManager" src-tauri src package.json scripts
if (Test-Path sidecar-adapter) { throw "sidecar-adapter must not exist" }
```

发布相关变更：

```powershell
npm run release:preflight
npm run release:msi
```

## 版本契约 / Version Contract

桌面外壳版本必须在以下文件中一致，并通过 `npm run version:sync` 检查：

```text
package.json
package-lock.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

桌面外壳版本与 Kimi Code CLI runtime 版本是两个概念。任何 CLI 版本 UI 都必须探测实际安装/运行的 CLI。

## 子代理边界 / Sub-Agent Boundaries

按所有权拆分并避免交叉编辑：

```text
Stream/data agent: src/hooks, src/lib/api, src/lib/tool-events
Conversation/UI agent: src/modules/conversation, src/modules/composer
Workspace/session agent: src/app, src/modules/workspace, src/modules/sessions, src/modules/settings
Rust agent: src-tauri/src ACP, commands, config/files, replay, runtime readiness
Release agent: package scripts, PowerShell, workflows, Tauri config, release docs
Acceptance agent: read-only runtime smoke, WebView2/CDP evidence, regression reports
```

每个代理都必须先读取本文件与当前 `git status`，声明拥有的文件，只修改分配范围。`src/app/app.tsx`、`src/hooks/useSessionStream.ts`、`src-tauri/src/commands.rs` 等共享热点文件同一时间只允许一个 owner 修改，其他代理只提出接口需求。把“代码存在”“测试通过”“真实桌面已验收”作为三个不同状态报告。

English: Every agent must read this file and the current Git status first, declare file ownership, stay within scope, and report “code exists,” “tests pass,” and “real desktop accepted” as separate states.
