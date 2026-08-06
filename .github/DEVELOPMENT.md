# Kimi Code Desktop 结构与开发规范

本文档是仓库结构、依赖边界和开发流程的正式规范。新增代码必须遵守；既有代码如有偏离，在相关代码被触及时小步收敛，不为对齐规范发起无关的整仓搬迁。

## 使用顺序

1. 先阅读本文，确定目录、依赖边界和变更范围。
2. 实现、添加、移动或删除功能时，按[功能开发装配手册](FEATURE_IMPLEMENTATION.md)选择路线并逐步执行。
3. 如两份文档存在冲突，以本文的结构、安全和运行时边界为准。

## 1. 项目边界

`codex/source-runtime` 正在把 Kimi Code Desktop 从 CLI 外壳迁移为源码自有产品。当前可执行代码仍是 ACP 基线；最终产品只交付仓内源码构建的 Kimi Runtime。

```text
React UI
  -> Tauri IPC / events
     -> RuntimeSupervisor
        -> source-built Kimi desktop runtime child
     -> local config, session history, files, and Git helpers
```

必须保持：

- 目标运行时为 Source-Runtime-only；不恢复 Python sidecar，不保留 ACP/旧 runtime 的生产 fallback，也不发布双 backend。
- M4 切换前 ACP 仅作为已验证迁移基线存在；不得宣称已取代，也不得扩展成长期兼容层。
- Source Runtime 的目录、协议、数据与发布契约以 `docs/plans/2026-08-06-source-runtime-migration.md` 为准。
- 不为后端尚未支持的能力制作假入口。
- 自动化测试通过、代码已实现、真实 Tauri/WebView2 已验收是三个不同状态，交付时分别说明。

## 2. 仓库结构

```text
.github/
  DEVELOPMENT.md     本规范
  workflows/         CI 与发布自动化
docs/
  plans/             已接受的实现与验收计划
  releases/          发布记录
public/               原样复制的静态资源
scripts/              检查、冒烟测试、版本与发布脚本
runtime/              固定 Kimi Code 源码与 source-built Desktop Runtime
src/
  main.tsx            浏览器入口
  bootstrap.tsx       启动恢复与 React 挂载
  app/                应用组合层
  assets/             前端打包资源
  config/             静态前端配置
  hooks/              状态、生命周期与会话编排
  lib/                共享类型、纯函数、store、API 与平台适配
  modules/            按业务能力划分的功能模块
  ui/                 无业务语义的通用视觉组件
src-tauri/
  src/                Rust/Tauri 原生实现
```

测试文件默认与被测代码相邻，命名为 `*.test.ts` 或 `*.test.tsx`。

以下内容属于生成物或本地缓存，不手工修改、不提交：

- `dist/`
- `node_modules/`
- `src-tauri/target/`
- `src-tauri/gen/`
- `tmp/`
- `src/lib/api/**` 中标记为 OpenAPI Generator 生成的文件

### 2.1 功能区域索引

| 功能 | 主要位置 |
| --- | --- |
| 应用壳、新会话入口 | `src/app/` |
| 输入框、附件、斜杠命令 | `src/modules/composer/` |
| 消息流、Markdown、工具卡片、审批与追问 | `src/modules/conversation/` |
| 会话列表、归档与侧栏 | `src/modules/sessions/` |
| 工作区 Changes、Files、Agents、Tasks | `src/modules/workspace/` |
| 设置、配置与 MCP 界面 | `src/modules/settings/` |
| 启动就绪检查 | `src/modules/readiness/` |
| 顶栏、状态栏 | `src/modules/topbar/`、`src/modules/statusbar/` |
| 会话状态和 wire 编排 | `src/hooks/useSessions.ts`、`src/hooks/useSessionStream.ts` |
| 前端 Tauri IPC | `src/lib/tauri-api.ts` |
| 原生 IPC 注册 | `src-tauri/src/commands.rs`、`src-tauri/src/lib.rs` |

### 2.2 变更落点矩阵

| 要做的事 | 首选落点 | 同时检查 |
| --- | --- | --- |
| 调整某个页面或卡片 | 对应 `src/modules/<feature>/` | 相邻测试、loading/error/empty 状态 |
| 新增通用视觉组件 | `src/ui/` | 是否真的没有业务文案和状态 |
| 新增共享类型或纯函数 | `src/lib/` | 是否会造成反向依赖或循环依赖 |
| 新增 React 状态编排 | `src/hooks/` | cleanup、竞态、disabled/unmount 行为 |
| 修改会话或 wire 行为 | `useSessionStream` 相关链路 | live、replay、store、语义 UI、fallback |
| 新增 Tauri 命令 | 对应 Rust 模块 + `commands.rs` | `lib.rs` 注册、`tauri-api.ts`、调用方和测试 |
| 修改配置或 MCP | 前端 settings + 对应 Rust 配置模块 | 序列化、真实路径、安全写入 |
| 修改检查或发布流程 | `scripts/`、`.github/workflows/` | `package.json` 脚本和发布文档 |

