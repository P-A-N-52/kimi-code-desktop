# G5：多活跃会话架构设计

| 项目 | 内容 |
| --- | --- |
| 状态 | **已实施**（2026-08-02）：Tauri Desktop 默认启用多活跃会话编排器；Web / 非 Tauri 仍使用单流。后续优化项见 §4 / §5 / §9 / §14。 |
| 关联计划 | [2026-07-31-kimi-code-0.31.0-alignment.md](./2026-07-31-kimi-code-0.31.0-alignment.md) § G5 |
| 代码仓库 | `source/kimi-code-desktop` |
| 日期 | 2026-07-31 |
| 范围 | 单窗口内消除「切换会话 = 断开 ACP worker」的前端瓶颈；**不含**多窗口 / fork-at-turn UI |

---

## 1. 执行摘要

**问题本质**：Rust 侧 `AcpProcessManager` 已是 `HashMap<sessionId, AcpWorker>`，可并行持有多个 `kimi acp` 子进程；前端 `useSessionStream` 仍强制「单活跃流」，切换侧栏会话时在 `useLayoutEffect` 内调用 `wireDisconnect`，杀死后台 worker，导致运行中任务中断、跨会话通知不可靠、G3 后台任务承诺无法兑现。

**目标**：在**保持单窗口**前提下，引入 `Map<sessionId, ViewState>` 与按会话归属的连接/事件路由，使切换 UI 焦点不再等价于销毁 ACP 连接；后台会话可持续接收事件直至显式断开或 LRU 回收。

**非目标（No-Go）**：

- 多窗口（与 `tauri-plugin-single-instance` 冲突，另立项）
- `fork-at-turn` UI（`fork_session` 当前明确返回不支持；无 `session/fork` 稳定契约前不设计假入口）
- 第二条竞争性 ACP RPC 通道（遵守 [acp-rpc-ownership.md](../acp-rpc-ownership.md)）
- **Web 版单流**（见 §1.1）：G5 仅交付 Tauri Desktop；浏览器构建保持现有单 `useSessionStream` 行为

### 1.1 平台范围（P2）

| 平台 | G5 范围 |
| --- | --- |
| **Tauri Desktop** | 完整 G5：Orchestrator、多 ViewState、RetentionPolicy |
| **Web / 非 Tauri** | **不改造**；`isTauri()` 为 false 时始终走现有单流路径，切换会话仍 disconnect |

Web 端不挂载 `SessionStreamOrchestrator`；Feature flag 在 Web 构建中恒为 off。避免在 WebView 与纯 Web 两套行为之间引入分叉测试矩阵。

---

## 2. 现状与根因

### 2.1 分层现状

```text
┌─────────────────────────────────────────────────────────────┐
│ App (app.tsx)                                                │
│   selectedSessionId ──► useSessionStream({ sessionId })      │
│   通知/审批/Changes 均绑定 stream.* 单实例                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ Tauri IPC
┌───────────────────────────▼─────────────────────────────────┐
│ AcpProcessManager (acp.rs)                                   │
│   workers: HashMap<String, Arc<AcpWorker>>  ← 已支持多 worker │
│   每 worker: 独立 kimi acp 子进程 + connection_id lease       │
└───────────────────────────┬─────────────────────────────────┘
                            │ emit("wire:message", { session_id, message })
└─────────────────────────────────────────────────────────────┘
```

### 2.2 前端单流约束（瓶颈）

`useSessionStream.ts` 文件头注释（L87–107）已草拟目标架构 `Map<sessionId, ViewState>`，但实现仍为：

| 行为 | 位置 | 后果 |
| --- | --- | --- |
| 切换 `sessionId` 时 `disconnect()` | `useLayoutEffect([sessionId])` L5699+ | 调用 `wireDisconnect` → Rust `disconnect_leased` → `stop_worker_async` |
| 重置全部 React 状态 | 同上 L5725–5734 | `messages`、modes、goal、tool-events 全局 store 被清空 |
| 单 `wsRef` / 单 `onWireMessage` 监听 | `createTauriWireConnection` L3489+ | 仅当前会话有 listener；切换后旧 worker 已被杀 |
| `activeSessionIdRef` 守卫 | `processEvent` / callbacks | 防止**迟到的**旧 socket 事件；无法保护**仍存活**的后台 worker |

`app.tsx` L183–189：`autoConnect: currentSession?.isRunning` — 仅对「当前选中且 isRunning」会话维持连接；切换离开即断开。

### 2.3 Rust 侧已具备能力

- **每会话 worker**：`connect_leased` / `disconnect_leased`（L478–629）按 `sessionId` + `connectionId` 租约管理
- **事件已带 session 路由键**：`wire_events::emit_wire_message(app, session_id, …)`（`wire_events.rs` L29）
- **前端过滤**：`onWireMessage(sessionId, cb)` 仅处理匹配 `session_id` 的 payload（`tauri-api.ts` L310）
- **批量重启**：`restart_running_workers`（`acp.rs` L767）可重启所有已连接 worker（配置变更场景）
- **退出清理**：`RunEvent::ExitRequested` → `stop_all()`（`lib.rs` L167–170）

