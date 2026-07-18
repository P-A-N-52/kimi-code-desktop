# Kimi Code Desktop UI V2 重写设计（Monochrome Pro）

日期：2026-07-18
状态：已与需求方逐节评审并定稿（视觉稿见 `assets/ui-v2-mockup.html`）

## 1. 背景与目标

现有前端为三栏 IDE 式布局（会话栏 + 聊天 + 常驻工作区面板），组件与样式在迭代中积累混杂，视觉被评价为"丑、AI 味强"。本次目标：**UI 层完全推倒重写**，打造极简会话风、单色高级感（Monochrome Pro）的 AI coding 窗口，同时**完整保留经过验证的数据层**。

## 2. 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 重写范围 | UI 组件与页面结构 100% 重写 |
| 数据层 | 保留：`src/hooks/`（useSessions、useSessionStream、wireTypes…）、`src/lib/tauri-api.ts`、`src/lib/` 其余基础设施、`src/config/` |
| 视觉风格 | 极简会话风（Claude/ChatGPT 的骨架），单色专业感（Linear/Vercel 的克制） |
| 布局 | 图标轨 + 可收会话侧栏 + 居中限宽对话 + 右侧按需滑出工作区面板 |
| 第一期功能 | 会话管理、聊天流（工具卡/diff/审批）、composer + 状态条、设置、运行时检查 |
| 主题 | 深色优先，亮色可选（沿用 `useTheme`） |
| 旧代码处置 | 整个 `src/` 打快照 zip 存**工作区根目录**，然后删除旧 UI 代码，在仓库内原位重写 |
| 后续阶段 | 工作区面板内容（diff 审查/文件树/Agent 监控/Plan 视图/技能）、side-chat、composer 增强（@ 文件、/ 命令、队列、todo） |

## 3. 范围与非目标

**第一期做：**

- 新应用外壳：图标轨、会话侧栏、顶栏、对话流、composer、状态条、右侧滑出面板（仅"更改"列表 + 迷你 diff + 全部接受/拒绝）
- 消息渲染：用户气泡、AI 正文（markdown）、工具卡片（Read/Edit/Bash…单行摘要 + 展开详情）、代码块、终端输出、审批卡片、流式光标
- 状态条四控件：权限模式（批准/自动/全放）、Swarm 开关、Plan 开关、上下文用量
- 设置对话框（保留功能，新视觉）、运行时就绪覆盖层（新视觉）
- 深/浅双主题

**第一期不做（后续迭代）：**

- 工作区面板的文件/Agent/Plan/技能完整页签（先留"更改"一个页签 + 占位）
- side-chat 浮窗、消息搜索、批量会话操作、fork
- composer 的 @ 文件引用、/ 命令菜单、队列、todo 工具栏（输入框先保留纯文本；底栏的 附件/命令/上下文 按钮照常渲染，但点击只给占位提示，菜单类交互后续阶段接入）
- 移动端/窄屏适配（桌面优先，窄屏仅保证不崩）

## 4. 旧代码归档与删除

1. 打包：将整个 `kimi-code-desktop/src/` 快照为 `kimi-cli-desktop/legacy-src-20260718.zip`（工作区根目录，不纳入任何 git 跟踪）。
2. 删除：`src/App.tsx`、`src/features/`、`src/components/`（ui 与 ai-elements 全部）。
3. 保留：`src/hooks/`、`src/lib/`、`src/config/`、`src/main.tsx`（改写）、`src/bootstrap.tsx`（改写）、`src/index.css`（重写为 tokens）。
4. 依赖清理：随删除一并移除仅被旧 UI 引用的包（@xyflow/react、embla-carousel-react、@tanstack/react-table 等，以实际引用扫描为准）；Radix 按需保留（dialog/switch/tooltip/scroll-area 等新 UI 仍会用）。
5. git 历史本身即为完整备份，zip 用于重写期快速对照旧实现（含未提交改动）。

## 5. 信息架构与布局

```
┌────┬────────┬──────────────────────────┬──────────┐
│ 图 │ 会话侧栏 │  顶栏（居中标题 + 右操作）  │ 工作区面板 │
│ 标 │ 260px  ├──────────────────────────┤ 400px    │
│ 轨 │ 可收为0 │  对话流 max-w-44rem 居中   │ 默认隐藏  │
│ 52 │        │                          │ 滑出推挤  │
│ px │        │  composer + 状态条        │          │
└────┴────────┴──────────────────────────┴──────────┘
```