### 2.3 编辑现有内容

1. 先运行 `git status --short --branch`，确认当前工作区和本次允许修改的范围。
2. 用 `rg` 找到定义、导入、导出、注册点和相邻测试：

   ```powershell
   rg -n "<symbol|command|path>" src src-tauri scripts .github docs
   ```

3. 在当前职责所属目录内完成修改；若必须跨层，先确认依赖方向仍符合第 3 节。
4. 默认保持现有公开签名、事件名、IPC command 名和持久化数据形状。
5. 行为发生变化时更新最贴近的测试；纯实现整理不重写无关快照或文案。
6. 不直接编辑生成文件，不整仓格式化。

### 2.4 新增内容

新增功能优先形成一个自包含目录：

```text
src/modules/<feature>/
  <feature>-view.tsx
  <feature>-helper.ts       仅在功能内部复用时
  <feature>-view.test.tsx
```

这只是放置模板，不要求为已有模块批量改名。新增时按顺序确认：

1. 功能归属是否唯一；若只服务一个模块，不提前放入 `lib` 或 `ui`。
2. 类型放在最靠近使用方的位置；只有跨功能稳定共享时才上移到 `src/lib/`。
3. 异步功能同时提供 loading、error、empty/unknown 状态。
4. 新增动态导入时提供可见且安全的 fallback，并验证生产构建的 chunk。
5. 新增依赖前检查仓库已有能力，并记录引入理由。
6. 新增 Tauri command 时完成整条注册链：

   ```text
   Rust implementation/test
     -> commands.rs IPC wrapper
     -> lib.rs generate_handler registration
     -> src/lib/tauri-api.ts wrapper/type
     -> frontend caller/test
   ```

### 2.5 移动或重命名

移动只改变归属，不同时修改业务行为：

1. 用 `rg` 记录旧路径、导出名、动态导入字符串和测试引用。
2. 使用 `git mv <old> <new>` 移动单个文件或一个清晰职责组。
3. 更新所有静态导入、动态导入、re-export、测试和文档链接。
4. 对外部调用方较多的导出先保留兼容 re-export，再分步迁移。
5. 再次搜索旧路径和旧符号，确认没有残留引用。
6. 运行移动前后相同的聚焦测试，确保只有结构变化。

Windows 上的仅大小写重命名使用临时中间名，并通过 `git status` 确认 Git 已识别。

### 2.6 删除内容

删除前必须确认目标不再被产品路径、测试、脚本或发布流程使用。逐项检查：

- 静态导入、动态导入和 re-export；
- React 组合入口、注册表、事件监听与 cleanup；
- Tauri `generate_handler!`、TypeScript IPC wrapper 和 command 调用方；
- Rust `pub mod`、模块内部测试与共享类型；
- CSS、图片、字体及 `public/` 资源引用；
- `package.json` scripts、GitHub workflow 和文档链接。

删除后再次运行：

```powershell
rg -n "<deleted-symbol|command|path>" src src-tauri scripts .github docs
git status --short
git diff --check
```

只删除明确目标，不使用针对仓库根目录或宽泛目录的递归删除。生成物由构建流程重新生成，不通过修改 `dist/` 验证删除是否完成。

## 3. 前端职责与依赖边界

新增代码遵循以下依赖方向：

```text
app     -> modules, hooks, lib, ui
modules -> hooks, lib, ui
hooks   -> lib
ui      -> lib（仅共享展示辅助）
lib     -> 平台 API 与第三方库
```

| 目录 | 职责 | 禁止新增 |
| --- | --- | --- |
| `src/app/` | 应用壳、顶层状态和功能组合 | 可复用的业务实现、底层平台细节 |
| `src/modules/<feature>/` | 功能 UI、功能内状态与功能私有辅助代码 | 反向依赖 `app`、无约束的跨功能深层导入 |
| `src/hooks/` | React 状态、生命周期、会话和 stream 编排 | 对 `app` 或业务 UI 的新依赖 |
| `src/lib/` | 共享类型、纯函数、store、API/IPC 适配器 | 对 `hooks`、`modules` 或 `app` 的新依赖 |
| `src/ui/` | 无业务文案和工作流的视觉原语 | 会话、设置、工作区等业务状态 |

新增文件按以下规则放置：

| 内容 | 位置 |
| --- | --- |
| 跨功能共享类型、纯函数 | `src/lib/` |
| React 状态或生命周期编排 | `src/hooks/` |
| 单一功能专用组件或辅助代码 | `src/modules/<feature>/` |
| 无业务语义的视觉组件 | `src/ui/` |
| 多功能组合与应用壳状态 | `src/app/` |
| Tauri 调用的 TypeScript 门面 | `src/lib/tauri-api.ts` 或同层适配器 |

补充规则：

