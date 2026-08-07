# Kimi Code Desktop 代理指南 / Agent Guide

## 项目定位 / Project Role

本仓库已在 `codex/runtime-cutover` 分支完成一次性切换，是源码自有的 Kimi Code Desktop 产品。React/Tauri 负责桌面体验和进程编排；`runtime/kimi-code` 内的 Kimi 源码是仓内唯一 AI Runtime 内核，构建为 Node 子进程并随应用交付。产品不依赖用户安装的 CLI，不使用 ACP，也没有生产双 backend 或静默 fallback。

English: On `codex/runtime-cutover`, this repository has completed the one-shot cutover to a source-owned Kimi Code Desktop product. React/Tauri owns desktop UX and process orchestration; the vendored Kimi source under `runtime/kimi-code` is the only AI runtime kernel, built as a Node child process and shipped with the app. The product does not depend on an installed CLI, does not use ACP, and has no production dual backend or silent fallback.

当前可执行基线已是 Source Runtime（`runtime-v1` stdio JSONL）；ACP 已从生产路径移除，`smoke:runtime` 是运行时门禁。切换契约以 `docs/plans/2026-08-08-runtime-cutover-m4.md` 为准；长期维护策略见 `docs/plans/2026-08-07-source-backend-maintenance.md`。

English: The executable baseline is the Source Runtime (runtime-v1 stdio JSONL); ACP has been removed from production paths and `smoke:runtime` is the runtime gate. The cutover contract is `docs/plans/2026-08-08-runtime-cutover-m4.md`; the long-term maintenance policy is `docs/plans/2026-08-07-source-backend-maintenance.md`.

当前事实来源按优先级为：正在运行的源码和测试、`package.json` 脚本、`.github/DEVELOPMENT.md`、本文件、已确认的 Source Runtime 迁移契约、`README.md`、其他 `docs/plans/`。不要引用已删除的 `docs/DEVELOPMENT_STANDARD.md`、`docs/RELEASE.md` 或 `docs/acp-contract.md`。

English: Sources of truth, in order, are running source and tests, `package.json` scripts, `.github/DEVELOPMENT.md`, this file, the accepted Source Runtime migration contract, `README.md`, and other plans. Do not reference the removed `docs/DEVELOPMENT_STANDARD.md`, `docs/RELEASE.md`, or `docs/acp-contract.md`.

开发规范见 `.github/DEVELOPMENT.md`，实现前先阅读。 / Read `.github/DEVELOPMENT.md` before implementation.

## 当前进度（2026-08-08）/ Current Progress

### Source Runtime 切换完成（M4）/ Source Runtime Cutover Complete

- 已冻结 Kimi Code `@moonshot-ai/kimi-code@0.33.0` / commit `53c832dfdf9566afd59a8b3d54ebd36d3cb03d72`（`runtime/UPSTREAM.md`）。
- W0–W3 完成：`runtime/host.rs`（RuntimeHost 单例：supervisor 懒启动/重建、泵线程单点 emit、会话表/lease、控制通道）接管会话 wire 流，`runtime-v1` stdio JSONL 是 Rust 与 Node runtime 之间唯一协议；命令族全切、ACP 文件删除、测试改写（`cargo test` 458→337）。
- W4 完成：发布门禁切换（`release:preflight` 换 `Assert-SourceRuntime`，发布流水线跑 `smoke:runtime`）与文档收口。
- 详见 `docs/plans/2026-08-08-runtime-cutover-m4.md`；维护策略见 `docs/plans/2026-08-07-source-backend-maintenance.md`。

### 已提交基线 / Committed Baseline

- Monochrome V2 视觉系统、AppShell、会话侧栏、消息流、Composer、Changes 面板、设置页和快捷键已在 2026-07-18 的 V2 提交序列中落地。
- 当前 `master` 比 `origin/master` 超前；不要把“尚未推送”误判成“尚未实现”。

English:

- The Monochrome V2 visual system, AppShell, session sidebar, message stream, composer, Changes panel, settings shell, and shortcuts landed in the 2026-07-18 V2 commit series.
- Local `master` is ahead of `origin/master`; do not confuse “not pushed” with “not implemented.”

### 已提交 Source Runtime 基线 / Committed Source Runtime Baseline

