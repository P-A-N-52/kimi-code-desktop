# Kimi Code Source Runtime 迁移方案

状态：已确认，M0 契约冻结  
日期：2026-08-06  
目标分支：`codex/source-runtime`

## 1. 决策

Kimi Code Desktop 从“调用用户安装的 `kimi acp` 的桌面外壳”迁移为“内置并修改 Kimi Code 源码的独立桌面产品”。完成迁移后的发布包只包含一个 AI Runtime 内核：由本仓库源码构建的 Kimi Code Runtime。

最终产品必须满足：

- 不依赖 PATH 中的 `kimi`，不启动 `kimi acp`。
- 不保留 ACP、旧 sidecar 或其他 AI backend 的生产 fallback。
- 不提供 runtime selector，也不静默切换到用户安装的 CLI。
- Kimi Runtime 运行在 Tauri 监管的独立 OS 子进程中，不嵌入 WebView，也不与 Rust 主进程同进程运行。
- React 只依赖 Desktop 的稳定事件语义，不直接依赖 Kimi 内部类型。

迁移分支可以在尚未完成切换时保留现有 ACP 代码以维持可构建基线，但不得发布双 backend。切换提交必须同时启用 Source Runtime、删除 ACP 生产入口和替换 readiness/smoke/release 门禁。

## 2. 保留与替换

### 保留的产品层

- React/Tauri 应用壳、窗口、菜单、快捷键、通知、更新和单实例行为。
- 会话侧栏、Composer、消息流、Settings、Changes、Files、Agents、Tasks。
- 附件、审批、追问、斜杠命令、Plan、Goal、Swarm、usage/context 和未知 payload fallback 的用户可见语义。
- 当前 Tauri IPC 外形和前端 wire 语义可作为迁移兼容面；实现内部逐步改为 runtime-neutral 命名。
- Rust 的本地路径校验、Git/文件读取、桌面 metadata 与发布编排。
- 既有 `~/.kimi-code` 会话和配置的可恢复读取。

### 必须替换的 ACP 层

- `AcpProcessManager`、`AcpDesktopClient` 和 `acp_translate` 生产路径。
- ACP capability/config-option 协商。
- PATH/`kimi acp --help` readiness 与 ACP smoke。
- 通过外部 `kimi provider` 修改配置的桥接。
- ACP fixture、错误文案和发布前检查。

不新增第二套前端组件树，不内置第二个 TUI，也不把 `kap-server` 的 HTTP/WebSocket API 当作 Desktop 协议。

## 3. 源码基线与目录

上游源码固定为：

| 字段 | 值 |
| --- | --- |
| Repository | `https://github.com/MoonshotAI/kimi-code.git` |
| Tag | `@moonshot-ai/kimi-code@0.33.0` |
| Commit | `53c832dfdf9566afd59a8b3d54ebd36d3cb03d72` |
| License | MIT，另保留仓内子项目许可证 |
| Node | `24.15.0` |
| pnpm | `10.33.0` |

目录契约：

```text
desktop-mac/
  package.json                         # 外层 React/Tauri，继续使用 npm
  package-lock.json
  runtime/
    UPSTREAM.md                        # 固定 commit、导入和同步说明
    kimi-code/                         # 保留历史的上游源码
      pnpm-lock.yaml                   # 上游 workspace 自己的锁文件
      apps/
        desktop-runtime/               # 本产品维护的 Runtime entrypoint
  src-tauri/
    src/
      runtime_supervisor.rs            # 子进程生命周期与 stdio
      runtime_protocol.rs              # runtime-v1 envelope
      runtime_translate.rs             # Runtime event -> Desktop wire
```

源码以保留 upstream history 的 subtree 方式导入 `runtime/kimi-code`，不使用 ZIP 拷贝、Git submodule 或 `--squash`。后续同步只能从明确的 upstream tag/commit 进入专门分支，先审阅再合并。

`apps/desktop-runtime` 放在 Kimi 现有 pnpm workspace 内，通过公开根 export 使用 `@moonshot-ai/kimi-code-sdk`。首个适配层使用 `createKimiHarnessV2` 兼容现有 Desktop 行为；Desktop 代码不得在多处深层导入 `agent-core-v2`。SDK v2 当前仍是兼容层，因此所有上游调用必须收口在一个 adapter 中。

## 4. 运行拓扑

```text
React / useSessionStream
  -> stable Tauri commands + desktop wire events
     -> RuntimeSupervisor (Rust)
        -> source-built desktop-runtime child (Node SEA)
           -> DesktopRuntimeAdapter
              -> createKimiHarnessV2 / Kimi source
     -> desktop metadata / files / Git helpers
```

进程模型：