### 2.4 关联全局状态（切换时被误伤）

| Store | 范围 | 切换行为 | G5 需求 |
| --- | --- | --- | --- |
| `useToolEventsStore` | 全局单值 `currentGoal`、`newFiles` | 切换时 `clear*` | 应按 `sessionId` 分区或从 ViewState 读取 |
| `useBackgroundTasksStore` | 按 `sessionId` 键 | **未**在切换时清理（正确） | 保持；通知路由需跨会话 |
| `useAgentMonitorStore` | 任务含 `sessionId` | 事件经 sync 写入 | 保持；UI 按 session 过滤 |
| `notifiedApprovalsRef` / `notifiedTerminalTasks` | 混合 | 切换 reset 或仅当前 session key | 跨会话通知需独立 dedupe |

### 2.5 通知现状（G3 缺口）

- **回合完成**：`app.tsx` L159–176，`handleSessionStatus` 仅在 `status.sessionId` 对应会话且窗口失焦时 toast；切换后旧会话 worker 已死 → **收不到 idle 事件**
- **审批**：L301–333，仅遍历 `stream.messages`（当前会话 pending approvals）
- **后台任务终态**：`background-tasks/sync.ts` 模块级 `notifiedTerminalTasks`；切换时 `resetBackgroundTaskNotifications()` 清空 dedupe（L5731）
- **Rust `notify.rs`**：`send_approval_notification` / `send_task_complete_notification` 已实现但 **ACP 路径未调用**；桌面通知目前几乎全在前端

### 2.6 `/fork` 文案问题（验收项）

- `commands.rs` L465：`fork_session` → `Err("…not available via ACP yet")`
- `slash-command-catalog.ts` L123：`fork: "Use Fork session in the sidebar."` — **误导**（侧栏无可用 Fork 入口；`message-list` 测试 L160 确认 fork 按钮未暴露）
- **Phase 0 应修正**为明确说明 ACP/CLI 限制，不指向不存在功能

### 2.7 单窗口约束

`lib.rs` L34–39：`tauri-plugin-single-instance` 注册于最前；第二次启动聚焦已有 `main` 窗口。G5 **不**改变此行为；多窗口另立项。

---

## 3. 目标架构

### 3.1 逻辑架构

```text
┌──────────────────────────────────────────────────────────────────┐
│ SessionStreamOrchestrator (新：hooks 层或 lib/session-stream/)    │
│                                                                   │
│  connections: Map<sessionId, ConnectionHandle>                    │
│  viewStates:   Map<sessionId, ViewState>                          │
│  policy:       RetentionPolicy (maxWorkers, idleTtl, …)           │
│                                                                   │
│  ┌─────────────┐  wire:message (全局 listen)                      │
│  │ EventRouter │──► reducer(sessionId, event) ──► ViewState 更新   │
│  └─────────────┘                                                  │
│                                                                   │
│  visibleSessionId ──► select ViewState ──► Conversation UI      │
└───────────────────────────────┬──────────────────────────────────┘
                                │ wire_connect / wire_send / wire_disconnect
┌───────────────────────────────▼──────────────────────────────────┐
│ AcpProcessManager（现有，小改：观测 API、可选 idle 断开策略）        │
└──────────────────────────────────────────────────────────────────┘
```

**核心不变量**：

1. **事件归属**：每条 `wire:message` 的 reducer 只写入 `viewStates.get(session_id)`；**A 会话事件绝不写入 B 的 ViewState**
2. **连接归属**：每个 `ConnectionHandle` 持有唯一 `connectionId` lease；仅 lease 持有者可 `wireDisconnect` 该 worker
3. **UI 单焦点**：同一时刻只有一个 `visibleSessionId` 驱动 Composer / Conversation；后台会话无 DOM 绑定但 state 持续更新
4. **单 RPC 通道**：所有 `session/*` 请求仍走现有 `wire_send` → `AcpProcessManager::send`

### 3.2 ViewState 状态模型（草案）

从现有 `UseSessionStreamReturn`（L640–723）提取 per-session 快照：

```typescript
/** 每会话独立；禁止跨 session 引用或共享可变 ref */
type SessionViewState = {
  sessionId: string;

  // ── 时间线 ──
  messages: LiveMessage[];
  status: ChatStatus;
  sessionStatus: SessionStatus | null;
  isReplayingHistory: boolean;
  isAwaitingFirstResponse: boolean;
  canCancel: boolean;
  error: Error | null;

  // ── 进度 / 用量 ──
  contextUsage: number;
  contextTokens: number | null;
  maxContextTokens: number | null;
  tokenUsage: TokenUsage | null;
  currentStep: number;
  goalCompletionEpoch: number;

  // ── 连接 ──
  connectionPhase: "disconnected" | "connecting" | "connected" | "reconnecting";
  connectionId: string | null;
  lastEventAt: number | null;

  // ── 会话 modes / config（来自 G1 SessionConfigState）──
  planMode: boolean;
  permissionMode: PermissionMode;
  swarmMode: boolean;
  goalMode: boolean;
  sessionConfigState: SessionConfigState;
  sessionConfigUpdating: boolean;
  slashCommands: SlashCommandDef[];

  // ── 会话局部 pending（不可放全局）──
  pendingApprovals: PendingApprovalEntry[];
  pendingQuestions: PendingQuestionEntry[];
  turnCounter: number;

  // ── 元数据 ──
  updatedAt: number;
  /** LRU / 观测 */
  lastVisibleAt: number;
};

type SessionStreamStore = {
  visibleSessionId: string | null;
  viewStates: Map<string, SessionViewState>;
  retention: RetentionPolicyState;
};
```

