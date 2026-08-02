# Desktop Plugin System 草案可行性审查

| 项目 | 内容 |
| --- | --- |
| 状态 | **评估结论 / 非实施计划** |
| 日期 | 2026-08-02 |
| 审查对象 | `docs/plans/2026-08-02-desktop-plugin-system-draft.md` |
| 范围 | 当前 React/Tauri/ACP 源码、依赖、IPC、安全边界、持久化和测试体系 |
| 不代表 | 已实现、已批准排期、自动化验证通过或真实桌面验收通过 |

---

## 1. 总体判断

Desktop Plugin System 的产品方向与当前 Desktop 的 ACP-only 架构并不冲突，草案的以下原则也应当保留：

- Desktop 插件不等同于 Kimi Code CLI Plugin、Skill 或 MCP；
- 插件声明权限不等于实际获得授权；
- 插件代码不得直接取得 Tauri、ACP wire、Kimi 凭据、文件系统和操作系统的环境权限；
- 包应使用预构建产物、可校验快照、内容 hash 和可回滚版本；
- 插件 UI 应先由 Desktop 原生渲染声明式 schema，而非注入任意 React、HTML、CSS 或脚本；
- JavaScript 和 Wasm 运行时都必须保留未知输入的安全失败路径，不能因未来扩展而静默扩大权限。

**但草案不能以当前形态直接进入完整实现。** 仓库目前没有插件包安装器、独立插件运行时、WebAssembly Component Host、插件权限 broker、插件网络代理、插件安全存储、通用 OAuth、事务恢复或插件审计系统。将 JavaScript、Wasm、Git/SSH 安装、OAuth、WSS 长连接及远程会话控制同时作为 v1，会把若干独立的安全敏感工程耦合为一个高风险改造。

建议先将草案拆为两个事实不同的目标：

1. **可信静态包管理**：导入、验证、快照、安装状态、权限声明与恢复；完全不执行插件代码。
2. **受控代码执行平台**：独立 host、capability broker、资源治理、审计和运行时 conformance；在安全 spike 验证后逐一开放能力。

第一个目标可作为近期独立交付；第二个目标需要先证明隔离与取消模型，不能作为普通前端功能增量处理。

---

## 2. 当前代码中可以借鉴的基础

### 2.1 子进程生命周期与故障处理

`AcpProcessManager` 已管理每会话 ACP 子进程、标准输入输出、请求表、错误与 shutdown。`AcpRpcSession::shutdown()` 会 kill/wait 子进程，应用退出时会调用 `stop_all()`：

- `src-tauri/src/acp.rs:356-434`
- `src-tauri/src/acp.rs:2663-2764`
- `src-tauri/src/acp.rs:3090-3113`
- `src-tauri/src/lib.rs:201-204`

这可以作为未来 `PluginHostSupervisor` 的进程监督参考，但不能直接复用 ACP worker。ACP 子进程是受信任 CLI runtime；第三方插件 host 需要独立身份、能力绑定、资源上限、审计和清理语义。

### 2.2 原子状态文件写入

`session_store` 已采用「同目录临时文件 → `sync_all` → rename」模式写入 JSON 文件：

- `src-tauri/src/session_store.rs:197-227`

`managed_usage` 也使用临时文件替换和 Unix 权限收紧：

- `src-tauri/src/managed_usage.rs:291-350`

这些模式适合用于插件的 active pointer、grant snapshot 和小型状态文件。但现有实现不涵盖多版本安装事务、跨进程锁、目录级 fsync、Windows rename 语义、断电恢复、GC 或版本树完整性。插件安装仍需独立的 transaction journal 和启动恢复算法。

### 2.3 Tauri 注册与前端 IPC 边界

Tauri state 和命令注册集中于 `src-tauri/src/lib.rs:51-122`。前端对应门面集中于 `src/lib/tauri-api.ts`。这是新增 Desktop Plugin 管理 API 的正确组合点：

```text
Rust plugin service
  -> commands.rs thin wrapper
  -> lib.rs generate_handler registration
  -> src/lib/tauri-api.ts typed wrapper + normalizer
  -> UI/store + adjacent tests
```

