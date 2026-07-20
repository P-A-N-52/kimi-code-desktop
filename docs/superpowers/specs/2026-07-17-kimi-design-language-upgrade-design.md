# Kimi 设计语言升级 · 设计文档

日期：2026-07-17
范围：kimi-code-desktop 前端（src/），不改 Rust、不改业务逻辑、不改功能行为
方向：符合 Kimi 品牌设计语言的 AI coding 工具；双主题并重；组件层先行，分波迁移

## 0. 品牌基因与设计哲学

Kimi 品牌视觉：纯黑底 + 白色几何字标 + 标志性蓝点（Kimi 蓝）+ 星尘粒子。气质：科技、冷静、极简、深邃。

落地为 UI 语言：**黑白是舞台，Kimi 蓝是唯一主角**。界面约 95% 为无彩色层级，蓝色只出现在主操作、选中态、焦点环、链接、流式状态上。语义状态色只允许从 success/warning/info/destructive 四个令牌来，消灭"彩虹状态色"。

## 1. 令牌层（src/index.css 重写要点）

### 1.1 必须修复的 bug

删除 `index.css` 第 143-145 行的裸规则（未分层，压制所有 Tailwind border-color 工具类）：

```css
* {
  border-color: var(--border);
}
```

第 242-248 行 `@layer base` 内已有等价的 `@apply border-border outline-ring/50`，保留它。

### 1.2 亮色主题（:root）令牌值

```css
--radius: 0.5rem;
--background: oklch(1 0 0);
--foreground: oklch(0.16 0.005 264);
--card: oklch(1 0 0);
--card-foreground: oklch(0.16 0.005 264);
--popover: oklch(1 0 0);
--popover-foreground: oklch(0.16 0.005 264);
--primary: oklch(0.55 0.24 263);            /* Kimi 蓝 ≈ #0062FF */
--primary-foreground: oklch(0.98 0 0);
--secondary: oklch(0.955 0.002 264);
--secondary-foreground: oklch(0.21 0.006 264);
--muted: oklch(0.967 0.001 264);
--muted-foreground: oklch(0.5 0.015 264);
--accent: oklch(0.94 0.004 263);
--accent-foreground: oklch(0.21 0.006 264);
--destructive: oklch(0.577 0.245 27.325);
--destructive-foreground: oklch(1 0 0);
--border: oklch(0.915 0.004 264);
--input: oklch(0.915 0.004 264);
--ring: oklch(0.55 0.24 263);               /* 焦点环 = Kimi 蓝 */
--success: oklch(0.62 0.17 155);
--success-foreground: oklch(1 0 0);
--warning: oklch(0.72 0.15 75);
--warning-foreground: oklch(0.25 0 0);
--info: oklch(0.55 0.2 256);
--info-foreground: oklch(1 0 0);
--sidebar: oklch(0.972 0.002 264);
--sidebar-foreground: oklch(0.16 0.005 264);
--sidebar-primary: oklch(0.55 0.24 263);
--sidebar-primary-foreground: oklch(0.98 0 0);
--sidebar-accent: oklch(0.93 0.005 263);
--sidebar-accent-foreground: oklch(0.21 0.006 264);
--sidebar-border: oklch(0.915 0.004 264);
--sidebar-ring: oklch(0.55 0.24 263);
```

chart/code/shadow 令牌保持现有值不动。

### 1.3 暗色主题（.dark）令牌值

```css
--background: oklch(0.145 0.004 264);       /* 近纯黑，非纯黑 */
--foreground: oklch(0.96 0.002 264);
--card: oklch(0.175 0.005 264);
--card-foreground: oklch(0.96 0.002 264);
--popover: oklch(0.19 0.005 264);
--popover-foreground: oklch(0.96 0.002 264);
--primary: oklch(0.66 0.19 256);            /* 提亮版 Kimi 蓝 */
--primary-foreground: oklch(0.14 0.004 264);
--secondary: oklch(0.24 0.006 264);
--secondary-foreground: oklch(0.96 0.002 264);
--muted: oklch(0.24 0.006 264);
--muted-foreground: oklch(0.72 0.015 264);
--accent: oklch(0.28 0.008 264);
--accent-foreground: oklch(0.96 0.002 264);
--destructive: oklch(0.68 0.18 20);
--destructive-foreground: oklch(0.14 0.004 264);
--border: oklch(0.26 0.006 264);
--input: oklch(0.28 0.006 264);
--ring: oklch(0.66 0.19 256);
--success: oklch(0.72 0.16 155);
--success-foreground: oklch(0.14 0.004 264);
--warning: oklch(0.78 0.14 80);
--warning-foreground: oklch(0.14 0.004 264);
--info: oklch(0.66 0.19 256);
--info-foreground: oklch(0.14 0.004 264);
--sidebar: oklch(0.17 0.005 264);
--sidebar-foreground: oklch(0.96 0.002 264);
--sidebar-primary: oklch(0.66 0.19 256);
--sidebar-primary-foreground: oklch(0.14 0.004 264);
--sidebar-accent: oklch(0.28 0.008 264);
--sidebar-accent-foreground: oklch(0.96 0.002 264);
--sidebar-border: oklch(0.26 0.006 264);
--sidebar-ring: oklch(0.66 0.19 256);
```