**Reducer 边界**：现有 `processEvent`（~L2166）整体下沉为 `(state: SessionViewState, event: WireEvent, ctx: ReducerContext) => SessionViewState`；`ReducerContext` 含 `isReplay`、`sessionId`（断言与 event 一致）。

**Streaming buffers**（think/text/tool args 的 ref 累加器）必须 **per-session** 放入 `ConnectionHandle` 或 `ViewState` 的 non-serialized side channel，不可继续用 hook 顶层单 ref。

### 3.3 ConnectionHandle 与租约

沿用现有 Tauri 租约模型（`createTauriWireConnection` L3489）：

```typescript
type ConnectionHandle = {
  sessionId: string;
  connectionId: string;
  phase: "connecting" | "open" | "closed";
  unlisten: (() => void) | null;
  /** 递增；用于忽略 stale connect 回调 */
  generation: number;
};
```

**切换会话时**：

- **旧会话 `isRunning` 或 `status ∈ {submitted, streaming}`** → **保留** connection + unlisten；ViewState 继续接收事件
- **旧会话 idle 且非 pinned** → 按 RetentionPolicy 决定立即断开或延迟 LRU
- **新会话** → 若 Map 中无 connection 且需要 live（running / 用户发消息 / autoConnect），则 `wireConnect`

**禁止**：切换 `visibleSessionId` 时无条件 `wireDisconnect`（当前行为）。

---

## 4. 连接生命周期

### 4.1 状态机（单 session）

```text
                    wireConnect OK
    [disconnected] ─────────────────► [connected]
          ▲                              │
          │ wireDisconnect               │ worker crash / send fail
          │ (lease match)                ▼
          └──────────────────────── [reconnecting]
                                           │
                           recover_worker_after_failure (Rust)
                           or orchestrator retry with backoff
                                           │
                                           ▼
                                      [connected] | [disconnected+error]
```

### 4.2 触发 connect 的条件

| 场景 | 是否 connect |
| --- | --- |
| 用户选中 running 会话（`is_running`） | 是 |
| 用户在 idle 会话发送首条 prompt | 是（现有 lazy connect） |
| 后台会话 turn 进行中，用户切走 | **保持**已有 connection |
| 打开 idle 已完成会话仅浏览历史 | 否（`replaySessionHistory` 本地重放，现有 L5805） |
| LRU 淘汰 | `wireDisconnect` + ViewState 保留 messages 快照 |

### 4.3 重连策略

**Rust 已有**：`recover_worker_after_failure`（L632）在 RPC 失败时 remove + `connect_with_lease` 同 `connection_id`。

**前端新增**：

1. Orchestrator 监听 `sessionStatus.state === "error"` 或 connection `phase === closed` 且 session 仍为 running
2. 指数退避重连（初始 1s，上限 30s，最多 5 次），UI 显示「后台会话重连中」badge
3. 重连成功后：对 **该 sessionId** 触发增量 `replay` 或 `replaySessionHistory` 补齐 gap（与现有 `resyncGoalHistory` L3757 模式类似）
4. **不**影响其他 session 的 connection

### 4.4 缓存上限与 RetentionPolicy

默认建议（可调，写入 `GlobalConfig` 或 constants）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `maxLiveWorkers` | 3 | 同时存活 `kimi acp` 子进程上限 |
| `maxCachedViewStates` | 20 | Map 中 ViewState 条目上限（含 disconnected） |
| `idleDisconnectTtlMs` | 30 × 60 × 1000 | idle 且非 visible 会话自动 disconnect |
| `pinnedWhileRunning` | true | in-flight prompt 期间永不 LRU |

**LRU 算法**：

1. 达到 `maxLiveWorkers` 时，从「idle + 非 visible + 最旧 `lastVisibleAt`」候选 disconnect
2. 达到 `maxCachedViewStates` 时，驱逐 disconnected 条目；若仍超限，驱逐 idle 条目（保留 messages 于 `session_store` replay）
3. **永不驱逐**：当前 `visibleSessionId`、有 pending approval/question、有 in-flight prompt

**观测**：Phase 0 增加 `wire_list_workers` 或 dev-only IPC 返回 `{ session_id, state, connection_id, updated_at }[]`（字段名统一见 §4.6 末）。

**Phase 1 临时上限（P0，评审强制）**：

Phase 2 才完整落地 LRU，但 Phase 1 **不得**无上限并行保活 worker。二选一写入实现与验收：

