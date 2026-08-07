# UI 迁移兼容清单（Source Backend 验收标准）

状态：生效中
日期：2026-08-07
用途：`runtime_translate.rs` 与 adapter 的验收标准。**本清单全绿 = 现有 UI 原样可用，零组件改动。**
盘点来源：`src/hooks/wireTypes.ts`、`src/lib/tool-events/tool-registry.ts`、`src-tauri/src/commands.rs`（2026-08-07 实际代码盘点）。

## 1. wire 事件全表（30 类，live 与 replay 必须同形）

| 事件 | 语义 | 验收点 |
| --- | --- | --- |
| `TurnBegin` | turn 开始 | 携带 turn/request 标识，前端终结只认匹配 id |
| `StepBegin` / `StepInterrupted` / `StepRetry` | 推理步骤生命周期 | retry/interrupt 文案与状态正确 |
| `ContentPart` | 内容增量 | `think`/`text`/`image_url`/`audio_url`/`video_url` 五类都要支持 |
| `ToolCall` / `ToolCallPart` | 工具调用开始/参数流式 | function name + 参数增量拼合正确 |
| `ToolResult` | 工具结果 | `display` 块数组原样透传到语义卡片或 fallback |
| `StatusUpdate` | 状态条（含 `[N task running]`） | 与 CLI 语义一致 |
| `SessionNotice` | 会话级提示 | 持久化错误可显示 |
| `CompactionBegin` / `CompactionEnd` | 上下文压缩 | 压缩指示出现/消失 |
| `MCPLoadingBegin` / `MCPLoadingEnd` | MCP 加载 | 加载状态可见 |
| `ApprovalRequest` | 审批请求 | 含 `display` 块；respond 后状态翻转 |
| `ApprovalRequestResolved` | 审批结果 | 与 request 配对 |
| `QuestionRequest` | 追问 | 选项/自由输入回传正确 |
| `SubagentEvent` | 子代理事件（含嵌套） | parent provenance 稳定，任意层级可折叠 |
| `TaskCreated` / `TaskProgress` / `TaskCompleted` | 后台任务 | Tasks 面板只读展示正确 |
| `SubagentLifecycle` | 子代理生命周期 | 与 SubagentEvent 不互相覆盖 |
| `SteerInput` | turn 中插话 | busy 时队列语义不变 |
| `PlanDisplay` | Plan 展示 | Plan 模式进出正确 |
| `SlashCommandsUpdate` | 斜杠命令列表 | 见 `docs/SLASH_COMMAND_PARITY.md` |
| `ConfigOptionUpdate` | 配置项变更 | Settings snapshot 刷新 |
| `BackgroundTaskObserved` | 后台任务观察 | 不干扰主消息流 |

## 2. replay 等价性

- 同一会话，live 事件流与 `replay_session_history` 回放产出的 wire 序列必须语义一致（附件、工具结果、任务状态、子代理步骤、审批/追问终态都保留）。
- replay 数据源切换为 transcript/minidb 后，本条仍需成立；0.33.0 原生可读记录保持原位，Desktop metadata 继续 overlay。

## 3. generic fallback（硬性）

- 未知 wire 事件、未知工具名、未知 display 块类型：渲染为可读 generic 卡片，**不得断连、不得丢事件**。
- 新语义 UI 的任何改动不得破坏 fallback（回归测试覆盖）。

## 4. 语义工具注册表（30 项 + 别名）

分类与展示名以 `tool-registry.ts` 为准：

- file：`ReadFile`(Read)、`ReadMediaFile`、`WriteFile`(Write)、`StrReplaceFile`(Edit)
- search：`Glob`(Find Files)、`Grep`(Search)、`SearchWeb`、`FetchURL`
- shell：`Shell`
- agent：`Agent`、`AgentSwarm`(Swarm)、`CreateSubagent`
- task：`Task`、`TaskList`、`TaskOutput`、`TaskStop`、`CronCreate`、`CronList`、`CronDelete`
- todo：`SetTodoList`
- goal：`CreateGoal`、`GetGoal`、`UpdateGoal`、`SetGoalBudget`
- plan：`EnterPlanMode`、`ExitPlanMode`
- skill：`Skill`
- generic：`Think`、`SendDMail`、其余未注册工具名（大小写不敏感别名命中失败时）

验收：kimi 侧工具名经 adapter 映射到上表 canonical 名；映射缺失时进 generic，不为每个新工具硬改前端。

## 5. Tauri 命令行为

分类迁移表见 `2026-08-07-source-backend-replacement-map.md` §5。验收标准：§5.1 命令行为与现状逐一致；§5.2 命令前端调用点零改动（同命令名、同参数、同返回形状或前端已兼容的形状）。

## 6. 发送反馈与终态

- 发送后立即显示“消息发送中”，首个可见响应后移除。
- 空终态或 runtime 错误显示持久错误；`turn.completed`/`turn.failed` 只终结匹配 `requestId`。
- busy 时消息排队，Steer 语义不变。

## 7. 验收方式（三道）

1. **golden protocol tests**：fixture worker 产出固定事件序列，断言 translate 输出 wire 快照（CI）。
2. **自动化回归**：`npm test` + `cargo test` + `smoke:runtime`。
3. **真实桌面验收**：真实 Tauri/WebView 路径按 `docs/plans/2026-07-18-webview2-acceptance.md` 检查可见 DOM、控制台错误与真实 IPC；浏览器 mock 不算数。

“代码完成”“自动化通过”“真实桌面验收”是三个独立状态，交接时分别报告。
