# 功能开发装配手册

这是 Kimi Code Desktop 当前代码结构下的逐步开发说明。它不替代 [结构与开发规范](DEVELOPMENT.md)：

- `DEVELOPMENT.md` 规定文件应放在哪里、依赖可朝哪个方向走、哪些内容不能修改；
- 本文档说明要实现一个功能时，按什么顺序新增、连接、测试和验收。

把每个功能当作一组积木：先选择积木类型，再只装配该类型要求的层。没有使用到的层不要修改。

## 1. 当前项目的固定条件

开始实现前，先以这些事实为准：

1. 前端是 React 19 + Vite，导入别名 `@/` 指向 `src/`。
2. 当前没有 React Router。主界面由 `src/app/app.tsx` 直接组合侧栏、对话、工作区、设置和弹窗；不要仅为了增加一个面板而引入路由框架。
3. 桌面能力通过 Tauri IPC 暴露，前端唯一门面是 `src/lib/tauri-api.ts`。组件和 hook 不直接调用 Tauri SDK。
4. 会话、模型、工具和 agent 行为来自用户安装的 `kimi acp`。桌面保持 ACP-only，不增加 Python sidecar 或 legacy runtime fallback。
5. `src/lib/api/**` 是 OpenAPI Generator 生成物，不手工编辑。需要本地桌面类型或适配时，在 `src/lib/` 增加本地类型/normalizer。
6. live event 与历史 replay 的前端归一入口是 `src/hooks/useSessionStream.ts`。只有 wire/ACP/tool 语义变化才进入它。

## 2. 每次开始前的准备卡

在写代码前，先完成下面六格。任何一格答不出来，先搜索代码而不是猜。

| 格子 | 要写清楚的内容 |
| --- | --- |
| 用户动作 | 用户点了什么、输入了什么，或什么事件触发功能？ |
| 结果 | 用户最终能看到、下载、保存或控制什么？ |
| 数据来源 | 纯本地计算、已有 hook、Tauri 命令、ACP stream 还是配置文件？ |
| 拥有者 | 哪个模块最自然地拥有这个交互和状态？ |
| 状态 | loading、error、empty、disabled、unknown 时各显示什么？ |
| 验收 | 最小自动化测试是什么？是否还需要真实 Tauri/ACP 验收？ |

先运行：

```powershell
git status --short --branch
rg -n "<功能名|相关命令名|相关类型>" src src-tauri scripts .github docs
```

第二条命令用于定位现有实现、调用方、测试和文档。搜索时优先找相似功能并仿照它的边界；不要从零发明一套新模式。

## 3. 选择正确的积木路线

```text
我想增加什么？
├─ 只改变展示、按钮、卡片、局部弹窗
│  └─ 路线 A：纯前端 UI
├─ 需要请求、缓存、订阅、轮询或跨组件状态
│  └─ 路线 B：Hook 与状态编排
├─ 需要新增工作区页签、设置页签、Shell 级弹窗或主布局区域
│  └─ 路线 C：挂到现有组合点
├─ 需要读写本机文件、调用系统能力或原生进程
│  └─ 路线 D：Tauri IPC
├─ 需要显示新的 Kimi ACP 会话/工具/agent 事件
│  └─ 路线 E：ACP wire 全链路
├─ 需要保存桌面或 Kimi Code 配置
│  └─ 路线 F：设置与配置
└─ 需要移动、改名或移除内容
   └─ 路线 G：结构变更
```

一个需求可能经过多条路线。例如“设置页增加一个保存到本地配置的开关”通常是 C + B + D + F；“新的工具结果卡片”通常是 A + E。

## 4. 所有路线共用的装配顺序

按顺序执行，不跳步：