| 方案 | 要求 |
| --- | --- |
| **A（推荐）** | Orchestrator 启用 **interim `maxLiveWorkers = 3`**（常量或 flag 可读）；超出时对最旧 idle 后台会话 `wireDisconnect` |
| **B** | 不实现 LRU，但 **验收范围限定**为 ≤2 个并行 running；自动化与手动用例不得启动第 3 个 running worker |

无论 A/B，Phase 1 PR 描述须写明所选方案；避免「2 会话验收通过、3+ 会话内存失控」的盲区。

### 4.5 应用退出与窗口隐藏

| 事件 | 现有行为 | G5 目标 |
| --- | --- | --- |
| 窗口 CloseRequested | `prevent_close` + hide（`lib.rs` L158） | 不变；**后台 worker 继续**（用户预期任务继续） |
| `RunEvent::ExitRequested` | `stop_all()` | 不变；托盘退出 / 安装更新时杀全部 worker |
| 切换会话 | disconnect 当前 | **改为 RetentionPolicy，不隐式杀 running** |
| 删除会话 | `delete_session` | Orchestrator 强制 disconnect + 移除 ViewState + `clearBackgroundTasksSession` |

**文档化用户预期**：关闭窗口 ≠ 退出应用；真正退出才停止所有 ACP 子进程。

### 4.6 `shouldPauseRuntime` 与全局 pause（P1）

`app.tsx` 在 runtime 自检未完成、自检失败或用户未确认 runtime 就绪时设置 `shouldPauseRuntime`（`isTauri() && (isCheckingRuntime || runtimeCheckError || shouldPauseForRuntimeReadiness(...))`）。当前单流路径通过 `sessionId: null` 与 `autoConnect: false` 间接断开。

**G5 Orchestrator 行为**（flag on 时）：

1. `shouldPauseRuntime === true` → **暂停并断开全部 live worker**（对每个 `ConnectionHandle` 调用 `wireDisconnect`，generation 递增以丢弃 stale 回调）
2. ViewState Map **可保留** messages 快照（便于恢复 UI），但 `connectionPhase` 一律置为 `disconnected`
3. `shouldPauseRuntime === false` 后 → 仅对 **visible 且 `isRunning`** 的会话（及用户显式发消息的 idle 会话）按 §4.2 重新 connect；**不**自动恢复全部历史 live worker（避免 pause 前 N 个后台任务同时复活）
4. pause 期间 **全局 `wire:message` listener 保持挂载**（§5.5），但 reducer 可 no-op 或丢弃事件直至 resume（须与 lease 断开一致，防串线）

与现有 `useSessions({ enabled: !shouldPauseRuntime })` 对齐：pause 时不拉 session 列表，Orchestrator 与 Shell 共用同一 `shouldPauseRuntime` prop。

**观测字段命名（P1）**：Rust `wire_list_workers`、dev overlay、日志中 worker 时间戳字段统一为 **`updated_at`**（Unix ms 或 ISO8601，与 `SessionViewState.updatedAt` 语义对应）。禁止混用 `last_update_at`。

### 4.7 `delete_session` 与批量删除（P1）

Rust `delete_session`（`commands.rs`）顺序：`ensure_editable` → `acp_wire.disconnect` → `session/close` → `delete_session_dir`。

**前端 Orchestrator 须在前端 IPC 返回前或与之原子编排**（`useSessions.deleteSession` / `bulkDeleteSessions` 回调内）：

```text
1. orchestrator.disconnectSession(sessionId, reason: "delete")  // lease 匹配 wireDisconnect
2. orchestrator.removeViewState(sessionId)                        // Map 删除 + React 订阅更新
3. clearBackgroundTasksSession(sessionId)                       // 现有 G3 store
4. 清理 session-scoped dedupe（notifiedApprovals、tool-events 键等）
5. invoke delete_session（Rust 持久化与 worker 收尾）
```

**顺序不变量**：**先释放 lease / 移除 ViewState，再删磁盘**。避免 `wire:message` 在 ViewState 已删后仍写入，或 delete 后 stale listener 更新幽灵 session。

批量删除：对每个 `sessionId` **串行**执行上述 1–5（或 `Promise.all` 仅当 Rust 侧并发安全已验证）；UI 在 bulk 完成前禁用对该 session 的切换。

### 4.8 `restart_running_workers`（配置变更）（P1）

Rust `AcpProcessManager::restart_running_workers`（`acp.rs` L767）在模型/权限等 GlobalConfig 变更后 **逐 session** disconnect + connect，返回 `restarted_session_ids` / `skipped_busy_session_ids`。

**G5 前端须配合**：

| 步骤 | 行为 |
| --- | --- |
| 收到 `notifyGlobalConfigApplied` 或等价 hook | Orchestrator 标记受影响 session 为 `reconnecting` |
| 每个 restarted session | **独立**对该 `sessionId` 触发 replay gap fill（`replaySessionHistory` / `resyncGoalHistory` 模式），**禁止** `resetState` 波及其他 session |
| `skipped_busy` | 保持 connection；待 in-flight turn 结束后再由 orchestrator 补一次 restart 或提示用户 |
| 并行 | 多 session 可同时处于 reconnecting；各 session reducer 隔离 |

