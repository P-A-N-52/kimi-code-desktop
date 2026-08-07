# Source Backend 架构决策

状态：已确认方向，待实施
日期：2026-08-07
替代：`docs/plans/2026-08-06-source-runtime-migration.md`（旧契约存档于 `origin/codex/source-runtime`，协议细节可回查，本文为准）

## 1. 决策

Kimi Code Desktop 从“连接用户安装的 `kimi acp` 的桌面外壳”迁移为“内置 Kimi Code 源码、自行构建后端的独立桌面产品”。后端结构参考主流 agent 工具的成熟范式定型，**主要基于 Kimi Code 源码改造**，原则上不修改上游源码文件。

## 2. 主流 agent 工具后端结构对标

| 工具 | 后端结构 | 关键范式 |
| --- | --- | --- |
| Codex（openai/codex，开源） | Rust workspace 单核多前端：`core` 库承载 agent loop/tools/sandbox，`app-server` 以 JSON-RPC over stdio 服务桌面/IDE | 引擎是库；UI 与引擎之间是结构化协议 |
| Claude Code | 单 Node 进程 agent loop；headless SDK 模式输出 `stream-json` JSONL stdio；官方 SDK = spawn CLI + JSONL 帧 | CLI 即后端；子进程 + 行分隔 JSON 协议 |
| Kimi Code 0.33.0（本仓库 `runtime/kimi-code`，源码实证） | 分层 monorepo：`kosong`（LLM 抽象）→ `kaos`（执行环境抽象）→ `agent-core-v2`（DI×Scope 引擎）→ `klient`（contract facade，ipc/memory 双 transport）→ `node-sdk` → `kap-server`（REST+WS daemon）/ `acp-server` | 后端所需全部分层已内置；DI×Scope 与 klient transports 是官方扩展缝 |
| pi（pi-mono 系） | `pi-ai` → `pi-agent-core` → `pi-tui`/`pi-coding-agent`，单进程库式，GUI 直接 import | 严格分层；前端薄 |

收敛出的范式：

1. 引擎做成库，前端做薄。
2. 引擎与 UI 之间走结构化协议（JSONL stdio / JSON-RPC），不共享内存对象。
3. 单后台进程托管多会话（supervisor 模型）。
4. LLM 层、执行环境层、引擎层、传输层严格分离。

## 3. 选定结构

```text
React/Tauri 桌面壳（现状保留，wire 语义不变）
  └─ Tauri IPC（现有命令外形作为迁移兼容面）
      └─ Rust: src-tauri/src/runtime/（supervisor + protocol/codec + client + translate + readiness）
         （新增模块目录，最终替换 acp.rs / acp_desktop.rs / acp_translate.rs）
          └─ stdio JSONL（runtime-v1 协议）
              └─ desktop-runtime（Node 子进程，发布时为 SEA 单文件 sidecar）
                  └─ adapter（全部上游调用的唯一收口）
                      └─ klient（首选 in-memory transport）
                          └─ agent-core-v2（引擎）
                              ├─ kosong      → providers / models
                              ├─ kaos        → tools / 执行环境（对接桌面 worktree 与审批）
                              └─ transcript / minidb → 会话持久化
```

### 3.1 seam 决策：klient 优先于 node-sdk

旧契约写的是 adapter 接 `createKimiHarnessV2`（`node-sdk`）。源码实证后改为 **`klient`**：

- `klient` 是 contract 驱动的 facade（`packages/klient/src/contract/`），协议字段可直接复用其 contract。
- transports 同时提供 in-memory 与 ipc（`packages/klient/src/transports/`）；同进程首选 in-memory 零开销，将来需要进程级隔离再切 ipc，对 Rust 侧透明。
- `node-sdk` 的 harness v2 是兼容层，不作为长期依赖。

约束：所有上游调用必须收口在 adapter 一个文件/模块内；Desktop 代码不得在多处深层 import `agent-core-v2` 内部。

### 3.2 明确不使用

- `kap-server` 的 REST/WebSocket API（不作为 Desktop 协议）。
- `acp-server` / `acp-adapter` / `protocol`（正是要淘汰的 ACP 层）。
- `pi-tui`、`migration-legacy`、`apps/kimi-code`（上游 CLI/TUI，不参与产品）。

### 3.3 进程模型

- 每个 Desktop 主进程只监管一个 Runtime 子进程（Node，开发期可用 `tsx` 跑源码，发布为 SEA artifact）。
- Runtime 内部复用一个引擎实例，按 `sessionId` 管理多活动会话。
- stdout 只承载协议帧；诊断日志只写 stderr；Rust 负责 spawn、handshake、请求路由、超时、退出、重启与崩溃报告。
- Runtime 崩溃不得拖垮 Tauri；恢复后由 Rust 按持久化状态重新打开需要的会话。

### 3.4 runtime-v1 协议要点（沿用旧契约 §5，不变）

- stdio 上 UTF-8、LF 分隔 JSONL；每行恰好一个 envelope，禁止多行 JSON。
- 帧类型：request / response / event / error-response；request-response 用不复用的 `id` 关联。
- 会话事件必须带 `sessionId` 与该会话单调递增的 `seq`；Rust 丢弃 `seq` 不大于已接收值的事件。
- turn 终态（`turn.completed`/`turn.failed`）必须携带对应 `requestId`，不靠到达时间猜归属。
- 未知 `event` 必须能进入 Desktop generic fallback，不能导致断连。
- 非 JSON、超大帧、协议版本不匹配、重复 response id → Rust 判 Runtime 故障，fail closed。
- handshake（`runtime.hello`）未完成前不接受会话请求；返回 capability snapshot 与 source commit，commit 与发布清单不一致则 readiness 失败。

## 4. “改造而不改源码”原则

定制点全部落在自己拥有的层：

| 需求 | 落点 |
| --- | --- |
| 桌面审批 / 追问 / worktree 语义 | `kaos` 执行环境抽象 + `agent-core-v2` DI×Scope 注入（`hooks.ts` 为官方扩展点） |
| 桌面特有行为 | 优先考虑做成 `plugins/` 插件 |
| 协议与生命周期 | 自有的 `apps/desktop-runtime` |
| 上游 bug / 缺 hook | `pnpm patchedDependencies` + `runtime/PATCHES.md` 逐条登记；能贡献上游就贡献 |

发布包不依赖 PATH 中的 `kimi`，不启动 `kimi acp`，不留 ACP/sidecar 生产 fallback，不提供 runtime selector。