- 会话 wire 流由 `runtime/host.rs`（RuntimeHost）统一管理：supervisor 懒启动/重建、泵线程单点 emit、会话表/lease、控制通道；`runtime-v1` stdio JSONL 是 Rust 与 Node runtime 之间唯一协议。
- V2 已重新接入单一活动 `useSessionStream`、历史回放、附件、状态消息、工具 display blocks、子代理步骤，以及通用未知 payload fallback。
- Workspace 已接入 Changes、Files、Agents、Tasks；Composer 已接入 slash 命令、文件上传、忙碌时队列和全局模型显示。
- `/usage` / `/status` 由桌面本地拉取平台额度（5h / 7d）；未知斜杠指令会拦截提示。详见 `docs/SLASH_COMMAND_PARITY.md`。
- 会话侧栏已接入 active/archived 分页、归档/恢复、标题生成、批量归档/恢复/删除；设置已接入 dark/light 主题、全局配置、原始 `config.toml` 和 MCP。
- 发送反馈已具备通用状态：立即显示“消息发送中”，首个可见响应后移除；空终态或 runtime 错误显示持久错误。

English:

- Session wire streams are owned by `runtime/host.rs` (RuntimeHost): lazy supervisor start/restart, single pump-thread emit point, session table/lease, and a control channel; `runtime-v1` stdio JSONL is the only protocol between Rust and the Node runtime.
- V2 reconnects a single active `useSessionStream`, replay, attachments, status messages, tool display blocks, subagent steps, and a generic fallback for unknown payloads.
- Workspace exposes Changes, Files, Agents, and Tasks. Composer exposes slash commands, uploads, busy-state queueing, and the global model label.
- `/usage` / `/status` are handled locally with platform quotas (5h / 7d); unknown slash commands are blocked with a desktop hint. See `docs/SLASH_COMMAND_PARITY.md`.
- Sessions expose active/archived pagination, archive/restore, title generation, and bulk archive/restore/delete. Settings expose dark/light theme, global config, raw `config.toml`, and MCP.
- Generic send feedback shows “消息发送中” immediately, clears on the first visible response, and preserves empty-terminal or runtime failures as visible errors.

该基线的自动化门禁与 `smoke:runtime` 已通过；真实 Tauri/WebView 可见验收（含 auth 真机、swarm 卡片、桌面完成通知）归 M5，不得把“代码存在/测试通过”描述为“真实桌面已验收”。

English: Automated gates and `smoke:runtime` passed for this baseline; real visible Tauri/WebView acceptance (live auth, swarm cards, desktop completion notifications) is M5 work. Do not describe “code exists / tests pass” as “real desktop accepted.”

### 尚未完成的验收 / Remaining Acceptance

- 按 `docs/plans/2026-07-18-webview2-acceptance.md` 与 `docs/plans/2026-08-07-ui-compatibility-checklist.md` 在真实 Tauri + Source Runtime 路径上完成 M5 验收（会话、prompt、工具、Workspace、Settings、auth 真机、swarm 卡片、桌面完成通知）；浏览器 mock 不等于桌面验收。
- 完成 `docs/plans/2026-07-18-v2-ui-integration.md` 的剩余差距审计，特别检查桌面完成通知和所有真实运行时入口；不要仅按文件存在判断完成。`fork_session` 维持显式错误（引擎仅整会话 fork），不得伪造 fork-at-turn UI。
- 补齐 Settings、Sessions sidebar 和 Workspace 的集成测试；system theme 尚未接入，不能把 dark/light 切换描述为完整的三态主题支持。
- Share 没有真实后端契约时应保持移除或禁用，不要制作假入口。
- Node SEA sidecar 构建、签名公证、`release:msi`/`desktop:release` 语义恢复与 release manifest 产出归 M5（见 M4 计划 §9）；`release:preflight` 门禁当前已生效。

English:

- Follow `docs/plans/2026-07-18-webview2-acceptance.md` and `docs/plans/2026-08-07-ui-compatibility-checklist.md` for M5 acceptance against real Tauri on the Source Runtime path (sessions, prompts, tools, Workspace, Settings, live auth, swarm cards, desktop completion notifications). Browser mocks are not desktop acceptance.
- Audit remaining gaps in `docs/plans/2026-07-18-v2-ui-integration.md`, especially desktop completion notifications and all real runtime entry points. `fork_session` keeps an explicit error (the engine only forks whole sessions); do not fake fork-at-turn UI.
- Add integration coverage for Settings, Sessions sidebar, and Workspace. System theme is not wired yet, so do not describe the dark/light toggle as complete three-state theme support.
- Keep Share removed or disabled until a real backend contract exists.
- Node SEA sidecar build, signing/notarization, `release:msi`/`desktop:release` semantics and the release manifest are M5 (M4 plan §9); the `release:preflight` gate is already in effect.