单流时代仅 visible session 需 replay；多流时代 **每个 restarted worker** 都要写回对应 ViewState，无论是否 visible。

---

## 5. 事件路由

### 5.1 Live 事件路径

```text
kimi acp ──notification──► AcpWorker::handle_acp_notification
                                │
                                ▼
                    emit_wire_message(app, session_id, json)
                                │
                                ▼
              Tauri event "wire:message" { session_id, message }
                                │
                                ▼
         Orchestrator: 单一全局 listen（不过滤 sessionId）
                                │
                                ▼
              viewStates.get(session_id)?.dispatch(parse(event))
                                │
              if session_id === visibleSessionId ──► React 订阅触发 render
```

**关键改动**：从「每 connection 一个 `onWireMessage(sessionId)`」改为「全局 listener + Map 路由」。`onWireMessage` 的 session 过滤可保留为 orchestrator 内部函数。

### 5.2 防串线保证（验收核心）

| 层级 | 机制 |
| --- | --- |
| Rust emit | 始终带 worker 的 `session_id` |
| Reducer | 入口断言 `event.session_id === targetState.sessionId` |
| React 渲染 | `useSyncExternalStore` 或 selector 仅订阅 `visibleSessionId` |
| 测试 | 双 session fixture 并行 inject events，断言 B.messages 长度不变 |

### 5.3 Replay 路径

- **打开 idle 会话**：继续 `replaySessionHistory` → 批量 `handleMessage`（现有路径），标记 `isReplay=true`
- **后台会话重连**：仅对该 session 执行 replay gap fill；**禁止**调用全局 `resetState`
- **Rust `session_store`**：仍为持久化真源；ViewState 是可丢弃缓存

### 5.4 wire_send 路由

无变更：`wire_send(sessionId, …)` 已由 Rust 路由到对应 worker。Orchestrator 需保证 send 前 worker 存在或触发 connect。

### 5.5 全局 `wire:message` listener 挂载与迁移（P1）

**现状**：`createTauriWireConnection` 内 per-connection 调用 `onWireMessage(sessionId, cb)`（`tauri-api.ts` L310），切换 session 时随 connection 销毁。

**目标**：Orchestrator 层 **单一** `listen("wire:message")`，在 reducer 内按 `payload.session_id` 路由。

| 阶段 | 挂载点 | unmount |
| --- | --- | --- |
| Phase 1 | `SessionStreamOrchestratorProvider`（`app.tsx` 内，仅 `isTauri() && flagOn`） | Provider unmount 或 `shouldPauseRuntime` → true 时 **不断开 listener**（仅 disconnect workers）；应用 `RunEvent::ExitRequested` 前 unlisten |
| 迁移步骤 | ① 新建 orchestrator 注册全局 listen；② flag off 时零注册；③ flag on 时 **不再**在 `createTauriWireConnection` 注册 per-session listen；④ `ConnectionHandle.unlisten` 字段废弃或恒 null |  |

**迁移验收**：

- DevTools / 日志：任意时刻最多 **1** 个全局 `wire:message` 订阅（flag on）
- 双 session 并行事件：listener 回调次数 = 两路 emit 之和，ViewState 仍隔离（§5.2）
- Fast refresh / HMR：不得重复注册 listener（`useEffect` cleanup 或 singleton guard）

---

## 6. 通知路由

### 6.1 设计原则

- 通知关联 **`sessionId`**，非「当前选中会话」
- 窗口 **有焦点且正在查看该 session** → 抑制 OS 通知（现有逻辑）
- 窗口失焦或查看其他 session → 对 **事件源 session** 发通知
- Dedupe key：`${sessionId}:${kind}:${entityId}`

### 6.2 通知类型矩阵

| 类型 | 触发源 | G5 路由 |
| --- | --- | --- |
| Turn 完成 | `SessionStatus idle` + `classifyIdleReason` | 任意 connected session；payload 含 session title |
| 审批 pending | ApprovalRequest in **该 session** ViewState | 非 visible 或失焦时通知；点击聚焦并切换 `visibleSessionId` |
| 后台任务终态 | `BackgroundTaskObserved` / tool result | 已有 sessionId；**不要** `resetBackgroundTaskNotifications` on switch |
| Question 请求 | QuestionRequest | 同审批 |
| Goal 完成 | Goal snapshot / event | session-scoped |

### 6.3 实现建议

**Phase 2+**：

1. 新建 `NotificationRouter`（`src/lib/notifications/`），订阅 Orchestrator 的 session 事件流
2. 可选：Rust `notify.rs` 统一发送 OS 通知，前端只 emit 结构化事件（减少 WebView 后台节流）；**Phase 1 可仍用前端 `sendNotification`**
3. 侧栏 session 项显示 running badge / 未读审批点（`is_running` + pending counts from ViewState）

### 6.4 与 G3 的关系

G3 承诺「当前持续连接会话」的 TaskOutput 通知；G5 完成后扩展为「任意 live worker 会话」，验收标准见 §10。

---

## 7. fork-at-turn（上游阻塞）