### 1.4 其他 index.css 改动

- 删除 `--text-xs: 0.795rem` 私改（@theme inline 第 238 行），恢复标准 0.75rem = 12px
- `glow-pulse` keyframes（第 373-381 行）改为变量驱动：`box-shadow: 0 0 6px var(--glow-color, rgba(59, 130, 246, 0.4))` 的两帧脉冲，不再写死蓝色
- 全局滚动条（第 291-295 行附近）：宽度 6px→8px；thumb 改为 `background: color-mix(in oklab, var(--muted-foreground) 40%, transparent)`，hover 态 60%，去掉对伪元素不可靠的 `opacity` 写法
- body 14px、Inter Variable、暗色 view-transition 动画等其余部分保持不动

### 1.5 排版公约（迁移时执行）

- 最小字号 12px（text-xs），禁止新增 `text-[10px]`/`text-[11px]`；现存 10/11px 一律提升到 text-xs
- 层级靠字重+颜色：面板/视图标题 `text-sm font-semibold`；正文 14px；辅助信息 `text-xs text-muted-foreground`
- 时间戳统一 `text-xs text-muted-foreground`（tabular-nums 可选）

### 1.6 形状与线条公约

- 卡片容器 `rounded-xl`；控件（按钮/输入/菜单）`rounded-md`；状态徽章/计数 pill `rounded-full`；消息气泡 `rounded-2xl`
- 面板分隔线只来自 ResizableHandle（1px bg-border）；面板自身不再声明 `border-r`/`border-l`，消除双线
- 图标按钮尺寸只有两档：工具栏/底栏用 Button `size="icon"`（32px），列表行内动作用 `size="icon-xs"`

### 1.7 状态色映射公约

| 场景 | 令牌 |
|---|---|
| connecting / 搜索高亮 / 信息提示 | info |
| processing / streaming / diff 新增 / approve | success（approve 按钮见 3.3，用 primary） |
| waiting_input / 警告 | warning |
| error / diff 删除 / 危险操作 | destructive |
| idle / 禁用 | muted-foreground |
| Plan 模式 / Swarm 模式 / 聚焦态 | primary（用虚线 vs 实线区分模式，不再引入 teal/blue 调色板色） |

## 2. 组件层（第一波新建，纯增量）

全部放 `src/components/ui/`，遵循现有 shadcn 风格（cva + cn() + data-slot）。

### 2.1 status-dot.tsx

```tsx
type StatusDotStatus = "idle" | "connecting" | "processing" | "waiting_input" | "error";
// Props: { status: StatusDotStatus; pulse?: boolean; className?: string }
```

- 单一 span，rounded-full，默认 size-2（可用 className 覆盖为 size-2.5/size-3.5）
- 颜色映射：connecting→bg-info，processing→bg-success，waiting_input→bg-warning，error→bg-destructive，idle→bg-muted-foreground/40
- pulse=true 时：`animate-[glow-pulse_1.5s_ease-in-out_infinite]` 且用 `style={{ "--glow-color": ... }}` 按 status 设置发光色（info/success/warning/destructive 对应的半透明色，用 color-mix 或预设 rgba 映射表）

### 2.2 diff-badge.tsx

```tsx
// Props: { added: number; removed: number; className?: string }
```

渲染 `+N`（text-success）与 `-N`（text-destructive），`text-xs tabular-nums`，removed 为 0 时省略 `-0`。全仓 diff 增删显示只允许用它。

### 2.3 empty-state.tsx

```tsx
// Props: { icon: LucideIcon; title: string; description?: string; action?: ReactNode; className?: string }
```

垂直居中布局：图标放在 `size-10 rounded-xl bg-muted flex items-center justify-center` 容器内（图标 size-5 text-muted-foreground），标题 `text-sm font-medium`，描述 `text-xs text-muted-foreground`（max-w 约 280px 居中），可选 action。用于所有空列表/空视图。

## 3. 分域迁移任务（第二波并行）

### 3.1 features/chat + ai-elements/message.tsx + ai-elements/prompt-input.tsx

