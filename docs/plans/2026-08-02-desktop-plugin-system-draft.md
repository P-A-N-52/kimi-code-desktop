# Desktop Plugin System / Package Format v1 草案

| 项目 | 内容 |
| --- | --- |
| 状态 | **DRAFT / 待讨论，不代表已批准实现** |
| 日期 | 2026-08-02 |
| 范围 | Desktop 自有插件宿主、包格式、运行时、权限、安装与持久化约定 |
| 实现状态 | 尚未开始；本文仅定义方案草案 |

---

## 1. 已确认决策

1. 本系统是 **Desktop Plugin System**，不是 Kimi Code CLI 的 Plugin、Skill 或 MCP 插件机制。
2. 远程控制的连接协议、服务端形态和传输实现归插件负责；Desktop 只开放稳定、受控的宿主接口。
3. 插件允许执行代码，但不能默认获得 Desktop、Tauri、ACP、文件系统或操作系统的完整权限。
4. 第一阶段优先支持两种安装来源：
   - Git 仓库或 Git 仓库子目录；
   - 本地插件文件夹。
5. 插件的安装来源、版本、授权、配置、状态和审计信息必须保存在该插件自己的安装目录中。
6. 插件运行时分为两种：
   - 标准 JavaScript 插件；
   - WebAssembly Component 插件。
7. 两种运行时共享同一份 manifest、权限模型和 Host API，不形成两套产品能力。

## 2. 目标与非目标

### 2.1 目标

- 支持远程控制、第三方用量表、OAuth 登录和以后新增的挂载能力。
- 允许插件订阅 Desktop 事件，并通过受控接口调用会话、网络、存储和认证能力。
- 插件崩溃、死循环或异常退出不能导致 Desktop 主进程和主 WebView 一同崩溃。
- 插件升级后可以确认实际 Git commit、校验产物，并在失败时回滚。
- 插件目录可以独立检查、备份、迁移或删除，不依赖不可恢复的全局注册表。
- 未识别的新 manifest 字段和 Host 事件应可安全忽略或提供通用错误，不静默扩大权限。

### 2.2 非目标

- 不修改 Kimi Code CLI 的插件、Skill、MCP 或 ACP 协议。
- 不允许插件直接访问 `~/.kimi-code`、Kimi 登录凭据或 ACP 原始 wire。
- v1 不支持把任意 React 组件、CSS 或脚本注入 Desktop 主界面 DOM。
- v1 不支持 Node 原生扩展、动态链接库、FFI 或插件自行启动任意子进程。
- v1 不建设公共插件市场；Git 和本地目录是优先分发方式。
- 安装阶段不执行来自插件的构建、安装或生命周期脚本。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| Plugin Package | Git 仓库或本地目录提供的可分发插件包 |
| Installed Plugin | 已导入 Desktop 数据目录、可被启用的插件实例 |
| Plugin Host | 管理运行时、生命周期、权限、资源限制和 Host API 的 Desktop 组件 |
| Capability | Desktop 显式开放给插件的一项受控能力 |
| Requested Permissions | `plugin.json` 声明希望申请的权限 |
| Granted Permissions | 用户或管理员实际授予的权限，保存在插件安装目录 |
| Runtime Artifact | Desktop 真正加载的 `plugin.mjs` 或 `plugin.wasm` |
| Host API | JavaScript SDK 与 WIT imports 共同表达的版本化宿主接口 |

## 4. 共同运行时规则

JavaScript 和 Wasm 插件均遵守以下不变量：

1. 一个插件版本只能声明一种运行时，不能在 JavaScript 失败后静默回退到 Wasm，反之亦然。
2. 运行产物必须在安装前生成；Desktop 不负责执行 `npm install`、Cargo、Go、C/C++ 或其他构建工具。
3. 插件没有环境权限（ambient authority）；所有外部行为必须通过 Host API。
4. Host API 先检查实际授权，再执行操作；manifest 声明本身不等于授权。
5. 所有跨边界参数必须可验证、可限制大小，并属于版本化协议。
6. 插件不能直接获得 Tauri IPC、React DOM、Rust对象、ACP transport 或 Kimi 凭据。
7. 插件版本目录只读；插件只通过 `host.storage`、`host.secrets` 等接口写入自己的数据区。
8. 插件的后台连接由 Host 持有资源句柄；插件不能绕过 Host 自行打开未授权网络连接。