未来的 `PluginManager` 应作为独立 Tauri state 注册。插件领域逻辑不应持续堆入 `commands.rs`。

### 2.4 Settings、Usage 与状态展示

`SettingsDialog` 已有 tab 结构和异步 loading/error 状态模式：

- `src/modules/settings/settings-dialog.tsx:48-56`
- `src/modules/settings/settings-dialog.tsx:127-237`

使用量面板也已展示多个本地/平台数据源：

- `src/modules/settings/usage-panel.tsx:162-313`

未来的 Desktop 插件管理应新增 `src/modules/plugins/` 功能目录，再由 Settings 只挂载一个 `Desktop 插件` tab。第三方 usage provider 只能输出标准化 snapshot，由 Desktop 决定显示，不能替换 Kimi usage 或注入 UI。

### 2.5 ACP 内部持有敏感状态的模式

ACP permission request 的实际 option ID 由 native 侧保存，再映射为稳定的 UI 数据；未知请求默认拒绝：

- `src-tauri/src/acp.rs:399-425`
- `src-tauri/src/acp.rs:2558-2590`
- `src-tauri/src/acp.rs:2857-2881`

这说明未来 Host API 可以且应当保留 ACP 内部标识、临时 capability 和真实审批细节，对插件仅返回版本化、去敏、结构化 DTO。

### 2.6 测试基础

项目有相邻 Vitest、Rust 单元测试、临时目录/环境变量隔离和 ACP fixture 的实践：

- `src-tauri/src/test_env.rs`
- `src-tauri/src/test-fixtures/acp/README.md`
- `src-tauri/src/acp_capabilities.rs:425-557`
- `src/lib/tauri-api.test.ts`

这可扩展为 package fixture、恶意输入测试、状态机测试、Host API conformance 和 runtime isolation 测试。现有浏览器 mock 能验证 UI 契约，但不能验证真实 Tauri IPC、子进程终止、OS secret store、网络限制或 Wasm resource limit。

---

## 3. 必须冻结的安全与架构边界

### 3.1 插件不得在主 WebView 或主 Tauri 进程中执行

主窗口当前拥有 Tauri bridge 以及 `path`、`event`、`window`、`webview`、`resources`、`notification` 等能力：

- `src-tauri/tauri.conf.json:28-56`
- `src-tauri/capabilities/default.json:5-43`
- `src/lib/tauri-api.ts:85-92`

因此以下方案都不满足草案的无环境权限原则：

- 在主页面使用 `import(pluginUrl)`；
- 使用 `<script>`、动态 import 或任意 React context 执行插件；
- 在同一 Tauri WebView 中执行 Web Worker；
- 在 Tauri 主进程内嵌入不可信 JS engine 并把它当作 crash isolation。

主 WebView 的 CSP 只能限制页面网络和资源来源，不会形成按插件、按授权、按 API 的能力边界。插件一旦进入该页面上下文，可能接触 Tauri internals、页面对象、浏览器网络 API 或已有应用代码。

**推荐硬决策：一个已启用插件对应一个 Desktop 创建的 `plugin-host` OS 子进程。**

- Desktop 主进程是唯一拥有 Tauri、ACP、网络、存储、密钥、原生通知和审计权限的实体；
- plugin-host 不初始化 Tauri，不监听网络端口，不接收 capability token 命令行参数；
- Core 与 host 通过私有 stdio/pipe RPC 通信，协议带版本、request ID、实例身份、最大帧长、deadline、背压和取消语义；
- 回调超时或 host 异常时，Core 停止事件分发、撤销该实例的 handles，随后 kill host；
- 插件 host 崩溃、死循环或资源超限只能影响该插件实例，不应影响主窗口、ACP worker 或其他插件。

独立进程是应用稳定性隔离，不自动等价于 OS 级安全沙箱。如果 v1 将任意 Git 插件视为恶意代码，还需独立评估 Windows restricted token/AppContainer 与 macOS sandbox/entitlements；不能把 QuickJS heap 限制误述为完整 OS memory sandbox。