1. `components/activity-status-indicator.tsx:182-188` STATUS_COLORS 调色板色 → 改用 StatusDot（connecting/processing/waiting_input/error/idle 映射见 1.7），其余 amber/red 等调色板类同步收敛
2. `components/assistant-message.tsx:103-107` 流式状态点 → StatusDot（status=processing, pulse）
3. `components/chat-prompt-composer.tsx:219-220` 删除 `!border-blue-200`/`!border-teal-300` !important hack → planMode: `[&_[data-slot=input-group]]:border-dashed [&_[data-slot=input-group]]:border-primary/60`；swarmMode: `[&_[data-slot=input-group]]:border-primary/60 [&_[data-slot=input-group]]:bg-primary/5`；同行双 min-h（:261 `min-h-[220px] ... min-h-[300px]`）删除前一个
4. `components/chat-conversation.tsx:173-177` "有会话无消息"空态 → EmptyState（MessageSquare 图标，标题+快捷键引导描述）；无会话空态（:122-171）视觉对齐 EmptyState 语言
5. `components/virtualized-message-list.tsx:141-144` 末条消息 `mb-30` → `mb-8`；`status` 变体消息（:269）错误态可见性：`text-xs text-muted-foreground` → 若是 error 类用 text-destructive
6. `components/chat-workspace-header.tsx:122` 会话标题 `text-xs font-bold` → `text-sm font-semibold`，hover 显示 Pencil size-3.5 图标提示可重命名
7. `components/prompt-toolbar/toolbar-changes.tsx:44-46` diff 计数 → DiffBadge；toolbar-context/toolbar-queue 等 pill 保持 rounded-full
8. `components/global-config-controls.tsx` 竖线分隔符 `h-4 w-px bg-border/70`（:237,292,305,331,365）从 4-5 处减到最多 2 处（模型选择与其他控件之间保留一处即可）
9. ai-elements/message.tsx 用户消息气泡（:93-98）：全宽条 → 右对齐气泡 `ml-auto w-fit max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5`（容器保持 items-end）；附件轮播等其余不动
10. 消息内其余调色板色（reasoning 琥珀等不在本域）不管

### 3.2 features/sessions

1. `sessions.tsx:1014-1019` 选中态层级：当前会话 → `bg-accent text-foreground` + 左侧 2px 指示条 `[box-shadow:inset_2px_0_0_var(--primary)]`；多选态保持 `bg-primary/10 ring-1 ring-primary/30`；hover 保持 `hover:bg-secondary/60`
2. 桌面端行操作可发现性：:1094、:1107 的 `md:hidden` 归档/删除按钮 → 改为 `hover-reveal` 模式（行加 `group` 类，按钮 `opacity-0 group-hover:opacity-100 transition-opacity`，触屏由全局 hover:none 规则常显）
3. 时间戳 `text-[10px]`（:964,:1083）→ `text-xs text-muted-foreground`；列表/分组两种模式的时间戳排版统一为行内右置
4. 侧栏横向内边距统一：品牌行（:1291 `px-3 pt-2`）、标题行（:655 `px-3`）、搜索行（:815 `px-2`→`px-3`）、列表项（:1035 `px-2.5`→`px-2` 配合行内元素对齐即可，左右留 12px 视觉对齐）、Archived 区（:1125 `mx-2`）——目标：所有行的内容左边缘对齐在 12px
5. Archived 空态（:1141 单行文字）→ EmptyState 紧凑用法或至少 `text-xs` 居中
6. 图标按钮尺寸统一：标题行 `p-1`（:660）→ Button size="icon-xs"；多选条 `h-7 w-7`（:738）→ size="icon-xs"；视图切换（:843）保持 size="icon"
7. 侧栏容器底色应用 sidebar 令牌：`bg-sidebar text-sidebar-foreground`（App.tsx 传入的容器类不改，本域在 SessionsSidebar 根元素应用）

### 3.3 features/workbench + settings + agent-monitor + review + plan + skills

1. `workbench/workspace-panel.tsx:248` Swarm 徽章 `border-teal-500/20 bg-teal-500/5 text-teal-...` → primary 族：`border-primary/20 bg-primary/5 text-primary`；:689-691 Notice 组件 emerald/amber/red 调色板 → success/warning/destructive 令牌；:526-529 diff 统计 → DiffBadge
2. `workbench/workspace-panel.tsx:275-296` 头部 chrome 减重：6 个 tab 的 grid-cols-2 三行网格 → 单行横向可滚动 TabsList（text-xs，overflow-x-auto），头部总高压到约 80px 内
3. `agent-monitor/agent-monitor-item.tsx:51` 等 amber/blue/green 调色板色 → 1.7 状态映射（用 StatusDot 或 text-<token>）
4. `plan/plan-actions.tsx:19`、`review/diff-review-actions.tsx:29,66` Approve 按钮 `bg-emerald-600 hover:bg-emerald-700` → 默认 primary Button（不加自定义类）；reject/destructive 保持
5. `settings/settings-dialog.tsx`：
   - :1447,:2190 `border-destructive/40`、:1521 `border-primary/25` 级联修复后自动生效，检查视觉即可
   - :2158 `w-[min(1220px,...)]` 保留对话框宽度，但内容区加 `max-w-3xl`（About/General/BooleanRow 不再通栏拉伸）
   - :2289-2295 空态单行虚线框 → EmptyState
   - 其余调色板色收敛