## 5. 标准 JavaScript 插件

### 5.1 语言和产物

标准插件的运行语言为 JavaScript，唯一可执行产物为：

```text
dist/plugin.mjs
```

具体约束：

- 模块格式：ECMAScript Module（ESM）。
- 初始编译目标：ES2022。
- Desktop 不加载 `.ts`、`.tsx`、`.jsx`、`.cjs` 或 `.node` 文件。
- Desktop 不解析 `package.json` 作为插件入口。
- Desktop 不加载插件自带的 `node_modules`。
- 第三方依赖必须在发布前打包进 `dist/plugin.mjs`。
- TypeScript 可以作为插件作者的开发语言，但分发产物必须是 JavaScript；Desktop 不编译 TypeScript。
- 运行环境不是 Node.js、Bun 或浏览器页面，不承诺兼容其私有 API。

### 5.2 JavaScript 全局环境

初始允许的语言级能力可包括：

- ECMAScript 标准对象；
- `JSON`；
- `URL` / `URLSearchParams`；
- `TextEncoder` / `TextDecoder`；
- 由运行时限制的 Promise 与微任务。

初始不提供：

- `process`、`require`、CommonJS；
- Node/Bun 文件系统和命令执行 API；
- DOM、`window`、`document`、Tauri bridge；
- 原生 `fetch`、`WebSocket`、`EventSource`；
- 任意环境变量访问；
- 任意动态网络 import；
- `eval` 或 `new Function`（是否完全禁用取决于最终 JS Runtime，但规范上不得依赖）。

网络、计时器、随机数、持久化和后台连接统一由 Host API 提供。

### 5.3 JavaScript 入口

`dist/plugin.mjs` 必须至少导出 `activate`：

```js
export async function activate(host) {
  // 注册 contribution、事件处理器和后台连接。
}

export async function deactivate() {
  // 可选；释放插件仍持有的逻辑资源。
}
```

约束：

- `activate` 在每次启用或版本切换时调用一次。
- `deactivate` 必须幂等；超时后 Host 可以直接终止运行时。
- 插件不通过导出对象暴露任意内部对象给 Desktop。
- Host API 由 `activate(host)` 参数注入，不挂载到全局对象。
- 插件注册的事件处理器在停用、卸载或运行时退出时自动注销。

## 6. WebAssembly 插件

### 6.1 语言和产物

Wasm 插件的源语言不受限制，可使用 Rust、Go、C/C++ 或其他支持目标格式的语言，但唯一可执行产物为：

```text
dist/plugin.wasm
```

`plugin.wasm` 必须满足：

- 是 WebAssembly Component Model component；
- 不是裸 Core Wasm Module；
- 实现 Desktop 指定版本的 WIT world；
- v1 暂定锁定 WASI 0.2；
- 不导入未在 allowlist 中的 WASI 或自定义接口；
- 安装时可以从二进制读取并验证 imports/exports。

选择 WASI 0.2 的原因是其 Component Model/WIT 基础稳定且语言工具链覆盖更成熟。WASI 0.3 已提供原生 async，但初始版本不依赖尚未普遍落地的 0.3 编译链。后续可以通过新的 Host API/ABI 大版本增加 0.3 支持。

### 6.2 WIT 边界

v1 由 Desktop 发布固定 WIT package，概念形状如下：

```wit
package desktop:plugin@1.0.0;

world guest {
    import host-log;
    import host-storage;
    import host-secrets;
    import host-network;
    import host-events;
    import host-sessions;
    import host-oauth;
    import host-usage;

    export lifecycle;
    export event-handler;
}
```

正式 WIT 的 package 名、接口拆分和数据类型在实现前另行冻结；一旦发布，同一 major 版本保持向后兼容。

### 6.3 WASI 限制

v1 默认不开放完整的：

- `wasi:cli`；
- `wasi:filesystem`；
- `wasi:sockets`；
- 进程参数和环境变量；
- stdin/stdout/stderr 作为任意数据通道；
- 进程退出或子进程能力。

如需时间、随机数、网络和存储，应使用 Desktop Host API。这样 JavaScript 与 Wasm 插件受到相同的域名、配额、审计和审批约束。

## 7. 可分发插件包结构

### 7.1 JavaScript 包