- 每个 Desktop 主进程只监管一个 Runtime 子进程。
- Runtime 内部复用一个 harness，按 `sessionId` 管理多个活动会话。
- Rust 负责 spawn、handshake、请求路由、超时、退出、重启和崩溃报告。
- Runtime 崩溃不得拖垮 Tauri；恢复后由 Rust 按持久化状态重新打开需要的会话。
- Runtime stdout 只允许协议帧，诊断日志只写 stderr。

单进程多会话避免为每个会话重复加载 Node/Kimi 内核。任何会导致一个会话事件串入另一会话的实现都属于协议错误。

## 5. `runtime-v1` 协议

传输为 stdio 上的 UTF-8、LF 分隔 JSONL。每行恰好一个 envelope；禁止多行 JSON。首版不开放 TCP、HTTP、WebSocket 或 Unix domain socket。

### 5.1 Envelope

请求：

```json
{"protocol":"runtime-v1","type":"request","id":"req-1","method":"turn.start","sessionId":"s-1","params":{}}
```

响应：

```json
{"protocol":"runtime-v1","type":"response","id":"req-1","ok":true,"result":{}}
```

事件：

```json
{"protocol":"runtime-v1","type":"event","sessionId":"s-1","seq":42,"event":"content.delta","payload":{}}
```

错误响应：

```json
{"protocol":"runtime-v1","type":"response","id":"req-1","ok":false,"error":{"code":"session_busy","message":"Session is busy","retryable":false}}
```

硬性字段：

- 所有帧都有精确的 `protocol` 与 `type`。
- request/response 通过不复用的 `id` 一一关联。
- 会话事件必须有 `sessionId` 和该会话单调递增的 `seq`。
- turn 终态必须携带对应 `requestId`/`turnId`，不得靠到达时间猜测归属。
- 未知 `event` 必须能进入 Desktop generic fallback，不能导致连接断开。
- stdout 出现非 JSON、超大帧、协议版本不匹配或重复 response id 时，Rust 将其视为 Runtime 故障。

### 5.2 Handshake

Rust 启动后发送 `runtime.hello`，至少包含：

- Desktop 版本和支持的协议范围。
- 期望的数据根目录。
- 当前平台、架构和 locale。

Runtime 返回：

- 选定协议版本。
- Runtime 版本、Kimi source tag/commit、Node 版本。
- capability snapshot。
- 数据 schema 版本。

handshake 未完成前不得接受会话请求。source commit 与发布清单不一致时 readiness 失败，不尝试外部 CLI fallback。

### 5.3 M1 最小方法

```text
runtime.hello
runtime.getInfo
runtime.shutdown

sessions.list
sessions.create
sessions.get
sessions.update
sessions.delete
session.open
session.close

turn.start
turn.cancel
turn.steer
approval.respond
question.respond

config.get
config.update
models.list
providers.list
providers.import
```

`sessions.fork`、Share 或其他能力只有在 Kimi source 路径真实支持并进入 capability snapshot 后才允许启用 UI。

### 5.4 M1 最小事件

```text
runtime.ready
runtime.warning
session.status
session.config
content.delta
thinking.delta
tool.started
tool.updated
tool.completed
plan.updated
usage.updated
task.updated
subagent.updated
approval.requested
question.requested
turn.completed
turn.failed
```

Runtime event 先翻译为 Desktop 的中性 wire，再进入现有 live/replay reducer。语义卡片之外继续保留原始、可读的 unknown fallback。

## 6. 状态与时序不变量

- 同一 session 同时最多一个会改变 turn 状态的请求；busy 错误必须显式返回。
- `turn.completed`/`turn.failed` 与 response 都携带相同 `requestId`，前端只终结匹配请求。
- 对同一请求，Runtime 必须先提交持久化终态，再发送 response/event；重新连接后可查询最终状态。
- cancel、restart 和 shutdown 不得让旧 turn 的终态覆盖新 turn。
- Rust 丢弃 `seq` 不大于已接收值的会话事件，并记录诊断。
- 工具/子代理事件必须携带稳定 tool/agent id 和 parent provenance。
- Runtime shutdown 必须先拒绝新请求，再等待有界 drain，最后返回 shutdown response；超时由 Rust 终止子进程。

## 7. 数据所有权与迁移

最终只允许一个 writer 修改每类持久化数据：

| 数据 | Writer | Reader |
| --- | --- | --- |
| Kimi session/journal | Source Runtime | Runtime、Rust replay adapter |
| Kimi provider/model/MCP config | Source Runtime | Runtime、Settings snapshot |
| Desktop title/archive/UI metadata | Rust Desktop store | Rust/React |
| Worktree files/Git | 用户工具或 Runtime | Rust read helpers |
| Runtime logs/crash reports | Rust supervisor | Desktop diagnostics |

