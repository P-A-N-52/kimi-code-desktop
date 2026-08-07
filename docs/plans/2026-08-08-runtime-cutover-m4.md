# M4 一次性切换契约（Source Runtime cutover）

状态：已完成切换（W4 收口）
日期：2026-08-08
配套：架构 `2026-08-07-source-backend-architecture.md`；替换地图 `2026-08-07-source-backend-replacement-map.md` §7；验收 `2026-08-07-ui-compatibility-checklist.md`
前置：M1（PR #22）/ M2（PR #23）/ M3（PR #24）

## 完成态摘要（W4 收口，2026-08-08）/ Completed State Summary

**状态**：已完成切换。可执行基线为 Source Runtime（`runtime-v1`）；生产代码零 ACP 残留；W0–W3 完成 host + 命令族全切 + ACP 删除与测试改写，W4 完成发布门禁切换与文档收口。

**删除文件（W3）**：`src-tauri/src/` 下 `acp.rs`、`acp_desktop.rs`、`acp_translate.rs`、`acp_capabilities.rs`、`provider_cli.rs`、`runtime_backend.rs`、`oauth_login.rs`、`managed_usage.rs`、`swarm_progress.rs`；`scripts/acp-smoke.mjs`、`scripts/run-cursor-acp-milestone0.ps1`、`scripts/verify-cursor-acp-milestone0.ps1`。`commands.rs` 拆分为 `commands/{mod,wire,sessions,config,auth,system}.rs`（纯拆分，零行为变化）。

**测试计数**：`cargo test` 458 → 337（随删模块内嵌测试与 ACP fixtures 移除）；`npm test` 534；`runtime:typecheck` + `runtime:test` 116；`smoke:runtime`（临时 `KIMI_CODE_HOME`，离线安全）全绿。

**门禁最终态**：`cargo test` 337 / `npm test` 534 / `runtime:typecheck`+`runtime:test` 116 / `smoke:runtime` / `check:quick` / `git diff --check` 全绿。`release:preflight` 换 `Assert-SourceRuntime`（artifact 存在且非空、`runtime/UPSTREAM.md` commit == `apps/desktop-runtime/src/protocol.ts` 的 `KIMI_SOURCE_COMMIT`、无 PATH `kimi` 依赖、无 ACP 入口 + `acp-smoke.mjs` 不存在）。发布流水线（release.yml）以 Node 24.15.0 + pnpm 10.33.0 跑 `runtime:install` + `smoke:runtime`。

**已知文案偏差（W1-D 遗留）**：`notifyGlobalConfigApplied`（`src/lib/config-update-toast.ts:13/24`，i18n 键 `src/lib/i18n.tsx:439/441`）统一显示“空闲会话将重启以应用”文案；结构化字段写（`config.update`）已热生效不重启会话，仅 raw `config.toml`/`mcp.json` 写后由 supervisor 重建。前端零改动原则下不改代码，登记为已知文案偏差，留后续产品决策。

## 1. 总策略

单分支（`codex/runtime-cutover`）一次性完成，stacked PR 分三段评审：M4a（host + wire 通路）→ M4b（命令族全切）→ M4c（删 ACP + 门禁切换）。中间态 ACP 代码成死代码但无命令引用，不构成生产双 backend；每个 PR 门禁自保绿。回滚 = revert 单个合并 commit。不做运行期 feature flag，不做静默 fallback，不提供 runtime selector。

逐波保持编译绿：W0/W0′/W0″ 是"加装"，ACP 的 `.manage` 与命令接线到 W1 才改、W3 才删。

## 2. 已拍板决策（2026-08-08）

1. **`update_config_toml` / `update_mcp_config`：保留整文件写 + supervisor 重建**（shutdown→spawn→handshake→恢复 open 会话）。理由：raw 编辑器语义/注释保真；避免脆弱的 TOML→domain patch 转换层；写后重启收敛引擎内存态，单 writer 纪律不破（config.toml 是唯一持久存储，引擎为缓存/读者）；`restarted_session_ids` 返回保持现有重连 UX。结构化字段写（`update_global_config`）走 `config.update`（target:"user"）热生效，不再 restart workers。
2. **`open_kimi_login`：显式可操作错误**（"终端登录已随内置运行时移除，请使用面板内登录"类文案）。无 runtime 等价物（原实现是终端跑外部 CLI），不伪造入口。
3. **W0′ 协议增补（M4 唯一的协议面扩大，已确认）**：
   - `session.setMode`：plan（agentPlanService.enter/clear）/permission（agentRPCService.setPermission）热切换；permission mid-turn 切换是现有行为，无此方法即行为回退。
   - `providers.catalog.list/get`：薄挂 klient modelResolver，适配桌面 `ProviderCatalogSummary/Entry` DTO。
   - `providers.import` 增 registry 通道（`{source:"registry", registryUrl?}`）：Node 侧 fetch + ProviderInput 映射 + addProvider；`KIMI_REGISTRY_API_KEY` 只经环境变量，不进 argv/日志/协议事件。