## 运行链路 / Runtime Chain

当前可执行基线为 **Source-Runtime-only**：Tauri 监管 source-built Node runtime 子进程，不恢复 Python sidecar，不新增 legacy runtime fallback，也不发布双 backend。

```text
React app shell / useSessionStream
  -> stable Tauri IPC / events
     -> RuntimeHost (src-tauri/src/runtime/host.rs)    # supervisor 懒启动/重建、泵线程单点 emit、会话表/lease、控制通道
        -> source-built runtime/kimi-code/apps/desktop-runtime/dist/main.mjs
           -> Kimi source (createKimiHarnessV2)
     -> session_store.rs                               # local metadata + wire.jsonl replay
     -> session_compat.rs / session_config.rs          # replay/prompt migration + session config snapshot
     -> global_config.rs / mcp_config.rs               # ~/.kimi-code config
     -> session_files.rs / git_diff.rs                 # selected session worktree
```

会话 list/get/update/delete 是 runtime 结果与本地 metadata/session state 的组合，不是单一 client 的纯远程 CRUD。历史回放由 `session_store.rs` 直接翻译本地新格式记录；Git diff 针对选中会话的 worktree。

English: Session list/get/update/delete combine runtime results with local metadata and session state rather than using one pure remote CRUD client. `session_store.rs` translates persisted new-format records directly for replay; Git diff targets the selected session worktree.

Runtime 事件到前端 wire 语义的翻译集中在 `src-tauri/src/runtime/translate.rs`；`session_compat.rs` 的 `legacy` 命名描述前端数据形状（replay/prompt 迁移助手），不代表允许恢复 legacy runtime。

English: Runtime-to-frontend wire translation lives in `src-tauri/src/runtime/translate.rs`. A `legacy` name in `session_compat.rs` describes the frontend data shape (replay/prompt migration helpers); it does not authorize restoring the legacy runtime.

## 硬性规则 / Hard Rules

- 开始前运行 `git status --short --branch`，区分 staged、unstaged、untracked 和本地已提交状态。
- 工作区包含大规模并行改动；不要 reset、checkout 或重写无关文件，也不要未经确认重新暂存全部内容。
- 修复用户可见事件时，沿完整链路检查 runtime 翻译（`src-tauri/src/runtime/translate.rs`）、live dispatcher、history replay、state store 和语义 UI，不要只检查 TypeScript union。
- 未知事件、工具和 display payload 必须保留通用 fallback；新增语义 UI 不得破坏 fallback。
- `useSessionStream` 是 live/replay wire 的统一归一化入口，AppShell 只持有一个 active-session stream。新增 wire/tool/media/subagent/steering 事件时必须同时核对类型契约、live dispatcher、`session_store` replay、state store、语义 UI 与 generic fallback。
- 不要恢复已删除的 legacy component tree；V2 `src/modules/` 组件与现有 Zustand stores 是当前 UI 主路径。
- `~/.kimi-code` 属于用户运行时数据；测试不得覆盖真实配置、凭据或历史会话。
- 日常启动使用 `npm run desktop`；本地 release exe 使用 `npm run desktop:release`；MSI 使用 `npm run release:msi`。
- 不要把 `cargo build --release` 当成可运行桌面构建，也不要让旧 exe/MSI 代替当前源码。
- Source Runtime 是唯一可执行基线：运行不依赖 PATH 上的 `kimi`，不得恢复 ACP/sidecar/外部 CLI fallback；runtime artifact 缺失、握手失败或进程崩溃时 fail-closed，向用户显示可操作错误，绝不静默降级。

English:

- Start with `git status --short --branch` and distinguish staged, unstaged, untracked, and locally committed work.
- This worktree contains large parallel changes. Do not reset, check out, or rewrite unrelated files, and do not restage everything without confirmation.
- For user-visible events, inspect the complete path: runtime translation (`src-tauri/src/runtime/translate.rs`), live dispatcher, history replay, state store, and semantic UI. A TypeScript union is not coverage.
- Preserve generic fallbacks for unknown events, tools, and display payloads.
- `useSessionStream` is the shared live/replay normalization point, and AppShell owns exactly one active-session stream. For wire/tool/media/subagent/steering changes, verify the type contract, live dispatcher, `session_store` replay, state store, semantic UI, and generic fallback together.
- Do not restore the deleted legacy component tree; V2 components under `src/modules/` and the existing Zustand stores are the current UI path.
- Treat `~/.kimi-code` as user runtime data; tests must not overwrite real config, credentials, or history.
- Use `npm run desktop` for daily launch, `npm run desktop:release` for a local release executable, and `npm run release:msi` for MSI packaging.
- Do not use `cargo build --release` as the runnable desktop path or substitute stale artifacts for the source tree.
- The Source Runtime is the only executable baseline: it must not depend on `kimi` on PATH, must not restore ACP/sidecar/external-CLI fallbacks, and must fail closed (an actionable error) when the artifact is missing, the handshake fails, or the runtime process crashes — never degrade silently.