Rust 不再在 Runtime 活跃时直接改写 Kimi core 文件。Settings、Provider 和 MCP 写操作必须走 Runtime API，并在 response 后刷新 snapshot。

迁移规则：

1. 首次启动只读扫描现有 `~/.kimi-code`，生成迁移预检，不立即重写。
2. 0.33.0 source 能原生读取的记录保持原位；Desktop metadata 继续 overlay。
3. 需要 schema 迁移时先创建可恢复备份和 migration marker，再原子提交。
4. 迁移中断可重试；不得产生两个 writer 或把秘密复制到 Desktop event/log。
5. 测试只使用临时 `KIMI_CODE_HOME`，永不覆盖用户真实目录。

## 8. 安全边界

- API key/token 不进入 argv、stdout 协议、前端 event、普通日志、transcript 或错误报告。
- 必须通过受限环境变量、Runtime 配置写 API 或系统凭据存储传递秘密。
- Rust 继续验证从 UI 进入的 URL、绝对路径、工作区路径和 MCP command。
- Runtime 请求方法使用 allowlist；不提供“执行任意 JS/命令”的通用协议方法。
- 单帧大小、待处理请求数、stderr 缓冲和优雅退出都有上限。
- stdout 协议解析失败、版本不匹配、source 身份不匹配都 fail closed。
- 崩溃报告在落盘和展示前继续执行 secret redaction。

## 9. 构建与发布

外层 Desktop 继续由 npm 构建；Kimi source workspace 由固定 pnpm 构建，两套锁文件不合并。

Runtime 开发构建：

```sh
npm install
npm run runtime:install
npm run runtime:build
npm run smoke:runtime
```

外层 `pnpm@10.33.0` 开发依赖负责调用 nested workspace，避免依赖全局 pnpm 或已从新版本 Node 中移除的 Corepack。

发布构建参考 Kimi Code 现有 Node SEA 流程，为每个平台/架构生成并校验单文件 Runtime sidecar。Tauri 配置只打包本次源码产生的 artifact。

发布门禁至少验证：

- artifact 中报告的 source commit 与冻结值一致。
- 不需要 PATH 中的 `kimi`。
- 安装包不包含 ACP/旧 sidecar 生产入口。
- macOS 签名、公证和 Windows 签名覆盖 Runtime sidecar。
- Runtime 缺失、损坏或握手失败时显示可操作错误，不下载或调用外部 CLI。

## 10. 分阶段实施

### M0：契约和源码所有权

- 冻结本文、source tag/commit、许可证和目录。
- 导入保留历史的 Kimi source。
- 添加 `apps/desktop-runtime` 的 build/test/protocol skeleton。

### M1：Source Runtime

- 建立 stdio codec、handshake、request router 和 lifecycle。
- 在单一 adapter 内接入 `createKimiHarnessV2`。
- 实现 session/turn/config 最小方法与 golden protocol tests。

### M2：Rust Supervisor

- 建立 runtime-neutral supervisor/client/translation 模块。
- 实现进程监管、请求表、seq、超时、restart 和 stderr redaction。
- 用 fixture worker 完成 Rust integration tests。

### M3：行为与数据对齐

- 接通 live/replay、工具、审批、追问、Plan/Goal/Swarm、usage。
- 接通 Provider/model/MCP 和现有 session migration。
- 对现有前端行为运行同一组回归测试。

### M4：一次性切换

- Tauri command 改接 RuntimeSupervisor。
- 删除 ACP manager/client/translation/capability 和外部 provider CLI 生产路径。
- 替换 readiness、smoke、文案和发布检查。
- 不留下生产 feature flag、双 backend 或静默 fallback。

### M5：发布验收

- source build、Rust/React、协议 fuzz/golden、migration 和 release preflight 全部通过。
- 在真实 Tauri/WebView 上验证多会话、prompt、工具、取消、重启、配置和恢复。
- 分别记录“代码完成”“自动化通过”“真实桌面验收”。

## 11. M0 完成标准

- 本文与仓库开发规范不再把最终产品描述为 ACP-only 外壳。
- `runtime/kimi-code` 精确对应冻结 commit，并保留要求的许可证/历史。
- `apps/desktop-runtime` 可在固定 Node/pnpm 下构建和运行协议 smoke。
- smoke 至少验证 hello、getInfo、未知方法错误、跨 session seq 隔离和 shutdown。
- 尚未切换的 ACP 代码明确标注为迁移基线，不能被描述为最终架构。
- 未完成真实 Tauri 切换前，不宣称“已取代 ACP”。