## 3. 盘点纠偏（替换地图未载，以代码现状为准）

1. `session_files.rs` 依赖 `acp_desktop`/`acp_translate::normalize_workspace_path`——§5.1"保留"命令也要换 work_dir 解析（本地 metadata 优先 → `sessions.get` 兜底）；`normalize_workspace_path` 搬入 `security.rs`。
2. `get_kimi_cli_version` 前端仍在用（`version.ts`）——"删除"纠偏为"留名换实现"：读 handshake 缓存 `RuntimeInfo.kimi_source.tag`。
3. `replay_session_history`（invoke 路）**保持 Rust 直读** wire.jsonl（session_store.rs，零变化；§6 数据表允许 Rust replay adapter 为合法 reader）；wire 路 replay 走 `session.replay`。双路并存与 ACP 时代同构。
4. 前端**从不发 steer**（busy 本地排队）——dispatcher 无入向 steer 路由；`SteerInput` 只是入向事件。
5. `turn.start` 的 `requestId` **必须用前端 prompt 消息 id**（前端终结只认匹配 id），禁止 host 自铸。
6. `fork_session` 维持显式错误（前端恒传 turnIndex；引擎仅整会话 fork）。
7. `swarm_progress.rs`（1530 行）仅被 acp.rs 引用，随删；swarm 投影由 runtime `subagent.updated`/`tool.started`（完整 payload）接管。
8. `goal_store.rs` 写侧（append_pause/clear 直写引擎 journal）是双 writer 风险点：M4 验证引擎 journal 对 Rust 旁路 append 的容忍度（现状已是无 in-flight 才写）；读侧保留。
9. `upload_session_file`/`delete_uploaded_file` 保持本地 pending 目录（runtime-v1 无附件 API；附件经 `turn.start` input parts 进引擎）。`get_providers_overview` 保持本地读（`providers.list` 形状撑不起 overview）。

## 4. 波次划分

- **W0**（串行阻塞面）：`runtime/host.rs`（RuntimeHost 单例：supervisor 懒启动/重建、泵线程单点 emit、会话表/lease、控制通道）+ spawn 解析（`env!("CARGO_MANIFEST_DIR")` 锚定 + `KIMI_RUNTIME_ENTRY` 覆盖 + `EXPECTED_KIMI_COMMIT` 编译期常量）+ lib.rs 追加 manage/退出钩子。
- **W0′**（并行）：§2 第 3 条的三项协议增补（双端同步）。
- **W0″**（并行）：commands.rs → `commands/{mod,wire,sessions,config,auth,system}.rs` 纯拆分（零行为变化，路径保持，解锁 W1 并行）。
- **W1**（并行四路，依赖 W0/W0′/W0″）：wire 族（connect/disconnect/send 全处理器/status/list_workers）、sessions 族（CRUD + session_files 去 ACP）、auth/usage 族（8 命令 DTO 适配）、config/provider 族（8 命令）。
- **W2**：`check_runtime_readiness` 换 `readiness::check_readiness` + 现有 `RuntimeReadiness` DTO 适配（`externalCli.available` 必须 true，否则 overlay 出现"前往下载"CTA）；`runtime_check.rs` 删 CLI 探测、留 config/路径助手；`get_kimi_cli_version`/`get_agent_runtime_capabilities`/`get_session_config_state` 三命令。
- **W3**：删除清单一次执行（§5）+ 测试改写（§7）。
- **W4**：门禁切换（§6）+ AGENTS.md/文档收口 + 全门禁绿。

## 5. 删除清单（W3 一次完成，rg 门禁紧跟）