### 3.2 Host API 必须是新 broker，不能复用现有 IPC 或 wire

现有 `wire_send` 接收任意 JSON 字符串，可间接处理 prompt、cancel、permission mode、config option 和 permission response：

- `src-tauri/src/commands.rs:153-161`
- `src-tauri/src/acp.rs:838-943`

现有 `wire:message` 是全局广播；虽然已做 ACP-to-frontend 语义翻译，仍携带 assistant text、thinking、tool arguments/results、display payload 与审批信息：

- `src-tauri/src/wire_events.rs:4-49`
- `src-tauri/src/acp_translate.rs:319-488`
- `src-tauri/src/acp_translate.rs:1319-1355`

这些都是主 UI 的受信任通信面，不是插件隔离 API。Desktop Plugin Host 不得取得：

- `wire_*` Tauri commands、wire JSON 或 worker connection ID；
- `AcpDesktopClient::request()` 或其他原始 ACP 请求能力；
- Tauri `invoke`、AppHandle、WebView event name；
- Kimi 配置、MCP 配置、会话工作区文件 API 或 OAuth credentials。

应单独创建 native `PluginSessionBroker`、`PluginNetworkBroker`、`PluginStorageBroker`、`PluginSecretBroker` 和 `PluginAuditSink`。每个调用都根据 Core 保存的 `{pluginId, immutableVersionKey, activationNonce, grantSnapshot}` 校验；不得信任 guest 自报的 plugin ID、权限或路径。

### 3.3 Desktop Plugin 数据根必须与 CLI Plugin 完全隔离

现有代码会在 `$KIMI_CODE_HOME/plugins/managed`、`installed.json` 以及 CLI manifest 中发现 Kimi Code CLI plugin/skill/agent 信息：

- `src-tauri/src/skills.rs:49-97`
- `src-tauri/src/session_influence.rs:128-240`
- `src/lib/session-influence.ts:3-25`

所以草案中的 `<desktop-data>/plugins` 不能解释为 `~/.kimi-code/plugins`，也不能挂入现有 skill/session influence discovery root。

建议固定为 Tauri OS app-data 下的专用目录，例如：

```text
<tauri-app-data>/desktop-plugin-system/v1/plugins/<plugin-id>/
```

它应通过 `AppHandle` 的 path API 解析，测试通过显式临时根注入，不能复用 `KIMI_CODE_HOME`。产品文案应始终使用「Desktop 插件」，而非复用 Workspace 中表示 CLI plugin 的「Plugins」类型和状态。

---

## 4. 安装、版本和持久化的审查结论

### 4.1 v1 应先支持本地目录复制导入

当前 `security.rs` 只覆盖单个绝对路径、外部浏览器 URL 和可执行路径，不能验证一个不可信目录树：

- `src-tauri/src/security.rs:6-148`

其 URL 校验仅检查 scheme/host 存在性，测试明确允许 `http://127.0.0.1`：

- `src-tauri/src/security.rs:241-245`

它不适用于插件 package 的以下要求：

- manifest 路径的 POSIX-only 规范；
- `..`、绝对路径、反斜杠、URL entry 的拒绝；
- symbolic link、junction/reparse point、FIFO、socket、设备文件、目录循环和硬链接策略；
- 文件数、深度、总大小、单文件大小、超长路径、Unicode/case collision；
- 校验和复制之间的 TOCTOU 防护；
- content hash、hash manifest 和运行前完整性复核。

应实现专用 `plugin_package` 层，不能把这些特殊语义塞入通用 `security.rs`。

推荐最小导入流程：

```text
source directory (untrusted)
  -> staging/<transaction-id>
  -> secure walk + strict manifest validation + hash
  -> immutable versions/<semver>--<hash-prefix>/ snapshot
  -> write version provenance/requested permissions
  -> atomically update selected/active pointer
  -> recovery/cleanup journal
```

导入只物化经过 allowlist 校验的包内容；不执行源目录的 `package.json`、shell、PowerShell、Makefile、Cargo 或 Git hooks。对于 JavaScript，安装期最多做 parse-only/静态 export 检查；不能为了确认 `activate` 而 evaluate 模块，因为顶层代码本身就是执行。