| 项 | 现状 |
| --- | --- |
| IPC | `fork_session` → 明确 Err（`commands.rs` L465） |
| UI | `message-list` fork 按钮仅在 `onForkSession` 传入时显示；**当前未传入**（测试覆盖） |
| `/fork` slash | blocked + 误导 hint |

**设计决策**：

- **不**为 fork 设计假 UI 或 stub RPC
- Phase 0 仅修正 `/fork` 文案，例如：`「ACP 尚未支持 session/fork；请使用 Kimi Code CLI TUI 的 /fork 或等待后续版本。」`
- 上游发布 `session/fork` 或等价 RPC 后，**单独**开 G5b 小计划：Rust handler → orchestrator → 侧栏/消息菜单入口

---

## 8. 风险与 No-Go

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 多 `kimi acp` 进程内存/句柄 | 高 | `maxLiveWorkers` + 观测 + 压力测试 |
| `useSessionStream.ts` 6000+ 行重构回归 | 高 | 分阶段；Phase 1 只抽类型 + 并行 Map，行为 flag 控制 |
| 全局 store 串线 | 高 | `currentGoal` / tool-events 会话化；代码审查 + 双 session 测试 |
| 热点文件并行编辑 | 中 | 串行 owner（alignment 计划 §2.8） |
| WebView 后台 timer 节流 | 中 | 关键通知可走 Rust notify |
| CLI 并发 session 限制 | 中 | 文档化；捕获 ACP error 并降级 disconnect |
| 多窗口需求 | — | **No-Go for G5**；与 single-instance 冲突 |
| Web 端误启用多流 | 低 | `isTauri()` + flag 双 guard；Web 构建不导出 orchestrator |
| 无限制后台保活 | — | **No-Go**；必须 LRU 或 Phase 1 interim 上限（§4.4） |

---

## 9. 分阶段落地建议

### Phase 0 — 观测与文案（可立即，低风险）

**目标**：可测量、可验收基线；零行为变更或多 worker。

| 项 | 内容 |
| --- | --- |
| 修正 `/fork` hint | `slash-command-catalog.ts` `DENIED_COMMAND_HINTS.fork` |
| Worker 观测 IPC | `wire_list_workers` → `{ session_id, state, connection_id, updated_at }[]` + dev overlay 可选 |
| 切换遥测 | debug 日志：`visibleSessionId` 变更、connect/disconnect 原因、Map size |
| 测试基线 | 记录「切换 running 会话后 worker 被 kill」的回归用例（当前预期失败，G5 后翻转） |
| 文档 | 本设计稿评审 |

**Owner 建议**：G5 设计 owner；不改 `useSessionStream` 核心逻辑。

### Phase 1 — 最小多 ViewState（评审通过后）

**目标**：引入 `SessionStreamStore` + 全局 event router；**切换时 running 会话不再 disconnect**。

| 项 | 内容 |
| --- | --- |
| 新建 | `src/lib/session-stream/types.ts`、`store.ts`、`orchestrator.ts`、`provider.tsx`（含 §5.5 全局 listen） |
| 抽离 | `processEvent` → pure reducer（单 session unit test） |
| 改造 | `useSessionStream` 瘦身为 `visibleSessionId` 的 selector + actions 委托 orchestrator |
| Feature flag | 见 **§9.1**（P0）；默认 **off** |
| Interim 上限 | **§4.4 Phase 1 临时上限**（P0）：`maxLiveWorkers = 3` 或验收 ≤2 running |
| 生命周期 | §4.6 `shouldPauseRuntime`、§4.7 delete/bulk delete、§4.8 config restart replay |
| Rust | 无必须改动；可选用 Phase 0 观测 API |
| 验收 | 2 个 running 会话交替切换，worker 数 ≥ 2；A 的事件不进入 B 的 ViewState；flag off 回归单流 |

**最小切片边界**：仅保活 **isRunning** 会话；idle 切换仍 disconnect（与 Phase 2 兼容）。

**Phase 1 已知限制（P1，须在 PR / 验收文档声明）**：

| 限制 | 说明 | 验收影响 |
| --- | --- | --- |
| `useToolEventsStore.currentGoal` | **仍为全局单值**；Phase 2 会话化 | Phase 1 **不测**跨 session goal 隔离；仅测 `messages` / `pendingApprovals` / worker 保活 |
| 跨 session 通知 | **不交付**（toast、badge、dedupe 跨会话）；见 §6.3 | 切换时仍可能 `resetBackgroundTaskNotifications`；MT-02 等挪到 Phase 3 |
| idle 后台保活 | idle 切换仍 disconnect | 仅 running/in-flight 保活 |

**Phase 1 不做**：侧栏 running badge、跨 session OS 通知、完整 LRU/`idleDisconnectTtlMs`（属 Phase 2–3）。

### 9.1 默认启用与 Web 回退

**Tauri Desktop** 使用 `isTauri()` 作为唯一运行时条件，默认创建 `SessionStreamOrchestrator`。该编排器为每个已访问会话保留独立 `SessionRuntime`，并通过一个全局 `wire:message` 监听器按 `session_id` 分发事件。