## 标准命令 / Canonical Commands

```powershell
npm run desktop
npm run desktop:dev
npm run check:quick
npm run lint:check
npm run runtime:install
npm run runtime:typecheck
npm run runtime:test
npm run smoke:runtime
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
src-tauri/src/runtime/host.rs                # RuntimeHost singleton: supervisor, pump, session table/lease
src-tauri/src/runtime/                      # supervisor.rs / client.rs / translate.rs / protocol.rs / codec.rs / readiness.rs
src-tauri/src/session_compat.rs              # replay/prompt migration helpers (legacy data shape)
src-tauri/src/session_config.rs              # session config snapshot types (runtime-neutral)
src-tauri/src/session_store.rs               # persisted new-format replay and local metadata
src-tauri/src/runtime_check.rs               # artifact/manifest/auth/config readiness
runtime/kimi-code/                           # pinned upstream source plus Desktop Runtime app
runtime/kimi-code/apps/desktop-runtime/      # source-built Node runtime (dist/main.mjs entry)
scripts/check-quick.mjs
docs/plans/2026-08-08-runtime-cutover-m4.md
docs/plans/2026-08-07-source-backend-maintenance.md
docs/plans/2026-08-07-source-backend-replacement-map.md
docs/plans/2026-08-07-ui-compatibility-checklist.md
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

Source Runtime 变更还需运行（runtime workspace 用 pnpm，外层用 npm）：

```powershell
npm run runtime:install
npm run runtime:typecheck
npm run runtime:test
npm run smoke:runtime
```

`smoke:runtime` 构建 dist 后在临时 `KIMI_CODE_HOME` 走完整 runtime-v1 方法链（hello/getInfo/会话 CRUD/config/models/providers/setMode/replay/auth/shutdown），离线安全，不依赖本机 CLI 或认证。UI 完成度必须再走真实 Tauri/WebView2 验收并检查可见 DOM、控制台错误和真实 IPC。

无 ACP 残留门禁应确认旧 runtime 标识没有重新进入生产路径。命中注释、测试、fixtures 或“legacy wire shape”时需人工分类，不要机械要求全仓零匹配：

```powershell
rg -n "KIMI_CODE_BIN|resolve_acp_command|kimi acp|AcpProcessManager|AcpDesktopClient|acp_translate|acp_desktop|acp_capabilities" src-tauri/src package.json scripts
if (Test-Path scripts/acp-smoke.mjs) { throw "acp-smoke.mjs must not exist" }
```

`src-tauri/src/test-fixtures/acp/` 仅保留 session_config/session_compat 测试消费的 4 个 payload（session_new/load/resume），其余 ACP fixtures 已随模块删除。

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

桌面外壳版本与 Kimi source runtime 版本是两个概念。任何版本 UI 都读 handshake `RuntimeInfo.kimiSource`（tag/commit）或 `runtime.getInfo`，不探测外部 CLI。

## 子代理边界 / Sub-Agent Boundaries

按所有权拆分并避免交叉编辑：

```text
Stream/data agent: src/hooks, src/lib/api, src/lib/tool-events
Conversation/UI agent: src/modules/conversation, src/modules/composer
Workspace/session agent: src/app, src/modules/workspace, src/modules/sessions, src/modules/settings
Rust agent: src-tauri/src runtime (host/translate/protocol), commands, config/files, replay, session_compat/session_config, readiness
Release agent: package scripts, PowerShell, workflows, Tauri config, release docs
Acceptance agent: read-only runtime smoke, WebView2/CDP evidence, regression reports
```

每个代理都必须先读取本文件与当前 `git status`，声明拥有的文件，只修改分配范围。`src/app/app.tsx`、`src/hooks/useSessionStream.ts`、`src-tauri/src/commands/mod.rs` 等共享热点文件同一时间只允许一个 owner 修改，其他代理只提出接口需求。把“代码存在”“测试通过”“真实桌面已验收”作为三个不同状态报告。

English: Every agent must read this file and the current Git status first, declare file ownership, stay within scope, and report “code exists,” “tests pass,” and “real desktop accepted” as separate states.