### 4.2 版本目录键和权限绑定需要修订

草案中 `<version-or-commit>` 无法区分「相同 id + version、不同内容 hash」的本地导入。建议目录键采用：

```text
<semver>--<content-hash-prefix>
```

完整 hash、manifest snapshot、来源、固定 commit 与请求权限应保存在每个 immutable version 中。根目录的 `current.json` 只记录已选择/已激活版本指针；运行状态、last error、crash count 和日志游标应拆出，以免频繁更新破坏 rollback point。

根级 `permissions.json` 还需要明确绑定语义：grants 必须绑定 plugin ID、version key、内容 hash 和 capability scope。更新扩大权限时，新版本应保持 `awaiting-permission`，旧 active version 不变；获得新确认并通过 activation health check 后才切换 active pointer。

「versions 只读」只是降低误操作，不是安全边界。同一 OS 用户仍可篡改文件；每次 activation 前必须重验树/hash，发现不一致就 `quarantined`。

### 4.3 Git 安装要后置，SSH 更要后置

当前唯一 Git 操作是对已选工作区执行受控的只读 diff：

- `src-tauri/src/git_diff.rs:117-160`

它不能演变为安全 Git importer。clone/fetch 的额外攻击面包括 Git config、hooks、filter、credential helper、remote helper、submodule、LFS、SSH agent、known_hosts、URL userinfo 和环境继承。

建议：

1. 第一阶段只做本地副本导入；
2. 第二阶段仅加入固定 commit 的 HTTPS Git import；
3. 所有 Git 来源先在 app-data staging 内解析和固定完整 SHA，再交给与本地来源相同的 package validator；
4. 禁止 install script、hook、submodule、LFS、未固定移动 branch 的静默更新和 URL 中的密码/token；
5. SSH 在 host-key、agent、私有仓库凭据、日志脱敏和真实集成测试都冻结后单独加入。

---

## 5. 运行时路线判断

### 5.1 JavaScript runtime

当前 `src-tauri/Cargo.toml` 没有 JS engine、独立 host binary、WebSocket client、OS keyring 或 Wasm Component runtime：

- `src-tauri/Cargo.toml:15-67`

前端 `package.json` 的 ESM 设置与 React/Vite 依赖也不构成插件 JS runtime：

- `package.json:7`
- `package.json:45-92`

建议以 rquickjs/QuickJS 为 plugin-host 内的候选引擎，而不是在主进程使用 Deno/V8/QuickJS。选择前需要技术 spike 验证：

- 受控 ESM loader 是否能仅加载已校验的 `dist/plugin.mjs`；
- v1 是否明确为「单 `.mjs` 文件，拒绝所有 static/dynamic import」；
- ES2022、top-level await、Promise/microtask 的实际支持范围；
- `activate`、`deactivate` 和事件回调的 wall-clock deadline；
- JS heap、stack、interrupt handler 与父进程 kill 的联动；
- `eval`、`Function`、派生 constructor 的可验证限制，或将承诺降为「动态代码不获得更多能力」；
- 无限循环、无限 microtask、拒绝 Promise、panic/exit、超大 IPC 后主 Desktop 的存活。

不能通过删除全局变量就声称完全禁止 `eval` 或 `new Function`。若产品要作语法级禁止承诺，需要 parse/AST 策略和逃逸测试；否则应只承诺没有动态模块/外部代码加载和无 ambient capability。

### 5.2 Wasm Component runtime

WebAssembly Component Model/WIT 与 Wasmtime 的 Component linker、fuel、epoch interruption、Store limits 能构成合理的后续 sandbox 基础；但当前 lockfile 中的 WIT/WASI 条目只是传递依赖，项目没有可执行 Component runtime。

建议 Wasm 后置，并先收缩草案：