```text
my-plugin/
├── plugin.json                 # 必需
├── dist/
│   └── plugin.mjs             # 必需且唯一运行入口
├── assets/                     # 可选静态资源
├── locales/                    # 可选本地化资源
├── README.md                   # 推荐
└── LICENSE                     # 推荐
```

### 7.2 Wasm 包

```text
my-plugin/
├── plugin.json                 # 必需
├── dist/
│   └── plugin.wasm            # 必需且唯一运行入口
├── wit/
│   └── world.wit              # 可选，供审查和 SDK 开发使用
├── assets/                     # 可选静态资源
├── locales/                    # 可选本地化资源
├── README.md                   # 推荐
└── LICENSE                     # 推荐
```

### 7.3 包内路径规则

- `plugin.json` 固定在包根目录。
- manifest 中的路径必须使用 `/`、以 `./` 开头并保持在插件根目录内。
- 禁止绝对路径、`..` 路径穿越和 URL 形式的本地入口。
- v1 安装包不接受符号链接；需要共享的文件必须真实包含在插件目录中。
- Host 不执行包内的 `package.json` scripts、Makefile、PowerShell、Shell 或其他安装脚本。
- Host 只加载 manifest 声明且通过校验的文件，不自动扫描执行其他 `.js` 或 `.wasm` 文件。
- Git 仓库可以保留 `src/`、测试和构建文件，但 Desktop 运行时只认 `plugin.json` 和预生成的 `dist/` 产物。

## 8. `plugin.json`

### 8.1 JavaScript 示例

```json
{
  "manifestVersion": 1,
  "id": "com.vendor.remote-control",
  "name": "Vendor Remote Control",
  "version": "1.0.0",
  "description": "Connect Desktop sessions to Vendor Relay.",
  "runtime": {
    "type": "javascript",
    "entry": "./dist/plugin.mjs",
    "apiVersion": "1.0"
  },
  "permissions": {
    "network": {
      "connect": [
        "https://api.vendor.example",
        "wss://relay.vendor.example"
      ]
    },
    "sessions": ["list", "read", "send", "cancel"],
    "storage": {
      "maxBytes": 16777216
    },
    "notifications": ["show"]
  },
  "contributes": {
    "remoteControl": [
      {
        "id": "vendor-relay",
        "displayName": "Vendor Relay"
      }
    ]
  }
}
```

### 8.2 Wasm 示例

```json
{
  "manifestVersion": 1,
  "id": "com.vendor.usage-meter",
  "name": "Vendor Usage Meter",
  "version": "1.0.0",
  "description": "Read and publish Vendor quota information.",
  "runtime": {
    "type": "wasm",
    "entry": "./dist/plugin.wasm",
    "apiVersion": "1.0",
    "componentModel": true,
    "wasi": "0.2"
  },
  "permissions": {
    "network": {
      "connect": ["https://api.vendor.example"]
    },
    "oauth": ["begin", "refresh"],
    "usage": ["publish"],
    "storage": {
      "maxBytes": 8388608
    }
  },
  "contributes": {
    "usageProvider": [
      {
        "id": "vendor-quota",
        "displayName": "Vendor Quota"
      }
    ]
  }
}
```

### 8.3 核心字段

| 字段 | 要求 |
| --- | --- |
| `manifestVersion` | 必需；当前为整数 `1` |
| `id` | 必需；稳定、全局唯一，建议反向域名格式；安装后不可变 |
| `name` | 必需；用户可见名称 |
| `version` | 必需；SemVer |
| `description` | 必需；简短说明插件目的 |
| `runtime.type` | 必需；仅 `javascript` 或 `wasm` |
| `runtime.entry` | 必需；必须指向规定格式的 `dist` 产物 |
| `runtime.apiVersion` | 必需；声明 Host API major/minor |
| `permissions` | 可选；仅声明申请范围，不代表已经授权 |
| `contributes` | 可选；声明插件向 Desktop 挂载的能力 |

### 8.4 初始 contribution 类型

| Contribution | 用途 |
| --- | --- |
| `remoteControl` | 远程会话控制 transport/provider |
| `usageProvider` | 第三方用量、额度和刷新时间提供方 |
| `authProvider` | OAuth、device code 或其他登录提供方 |
| `statusProvider` | 状态栏或设置页的结构化状态来源 |
| `settingsSchema` | 由 Desktop 原生渲染的声明式插件设置 |