- 不新增循环依赖。
- 跨功能共享前先确认确实有两个以上稳定调用方；不要为“可能复用”提前抽象。
- 保留现有导出或提供兼容层，先迁移调用方，再删除旧入口。
- 文件名、导出名和目录风格跟随所在区域，不为统一命名批量重命名旧文件。

## 4. 会话与 Runtime 变更

`useSessionStream` 是 live event 与 history replay 的前端统一入口。M4 前 ACP 是当前适配层；M4 后由 Source Runtime adapter 取代。修改 wire、tool、media、subagent、steering、approval 或 status 行为时，必须核对完整链路：

```text
wire type -> runtime translation -> live dispatch
          -> persisted replay -> state/store -> semantic UI -> generic fallback
```

同时遵守：

- 一个应用壳只维护一个活动会话 stream。
- 未知事件、未知工具和未知 display payload 必须保留可用 fallback。
- session list/get/update/delete 是 Runtime 数据、本地 metadata 与运行状态的组合，不按单一远程 CRUD 理解。
- live 与 replay 的语义必须一致，不能只修其中一条路径。
- turn 终态必须与 request/turn id 精确关联；不得靠事件时间或广泛清空完成新旧 turn 归属。
- 未完成 M4 前，新增接口必须能映射到已冻结的 `runtime-v1`，不要继续扩大 ACP 私有面。

## 5. Rust/Tauri 边界

| 模块 | 职责 |
| --- | --- |
| `commands.rs` | 薄 IPC 入口、参数转换与调用编排 |
| `acp.rs` | 每会话 ACP wire 进程 |
| `acp_desktop.rs` | 非 wire 的共享 ACP session RPC |
| `acp_translate.rs`、`wire_events.rs` | ACP 数据到前端 wire 语义的翻译 |
| `session_store.rs` | 本地 metadata、wire history 与 replay |
| `session_files.rs`、`git_diff.rs` | 当前会话工作区文件与 Git 数据 |
| `global_config.rs`、`mcp_config.rs` | `~/.kimi-code` 配置 |
| `security.rs` | 路径与本地访问安全边界 |

Source Runtime 目标模块：

| 模块 | 职责 |
| --- | --- |
| `runtime/kimi-code/apps/desktop-runtime` | Kimi source adapter、stdio router 与 Runtime lifecycle |
| `runtime_supervisor.rs` | source-built 子进程生命周期、请求表、超时和重启 |
| `runtime_protocol.rs` | `runtime-v1` envelope、codec 和版本协商 |
| `runtime_translate.rs` | Runtime event 到 Desktop wire 语义的翻译 |

业务逻辑不得持续堆入 `commands.rs`。配置、登录、skills、usage、通知和 runtime readiness 应继续收口在各自模块。

测试不得覆盖真实的 `~/.kimi-code` 凭据、配置或历史记录；使用测试环境和临时目录。

## 6. 变更原则

- 一个改动只解决一个清晰职责；功能、重构、目录迁移和整仓格式化不要混在一起。
- 优先修复根因，但选择最小的行为兼容改动。
- 重构 PR 不夹带新功能，功能 PR 不顺手整理无关代码。
- 不以文件行数为拆分目标；只有职责、依赖方向或测试隔离改善时才拆分。
- 新依赖必须说明必要性，并优先复用仓库已有能力。
- 修改异步加载、stream 或 IPC 时，必须保留 loading、error 和未知数据 fallback。

## 7. 验证门槛

先运行最贴近改动的检查；跨层改动再扩大范围。

| 改动范围 | 最低验证 |
| --- | --- |
| 文档、注释 | `git diff --check` |
| 纯 TypeScript 类型或函数 | 相关 Vitest + `npx tsc -b` |
| React UI 或 hook | 相关 Vitest + `npm run build` |
| 跨多个前端模块 | `npm test` + `npm run build` |
| Rust | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` + `npm run rust:check` + `npm run rust:clippy` + `npm run rust:test` |
| ACP runtime | 上述检查 + `npm run smoke:acp` |
| 发布 | `npm run release:preflight`；需要 MSI 时运行 `npm run release:msi` |

前端源码的历史 Biome 基线尚未清零。修改源码时至少运行：

```powershell
npx biome lint <changed-files>
```

触及文件不得新增 lint 诊断。若文件原有诊断无法在本次安全清理，应在交付中明确记录，不要用提高阈值、禁用规则或整仓格式化掩盖。

`npm run smoke:acp` 需要可用的本地 CLI 和认证；浏览器 mock 不能替代真实桌面验收。

## 8. 提交前检查

- 改动是否保持依赖方向，并符合 Source-Runtime-only、无生产双 backend 的约束？
- 新文件是否放在职责正确的目录？
- 是否保留 unknown、loading 和 error fallback？
- 是否只修改任务需要的文件？
- 是否新增或更新了最贴近行为的测试？
- 是否运行了对应验证并记录未执行项？
- 是否分别说明代码、自动化测试和真实桌面验收状态？