- 先使用同步、短调用、host-owned async task + 有界事件队列；不允许后台任务 reentrant 地调用同一 Wasmtime store；
- 每次 guest call 设置 fuel 和 epoch deadline，Host I/O 自行设 cancellation/deadline；fuel/epoch 无法中断阻塞的 host call；
- `StoreLimits` 仅限制 guest resource，64 MiB 应明确是 linear-memory/guest budget，不是 plugin-host 的完整 RSS；如需 64 MiB 总 guest memory，应同时限制 memory 数量；
- Component 静态检查、link-time allowlist 和 call-time grant check 必须三层同时存在；
- 不注册 WASI filesystem/socket/CLI；需要明确 v1 是零 `wasi:*` ambient import，还是一个经 fixture 验证的精确 WASI 0.2 profile；
- 「源语言不受限制」应改为「任何生成合规 Component 的语言都可导入；v1 只保证已由 CI fixture 覆盖的工具链」。

草案当前的全量 `world guest` 同时 import `host-network`、`host-sessions`、`host-oauth` 等接口也需要重做。WIT import 是强制链接要求，和按权限按需提供 capability 有冲突。应按最小 product profile 定义多个 world，例如：

```text
lifecycle-storage-v1
usage-provider-v1
status-provider-v1
remote-control-v1
```

JavaScript SDK 与 WIT bindings 应共享 Host Protocol 的权限、错误、对象 ID、审计和事件语义，并运行同一组 conformance fixture；不应承诺两者有完全相同的对象模型、异步形式或一个简单 `apiVersion` 就可覆盖的兼容性。

---

## 6. Host API 的必要收缩

### 6.1 网络

插件网络不能复用 `validate_http_external_url`、`open_external` 或现有 `ureq` usage/OAuth 调用。需要独立 `PluginNetworkBroker`：

- 精确授权 scheme + hostname + port；
- 默认仅 HTTPS/WSS，拒绝 URL userinfo、IP literal、localhost、loopback、link-local、RFC1918/ULA/CGNAT/metadata ranges；
- DNS 解析后和每次实际连接时重查，防 DNS rebinding；
- 关闭自动 redirect 或对每一跳重新授权；
- 强制 header allowlist，默认过滤 `Authorization`、Cookie、Proxy-*、Kimi/ACP 相关 header；
- 限制连接数、并发、频率、请求/响应字节、redirect、超时和 event queue；
- WebSocket/长连接由 Core 保存 opaque handle，在停用、升级、host crash 或 quarantine 时无条件关闭。

WSS 不应作为第一个插件 runtime 的验收能力。应先实现受限 HTTPS `fetch`，证明 DNS、TLS、cancel、redaction 和 backpressure 后再考虑连接型协议。

### 6.2 Storage、secrets 与 OAuth

普通 `host.storage` 可先只允许插件私有 state，限制 key/value/总量/写频率，并由 Host 进行原子写入。它不能读写 package version 目录、其他插件目录、Kimi home、工作区或任意路径。

现有 Kimi credentials 文件和 device-code flow 是 Kimi 专用，不能泛化：

- `src-tauri/src/managed_usage.rs:96-123`
- `src-tauri/src/oauth_login.rs:55-124`

`secrets.enc` 的实现前提是跨平台的 OS credential-store abstraction、AEAD 格式、per-plugin DEK、key version、轮换、卸载清理、key 丢失、重装和跨机迁移规则。密钥不在插件目录是正确原则；复制目录到新设备应恢复安装状态，但 secret 失效并要求重新登录/授权。

OAuth 应由 Desktop 管理浏览器跳转、PKCE、state、nonce、callback、refresh、revoke 与 token storage。插件应得到状态和 opaque authorization handle，而非 bearer token 明文；带认证的请求由 Host 在 `authorizedFetch` 等受控调用中注入凭据。

### 6.3 Sessions、events 与远程控制

现有 session storage/replay 含有 work directory、session directory、完整 prompt、thinking、tool arguments、tool outputs 和 display payload：

- `src-tauri/src/session_store.rs:271-300`
- `src-tauri/src/session_store.rs:711-811`
- `src-tauri/src/session_store.rs:963-1048`

因此不能将现有 replay 包装为 `sessions.read`。推荐将 API 拆分为：