- **图标轨（52px 常驻）**：logo 方块、会话、新建、搜索；底部主题切换、设置。绿色呼吸点表示有运行中会话。
- **会话侧栏（260px，可完全收起）**：搜索框（⌘K）、按 今天/昨天/本周 分组、条目 = 标题 + 等宽体元信息（目录 · 相对时间）、选中态 = 左侧 2px 亮色指示条 + 浅底、底部用户区。
- **顶栏（48px）**：居中会话标题 + 等宽体会话短 id + 折叠 chevron；右侧分享、面板开关。
- **对话流**：`max-w-44rem` 居中，用户消息右对齐中性气泡（82% 宽），AI 消息 = 20px 方块 K 标 + 全宽正文。
- **工作区面板（400px）**：默认隐藏；有未决更改或用户手动点开时向右滑出、推挤主区（非覆盖）。页签：更改(n) / 文件 / Agent（后两者第一期为占位）。底部固定「全部接受 / 全部拒绝」。
- 面板与侧栏均用 1px 发丝线分隔，不使用阴影分区。

## 6. 视觉语言（Monochrome Pro）

### 6.1 色彩 tokens

| Token | Dark | Light | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#0A0A0A` | `#FAFAFA` | 应用底色（全局统一，侧栏/面板不另设色） |
| `--bg-elev` | `#121212` | `#FFFFFF` | 卡片、composer、菜单 |
| `--bg-2` | `#181818` | `#F1F1F1` | 次级填充（用户气泡、卡片头、kbd） |
| `--border` | `rgba(255,255,255,.09)` | `rgba(0,0,0,.10)` | 发丝线 |
| `--border-strong` | `rgba(255,255,255,.17)` | `rgba(0,0,0,.18)` | composer、浮层边框 |
| `--text` / `--bright` | `#E8E8E8` / `#FFFFFF` | `#1A1A1A` / `#000000` | 正文 / 强调（主按钮、激活态） |
| `--muted` / `--faint` | `#8B8B8B` / `#565656` | `#6E6E6E` / `#ABABAB` | 次级 / 占位 |
| `--green` `--red` `--amber` | `#4DC08A` `#DE6262` `#D0A24A` | `#1E9E64` `#CE4444` `#A87818` | **仅语义**：成功/新增、危险/删除、审批/警示 |

无品牌强调色。主按钮与发送键 = `--bright` 底 + `--bg` 字的反转处理。选中/激活 = 中性灰底。

### 6.2 字体

- UI：Inter Variable（已有 `@fontsource-variable/inter`），正文 14px，`letter-spacing: -0.011em`
- 等宽：Iosevka（已有 `@fontsource/iosevka`），用于：路径、工具名、命令、代码、时间戳、会话 id、百分比、微标签；数字一律 `tabular-nums`
- 分组微标签：等宽 10px、大写、`.09em` 字距

### 6.3 形状与质感

- 圆角三级：`--r1: 6px`（按钮/小件）、`--r2: 8px`（卡片/菜单）、`--r3: 10px`（composer/气泡）
- 分隔一律 1px 发丝线；仅 composer 与浮层使用投影
- 图标：lucide，1.5px stroke，单色（无彩色图标块）
- diff：正文中性色，颜色只出现在 +/− 号与左侧 2px 槽线 + 8% 语义底色
- 动效克制：hover 120–150ms、面板滑出 250ms、运行中会话绿点呼吸、流式方块光标

## 7. 组件设计（第一期）

### 7.1 目录结构（新）

```
src/
  app/            # AppShell、providers、主题、快捷键
  ui/             # 新基础件：button、icon-btn、kbd、tooltip、dialog、switch、scroll-area、status-pill
  modules/
    rail/         # 图标轨
    sessions/     # 会话侧栏（列表、分组、搜索、新建对话框）
    topbar/
    conversation/ # 消息流：MessageList、UserMessage、AiMessage、ToolCard、DiffView、
                  #   TermView、CodeBlock、ApprovalCard、StreamingCaret
    composer/     # 输入框、发送键、模型胶囊
    statusbar/    # 权限模式选择器、swarm/plan 开关、上下文用量
    workspace/    # 右侧滑出面板（更改列表 + 迷你 diff + 批量操作）
    settings/     # 设置对话框（逻辑复用旧实现的 hooks，视觉重写）
    readiness/    # 运行时就绪覆盖层
  hooks/ lib/ config/   # 保留不动
```