**Web / 非 Tauri** 恒为单流回退：不创建 orchestrator，不注册全局 `wire:message` listener，并保持既有的会话切换生命周期。这是平台差异，不提供 build-time 或 localStorage 的桌面关闭开关。

桌面端切回一个 `autoConnect` 的会话时，只要其 wire lease 不处于 connecting / connected / reconnecting 状态，就必须补连；即使该会话仍报告 `streaming`，也要 replay 缺失事件，不能让时间线凝固或让下一条 prompt 落入错误队列。

### Phase 2 — RetentionPolicy + idle 后台

- 实现 LRU、`idleDisconnectTtlMs`
- 侧栏 running / pending approval badge
- `useToolEventsStore.currentGoal` 改为 per-session 或从 ViewState 读取

### Phase 3 — 跨会话通知

- `NotificationRouter`；移除 switch 时 `resetBackgroundTaskNotifications`
- 审批 / 后台任务 / turn 完成跨 session toast + 点击跳转
- 可选 Rust `notify.rs` 接入

### Phase 4 — 后续硬化

- 压力测试通过（§11）
- WebView2 真实验收（`2026-07-18-webview2-acceptance.md` 增补 G5 场景）
- 评估是否可移除不支持多流的 Web 单流实现

### Phase 5（独立）— fork-at-turn

- 阻塞于上游 `session/fork`；不在 G5 主链

---

## 10. 验收标准

### 10.1 功能

- [ ] **串线零容忍**：自动化测试同时驱动 session A/B 事件流，B 的 `messages` / `pendingApprovals` 不因 A 的事件变化
- [ ] **切换**：A running → 切到 B → 再切回 A，A 的时间线连续、无丢 turn、worker 未无故重启
- [ ] **断线**：杀单个 `kimi acp` 子进程，仅该 session 进入 error/reconnecting；其他 session 不受影响
- [ ] **退出**：托盘/真正 Exit 后无残留 `kimi acp` 子进程（进程列表验收）
- [ ] **重启 Desktop**：已持久化会话历史完整；live 状态按 `is_running` 恢复连接
- [ ] **`/fork`**：blocked 文案准确，不引用侧栏 Fork 入口

### 10.2 可观测

- [ ] dev/prod 可查询当前 live worker 数与 session 列表
- [ ] 每次 disconnect 日志含 **原因**（user / lru / exit / delete / error）

### 10.3 性能（压力测试门槛）

- [ ] 3 并发 running 会话 30min，Desktop 内存增长 < 30% 基线
- [ ] 快速切换 20 个会话（仅 3 running）无 UI 卡死 > 500ms
- [ ] `maxLiveWorkers=3` 时第 4 个 running 触发 LRU 且日志可追踪

---

## 11. 压力测试计划

### 11.1 自动化（Vitest + Rust）

| 用例 ID | 描述 | 层级 |
| --- | --- | --- |
| ST-01 | 双 session reducer 并行 inject 100 events | reducer unit |
| ST-02 | Mock orchestrator 切换 visibleSessionId，assert disconnect 调用次数 | hook/integration |
| ST-03 | `wire_list_workers` 与 ground truth HashMap 一致 | Rust unit |
| ST-04 | Lease mismatch：`wireDisconnect` 旧 connectionId 不杀新 lease | Rust + TS |

### 11.2 ACP fixture 驱动

- 扩展 `test-fixtures/acp/`：两 session 交替 `session/update` trace
- `npm run smoke:acp` 增补脚本：创建 2 session，session A prompt 中切换 UI（需 test harness 或 manual checklist）

### 11.3 手动 / WebView2（发布前）

| 场景 | 步骤 | 预期 |
| --- | --- | --- |
| MT-01 双任务 | A/B 各发长任务，交替查看 | 两任务均完成，通知正确 |
| MT-02 失焦通知 | A 运行中切到 B，失焦 | A 完成时 OS 通知含 A 标题 |
| MT-03 LRU | 启动 4 个 running（调低 max 为 3） | 最旧 idle 被杀，running 保留 |
| MT-04 窗口关闭 | 任务中关窗（hide） | 任务继续；托盘唤起可见进度 |
| MT-05 真正退出 | Exit 后检查进程 | 无 kimi acp 残留 |

### 11.4 工具

- Windows：Task Manager / `Get-Process kimi*` 计数
- 内置 dev overlay（Phase 0）：worker 数、Map size、visible session

---

## 12. 热点文件影响与所有权

**规则**：下列文件在 G5 实施窗口内 **串行单 owner**（alignment §2.8）。