1. **定范围**：写出准备卡，确认只修改完成该功能所需的文件。
2. **找样例**：使用同一模块内已有的相似组件、hook 或 command 作为样板。
3. **先定契约**：先定义 props、返回类型、事件 payload 或 Rust 请求/响应形状，再写内部实现。
4. **先实现最小可见结果**：先让一种正常输入走通；不要一开始同时覆盖所有边界状态。
5. **补齐状态**：逐个补 loading、error、empty、disabled、unknown/fallback。
6. **接入最近组合层**：组件由最接近、最了解其状态的父组件渲染；只有 Shell 级状态才放进 `App`。
7. **写相邻测试**：先测试用户可见行为，再测试实现细节。
8. **做最小验证**：运行该文件的测试、受触及文件 lint、类型/构建检查。
9. **扩大验证**：跨模块、Rust、ACP 或发布路径才运行相应完整门禁。
10. **收尾搜索**：确认没有旧名称、无用导入、失效入口或未处理错误。

## 5. 路线 A：新增或修改纯前端 UI

适用：新的卡片、按钮、信息行、局部弹窗、空状态、展示格式，且不需要新数据源。

### A1. 选目录

| UI 属于哪里 | 创建位置 | 首选组合点 |
| --- | --- | --- |
| 消息、工具、审批、思考过程 | `src/modules/conversation/` | `conversation-view.tsx`、`message-list.tsx` 或对应卡片 |
| 输入、附件、斜杠命令 | `src/modules/composer/` | `composer.tsx` |
| 会话侧栏、归档、搜索 | `src/modules/sessions/` | `app-sidebar.tsx` 或侧栏内组件 |
| Changes、Files、Agents、Tasks | `src/modules/workspace/` | `changes-panel.tsx` 或对应 tab |
| 设置内容 | `src/modules/settings/` | `settings-dialog.tsx` |
| 所有模块都可复用、没有业务语义 | `src/ui/` | 由业务模块引用 |

不要把一个只显示会话信息的组件放进 `src/ui/`；`src/ui/` 只放 Button、Dialog、Tooltip、滚动区等无业务语义原语。

### A2. 创建组件和测试

在所属模块创建同名组件及相邻测试：

```text
src/modules/<feature>/
  <name>.tsx
  <name>.test.tsx
```

组件从 props 接收数据和回调，局部展开/收起等只影响自身的状态留在组件内部。最小模板：

```tsx
type FeatureCardProps = {
  title: string;
  onOpen?: () => void;
};

export function FeatureCard({ title, onOpen }: FeatureCardProps) {
  return (
    <section>
      <span>{title}</span>
      {onOpen ? <button type="button" onClick={onOpen}>打开</button> : null}
    </section>
  );
}
```

先复用 `src/ui/` 中的原语和现有 Tailwind token；不要给单个功能引入独立 CSS 体系或重复实现 Button、Dialog、Tooltip。

测试以可见行为为主：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureCard } from "./feature-card";