### 7.2 工具卡片 ToolCard

单行摘要（单色图标 + 等宽工具名 + 等宽参数 + 右侧状态：行数/+n−n/✓）→ 点击展开详情（Edit=diff、Bash=终端、Read=省略）。默认折叠；Edit 类默认展开第一个。

### 7.3 审批卡片 ApprovalCard

琥珀色 32% 边框 + 7% 底色；标题 + `APPROVAL` 等宽标签；命令/变更摘要明文；操作：允许(⏎) / 拒绝(Esc) / 本会话不再询问。

### 7.4 状态条 StatusStrip（composer 正下方）

- **权限模式**：三态选择器，上弹菜单带说明文案。`批准`=默认中性；`自动`=琥珀（安全操作自动批准：只读类工具白名单，如 read/grep/glob/list，危险操作仍询问）；`全放`=红色（全部自动批准，按会话持久化）。
  实现：复用 useSessionStream 的 approval 流，外层封装自动应答器——收到 `approval-requested` 时按模式 + 工具白名单自动调用既有的 respond 通道；不动 ACP 协议。持久化模式参考现有 `readPersistedSwarmMode` 的 localStorage 方案（`kimi-code-desktop.permission-mode-by-session.v1`）。
- **Swarm / Plan**：胶囊开关，沿用既有 `sendSetSwarmMode` / `sendSetPlanMode` RPC；Plan 开启时 composer 变虚线亮边框 + `PLAN` 实心标签。
- **上下文用量**：圆环 + 百分比，悬停展开 token 明细（移植现有 `ToolbarContextIndicator` 的 HoverCard 内容）。

### 7.5 数据流

- 会话列表/归档/搜索：`useSessions`（不动）
- 聊天流/工具事件/审批：`useSessionStream`（不动）；新 UI 只消费其返回的 messages、status、swarmMode、planMode、tokenUsage、send* 方法
- 会话短 id：取 sessionId 前 6 位显示于顶栏
- 设置/全局配置：沿用 `global-config-controls` 背后的 Rust 命令（视觉层重写）
- 主题：`useTheme` 扩展为新 tokens（data-theme 属性切换）

## 8. 错误处理

- 运行时未就绪：全屏覆盖层（新视觉），阻塞交互，支持重试/继续/下载 CLI——逻辑沿用 `runtime-readiness`
- 会话错误：沿用 `sessionsError` → sonner toast（右上角，richColors 关闭以贴合单色语言）
- 流中断/拒绝：审批卡片与工具卡片内联呈现终态（denied 红色、error 红色），可重试
- 空态：无会话时对话区显示品牌块 + 快捷引导（新建会话 / ⌘K）

## 9. 测试

- `npm test` 现存数据层测试必须全绿（hooks 不动）
- 新组件补关键行为测试：ToolCard 展开/折叠、ApprovalCard 三操作回调、StatusStrip 权限切换与持久化、会话侧栏分组渲染、主题切换
- 沿用 vitest + @testing-library + happy-dom 既有基建

## 10. 实施顺序（高层）

1. `src/` 快照 zip → 工作区根；删除旧 UI；依赖清理
2. tokens（index.css）+ 基础件（ui/）+ AppShell 骨架（轨/栏/面板伸缩）
3. 会话侧栏 + 顶栏（接通 useSessions）
4. 对话流渲染（接通 useSessionStream，含工具卡/diff/审批）
5. composer + 状态条（含权限自动应答器）
6. 设置对话框、运行时覆盖层换肤
7. 右侧"更改"面板（消费 streamSnapshot）
8. 双主题打磨、空态/错误态、测试补齐、验收

后续阶段按第 3 节"第一期不做"清单逐项补齐。

## 11. 验收标准（第一期）

- `npm run desktop` 启动后默认进入新 UI；会话创建/切换/聊天/审批/设置全链路可用
- 深/浅主题切换无残色；窗口从 1024px 到 4K 布局不崩
- `npm test`、`npm run build`、`cargo check` 全绿
- 视觉与 `assets/ui-v2-mockup.html` 一致（tokens 1:1 落进 Tailwind 主题）