`acp.rs`（4763 行）、`acp_desktop.rs`、`acp_translate.rs`、`acp_capabilities.rs`、`provider_cli.rs`、`runtime_backend.rs`、`oauth_login.rs`、`managed_usage.rs` 大部分（`credentials_present` 小函数搬迁保留）、`swarm_progress.rs`、`runtime_check.rs` 的 CLI 探测部、`scripts/acp-smoke.mjs`、两个 cursor ACP ps1 探针、`get_kimi_cli_version` 的 CLI 探测实现、`KIMI_CODE_BIN` 解析。

搬家不清删：`filter_sessions`/`shape_*_to_legacy`（→ sessions 家族）、`normalize_workspace_path`（→ security.rs）、`user_content_from_acp_prompt`/`legacy_user_input_to_acp_prompt_with_swarm`/`translate_session_config_snapshot`（→ 新 `session_compat.rs`，这些是 replay/prompt 迁移助手而非 ACP 专属）、`SessionConfigState` 等类型与 `session_config_state_to_value`（→ 新 `session_config.rs` 去 ACP 命名）。

前端 `src/lib/acp-capabilities.ts` 文件名保留（前端零改动）。

## 6. readiness / 冒烟 / 发布门禁切换

- `check_runtime_readiness`：`readiness::check_readiness` 三段（artifact→manifest→live probe）+ DTO 适配现有 `RuntimeReadiness`；`bundledRuntime{available, version, packagePath, executable:"node"}`；`externalCli{available:true, program:null}`（硬性，见 §4 W2）。
- package.json：删 `smoke:acp` 与 cursor ACP 三条；`smoke:runtime` 提为正式门禁；AGENTS.md 标准命令表同步。
- `release-preflight.ps1`：`Assert-KimiCodeCli` → `Assert-SourceRuntime`：artifact 存在且自报 commit=冻结值；`rg` 无 PATH `kimi` 依赖（`KIMI_CODE_BIN|resolve_acp_command|kimi acp` 零命中，注释命中人工分类）；无 ACP 入口（`AcpProcessManager|AcpDesktopClient|acp_translate|acp_desktop` 零命中 + acp-smoke.mjs 不存在）。

## 7. 测试策略

随删：被删模块的内嵌测试与 ACP fixtures。保留适配：session_store/security/session_files/路径安全测试（import 改道）。改写为 runtime 版：host 级集成测试（golden worker 演全流，断言 wire 序列快照，emitter 注入捕获 sink）；命令适配层纯函数测试（auth DTO 映射、readiness DTO、shape_runtime_session_to_legacy、decision 词汇映射）。**前端 `npm test` 零改动通过是硬门禁**（任何红 = 适配层形状错误）。

切换后验证序列：`cargo test` → `cargo clippy -D warnings` → `npm test` → `npm run build` → `runtime:typecheck/test/build` → `smoke:runtime` → ACP 残留 rg 门禁 → `check:quick` → `release:preflight`（新门禁）。环境阻塞与代码回归分开报告。

## 8. 风险清单

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 事件次序（replay burst vs result、TurnBegin vs 首 delta、终态 id 匹配） | 高 | 泵线程单点 emit + 控制通道；golden 钉次序 |
| Goal 双 writer | 高 | M4 验证引擎 journal 容忍度；swarm 卡片完整性列 M5 真实验收 |
| permission 热切换无 runtime 方法 | 高 | W0′ `session.setMode` 硬前置（已确认） |
| auth 真机依赖 | 中 | M4 仅 contract 测试；真实登录归 M5 验收 |
| 单 runtime 崩溃影响面（ACP 时代故障域=单会话） | 中 | fail-closed 已验收 + host 重建 + session.open 恢复 + stderr ring |
| Node 增补延期阻塞 Rust | 中 | W0′ 与 W0 并行；catalog 未就绪时两命令临时显式错误（可发布判断） |

## 9. M4 / M5 分界

M4 交付：dev 环境（`npm run desktop`）纯 runtime 全功能；无 ACP 入口残留；`cargo test`/`npm test`/`smoke:runtime`/新 preflight 全绿；文档收口。

留 M5：Node SEA sidecar 构建与 tauri externalBin 接线；macOS 签名公证/Windows 签名覆盖 sidecar；`release:msi`/`desktop:release` 语义恢复；真实 Tauri/WebView 验收全流（含 auth 真机、swarm 卡片、通知）；协议 fuzz；`~/.kimi-code` 首启迁移预检（备份+marker）；release manifest 产出。