6. skills/review/plan 面板内剩余调色板色按 1.7 收敛

### 3.4 App.tsx + components/ai-elements（除 message/prompt-input）+ features/tool + side-chat + startup + theme-toggle + kimi-cli-brand + components/ui/diff

1. `App.tsx:613` 面板 `border-r`、:752 折叠条 `border-l`、:778 容器 `border-l` 删除（分隔线只留 ResizableHandle）；:595 根容器底部 `pb-1` → `pb-3` 对称
2. `App.tsx:698-718` 底部工具条：ThemeToggle 改 ghost；侧栏容器应用 `bg-sidebar`（与 3.2-7 配合）；`pl-2` 对齐 12px
3. `components/ui/theme-toggle.tsx:20,28` variant outline → ghost，删除自定义 `hover:bg-accent/20`
4. `components/kimi-cli-brand.tsx:73-83` 版本号三档透明度 → 单行 `text-xs text-muted-foreground`：`v{desktopVersion} · CLI {cliVersion}`
5. `components/ai-elements/reasoning.tsx:172`、`subagent-steps.tsx:63`、`tool.tsx:366-368`、`message-search-dialog.tsx:70`（搜索高亮 bg-yellow-300 → bg-info/20 text-foreground）等调色板色按 1.7 收敛；tool.tsx 审批态用 warning
6. `features/tool/components/display-content.tsx:637-640` diff 计数 → DiffBadge；其余 green/orange 调色板收敛
7. `features/side-chat/side-chat-panel.tsx:101-107` 用户气泡 `bg-primary text-primary-foreground` → `bg-secondary text-secondary-foreground`（与主聊气泡语言统一）；FAB `bottom-6 right-6` 保持
8. `features/startup/runtime-readiness-overlay.tsx:58-64` blocking 用 XCircle text-destructive，非 blocking 用 AlertTriangle text-warning，不再两个都 AlertTriangle
9. `components/ui/diff/theme.css:37` 字体栈 `"Fira Code", ...` → `var(--font-mono)`；:910-926 硬编码 rgba → 语义令牌（黄色高亮用 warning 族、蓝色用 info 族、紫色删除或改 chart-5），并补上未定义的 `--color-yellow` 引用
10. `components/ai-elements/` 内 `max-h-[88vh]` 等尺寸任意值不动（功能性的）；只收敛颜色

### 3.5 明确不做

- 不动 Rust（src-tauri）、不动 hooks 数据层逻辑、不动 i18n 词条结构（新增文案走现有 t() 模式）
- 不卸载 @fontsource/iosevka（避免 lock 文件 churn，记为后续可选清理）
- 不改布局骨架（三栏 ResizablePanelGroup 保持）、不改路由/深链接行为
- 不新增依赖

## 5. 修订：精致化重构（2026-07-17 第二轮）

针对"粗糙感"截图审查后的第二轮调整：

1. **三层明度分层**：暗色主区加深至 oklch(0.13)，侧栏/工作台面板浮起 oklch(0.185)，卡片 oklch(0.205)；亮色侧栏加深至 oklch(0.962)。层级靠明度而非细线
2. **Edge-to-edge**：删除桌面端 12px 外框（App.tsx 根容器 padding 仅保留窄屏安全区），工作台面板底色改 bg-sidebar 与左侧栏一致
3. **Segmented 组件**（components/ui/segmented.tsx）：统一的分段控件，轨道 bg-muted(dark:bg-background)、选中 bg-card shadow-sm。应用于工作台 6-tab（替代原按钮行+横向滚动条，overflow 用 scrollbar-none）与会话列表视图切换（替代 ToggleGroup）
4. **EmptyState size="lg"**：大构图变体（size-16 图标容器+ring、text-base 标题），用于中央无会话空态；全仓 border-dashed 空态框改为 bg-muted/40 软井
5. **会话行排版**：标题 text-foreground/90、时间 text-muted-foreground/70 tabular-nums，建立层级
6. **FAB 中性化**：side-chat 浮动按钮从高饱和蓝球改为 bg-card border 中性浮钮
7. **原生标题栏跟随主题**：use-theme 在 Tauri 环境调用 getCurrentWindow().setTheme()
8. 新增 @utility scrollbar-none

## 4. 验证

- 每波完成后：`npm run build`（tsc -b && vite build）零错误
- 全部完成后：`npm test`（vitest run）全绿
- 人工走查清单：双主题切换检查——边框语义色生效（destructive 红框、primary 蓝框、focus 蓝环）、diff +/- 颜色一致、会话选中态可一眼定位、无 10px 文字、无双线分隔