- `sessions.list`：仅获授权的 `id`、受控标题、更新时间、状态；默认无路径；
- `sessions.readMessages`：分页、长度受限、仅用户/assistant 可见文本投影；默认排除 thinking、tool data、display、附件和绝对路径；
- `sessions.sendText`：仅 UTF-8 文本、严格字节限制、单 session 并发规则；
- `events.subscribe`：仅 allowlist 的 versioned DTO，例如 `session.state`、`turn.state`、`approval.local_required`；未知事件不可套用 UI generic fallback 原样转发。

草案中的通用 `sessions.cancel` 不能直接实现。ACP cancel 只有 session 范围，不包含 prompt origin：

- `src-tauri/src/acp.rs:2513-2556`
- `src-tauri/src/acp.rs:2297-2320`

直接授权远端可能取消本地用户正在执行的 turn。应先增加 prompt origin、plugin operation ID 和 worker generation，之后最多提供 `cancelOwnedTurn`。

远控 send/cancel 的确认必须独立于当前 ACP `manual/auto/yolo` mode。一个安全的最小流程是：

```text
plugin request
  -> Core validates grant and session scope
  -> Core creates one-time, short-lived operation
  -> Desktop native UI asks local user
  -> Core executes or rejects
  -> redacted audit record
```

确认 ticket 应绑定 plugin ID、version/hash、设备/connection identity、session ID、payload digest 和到期时间。ACP agent 产生的 tool approval 永远只由本地 Desktop 处理；插件只能收到去敏的「等待本地审批」状态和结果。

### 6.4 Notifications、status 和 settings schema

当前浏览器通知路径和 native notification 都不具备插件 permission、频率、长度或审计边界：

- `src/lib/tauri-api.ts:854-869`
- `src-tauri/src/notify.rs:4-50`

插件通知应由 Host 控制，避免 token、远端输入、session title 或 OAuth 错误泄露至锁屏界面。

`settingsSchema` 必须在实现前冻结为严格、有限的原生字段语言，如 `string`、`number`、`boolean`、`select`、`secret`；还需规定字段数量、文本长度、键命名、枚举、默认值、验证、迁移、secret readback、i18n 资源及错误形状。不能将 manifest 映射成任意 React props、HTML/CSS 或动态逻辑。

插件 health/status 初期应显示在 Settings 插件详情页；现有 session `StatusStrip` 只描述当前 Kimi session 状态，不适合作为全局 plugin status 入口。

---

## 7. 建议的实施顺序

这不是已批准的实施计划，只是风险从低到高的推荐顺序。

### Phase 0：规范和安全 spike

冻结：独立 data root、plugin ID、version key、hash、manifest strict subset、permissions/grants、error codes、audit schema、transaction/recovery 状态机、Host RPC framing、session projection 和 confirmation ticket。

建立 fixture：合法包、路径穿越、symlink/junction、超量、未知 capability、损坏 hash、坏 ABI/component、被篡改 pointer。

以固定内部 fixture 验证独立 plugin-host：死循环、内存增长、无限 Promise/microtask、超大 IPC、异常退出和强杀后主窗口及 ACP session 仍存活。未通过前，不开始可执行插件功能。

### Phase 1A：本地复制导入的静态 package manager

仅支持 local directory copy-to-staging，完全不执行 JS/Wasm。支持 list、inspect、remove、selected-version rollback、损坏恢复和生命周期状态展示。

UI 显示 `invalid-package`、`awaiting-permission`、`installed-disabled`、`runtime-unavailable`、`quarantined`；无 runtime 时不显示 `active`，避免「启用」语义与「尚不执行代码」矛盾。

### Phase 1B：固定 commit 的 HTTPS Git importer

在 1A 的 validator、snapshot 和 recovery 足够稳定后再添加。Git 只是 package source，最终仍经过完全相同的静态校验。SSH、自动更新、签名和企业 allowlist 后置。

### Phase 2：一个隔离 runtime 的最小能力闭环

优先评估 JavaScript `plugin-host` + QuickJS/rquickjs。首批只开放：