v1 不接受任意 HTML/React UI contribution。需要 UI 时先使用 Desktop 渲染的 schema；独立受限 WebView 可在后续版本单独设计。

## 9. 安装后目录

Git 安装和本地文件夹导入最终都规范化为同一种结构：

```text
<desktop-data>/plugins/<plugin-id>/
├── install.json               # 来源、Git ref/commit、校验值、安装时间
├── current.json               # 当前启用版本和运行时状态
├── permissions.json           # 实际授权，不等同于 manifest 申请
├── config.json                # 用户可编辑配置
├── secrets.enc                # 插件凭据密文
├── state/                     # 插件持久状态
├── logs/                      # 插件独立日志和审计摘要
└── versions/
    ├── <version-or-commit-a>/
    │   ├── plugin.json
    │   ├── dist/
    │   │   └── plugin.mjs
    │   └── assets/
    └── <version-or-commit-b>/
        ├── plugin.json
        ├── dist/
        │   └── plugin.wasm
        └── assets/
```

目录约束：

- `<plugin-id>/` 是该插件的完整事实来源。
- Desktop 启动时扫描插件目录恢复安装状态；不依赖另一个不可恢复的全局 registry。
- 可以生成全局索引以加速启动，但索引必须可从各插件目录完全重建。
- `versions/` 下的安装产物只读。
- `state/`、`config.json`、`permissions.json` 和 `secrets.enc` 只能通过 Host 管理。
- `logs/` 应有大小和保留时间上限。
- 卸载插件时可以整体删除该插件目录；删除前应提示是否导出配置或保留数据。

### 9.1 凭据例外

OAuth token、refresh token 或 API key 的密文和元数据保存在 `secrets.enc`，满足“插件信息位于插件目录”。

加密密钥不得与密文存放在同一目录。密钥由 Windows Credential Manager 或其他操作系统凭据库保护，并以插件 ID 作为索引。否则复制插件目录就等价于复制明文凭据。

## 10. 安装来源

### 10.1 Git 安装

初始支持：

- HTTPS Git URL；
- SSH Git URL；
- 可选 branch/tag/ref；
- 可选准确 commit SHA；
- 可选仓库内插件子目录。

安装流程：

```text
解析来源
  -> clone/fetch 到 staging
  -> 解析并固定 commit SHA
  -> 定位插件包或子目录
  -> 校验路径与包大小
  -> 校验 plugin.json
  -> 校验 JavaScript 或 Wasm 产物
  -> 计算内容摘要
  -> 展示权限申请
  -> 写入插件目录的新 versions/<id>
  -> 原子切换 current.json
```

禁止：

- 安装时运行仓库中的脚本；
- 默认追踪未经固定的移动分支并静默自动更新；
- Git 更新后直接覆盖当前可运行版本；
- 凭据出现在 Git URL、manifest 或日志中。

### 10.2 本地文件夹安装

用户选择或放入一个符合第 7 节结构的插件目录。Desktop 对其执行与 Git 安装相同的校验，然后复制为版本快照。

- 默认是“导入副本”，不直接运行原目录中的文件。
- 开发期 live directory 模式如有需要应单独设计，并明确标为不安全开发能力。
- 再次导入同一插件时，根据 `id + version + content hash` 判断新增版本或重复版本。

## 11. 权限模型

### 11.1 声明与授权分离

```text
plugin.json permissions         插件申请什么
        ↓ 用户/管理员确认
permissions.json               实际允许什么
        ↓ 每次 Host API 调用
Capability Broker              运行时强制检查
```

规则：

- 未声明的权限不能在运行时临时获取。
- 已声明但未授予的权限调用必须失败并返回结构化错误。
- 插件升级新增或扩大权限时，保持旧版本运行或暂停新版本，等待重新确认。
- 权限缩小时可以自动接受，但应更新审计记录。
- 禁止使用一个宽泛的 `fullAccess` 代替细粒度权限。

### 11.2 初始权限域

| 权限域 | 示例 |
| --- | --- |
| `network` | 允许的 HTTPS/WSS origin、是否允许本地地址 |
| `sessions` | `list`、`read`、`send`、`cancel` |
| `events` | 可订阅的 Desktop 事件类型 |
| `storage` | 私有存储配额 |
| `secrets` | 以命名 handle 读取/更新插件自己的凭据 |
| `oauth` | `begin`、`callback`、`refresh`、`revoke` |
| `usage` | 发布标准化额度快照 |
| `notifications` | 显示本地通知 |
| `settings` | 读取插件自己的声明式设置 |