| 文件 | Phase 0 | Phase 1+ | 变更性质 |
| --- | --- | --- | --- |
| `src/hooks/useSessionStream.ts` | 只读/注释 | **主重构** | 抽 reducer；瘦身 selector |
| `src/lib/session-stream/*` | — | **新建** | Orchestrator、Store、types |
| `src/app/app.tsx` | — | 中 | 绑定 orchestrator；通知路由 |
| `src/hooks/useSessions.ts` | — | 低 | `is_running` 与 worker 状态同步 |
| `src/lib/tauri-api.ts` | 低 | 低 | 观测 IPC wrapper |
| `src-tauri/src/acp.rs` | 低 | 低–中 | list workers、可选 idle policy |
| `src-tauri/src/commands.rs` | 低 | 低 | 新 IPC 注册 |
| `src-tauri/src/lib.rs` | — | 低 | handler 注册 |
| `src-tauri/src/wire_events.rs` | — | 无 | 已满足路由键 |
| `src/lib/slash-command-catalog.ts` | **fork 文案** | 无 | Phase 0 |
| `src/lib/background-tasks/sync.ts` | — | 中 | 去掉 switch reset dedupe |
| `src/lib/tool-events/store.ts` | — | 中 | session-scoped goal |
| `src/lib/agent-monitor/sync.ts` | — | 低 | 已带 sessionId |
| `src/hooks/useSessionStream.test.tsx` | 基线 | **大量增补** | 多 session 用例 |

**建议 owner 分工**：

1. **Stream owner**：`useSessionStream` + `session-stream/*` + tests
2. **Platform owner**：`acp.rs` / `commands.rs` 观测与 lifecycle
3. **Shell owner**：`app.tsx` 通知与侧栏 badge

---

## 13. 与现有计划的关系

- **G0–G4**：不依赖 G5；G5 未完成不阻塞已交付 Gate
- **G3 后台任务**：G5 Phase 3 完成后方可承诺跨会话通知
- **G1 SessionConfigState**：已按 sessionId 隔离（`acp_capabilities.rs`）；ViewState 引用，不合并进 initialize
- **单实例**：[2026-07-22-single-instance.md](./2026-07-22-single-instance.md) 继续有效

---

## 14. Phase 0 / Phase 1 开工条件

### 14.1 Phase 0（可立即）

| 条件 | 状态 |
| --- | --- |
| 本设计评审 | ☑ APPROVE_WITH_NITS |
| `/fork` 文案修正 | ☑ 已完成 |
| `wire_list_workers` IPC（`updated_at` 字段） | ↪ **defer → Phase 1 前置 / Phase 1 并行** |
| 切换 running 回归用例（当前预期 fail） | ☑ 已完成 |

**`wire_list_workers` defer 说明**：`acp.rs` / `commands.rs` 为 Phase 1 热点，并行改动易冲突；Phase 0 优先零行为变更与基线测试，观测 IPC 由 Platform owner 在 Phase 1 首 PR 前置或与多流改造并行交付。

**结论**：Phase 0 **窄范围可关闭**（文案 + 基线测试）；`wire_list_workers` 不阻塞 Phase 0 关闭，但须在 Phase 1 启动前或首 PR 并行完成。

### 14.2 Phase 1 开做门禁（须全部 ☑）

| # | 条件 | 状态 |
| --- | --- | --- |
| 1 | 设计评审通过（含本文 P0/P1 补丁） | ☑ |
| 2 | Phase 0 基线测试 / IPC 可观测 worker | 基线测试 ☑；IPC 观测 ☐（defer → Phase 1 前置） |
| 3 | `useSessionStream.ts` **串行 owner** 确认（alignment §2.8） | ☐ |
| 4 | Feature flag 按 **§9.1** 实现清单评审（含 flag off 回归） | ☐ |
| 5 | Interim **`maxLiveWorkers = 3`** 或书面限定验收 **≤2** running（§4.4） | ☐ |
| 6 | §4.6 pause、§4.7 delete 顺序、§4.8 restart replay 纳入 orchestrator 任务拆分 | ☐ |
| 7 | §5.5 全局 listener 迁移步骤写入 Phase 1 首 PR 描述 | ☐ |
| 8 | Phase 1 已知限制（§9 `currentGoal` 全局、无跨 session 通知）已同步 QA | ☐ |

**结论**：

- **Phase 1 在 #2–#8 全部满足后启动**；不满足时仅允许 Phase 0 / flag-off 脚手架
- 首 PR 范围建议：§9.1 flag + §5.5 全局 listen + 双 session running 保活 + §4.4 interim 上限；delete/pause/restart 可同 PR 或紧接 follow-up

---

## 15. 附录：类型草案（Phase 1 起点）

供 Phase 1 创建 `src/lib/session-stream/types.ts` 时使用；**本设计阶段不提交代码**。

```typescript
export type ConnectionPhase = "disconnected" | "connecting" | "connected" | "reconnecting";

export type RetentionPolicy = {
  maxLiveWorkers: number;
  maxCachedViewStates: number;
  idleDisconnectTtlMs: number;
  pinRunning: boolean;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxLiveWorkers: 3,
  maxCachedViewStates: 20,
  idleDisconnectTtlMs: 30 * 60 * 1000,
  pinRunning: true,
};
```

---

## 16. 变更记录

| 日期 | 说明 |
| --- | --- |
| 2026-07-31 | 初稿：G5 设计子代理基于代码审阅产出 |
| 2026-07-31 | 评审 APPROVE_WITH_NITS：补 §1.1 平台范围、§4.4 Phase1 上限、§4.6–4.8 生命周期、§5.5 全局 listen、§9.1 feature flag、§14 开工门禁 |