- `host.log`：结构化、自动去敏、限频和日志配额；
- `host.storage`：私有、配额化、无任意路径；
- `host.settings`：受限原生 schema；
- 通过独立 SSRF policy 后的单次 HTTPS `network.fetch`。

此阶段不开放 secrets、OAuth、WSS、notifications、sessions 或 events。先证明 runtime isolation、stop/restart、quarantine、handle revocation、资源限制和 deny-by-default。

### Phase 3：Wasm Component 或第二 runtime

只在 broker 和 runtime-neutral conformance suite 已稳定后引入 Wasm。以最小 WIT profile、Component linker allowlist、fuel/epoch、Store limits 和同一审计/权限语义验证，不与远控耦合。

### Phase 4：Usage、OAuth 和远控分别推进

先做标准化 usage provider；OAuth 使用 Host-owned token lifecycle；远控依次开放脱敏只读 metadata/event、每次确认的 `sendText`、具备 origin tracking 后的 `cancelOwnedTurn`。WSS/relay transport 只在 Core 已拥有网络 handle、backpressure 和可靠清理模型后加入。

---

## 8. 测试、发布与真实验收门槛

每个 API 至少覆盖：未声明、已声明未授权、scope 不匹配、已授权。未知 permission/contribution/runtime 字段必须 fail closed，而非静默忽略后尝试运行。

必须新增以下验证：

- package parser/path/origin/state transition 的 adversarial fixture 与 property/fuzz tests；
- staging 中断、`current.json`/grant 损坏、升级失败、崩溃循环和应用重启恢复；
- runtime 的循环、内存、超时、IPC、host crash、upgrade/deactivate cleanup 和 event backpressure；
- SSRF、redirect、DNS rebinding、header/body/token redaction；
- session broker 的范围控制、确认 ticket、busy、origin-owned cancellation 和 ACP approval 不可委派；
- JS/Wasm runtime-neutral conformance trace；
- Windows 与 macOS ARM 上真实 Tauri 构建的 import、activation、kill/restart、rollback、日志/通知隐私验收。

当前 CI 已有前端与 Rust 基础检查，但插件安全模块还需要专属 test target，并在 Windows/macOS 都运行。浏览器 mock 或 TypeScript build 不能替代真实 Tauri/子进程/secret store 验收。

如果 Desktop 将执行第三方代码，发布物的签名、notarization、依赖审计、SBOM/provenance 也应从「尽力而为」升级为明确的产品安全前提；不应让未签名/临时回退的 host 承载强隔离承诺。

---

## 9. 与当前并行工作区改动的关系

当前工作区已有 `src/app/app.tsx`、`src/modules/settings/settings-dialog.tsx`、global config、session-stream/orchestrator、conversation view 等未提交并行改动。后续 plugin 工作必须避免：

- 在 `app.tsx` 或 session-stream 热点中临时塞入 plugin lifecycle；
- 将插件配置混入 `useGlobalConfig`、`config.toml` 或 `kimi:config-update`，从而无关地影响 ACP worker；
- 复用 `session_influence` 的 CLI plugin 类型、文案或启用状态；
- 在现有 Settings 单文件中实现整个插件产品，而不是新增独立模块后做最小 tab 挂载。

代码存在、自动化测试通过、真实桌面验收通过必须持续作为三种不同状态报告。

---

## 10. 最终建议

- **近期可交付目标：** 独立 data root 下的本地目录静态导入、严格校验、不可变版本快照、恢复/回滚和 Desktop 插件管理 UI；不执行任何第三方代码。
- **执行 runtime 的前提：** 先通过一插件一 host 进程的隔离 spike；主进程持有所有能力；Host API 按 capability broker 逐个开放。
- **Wasm：** 是合理的后续 runtime，不应与 JS、Git、OAuth、WSS、远控同时作为首发承诺。
- **远控：** 能做，但需要全新的结构化 session broker、确认、origin tracking、审计和网络 handle 模型；不得映射现有 `wire_*` 或 ACP surface。
- **草案状态：** 在独立 data root、runtime isolation、WIT profile、secret strategy、Git security、remote confirmation 等问题冻结并经过 spike 前，应保持 DRAFT。