describe("FeatureCard", () => {
  it("点击后调用回调", () => {
    const onOpen = vi.fn();
    render(<FeatureCard title="示例" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
```

### A3. 挂载组件

1. 从拥有该交互状态的最近父组件导入新组件。
2. 给它传入数据和回调；不要让子组件跨层读取 `App` 的状态。
3. 如果只在一个现有卡片内出现，挂到该卡片，不改 `app.tsx`。
4. 如果它是全局弹窗，才在 `App` 保存 `open`、`pending`、`target` 等状态，并像现有 Settings/确认弹窗一样在 Shell 外层挂载。
5. 补齐父组件已有的空、错误、loading 分支，避免新组件只在理想数据下可用。

### A4. 验收

```powershell
npm test -- src/modules/<feature>/<name>.test.tsx
npx biome lint src/modules/<feature>/<name>.tsx src/modules/<feature>/<name>.test.tsx
npm run build
git diff --check
```

## 6. 路线 B：新增 Hook、异步状态或共享状态

适用：功能需要请求数据、缓存、订阅浏览器事件、定时刷新、处理会话切换，或多个组件共享同一状态。

### B1. 先决定 Hook 放在哪里

| 使用范围 | 位置 |
| --- | --- |
| 仅一个功能模块使用 | `src/modules/<feature>/use-<name>.ts` |
| 多个功能模块或 App 共同使用 | `src/hooks/use<Name>.ts` |
| 无 React 依赖的转换、解析、筛选 | `src/lib/<name>.ts` 或功能内 helper |
| 多个不相关面板同时订阅 stream 事件 | 评估 `src/lib/tool-events/store.ts`，不要先建全局 store |

Hook 不能反向导入具体 UI 组件或 `App`。它只返回数据、状态和 actions，由调用组件决定怎么显示。

### B2. 建立明确返回契约

每个异步 hook 至少明确它真正需要的字段：

```ts
export type UseFeatureReturn = {
  data: FeatureData | null;
  isLoading: boolean;
  isUpdating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (input: FeatureInput) => Promise<FeatureData>;
};
```

不是每个 hook 都必须有所有字段；没有写操作时不要伪造 `isUpdating`。但调用方不能通过读取内部 ref 或直接调用底层 API 来绕过该契约。

### B3. 实现时逐项处理

1. 把无 React 依赖的转换、normalizer、常量先拆到 `src/lib/` 或功能内 helper。
2. 在 hook 内维护 data、loading、error；只在真正发生请求时改变 loading。
3. 请求可能因为 session、query 或输入变化而过期时，使用 request id 或 `AbortController` 防止旧结果覆盖新结果。
4. 使用 `useEffect` 订阅事件、计时器或 idle callback 时，返回对应 cleanup。
5. `enabled` 为 false 时不启动请求或订阅；这在启动就绪检查、关闭的对话框和会话切换中很重要。
6. 组件卸载或 session 改变后不得写入旧状态。
7. 如果 hook 只封装已有 Tauri 能力，只通过 `src/lib/tauri-api.ts` 调用。

可仿照的现有模式：

- `src/hooks/useGitDiffStats.ts`：请求序号、取消、session reset 与轮询 cleanup；
- `src/modules/composer/use-file-mentions.ts`：session 切换、缓存和 debounce cleanup；
- `src/hooks/useGlobalConfig.ts`：加载、更新、缓存与浏览器事件同步。

### B4. 在最低共同拥有者调用

| 谁需要数据 | 应由谁调用 hook |
| --- | --- |
| 只有 Composer | Composer 或 composer 内组合组件 |
| 对话区多个子组件 | `ConversationView` |
| 侧栏、工作区和对话区都需要 | `App`，然后通过 props 下传 |
| 独立订阅的 stream 派生状态 | 仅在确认多个无关面板都需要时放入 store |

### B5. 测试和验收

使用 `renderHook`、`act`、`waitFor` 和 `vi.mock` 测试：首次加载、成功、失败、输入/会话变化后的过期请求、cleanup。可仿照 `src/hooks/useSessions.test.tsx`。

```powershell
npm test -- src/hooks/use<Name>.test.tsx
# 或 npm test -- src/modules/<feature>/use-<name>.test.tsx
npx biome lint <changed-hook-and-test-files>
npx tsc -b
npm run build
```

## 7. 路线 C：新增现有 Shell 内的页面、页签或弹窗

当前项目通过组合组件管理主界面，不通过 URL 路由管理页面。先选择正确扩展点。

| 要增加的区域 | 必须更新的位置 |
| --- | --- |
| 新设置页签 | `src/modules/settings/settings-dialog.tsx` 中的 `SettingsTab`、`TABS` 和内容渲染；如需从外部打开，再检查 `App` 的 `settingsInitialTab` |
| 新工作区页签 | `src/modules/workspace/changes-panel.tsx` 中的 `WorkspaceTab`、页签列表、计数和条件渲染；再检查 `App` 的 `workspaceTab` 传递 |
| 对话内面板 | `src/modules/conversation/conversation-view.tsx` 或现有消息/工具组件；必要时通过其 props 向上请求 Shell 行为 |
| 新 Composer 能力 | `src/modules/composer/composer.tsx` 及其现有 callback 链；只有影响会话/全局状态时才延伸到 `ConversationView`/`App` |
| 会话侧栏能力 | `src/modules/sessions/` 和 `useSessions`；不要把会话请求散落到侧栏组件 |
| 顶栏/状态栏能力 | `src/modules/topbar/` 或 `src/modules/statusbar/`；全局动作通过明确 callback 传入 |
| Shell 级确认框/弹窗 | `App` 持有 open/target/pending 状态，在根部渲染对话框 |

装配顺序：

1. 先在所属模块完成独立组件和测试。
2. 在上表的扩展点把类型、标签、条件渲染和计数一次接齐。
3. 若功能会打开另一个区域，只沿已有 callback 链传递意图，例如“打开工作区某个 tab”，不要让子组件直接改 App 内部 state。
4. 只有确定现有组合方式无法表达时，才在 `App` 新增状态；新增后检查 App 是否仍只负责组合而非承载功能细节。
5. 在窄窗口下检查已有 Shell overlay/width 行为，避免新面板压住对话区。

## 8. 路线 D：新增 Tauri IPC 能力

适用：前端需要安全地访问本机文件、原生窗口、进程、系统对话框、`~/.kimi-code` 数据或其他桌面能力。

### D1. 先选 Rust 领域模块

1. 已有领域模块能承载时，在该模块增加业务函数，例如 config 放 `global_config.rs`/`mcp_config.rs`，文件放 `session_files.rs`，安全校验放 `security.rs`。
2. 只有新能力确实独立时，创建 `src-tauri/src/<feature>.rs`，并在 `src-tauri/src/lib.rs` 添加 `pub mod <feature>;`。
3. 不把读取文件、路径遍历、配置写入或复杂 ACP 调用直接堆进 `commands.rs`。
4. 涉及路径、URL、配置内容或凭据时，先复用/扩展 `security.rs` 校验；不要把未校验的前端字符串直接用于文件系统或进程调用。

### D2. 添加薄 command 包装

在 `src-tauri/src/commands.rs` 添加 Tauri command。它只做参数接收、必要校验、调用领域函数和错误转换：

```rust
#[tauri::command]
pub async fn get_feature(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    crate::feature::get_feature(&app, &session_id).await
}
```

示例只表示边界：实际返回类型跟随相邻 command。不要为了套用模板而把同步函数改成异步，或把业务逻辑移入 command。

### D3. 注册 command

在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![ ... ]` 中加入：

```rust
commands::get_feature,
```

漏掉该项时，前端会在运行时得到 command not found；所以它与 Rust 实现同等重要。

### D4. 添加 TypeScript 门面

在 `src/lib/tauri-api.ts` 完成四件事：

1. 定义本地输入/输出类型；不要改生成的 `src/lib/api/**`。
2. 需要时写 `normalizeFeature`，把 Rust 的 snake_case 响应转换为前端 camelCase 契约。
3. 用 `isTauri()` 保护桌面专用能力。
4. 用 `invoke` 调 command，并只向 hook/模块导出这个包装函数。

参考形状：

```ts
export type FeatureResult = { value: string };

export async function getFeature(sessionId: string): Promise<FeatureResult> {
  if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
  const raw = await invoke<Record<string, unknown>>("get_feature", { sessionId });
  return { value: String(raw.value ?? "") };
}
```

前端参数名称和 Rust 参数名称必须跟随同一 command 的现有写法；请求和响应都不要直接 `as FeatureResult`，优先 normalizer/显式转换。

### D5. 连接 UI 与测试

1. 在 hook 或所属模块调用 `getFeature`，不要在 JSX render 期间直接 `invoke`。
2. UI 必须显示加载失败，并保留可恢复操作（重试、关闭或明确错误）。
3. Rust 领域函数添加单元测试；前端 hook/组件测试中 mock `@/lib/tauri-api`。
4. 涉及真实文件、凭据或工作区时，只在临时测试环境执行，不操作用户真实数据。

### D6. 验收

```powershell
npm test -- <related-test-files>
npx biome lint <changed-ts-files>
npm run rust:check
npm run rust:test
npm run rust:clippy
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run build
```

若 command 依赖真实 CLI、登录或工作区，再完成真实 Tauri 验收；单元测试不替代它。

### D7. 避免装错层

- 如果用户动作的本质是“向当前 ACP 会话发送一个协议请求”，优先走路线 E 的 `wireSend -> commands::wire_send -> AcpProcessManager::send` 链路；不要为同一个协议动作另建普通 Tauri command。
- 新增普通 Rust command 时，只需注册 `generate_handler!`；只有引入新的 Tauri 插件能力（例如系统权限）时，才检查/修改 `src-tauri/capabilities/default.json`。
- 需要 ACP worker 的 command 以相邻实现为样板，注入 `AppHandle` 和 `State<AcpProcessManager>`；没有这项需求时不要为了统一模板而引入它。
- 前端参数用当前门面的 camelCase 调用形状，Rust command 参数保持 snake_case；以同一个已存在 command 的实参命名为准，不要自行猜测 Tauri 的映射规则。

## 9. 路线 E：新增或修改 ACP/wire 事件

适用：新的 ACP session update、lifecycle notification、tool display、subagent、approval、steering 或 status 语义需要被桌面显示或操作。

先判断事件是否需要跨会话切换、重连和历史打开后仍可见：

- **需要保留的会话语义**必须同时完成 live 与 replay；只让正在运行的会话能显示是不完整的。
- **纯瞬时提示**可以明确标为 live-only，但必须写清楚为什么无需回放，并保证它不承载用户之后仍需看到的状态。

正常 live 链路为：`ACP 通知 -> acp.rs -> acp_translate.rs -> wire:message -> tauri-api.onWireMessage -> useSessionStream -> store/UI`。

### E1. 先确定事件来源

| ACP 形状 | 首先查看 |
| --- | --- |
| `session/update` | `src-tauri/src/acp.rs` 的 notification 处理与 `acp_translate.rs` |
| 生命周期 notification | `acp.rs` + `translate_acp_lifecycle_notification` |
| 反向请求（问题/权限） | `acp.rs` reverse request + `acp_translate.rs` |
| 已落盘的会话历史 | `src-tauri/src/session_store.rs` 的 `replay_session_history` |

先捕获真实或测试用 ACP payload，写下必填字段、可选字段和未知字段的降级方式。

### E2. 按固定链路逐段实现

1. 在 `src/hooks/wireTypes.ts` 定义或扩展事件 payload 类型，并把它纳入 `WireEvent` 联合类型。
2. 在 `src-tauri/src/acp_translate.rs` 把 ACP payload 转换为稳定的前端 wire 形状，通常通过 `wire_event_message`。
3. 确认 `acp.rs` 已通过既有翻译入口 emit；不要为同一事件再开一条绕过翻译器的推送路径。
4. 检查 `session_store.rs` 的 replay 是否能从 `wire.jsonl` 还原同一语义。若不能，新增最小 replay 转换；不要依赖“当前 worker 还活着”。
5. 在 `useSessionStream.ts` 的 `processEvent` 中处理该事件，更新单一拥有者的状态。
6. 在对应 `conversation`、`workspace` 或 `statusbar` 组件渲染语义 UI；不要把原始 payload 直接散落在 JSX。
7. 无法识别的 tool、display 或字段必须仍能落到通用 fallback，不能让一次未知 payload 打断整个 turn。
8. 对同一事件分别测试 live 输入和 replay 输入，断言用户看到的结果一致。

### E3. 必须覆盖的状态

- 事件字段缺失；
- 未知 `type`、工具名或 display 类型；
- 同一事件重复到达；
- 事件顺序晚于会话切换；
- 历史回放没有正在运行的 ACP worker；
- 失败/取消状态而非仅成功状态。

### E4. 验收

```powershell
npm test -- src/hooks/useSessionStream.test.tsx
npx biome lint src/hooks/wireTypes.ts src/hooks/useSessionStream.ts
npm run rust:test
npm run rust:check
npm run build
npm run smoke:runtime
```

`npm run smoke:runtime` 离线安全（临时 `KIMI_CODE_HOME`，不依赖本机 CLI 与登录）；真实桌面验收（M5）未执行时要写明，不能把自动化绿当作已验收。

### E5. 事件来源与回放的分流卡

1. `session/update` 先查看 `translate_session_update`；顶层生命周期通知先查看 `translate_acp_lifecycle_notification`；需要用户回应的 ACP reverse request 则沿 `acp_update_to_wire_event` 的请求/响应路径实现，不能当作普通广播事件。
2. 普通通知复用 `wire_event_message` 形成统一 JSON-RPC envelope。`acp.rs` 的通知处理会分发，`wire_events.rs` 负责发出 `wire:message`；普通新事件通常不需要新 command。
3. 闲置会话的历史回放不经过 `acp_translate.rs`：它从 CLI 已记录的 `wire.jsonl` 经 `session_store::replay_session_history` 重建；已连接会话的 `session/load` 通知仍走 live 翻译。新增持久语义时只能从已有 journal 记录重建，或读取 canonical snapshot；不要向 CLI journal 写自定义前端事件。可参考 `replay_loop_event`。
4. 如果前端还要主动让 ACP 执行动作，复用既有 `wireSend`、`commands::wire_send` 和 `AcpProcessManager::send`；在 `acp.rs` 的 method 分发增加对应 case，而不是设计第二条私有 IPC。
5. “未知 wire event”与“未知 tool/display”不同：前者在 reducer 的默认分支可能被忽略，所以类型、翻译和 `processEvent` 必须同步新增；后者的通用展示 fallback 必须继续保留，不能因新分支而中断整轮消息。

### E6. Wire 状态归属与副作用卡

- 如需兼容旧 event 名，在 `wireTypes.ts` 的 `EVENT_TYPE_ALIASES` 同步添加别名；`extractEvent` 只做类型转换，不替你校验 payload。
- 时间线内容归入 `LiveMessage`；跨面板状态选对应 Zustand/store；工具语义优先扩展 `tool-events`；子代理状态复用 `agent-monitor`。先选一个拥有者，再写 UI。
- 在 `processEvent` 中显式区分 `isReplay`：回放可以恢复 Todo、Goal 或消息，但不能再次触发“已写文件”“新通知”等一次性副作用。
- 测试至少覆盖真实 JSON-RPC live envelope、`replaySessionHistory` 的同一语义、重复/乱序/缺字段，以及切换 session 后的过滤。

## 10. 路线 F：新增设置或配置项

设置功能通常是 C + B + D 的组合：设置 UI → hook/adapter → Rust 配置模块 → 安全写入 → 可能的 worker restart。

### F1. 选择配置归属

| 配置类型 | 首选位置 |
| --- | --- |
| 桌面展示、主题、界面偏好 | 前端状态/已有主题能力；确认是否需要持久化 |
| Kimi Code 全局配置 | `global_config.rs`、`useGlobalConfig.ts`、`settings-dialog.tsx` |
| `config.toml` 原文编辑 | `commands.rs` 的 config command + `src/lib/settings-api.ts` |
| MCP 配置 | `mcp_config.rs`/对应 command + `src/lib/settings-api.ts` |
| 只与单个会话相关的模式 | session state/ACP 路径，不放到全局 config |

### F2. 逐步增加设置 UI

1. 先决定新增现有页签内的 Section，还是新增一个页签。
2. 新页签时，在 `src/modules/settings/settings-dialog.tsx` 同时更新 `SettingsTab`、`TABS` 和对应内容渲染。
3. 如果其他模块需要直接打开该页签，再更新 `App` 保存的 `settingsInitialTab` 及打开回调。
4. UI 先读取 hook 返回的 `config/isLoading/error`，不直接读取文件。
5. 保存按钮必须防重复提交，显示保存失败，并在成功后刷新受影响视图。
6. 若变更需要重启运行中的 ACP worker，展示后端返回的重启/跳过摘要；不能默默丢失该结果。

### F3. 写入安全

- Rust 侧先验证 TOML/JSON/字段值，再写入；复用现有 config 验证与原子写入路径。
- 凭据、token、完整私密配置不能出现在 toast、日志、测试失败输出或文档中。
- 前端收到 unknown 配置字段时保留兼容，避免一次更新把未识别字段清空。
- 修改后通过现有配置更新事件/refresh 让其他打开的 UI 同步，而不是要求用户重启窗口。

### F4. 验收

至少覆盖：初始读取、成功保存、校验失败、写入失败、重复点击、其他视图刷新。再运行对应前端测试、Rust 测试和真实桌面验证。

### F5. 全局配置与运行模式的详细接线

1. 普通全局默认项以 `~/.kimi-code/config.toml` 为真相源，不额外创建桌面配置副本。在 `global_config.rs` 增加默认值、解析/校验和稳定输出字段。
2. 扩展 `commands::update_global_config` 的可选参数和返回摘要；保留“重启空闲 worker、跳过忙碌 worker”的结果，不能静默吞掉运行时副作用。
3. 在 `tauri-api.ts` normalizer 与 `useGlobalConfig` 同时增加契约和缓存刷新；成功后复用 `kimi:config-update` 广播与 `config-update-toast.ts` 的反馈，而不是只更新当前弹窗的局部状态。
4. 在 General tab 增加控件时，检查 `new-session-view.tsx`、`conversation-view.tsx` 等同一配置的消费者，保证新旧会话的产品语义一致。
5. 若配置会影响 ACP 新会话的运行模式，还要检查 `runtime_mode_defaults`、`session_store` 的 `resolved_runtime_modes`、`acp.rs` 的 `resolve_initial_runtime_modes` 和相应 `StatusUpdate`。仅影响 UI 的偏好不要无谓进入 wire。
6. 原始 `config.toml` 或 `mcp.json` 编辑器优先复用 `settings-api.ts` 与 `TextConfigEditor`；MCP 内容必须经过 native JSON 与安全校验，前端不直接写文件。
7. 新增设置 UI 时，如果相邻测试尚不存在，就在设置模块创建相邻测试，至少 mock `@/lib/tauri-api` 并覆盖读取、保存成功、保存失败和重复点击。

## 11. 路线 G：移动、改名与删除

移动、改名和删除遵循 [结构规范的 2.5 与 2.6 节](DEVELOPMENT.md#25-移动或重命名)。这里给出执行顺序。

### G1. 移动或改名

```powershell
rg -n --fixed-strings "<old-path-or-name>" src src-tauri scripts .github docs README.md AGENTS.md
git mv <old-path> <new-path>
rg -n --fixed-strings "<old-path-or-name>" src src-tauri scripts .github docs README.md AGENTS.md
git diff --name-status -M
git diff --check
```

然后更新静态 import、动态 import、re-export、测试、文档和脚本。Windows 仅改大小写时先改为临时名，再改为目标名，最后检查 Git 是否识别为 rename。

### G2. 删除

先搜索定义和引用，确认不是生成源、发布资产、运行时数据或仍支持的入口。删除一个 Tauri command 时，必须同时处理：

```text
Rust domain function/test
  -> commands.rs wrapper
  -> lib.rs generate_handler registration
  -> tauri-api.ts wrapper/type
  -> hook/component call sites and mocks
  -> docs/scripts if referenced
```

删除一个 ACP/wire 功能时，必须同时处理类型、翻译、replay、状态、UI、fallback 测试。删除后搜索旧符号应没有当前运行链路引用。

## 12. 完成定义与命令选择

| 改动类型 | 必做命令 |
| --- | --- |
| 单个 UI 组件 | 相关 Vitest + `npx biome lint <files>` + `npm run build` |
| Hook 或共享 TypeScript | 相关 Vitest + lint + `npx tsc -b` |
| Shell 页签/跨模块前端 | `npm test` + `npm run build` |
| Tauri/Rust | 前端相关测试 + `npm run rust:check` + `npm run rust:test` + `npm run rust:clippy` + `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |
| Runtime/wire | 上述 Rust/前端检查 + `npm run smoke:runtime` |
| 仅文档 | `git diff --check` |

交付时使用这个模板，避免把不同验证状态混为一谈：

```text
实现：<完成了什么>
自动化验证：<已运行的命令及结果>
真实桌面/ACP 验收：<已执行，或未执行的原因>
遗留项：<无，或明确列出>
```

如果某项检查不能执行，不要声称它已通过；写清原因和用户可执行的下一步。

## 13. 从需求卡到完成：三个完整装配例子

下面的例子不是要复制文件名，而是用来确认自己有没有漏装某块积木。每一步只在前一步明确需要时再继续。

### 示例 1：把新的 ACP 工具结果显示为一张对话卡片

需求：ACP 发来新的工具结果，当前会话和历史会话都要看到一张可展开的结果卡片。

1. 准备卡写明：数据来自 ACP、归属 conversation、需要持久化、正常/失败/未知 payload 都要可见。
2. 在 `src/hooks/wireTypes.ts` 增加判别 payload 和 `WireEvent` 成员；先为字段缺失设计安全默认值。
3. 在 `src-tauri/src/acp_translate.rs` 的对应 `session/update` 翻译处把 ACP payload 映射为稳定 wire 形状；复用 `wire_event_message`。
4. 确认 CLI journal 是否已记录足以重建该结果的语义：若有，在 `session_store.rs` 增加最小 replay 转换；若没有，选择 canonical snapshot。不要向 `wire.jsonl` 写自定义前端事件，也不要直接复用 live 翻译函数。
5. 在 `useSessionStream.ts` 的 `processEvent` 把事件写入拥有消息流的状态，不把原始 JSON 直接传到 JSX。
6. 在 `src/modules/conversation/` 创建 `<tool>-result-card.tsx` 和相邻测试；它接收已归一化的 props，内部只管理展开/收起。
7. 在现有消息/工具渲染分支挂入该卡片；未知工具或 display 仍走已有 fallback。
8. 先跑 `useSessionStream` 测试（live + replay），再跑卡片测试、Rust 测试、构建和条件具备时的 ACP smoke。

不要做：新增一个仅用于显示结果的普通 Tauri command；把 `invoke` 写进卡片；或只为 live session 实现卡片。

### 示例 2：在 General 设置中增加一个会影响新会话默认行为的开关

需求：用户保存一个全局默认开关；之后新会话使用它，正在运行的会话根据后端摘要重启或提示跳过。

1. 准备卡确认它是全局默认而非单会话状态，真相源是 `~/.kimi-code/config.toml`。
2. 在 `global_config.rs` 加默认值、读取、校验与写入字段；为非法值和旧配置设计兼容行为。
3. 扩展 `commands::get_global_config`/`update_global_config` 的参数与返回摘要，并保持 command 薄包装。
4. 在 `tauri-api.ts` 增加本地类型与 normalizer，在 `useGlobalConfig.ts` 增加更新 action 与缓存刷新。
5. 若它会改变 ACP 新会话运行模式，沿 `runtime_mode_defaults -> resolved_runtime_modes -> resolve_initial_runtime_modes -> StatusUpdate` 补齐；若只影响 UI，则在此停止，不进入 wire。
6. 在 `settings-dialog.tsx` 的 General tab 增加受控控件。保存时禁用重复点击、显示错误、等待 hook 返回；成功后使用已有 `kimi:config-update` 和 toast 摘要同步其他界面。
7. 检查 `new-session-view.tsx`、`conversation-view.tsx` 等消费同一默认值的位置，避免“设置已变而新会话仍用旧值”。
8. 新增相邻设置测试，mock Tauri 门面，覆盖读取、成功、校验错误、写入错误、重复提交和刷新；再跑 Rust 与真实桌面验收。

不要做：让设置组件直接读写文件；把 token 写进 toast；或为了一个 UI 偏好重启 ACP worker。

### 示例 3：在工作区增加一个纯前端页签

需求：新增一个由现有前端数据计算的工作区页签，不读本机、不发 ACP、也不保存配置。

1. 准备卡确认路线只有 A + C；不要碰 `src-tauri/`、wire 或设置代码。
2. 在 `src/modules/workspace/` 创建页签内容组件与测试；计算逻辑复杂时提到模块内 helper 或 `src/lib/`。
3. 在 `changes-panel.tsx` 同时补 `WorkspaceTab` 类型、页签标签、计数和条件渲染；沿已有 callback 传递切换意图。
4. 如果状态只被这一个页签使用，就留在该组件或该模块 hook；不要放进 `App` 或新建全局 store。
5. 宽度较窄时检查现有 workspace/Shell overlay 行为；空数据、加载态和错误态使用项目已有视觉原语。
6. 跑相邻 Vitest、变更文件 Biome、`npm run build` 与 `git diff --check`。没有原生逻辑时不要为了“完整”而跑或改 Rust。

这个例子的关键是边界：功能越小，装配的层越少；“完整”指该功能的必要链路完整，而不是修改更多目录。