v1 明确不提供：

- 任意 shell/subprocess；
- 任意本地文件路径读写；
- FFI 或动态库；
- 读取其他插件目录；
- 读取 Kimi Code 配置或凭据；
- 发送原始 ACP 请求；
- 调用未列入 Plugin Host 的 Tauri command。

## 12. Host API 初始分组

JavaScript SDK 和 WIT imports 应从同一份接口定义生成或保持逐项对应。

```text
host.log
host.storage
host.secrets
host.network
host.events
host.sessions
host.oauth
host.usage
host.notifications
host.settings
```

### 12.1 远程控制最小接口

远程控制插件自行实现 relay、WebSocket、轮询或其他协议。Desktop 只开放：

```text
sessions.list
sessions.read
sessions.send
sessions.cancel
events.subscribe
network.fetch
network.connect
notifications.show
```

必须保证：

- 远端输入先由插件协议解析，再转换为结构化 Host 调用。
- Host 独立校验会话是否存在、操作是否授权、是否需要本地确认。
- 不把 ACP 原始消息、内部 connection ID 或 Kimi 凭据暴露给插件或远端。
- 高风险远程操作留下插件 ID、会话 ID、动作、时间和结果审计记录。
- 远程控制断开后，Desktop 本地会话仍保持可控和可取消。

### 12.2 OAuth 最小接口

OAuth 应尽可能由 Host 管理浏览器跳转、PKCE、state、nonce、callback 校验、token refresh 和凭据加密。插件提供 provider 配置和协议适配，不直接获得操作系统凭据库访问权限。

### 12.3 用量表最小接口

插件把厂商响应转换为统一额度快照，例如：

```text
providerId
label
periodStart
periodEnd
used
limit
remaining
unit
updatedAt
status
```

Desktop 决定如何展示；插件不能直接注入额度 UI。

## 13. 生命周期

```text
discovered
  -> validating
  -> awaiting-permission
  -> installed-disabled
  -> activating
  -> active
  -> deactivating
  -> disabled
```

异常状态：

```text
invalid-package
incompatible-api
permission-denied
activation-failed
crashed
resource-exhausted
quarantined
```

规则：

- 新安装插件默认先完成权限确认，再允许启用。
- 连续崩溃或资源超限的插件自动停用并进入隔离状态。
- Desktop 启动不等待所有插件完成联网或后台初始化。
- 插件激活失败不能阻止 Desktop 或其他插件启动。
- 版本更新先验证新版本，激活成功后再完成切换；失败时回到旧版本。

## 14. 资源限制（初始建议值，待基准测试）

| 项目 | JavaScript | Wasm |
| --- | --- | --- |
| 单产物大小 | 10 MiB | 32 MiB |
| 单插件包大小 | 50 MiB | 50 MiB |
| 运行内存 | 64 MiB | 64 MiB linear memory |
| 单次事件输入 | 1 MiB | 1 MiB |
| 单次事件输出 | 1 MiB | 1 MiB |
| 单个同步回调 | 100 ms CPU slice | fuel + epoch interruption |
| 普通异步操作 | 5 s，特定 Host handle 除外 | 5 s，特定 Host handle 除外 |
| 默认存储配额 | 16 MiB | 16 MiB |

长连接不通过一个永不返回的插件函数维持。`host.network.connect` 返回受控 handle，网络事件由 Host 回调插件，因此仍可限制每次插件执行时间。

## 15. 安装与运行校验

### 15.1 公共校验

- `plugin.json` 是合法 UTF-8 JSON。
- `manifestVersion`、`id`、`version`、runtime 和 entry 合法。
- 插件 ID 与安装目录、历史安装身份一致。
- 所有引用路径均位于包根目录。
- 不存在符号链接、设备文件或路径穿越。
- 文件数量、单文件大小和总包大小未超限。
- 申请的权限和 contribution 均为 Host 已知类型。
- 计算并保存安装内容哈希。

### 15.2 JavaScript 校验

- 入口固定为 `.mjs`。
- 模块可以被目标 JS Runtime 解析。
- 导出 `activate`，可选导出 `deactivate`。
- 不存在无法解析的外部 package import。
- 不依赖安装期生成的文件。

### 15.3 Wasm 校验

- 二进制是合法 Component Model component。
- WIT world、Host API major 和 WASI 版本受支持。
- imports 是 Host allowlist 的子集。
- exports 满足生命周期和事件接口。
- 内存声明和表大小未超限。
- 不包含禁止的 WASI filesystem/socket/CLI imports。

## 16. 安全与信任

- Git URL、ref、commit SHA、内容哈希和安装时间写入 `install.json`。
- 插件内容发生变化但版本号未变化时仍视为新内容，重新记录哈希。
- 扩大权限、变更来源或变更发布者身份时重新确认。
- 未来可以增加签名，但 v1 不能把“来自 Git”当成安全证明。
- 网络权限按 origin/host 范围授权，默认禁止 localhost、私网和任意域名通配。
- Host 对请求设置超时、响应大小限制、重定向限制和敏感 header 过滤。
- 插件日志不得自动记录 token、authorization header、OAuth code 或完整用户 prompt。
- Native process、Node full access、FFI 和 shell 属于未来的高信任运行时讨论，不伪装成普通 JavaScript/Wasm 权限。

## 17. 兼容与版本

- `manifestVersion` 控制包描述格式。
- `runtime.apiVersion` 控制 Host API/WIT ABI。
- Host API 使用 major/minor：
  - 相同 major 下新增可选接口保持兼容；
  - 删除、改名或改变语义必须升级 major；
  - 插件声明不受支持的 major 时拒绝激活。
- JavaScript SDK 与 WIT package 使用相同 API 版本号。
- Desktop 应提供“当前支持的 manifest 和 Host API 版本”查询能力。

## 18. 建议实施阶段

### Phase 0：冻结规范

- 冻结 `plugin.json` v1 schema。
- 冻结目录结构和安装状态文件。
- 冻结 capability 命名和权限扩展规则。
- 冻结 JavaScript lifecycle 与 WIT world。

### Phase 1：包管理和只读发现

- Git/目录导入；
- manifest、路径和产物校验；
- 插件目录扫描；
- 安装、启用、停用、卸载、更新和回滚状态；
- 尚不执行插件代码。

### Phase 2：JavaScript Runtime

- 独立、可终止的 JS Runtime；
- Host API v1；
- 权限、网络、存储、日志和资源限制；
- 首个 usage/auth provider 验证。

### Phase 3：Wasm Runtime

- Component Model/WASI 0.2；
- WIT bindings；
- import allowlist、fuel、memory 和 interruption；
- 与 JavaScript 插件运行相同的 conformance tests。

### Phase 4：远程控制接口

- 会话只读事件订阅；
- 结构化 send/cancel；
- 本地确认和审计；
- 通过插件验证一种远程 transport，不把具体协议写入 Desktop core。

## 19. 待确认问题

以下问题在实现前仍需单独确认：

1. JavaScript Runtime 采用哪种可隔离、可中断实现，以及是否单独运行在 `plugin-host` 进程。
2. JavaScript 是否完全禁用 `eval` / `new Function`，还是只通过 CSP/Runtime capability 禁止外部加载。
3. WIT package 的最终命名和 v1 数据类型。
4. 本地文件夹安装是否只支持“复制导入”，还是增加显式开发模式的 live directory。
5. 第三方插件是否默认关闭自动更新，以及 UI 如何显示 Git ref 与 commit 差异。
6. 插件签名、发布者身份和企业来源白名单是否进入 v1。
7. `secrets.enc` 的加密格式、轮换和跨机器迁移策略。
8. 远控中的 `sessions.send`、`sessions.cancel` 是否每次确认，或允许按插件/设备建立有限期授权。
9. 资源限制的正式默认值及不同设备规格下的调整策略。

## 20. 调研参考

- [Codex：Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Codex：Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Claude Code：Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code：Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code：Permissions](https://code.claude.com/docs/en/permissions)
- [OpenCode：Plugins](https://dev.opencode.ai/docs/plugins/)
- [OpenCode：Permissions](https://dev.opencode.ai/docs/permissions/)
- [WASI releases](https://wasi.dev/releases)
- [WebAssembly Component Model / WIT](https://component-model.bytecodealliance.org/design/wit.html)
