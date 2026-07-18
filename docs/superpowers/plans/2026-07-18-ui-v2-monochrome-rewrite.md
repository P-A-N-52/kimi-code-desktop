# UI V2 Monochrome Rewrite 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已定稿的 Monochrome Pro 设计（`docs/superpowers/specs/2026-07-18-ui-v2-monochrome-rewrite-design.md`）推倒重写 Kimi Code Desktop 的全部 UI，保留数据层。

**Architecture:** 旧 `src/` 整体快照 zip 到工作区根 → 删除旧 UI（`App.tsx`/`features/`/`components/`）→ 原位新建 `src/{app,ui,modules}/`。数据层（`src/hooks/`、`src/lib/`、`src/config/`）原样保留，仅把它被旧 UI 反向依赖的 6 个逻辑模块先迁入 `src/lib/`。

**Tech Stack:** React 19 · Tailwind CSS 4（`@theme inline`）· Radix UI · lucide-react · streamdown · diff（structuredPatch）· zustand · vitest + @testing-library/react

## Global Constraints

- **数据层冻结**：除 Task 1 指定的 3 行 import 修改外，不得改动 `src/hooks/`、`src/lib/`、`src/config/` 的任何文件。
- **无品牌强调色**：颜色只用于语义（绿=新增/通过、红=删除/危险、琥珀=审批/警示）；主按钮/发送键 = `--bright` 底 + `--bg` 字反转。
- **tokens 以 spec §6 为唯一标准**，1:1 落入 `src/index.css`。
- 代码风格：tab 缩进、双引号（biome 既有配置）；组件文件一律 `.tsx`，纯逻辑 `.ts`。
- 主题机制沿用 `useTheme`（切换 `<html>` 的 `.dark` class），新 CSS 必须同时提供 `:root`（亮）与 `.dark`（深）两套 tokens。
- 每个 Task 结束 `npm test` 与 `npm run build` 必须全绿；每个 Task 一个 commit。
- 旧视觉稿（验收基准）：`docs/superpowers/specs/assets/ui-v2-mockup.html`。

---

### Task 1: 归档快照 + 迁移数据层依赖 + 清场

**Files:**
- Create（zip 产物）: `../legacy-src-20260718.zip`（工作区根，git 不跟踪）
- Move: `src/features/chat/slash-command-catalog.ts` → `src/lib/slash-command-catalog.ts`（含 `.test.ts`）
- Move: `src/features/tool/store.ts`、`src/features/tool/tool-registry.ts` → `src/lib/tool-events/`（含两个 `.test.ts`）
- Move: `src/features/agent-monitor/agent-monitor-store.ts`、`src/features/agent-monitor/agent-monitor-sync.ts` → `src/lib/agent-monitor/`（含两个 `.test.ts`）
- Modify: `src/hooks/useSessionStream.ts:148,158,167`（仅 3 行 import 路径）
- Modify: `vite.config.ts`（删 `@ai-elements` alias）
- Modify: `tsconfig.app.json`（删 `@ai-elements` paths 与 exclude）
- Delete: `src/App.tsx`、`src/features/`、`src/components/`
- Create: `src/app/app.tsx`（占位外壳）、`src/ui/error-boundary.tsx`（从 `src/components/error-boundary.tsx` 平移，内容不变）
- Modify: `src/bootstrap.tsx:4-5`（import 路径）

**Interfaces:**
- Consumes: 现有仓库状态
- Produces: 可构建的空壳 `App` 默认导出；`@/lib/slash-command-catalog`、`@/lib/tool-events/store`、`@/lib/tool-events/tool-registry`、`@/lib/agent-monitor/store`、`@/lib/agent-monitor/sync` 五个新路径供数据层与后续任务使用

- [ ] **Step 1: 快照 zip**

```powershell
Compress-Archive -Path "C:\Users\administer\Desktop\kimi-cli-desktop\kimi-code-desktop\src" -DestinationPath "C:\Users\administer\Desktop\kimi-cli-desktop\legacy-src-20260718.zip" -Force
```

验证：`Test-Path ..\legacy-src-20260718.zip` 为 True。

- [ ] **Step 2: git mv 迁移 6 个逻辑模块（含测试）**

```powershell
cd kimi-code-desktop
git mv src/features/chat/slash-command-catalog.ts src/lib/slash-command-catalog.ts
git mv src/features/chat/slash-command-catalog.test.ts src/lib/slash-command-catalog.test.ts
git mv src/features/tool/store.ts src/lib/tool-events/store.ts
git mv src/features/tool/store.test.ts src/lib/tool-events/store.test.ts
git mv src/features/tool/tool-registry.ts src/lib/tool-events/tool-registry.ts
git mv src/features/tool/tool-registry.test.ts src/lib/tool-events/tool-registry.test.ts
git mv src/features/agent-monitor/agent-monitor-store.ts src/lib/agent-monitor/store.ts
git mv src/features/agent-monitor/agent-monitor-store.test.ts src/lib/agent-monitor/store.test.ts
git mv src/features/agent-monitor/agent-monitor-sync.ts src/lib/agent-monitor/sync.ts
git mv src/features/agent-monitor/agent-monitor-sync.test.ts src/lib/agent-monitor/sync.test.ts
```

- [ ] **Step 3: 修正 import**

`src/lib/agent-monitor/sync.ts` 内 `"./agent-monitor-store"` → `"./store"`；`src/lib/tool-events/store.ts` 内 `"./tool-registry"` 保持不变（同目录）。`src/lib/tool-events/store.test.ts`、`src/lib/agent-monitor/*.test.ts` 内被测模块引用按新文件名同步（`./store`、`./sync`、`./tool-registry`）。

`src/hooks/useSessionStream.ts` 仅改 3 行：

```ts
// 148 行: from "@/features/chat/slash-command-catalog" → from "@/lib/slash-command-catalog"
// 158 行: from "@/features/tool/store" → from "@/lib/tool-events/store"
// 167 行: from "@/features/agent-monitor/agent-monitor-sync" → from "@/lib/agent-monitor/sync"
```

- [ ] **Step 4: 删除旧 UI**

```powershell
git rm -r src/features src/components src/App.tsx
```

- [ ] **Step 5: 清理 alias**

`vite.config.ts` 删除 `resolve.alias` 中的 `"@ai-elements"` 行（保留 `"@"`）。`tsconfig.app.json` 删除 `paths` 中两个 `@ai-elements` 条目与 `exclude` 中的 `"src/components/ai-elements"`（保留 `"src/lib/api"`）。

- [ ] **Step 6: 平移 error boundary + 占位 App**

`src/ui/error-boundary.tsx`：内容与旧 `src/components/error-boundary.tsx` 完全一致（先 `git show HEAD:src/components/error-boundary.tsx > src/ui/error-boundary.tsx` 恢复再移动）。

`src/app/app.tsx`（占位）：

```tsx
export default function App() {
	return (
		<div className="flex h-dvh items-center justify-center bg-background text-foreground">
			<span className="font-mono text-sm text-muted">UI V2 shell</span>
		</div>
	);
}
```

`src/bootstrap.tsx` 改两行 import：

```tsx
import App from "./app/app.tsx";
import { ErrorBoundary } from "./ui/error-boundary";
```

- [ ] **Step 7: 验证全绿**

```powershell
npm test          # hooks + lib 既有测试（含迁移后的 4 个测试文件）全绿
npm run build     # tsc -b && vite build 通过
```

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "refactor: archive legacy UI to zip, relocate stream deps to lib, scaffold V2 shell"
```

---

### Task 2: Monochrome Pro tokens + 基础 UI 件

**Files:**
- Modify: `src/index.css`（整体重写）
- Create: `src/ui/button.tsx`、`src/ui/icon-button.tsx`、`src/ui/kbd.tsx`、`src/ui/status-pill.tsx`
- Create: `src/ui/dialog.tsx`、`src/ui/tooltip.tsx`、`src/ui/scroll-area.tsx`、`src/ui/switch.tsx`、`src/ui/separator.tsx`（Radix 薄封装）
- Test: `src/ui/button.test.tsx`、`src/ui/status-pill.test.tsx`

**Interfaces:**
- Consumes: `@fontsource-variable/inter`、`@fontsource/iosevka`（package.json 已有）、`cn`（`@/lib/utils`）
- Produces:
  - `<Button variant="primary"|"ghost"|"danger" size="sm"|"md">`
  - `<IconButton label string active?>`（必须 aria-label）
  - `<Kbd>`（等宽小键帽）
  - `<StatusPill icon? tone="neutral"|"amber"|"red" on?>`（`on`=激活态亮底）
  - Tailwind 语义类：`bg-background/elevated/secondary`、`text-foreground/bright/muted/faint`、`border-line/line-strong`、`text-success/danger/warn`、`font-mono`、`rounded-r1/r2/r3`

- [ ] **Step 1: 写 tokens 测试前的样式文件**

`src/index.css` 完整重写（关键部分；完整 tokens 值从 spec §6.1 逐行抄入）：

```css
@import "tailwindcss";
@import "@fontsource-variable/inter";
@import "@fontsource/iosevka";

@custom-variant dark (&:is(.dark *));

:root {
	--bg: #FAFAFA; --bg-elev: #FFFFFF; --bg-2: #F1F1F1;
	--hover: rgb(0 0 0 / 0.045); --active: rgb(0 0 0 / 0.07);
	--line: rgb(0 0 0 / 0.10); --line-strong: rgb(0 0 0 / 0.18);
	--fg: #1A1A1A; --bright: #000000;
	--muted-fg: #6E6E6E; --faint-fg: #ABABAB;
	--success: #1E9E64; --danger: #CE4444; --warn: #A87818;
	--success-bg: rgb(30 158 100 / 0.08);
	--danger-bg: rgb(206 68 68 / 0.07);
	--warn-bg: rgb(168 120 24 / 0.07);
	--shadow-pop: 0 12px 40px rgb(0 0 0 / 0.12), 0 2px 8px rgb(0 0 0 / 0.06);
	--r1: 6px; --r2: 8px; --r3: 10px;
}
.dark {
	--bg: #0A0A0A; --bg-elev: #121212; --bg-2: #181818;
	--hover: rgb(255 255 255 / 0.05); --active: rgb(255 255 255 / 0.08);
	--line: rgb(255 255 255 / 0.09); --line-strong: rgb(255 255 255 / 0.17);
	--fg: #E8E8E8; --bright: #FFFFFF;
	--muted-fg: #8B8B8B; --faint-fg: #565656;
	--success: #4DC08A; --danger: #DE6262; --warn: #D0A24A;
	--success-bg: rgb(77 192 138 / 0.08);
	--danger-bg: rgb(222 98 98 / 0.08);
	--warn-bg: rgb(208 162 74 / 0.07);
	--shadow-pop: 0 12px 40px rgb(0 0 0 / 0.55), 0 2px 8px rgb(0 0 0 / 0.35);
}

@theme inline {
	--color-background: var(--bg);
	--color-elevated: var(--bg-elev);
	--color-secondary: var(--bg-2);
	--color-foreground: var(--fg);
	--color-bright: var(--bright);
	--color-muted: var(--muted-fg);
	--color-faint: var(--faint-fg);
	--color-line: var(--line);
	--color-line-strong: var(--line-strong);
	--color-success: var(--success);
	--color-danger: var(--danger);
	--color-warn: var(--warn);
	--color-success-bg: var(--success-bg);
	--color-danger-bg: var(--danger-bg);
	--color-warn-bg: var(--warn-bg);
	--color-hover: var(--hover);
	--color-active: var(--active);
	--shadow-pop: var(--shadow-pop);
	--radius-r1: var(--r1); --radius-r2: var(--r2); --radius-r3: var(--r3);
	--font-sans: "Inter Variable", -apple-system, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei", sans-serif;
	--font-mono: "Iosevka", "JetBrains Mono", "Cascadia Code", Consolas, monospace;
}

@layer base {
	* { border-color: var(--line); }
	html, body { height: 100%; }
	body {
		background: var(--bg); color: var(--fg);
		font-size: 14px; line-height: 1.6; letter-spacing: -0.011em;
		-webkit-font-smoothing: antialiased;
	}
	::selection { background: var(--active); }
	*::-webkit-scrollbar { width: 8px; height: 8px; }
	*::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 4px; }
	*::-webkit-scrollbar-track { background: transparent; }
}
```

- [ ] **Step 2: 写失败测试 `src/ui/button.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
	it("primary 变体使用反转色", () => {
		render(<Button variant="primary">允许</Button>);
		const btn = screen.getByRole("button", { name: "允许" });
		expect(btn.className).toContain("bg-bright");
		expect(btn.className).toContain("text-background");
	});
	it("ghost 变体带发丝边框", () => {
		render(<Button variant="ghost">拒绝</Button>);
		expect(screen.getByRole("button", { name: "拒绝" }).className).toContain("border-line-strong");
	});
});
```

`src/ui/status-pill.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
	it("on 态显示指示点并高亮", () => {
		render(<StatusPill on>swarm</StatusPill>);
		const pill = screen.getByText("swarm").closest("button")!;
		expect(pill.className).toContain("bg-active");
	});
	it("tone=red 使用危险色", () => {
		render(<StatusPill tone="red">全放</StatusPill>);
		expect(screen.getByText("全放").closest("button")!.className).toContain("text-danger");
	});
});
```

- [ ] **Step 3: 跑测试确认失败**

`npx vitest run src/ui` → FAIL（模块不存在）。

- [ ] **Step 4: 实现基础件**

`src/ui/button.tsx`：

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-1.5 rounded-r1 text-[12.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				primary: "bg-bright text-background hover:opacity-85",
				ghost: "border border-line-strong text-muted hover:bg-hover hover:text-foreground",
				danger: "border border-danger/40 text-danger hover:bg-danger-bg",
			},
			size: { sm: "h-7 px-3", md: "h-8 px-4" },
		},
		defaultVariants: { variant: "primary", size: "sm" },
	},
);

export function Button({
	className, variant, size, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
	return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
```

`src/ui/icon-button.tsx`：

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function IconButton({
	label, active, className, children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={cn(
				"flex size-[30px] items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground",
				active && "bg-active text-bright",
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
```

`src/ui/kbd.tsx`：

```tsx
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
	return (
		<kbd
			className={cn(
				"rounded border border-line bg-secondary px-1 py-px font-mono text-[10px] text-faint",
				className,
			)}
			{...props}
		/>
	);
}
```

`src/ui/status-pill.tsx`：

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const pillVariants = cva(
	"inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 font-mono text-[11px] font-medium transition-colors",
	{
		variants: {
			tone: {
				neutral: "text-muted hover:bg-hover hover:text-foreground",
				amber: "border-warn/30 bg-warn-bg text-warn",
				red: "border-danger/30 bg-danger-bg text-danger",
			},
			on: { true: "border-line-strong bg-active text-bright", false: "" },
		},
		defaultVariants: { tone: "neutral", on: false },
	},
);

export function StatusPill({
	className, tone, on, children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof pillVariants> & { children: ReactNode }) {
	return (
		<button type="button" className={cn(pillVariants({ tone, on }), className)} {...props}>
			{on !== undefined && (
				<span className={cn("size-[5px] rounded-full bg-current opacity-0 transition-opacity", on && "opacity-100")} />
			)}
			{children}
		</button>
	);
}
```

`src/ui/dialog.tsx`、`tooltip.tsx`、`scroll-area.tsx`、`switch.tsx`、`separator.tsx`：对 `@radix-ui/react-dialog` / `react-tooltip` / `react-scroll-area` / `react-switch` / `react-separator` 的薄封装，样式类同 shadcn 但替换为新 tokens（`bg-elevated`、`border-line-strong`、`rounded-r2/r3`、`shadow-pop`、`text-foreground`）。参照旧 `src/components/ui/dialog.tsx` 的结构，把颜色类替换为新语义类即可（旧文件在 zip 快照与 git 历史中可查）。

- [ ] **Step 5: 跑测试确认通过 + build 绿**

`npx vitest run src/ui` → PASS；`npm run build` → 绿。

- [ ] **Step 6: Commit**

```powershell
git add -A; git commit -m "feat(ui): add Monochrome Pro tokens and base primitives"
```

---

### Task 3: AppShell 布局骨架

**Files:**
- Create: `src/app/app-shell.tsx`、`src/app/empty-state.tsx`、`src/modules/rail/app-rail.tsx`
- Modify: `src/app/app.tsx`（接入骨架 + 主题初始化 + 运行时就绪门）
- Test: `src/app/app-shell.test.tsx`

**Interfaces:**
- Consumes: `useTheme`（`@/hooks/use-theme`）、`IconButton`、`checkRuntimeReadiness/isTauri/showWindow`（`@/lib/tauri-api`）
- Produces:
  - `<AppShell rail sidebar topbar panel panelOpen onPanelToggle>`：sidebar/panel 为 ReactNode 插槽；宽度动画 250ms；sidebar 收起后宽度 0
  - `<AppRail onNewSession onToggleSessions onOpenSettings sessionsActive runningCount>`
  - 布局常量：`RAIL_WIDTH=52`、`SIDEBAR_WIDTH=260`、`PANEL_WIDTH=400`

- [ ] **Step 1: 失败测试 `src/app/app-shell.test.tsx`**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell", () => {
	it("点击面板开关回调 onPanelToggle", () => {
		const onToggle = vi.fn();
		render(
			<AppShell rail={<div />} sidebar={<div />} topbar={<div />} panel={<div />}
				panelOpen onPanelToggle={onToggle}>
				<div>content</div>
			</AppShell>,
		);
		expect(screen.getByText("content")).toBeInTheDocument();
	});
	it("panelOpen=false 时面板宽度为 0", () => {
		const { container } = render(
			<AppShell rail={<div />} sidebar={<div />} topbar={<div />} panel={<div>P</div>}
				panelOpen={false} onPanelToggle={() => {}}>
				<div />
			</AppShell>,
		);
		const panel = container.querySelector("[data-slot=workspace-panel]")!;
		expect(panel.className).toContain("w-0");
	});
});
```

- [ ] **Step 2: 实现 AppShell**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const RAIL_WIDTH = 52;
export const SIDEBAR_WIDTH = 260;
export const PANEL_WIDTH = 400;

export function AppShell({
	rail, sidebar, topbar, panel, panelOpen, onPanelToggle, children,
}: {
	rail: ReactNode; sidebar: ReactNode; topbar: ReactNode; panel: ReactNode;
	panelOpen: boolean; onPanelToggle: () => void; children: ReactNode;
}) {
	return (
		<div className="flex h-dvh overflow-hidden bg-background text-foreground">
			<div className="flex w-[52px] shrink-0 flex-col items-center gap-0.5 py-2.5">{rail}</div>
			<div
				data-slot="sessions-sidebar"
				className="shrink-0 overflow-hidden border-r border-transparent transition-[width,border-color] duration-200"
				style={{ width: SIDEBAR_WIDTH }}
			>
				{sidebar}
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex h-12 shrink-0 items-center justify-center px-3">{topbar}</div>
				<div className="flex min-h-0 flex-1">{children}</div>
			</div>
			<div
				data-slot="workspace-panel"
				className={cn(
					"shrink-0 overflow-hidden border-l border-transparent transition-[width,border-color] duration-250",
					panelOpen ? "border-line" : "w-0",
				)}
				style={panelOpen ? { width: PANEL_WIDTH } : undefined}
			>
				{panel}
			</div>
		</div>
	);
}
```

`src/modules/rail/app-rail.tsx`：logo 方块（`size-[26px] rounded-r1 bg-bright font-mono text-[13px] font-semibold text-background`，字母 K）、四个 `IconButton`（MessagesSquare/Plus/Search；底部 Moon·Sun/Settings，lucide 1.5px stroke 即 `strokeWidth={1.5}` size 15–16），运行数 `runningCount>0` 时会话钮右上绿色呼吸点（`bg-success` + `animate-pulse` 自定义 breathe keyframes 写入 index.css utilities）。

- [ ] **Step 3: app.tsx 接入**

`src/app/app.tsx`：调用 `useTheme()` 初始化主题；`isTauri()` 时 `showWindow()`；运行时就绪逻辑照搬旧 App.tsx 的 `runRuntimeReadinessCheck`/`shouldPauseRuntime`（引入 `@/lib/runtime-readiness`、`@/lib/tauri-api`），未就绪渲染 Task 8 的覆盖层占位 `<div data-slot="readiness-gate"/>`（Task 8 替换为真组件）；就绪渲染 AppShell，sidebar/topbar/panel 暂时传占位 `null`，children 为 `<EmptyState/>`。

`src/app/empty-state.tsx`：居中品牌块（logo 方块 + `font-mono text-[13px] text-muted`「给 Kimi 布置一个任务」+ `<Kbd>⌘K</Kbd>` 提示）。

- [ ] **Step 4: 测试通过 + build 绿 → Commit**

`npx vitest run src/app` PASS；`npm run build` 绿。

```powershell
git add -A; git commit -m "feat(app): add AppShell layout skeleton with rail and slide panel"
```

---

### Task 4: 会话侧栏 + 顶栏（接通 useSessions）

**Files:**
- Create: `src/modules/sessions/session-groups.ts`（纯函数）、`src/modules/sessions/sessions-sidebar.tsx`、`src/modules/sessions/create-session-dialog.tsx`
- Create: `src/modules/topbar/topbar.tsx`
- Modify: `src/app/app.tsx`（接入 useSessions）
- Test: `src/modules/sessions/session-groups.test.ts`

**Interfaces:**
- Consumes: `useSessions({enabled})`（`@/hooks/useSessions`，返回见 spec §7.5）；`Session`（`@/lib/api/models`）
- Produces:
  - `groupSessionsByDay(sessions: Session[], now?: Date): { label: string; items: Session[] }[]`（分组：今天/昨天/本周/更早，各组内保持传入顺序）
  - `<SessionsSidebar sessions selectedId searchQuery onSearch onSelect onCreate onDelete onRename running>` 
  - `<Topbar title shortId panelOpen onTogglePanel>`

- [ ] **Step 1: 失败测试 `session-groups.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { Session } from "@/lib/api/models";
import { groupSessionsByDay } from "./session-groups";

const s = (id: string, daysAgo: number, now: Date): Session =>
	({ sessionId: id, title: id, lastUpdated: new Date(now.getTime() - daysAgo * 86400000) }) as Session;

describe("groupSessionsByDay", () => {
	it("按 今天/昨天/本周/更早 分组且跳过空组", () => {
		const now = new Date("2026-07-18T12:00:00");
		const groups = groupSessionsByDay([s("a", 0, now), s("b", 1, now), s("c", 3, now), s("d", 10, now)], now);
		expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "本周", "更早"]);
		expect(groups[3].items[0].sessionId).toBe("d");
	});
});
```

- [ ] **Step 2: 实现 `session-groups.ts`（同一自然日为今天；昨天=前一自然日；本周=今天起 7 天内；其余更早）**

```ts
import type { Session } from "@/lib/api/models";

export type SessionGroup = { label: string; items: Session[] };

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function groupSessionsByDay(sessions: Session[], now: Date = new Date()): SessionGroup[] {
	const today = startOfDay(now);
	const dayMs = 86400000;
	const buckets: SessionGroup[] = [
		{ label: "今天", items: [] },
		{ label: "昨天", items: [] },
		{ label: "本周", items: [] },
		{ label: "更早", items: [] },
	];
	for (const session of sessions) {
		const t = startOfDay(new Date(session.lastUpdated));
		const diff = today - t;
		if (diff <= 0) buckets[0].items.push(session);
		else if (diff < 2 * dayMs) buckets[1].items.push(session);
		else if (diff < 7 * dayMs) buckets[2].items.push(session);
		else buckets[3].items.push(session);
	}
	return buckets.filter((b) => b.items.length > 0);
}
```

- [ ] **Step 3: 实现侧栏与顶栏组件**

`SessionsSidebar`：顶部搜索框（`border border-line rounded-r2`，右侧 `<Kbd>⌘K</Kbd>`，值/回调受控）；`groupSessionsByDay` 渲染分组，组标题 `font-mono text-[10px] uppercase tracking-[0.09em] text-faint`；条目：标题 13px medium + `font-mono text-[10.5px] text-faint` 元信息行（`workDir` 尾段 + `formatRelativeTime(lastUpdated)`，`formatRelativeTime` 从 `@/hooks/utils` 导入）；选中 = `bg-active` + 左侧 2px `bg-bright` 指示条（`::before` 或绝对定位 span）；运行中条目标题前绿色呼吸点。底部用户区跳过（v1 无账户体系，放主题/设置已在图标轨）。

`CreateSessionDialog`：Radix Dialog；输入 workDir（占位「工作目录，如 C:\projects\foo」）+ 「浏览…」下拉列出 `fetchWorkDirs()` 结果；确认调 `createSession(workDir)`；失败文案展示 `sessionsError`。

`Topbar`：居中按钮（标题 13px/550 + `font-mono text-[10.5px] text-faint` 的 `#`+sessionId 前 6 位 + ChevronDown size 12）；右侧 `IconButton`（Share2）与 `IconButton active={panelOpen}`（PanelRight）触发 `onTogglePanel`。

- [ ] **Step 4: app.tsx 接通**

`useSessions({ enabled: runtimeEnabled })`；`sessions` 传侧栏；`selectSession` 切换；`createSession/deleteSession/renameSession/searchQuery/setSearchQuery` 全接线；`currentSession` 标题给 Topbar；侧栏 `running` = `sessions.some(s => s.isRunning)`。会话选中后 children 区域仍渲染 `<EmptyState/>`（Task 5 替换为对话流）。

- [ ] **Step 5: 测试 + build 绿 → Commit**

```powershell
npx vitest run src/modules/sessions
npm run build
git add -A; git commit -m "feat(sessions): add sessions sidebar with day grouping and topbar"
```

---

### Task 5: 对话流（消息渲染 + 工具卡 + 审批/提问卡）

**Files:**
- Create: `src/modules/conversation/conversation-view.tsx`、`message-list.tsx`、`user-message.tsx`、`ai-message.tsx`、`thinking-block.tsx`、`tool-card.tsx`、`diff-view.tsx`、`diff-display.ts`、`term-view.tsx`、`code-block.tsx`、`approval-card.tsx`、`question-card.tsx`、`streaming-caret.tsx`
- Modify: `src/app/app.tsx`（选中会话后渲染 ConversationView）
- Test: `src/modules/conversation/diff-display.test.ts`、`tool-card.test.tsx`、`approval-card.test.tsx`

**Interfaces:**
- Consumes: `useSessionStream`（`@/hooks/useSessionStream`；实例化参数与旧容器一致： `{ sessionId, baseUrl: getApiBaseUrl(), onError, onSessionStatus, autoConnect: Boolean(currentSession?.isRunning) }`，`getApiBaseUrl` 从 `@/lib/tauri-api` 导入——以旧 `chat-workspace-container.tsx:116` 的实际 import 为准）；`LiveMessage`（`@/hooks/types`）；`streamdown`（markdown）
- Produces:
  - `<ConversationView sessionId currentSession onSessionStatus />`：内部持有 useSessionStream，向外暴露 stream 状态（后续 Task 6/7 需要 messages、respondToApproval、status）
  - `parseDiffDisplay(data: unknown): DiffDisplayData | null`（`{type:"diff", path, old_text, new_text, is_summary?}` 类型守卫）
  - `<ToolCard>` / `<ApprovalCard onRespond(requestId, decision)>` / `<QuestionCard onRespond(requestId, answers)>`

- [ ] **Step 1: 失败测试**

`diff-display.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseDiffDisplay } from "./diff-display";

describe("parseDiffDisplay", () => {
	it("识别合法 diff display block", () => {
		expect(parseDiffDisplay({ type: "diff", path: "a.ts", old_text: "1", new_text: "2" }))
			.toMatchObject({ path: "a.ts" });
	});
	it("拒绝缺字段的 block", () => {
		expect(parseDiffDisplay({ type: "diff", path: "a.ts" })).toBeNull();
		expect(parseDiffDisplay(null)).toBeNull();
	});
});
```

`tool-card.test.tsx`：渲染折叠态（只有摘要行）→ 点击 head 展开出现 `[data-slot=tool-body]` → 再点收起。`approval-card.test.tsx`：点击「允许」回调 `("r1","approve")`；「拒绝」`("r1","reject")`；「本会话不再询问」`("r1","approve_for_session")`。

- [ ] **Step 2: 纯函数 `diff-display.ts`**

```ts
export type DiffDisplayData = {
	type: "diff";
	path: string;
	old_text: string;
	new_text: string;
	is_summary?: boolean;
};

export function parseDiffDisplay(data: unknown): DiffDisplayData | null {
	if (typeof data !== "object" || data === null) return null;
	const r = data as Record<string, unknown>;
	if (typeof r.old_text !== "string" || typeof r.new_text !== "string") return null;
	return {
		type: "diff",
		path: typeof r.path === "string" ? r.path : "",
		old_text: r.old_text,
		new_text: r.new_text,
		is_summary: r.is_summary === true,
	};
}
```

- [ ] **Step 3: 消息组件**

- `UserMessage`：右对齐 `max-w-[82%] rounded-r3 border border-line bg-secondary px-3.5 py-2.5 text-[14px]`。
- `AiMessage`：20px logo 方块 + 正文；正文 markdown 用 `streamdown` 的 `<Streamdown>` 渲染；`code` 行内码样式 `font-mono text-[12px] rounded border border-line bg-secondary px-1`。
- `ThinkingBlock`：`font-mono text-[11px] text-faint` 标题行「思考过程 · {thinkingDuration}s」+ 可折叠正文（`text-muted text-[13px]`），默认折叠。
- `CodeBlock`：头部（语言 `font-mono text-[11px] text-muted` + 复制按钮 `navigator.clipboard.writeText`）+ `<pre className="overflow-x-auto p-3.5 font-mono text-[12px] leading-[1.75]">`。v1 不做语法高亮（streamdown 自带的走 streamdown 默认，不做额外定制）。
- `StreamingCaret`：`inline-block h-[15px] w-[7px] animate-[blink_1s_steps(2)_infinite] rounded-[1px] bg-foreground align-text-bottom`（blink keyframes 进 index.css）。

- [ ] **Step 4: ToolCard + DiffView + TermView**

`ToolCard`（props: `{ title, state, input, display, output, errorText, isError, defaultOpen? }`）：
- head（`button`，hover:bg-hover）：单色 lucide 图标（按 title 映射：Read→FileText、Edit/MultiEdit/Write→Pencil、Bash→SquareChevronRight（或 Terminal）、默认→Wrench，size 13，strokeWidth 1.5，`text-muted`）+ `font-mono text-[12px] font-semibold` 工具名 + `font-mono text-[11.5px] text-muted` 参数摘要（从 `input` 取 `file_path`/`path`/`command`/`pattern` 第一个存在的字段，缺省 JSON.stringify 截断 60 字符）+ 右侧状态（运行中：`text-faint` spinner；成功 `text-success`；`+n −n`（若有 diff display）；错误 `text-danger`）+ chevron 旋转。
- body：首个 `parseDiffDisplay` 命中的 display block → `<DiffView>`；否则 `output` → `<TermView>`（`font-mono text-[11.5px] leading-[1.75] whitespace-pre-wrap`，$ 提示符行 `text-faint`，✓/passed 行 `text-success`）；`isError` 时 `errorText` 用 `text-danger`。

`DiffView`：懒加载 `diff` 包（单例 promise 模式，照搬旧 display-content.tsx 的 `loadDiffModule`），`structuredPatch("file","file",old_text,new_text,"","")` → hunks 渲染：文件头（`bg-secondary font-mono text-[11px] text-muted` + `+adds −dels`，adds/dels 从 hunks 行统计）；行渲染：`grid grid-cols-[34px_14px_1fr]`，行号 `text-faint tabular-nums text-right pr-2.5`，add 行 `bg-success-bg shadow-[inset_2px_0_0_var(--success)]`、del 行 `bg-danger-bg shadow-[inset_2px_0_0_var(--danger)]`，上下文行 `text-muted`；`is_summary` 时只渲染文件头 + 「摘要」标记。

- [ ] **Step 5: ApprovalCard + QuestionCard**

`ApprovalCard`（props: `{ approval: NonNullable<LiveMessage["toolCall"]>["approval"], display, onRespond }`）：
- 容器：`rounded-r2 border border-warn/30 bg-warn-bg`
- 头部：TriangleAlert size 13 `text-warn` + 标题（`approval.description || approval.action`，13px/550）+ 右侧 `font-mono text-[10px] tracking-[0.08em] text-warn border border-warn/35 rounded px-1.5 py-px`「APPROVAL」
- display 中有 diff → 迷你 DiffView；有命令文本 → `rounded-r1 border border-line bg-black/20 px-2.5 py-2 font-mono text-[11.5px] text-muted`
- 按钮行：`<Button variant="primary">允许<Kbd>⏎</Kbd></Button>` → `onRespond(id,"approve")`；`<Button variant="ghost">拒绝<Kbd>Esc</Kbd></Button>` → `"reject"`；`<Button variant="ghost">本会话不再询问</Button>` → `"approve_for_session"`
- `approval.resolved` 或 `submitted` 时按钮禁用并显示终态文案（`已批准`/`已拒绝`，成功/危险色）。

`QuestionCard`：对 `question.questions`（`QuestionItem[]`）逐题渲染：`header` 小标题 + 选项列表（`multi_select` → checkbox，否则 radio）+ `other_label` 存在时附加自由输入；「提交」聚合为 `Record<string,string>`（key=`question.header`）回调 `onRespond(question.id, answers)`；键盘/校验从简。`resolved` 后只读展示所选答案。

- [ ] **Step 6: ConversationView 组装**

```tsx
const stream = useSessionStream({
	sessionId,
	baseUrl: getApiBaseUrl(),
	onError,
	onSessionStatus,
	autoConnect: Boolean(currentSession?.isRunning),
});
```

`MessageList`：`flex-1 overflow-y-auto`，内容列 `mx-auto max-w-[44rem] px-6`；按 `msg.variant` 分派：user→`UserMessage`；tool→`ToolCard`（`toolCall.state==="approval-requested"` 且有 `approval` → `ApprovalCard`，`question-requested` → `QuestionCard`）；thinking→`ThinkingBlock`；其余 assistant 文本→`AiMessage`（`isStreaming` 时尾部 `StreamingCaret`）。自动滚动：`useRef` + 消息数变化时 `scrollTo({top: scrollHeight})`（用户上翻超过 200px 时暂停跟随，回底恢复——用 `use-stick-to-bottom`（已在 deps）可简化）。app.tsx 在选中会话时用 `<ConversationView>` 替换 `<EmptyState/>`，`onSessionStatus` 沿用旧 App.tsx 的 `handleSessionStatus` 逻辑（`applySessionStatus` + `prompt_` 完成时 `refreshSession` + `config_update` 广播）。

- [ ] **Step 7: 测试 + build 绿 → Commit**

```powershell
npx vitest run src/modules/conversation
npm run build
git add -A; git commit -m "feat(conversation): add message stream with tool cards, diffs, approvals and questions"
```

---

### Task 6: Composer + 状态条（权限/swarm/plan/上下文）

**Files:**
- Create: `src/modules/composer/composer.tsx`
- Create: `src/modules/statusbar/status-strip.tsx`、`permission-mode.ts`、`context-ring.tsx`
- Modify: `src/modules/conversation/conversation-view.tsx`（底部挂载 composer + 状态条；暴露 stream 字段）
- Test: `src/modules/statusbar/permission-mode.test.ts`

**Interfaces:**
- Consumes: useSessionStream 返回的 `sendMessage/cancel/status/planMode/sendSetPlanMode/swarmMode/sendSetSwarmMode/contextUsage/tokenUsage/messages/respondToApproval`
- Produces:
  - `<Composer onSend(text) onCancel busy planMode />`
  - `type PermissionMode = "ask" | "auto" | "yolo"`；`usePermissionMode(sessionId): { mode, setMode }`（localStorage per session，key `kimi-code-desktop.permission-mode-by-session.v1`，结构 `{[sessionId]: PermissionMode}`）
  - `shouldAutoApprove(mode: PermissionMode, toolTitle: string): boolean`（ask→false；yolo→true；auto→白名单）
  - 白名单常量 `SAFE_AUTO_APPROVE_TOOLS = ["Read","Glob","Grep","List","LS","Search","TodoWrite"]`

- [ ] **Step 1: 失败测试 `permission-mode.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { SAFE_AUTO_APPROVE_TOOLS, shouldAutoApprove } from "./permission-mode";

describe("shouldAutoApprove", () => {
	it("ask 模式全部不自动批准", () => {
		expect(shouldAutoApprove("ask", "Read")).toBe(false);
	});
	it("yolo 模式全部自动批准", () => {
		expect(shouldAutoApprove("yolo", "Bash")).toBe(true);
	});
	it("auto 模式只放行白名单", () => {
		expect(shouldAutoApprove("auto", "Read")).toBe(true);
		expect(shouldAutoApprove("auto", "Bash")).toBe(false);
		expect(SAFE_AUTO_APPROVE_TOOLS).toContain("Glob");
	});
});
```

- [ ] **Step 2: 实现 `permission-mode.ts`**

```ts
import { useCallback, useEffect, useState } from "react";

export type PermissionMode = "ask" | "auto" | "yolo";
export const SAFE_AUTO_APPROVE_TOOLS = ["Read", "Glob", "Grep", "List", "LS", "Search", "TodoWrite"];
const STORAGE_KEY = "kimi-code-desktop.permission-mode-by-session.v1";

export function shouldAutoApprove(mode: PermissionMode, toolTitle: string): boolean {
	if (mode === "yolo") return true;
	if (mode === "auto") return SAFE_AUTO_APPROVE_TOOLS.some((t) => toolTitle.toLowerCase() === t.toLowerCase());
	return false;
}

function readMode(sessionId: string | null): PermissionMode {
	if (!sessionId) return "ask";
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, PermissionMode>) : {};
		return map[sessionId] ?? "ask";
	} catch { return "ask"; }
}

export function usePermissionMode(sessionId: string | null) {
	const [mode, setModeState] = useState<PermissionMode>(() => readMode(sessionId));
	useEffect(() => { setModeState(readMode(sessionId)); }, [sessionId]);
	const setMode = useCallback((next: PermissionMode) => {
		setModeState(next);
		if (!sessionId) return;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const map = raw ? (JSON.parse(raw) as Record<string, PermissionMode>) : {};
			map[sessionId] = next;
			localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
		} catch { /* ignore */ }
	}, [sessionId]);
	return { mode, setMode };
}
```

- [ ] **Step 3: Composer**

`rounded-r3 border border-line-strong bg-elevated shadow-pop px-3 pt-3 pb-2`；`focus-within:border-color-mix`（用 `focus-within:border-line-strong` 加 `focus-within:shadow-[0_0_0_1px_var(--line-strong)]`，保持单色）；textarea 自动长高（`field-sizing: content` 或 ref 调整，`max-h-40`）；`Enter` 发送、`Shift+Enter` 换行；`busy`（status!=="ready"）时发送钮变为停止钮（Square 图标）调 `onCancel`；底栏：Plus/命令/上下文三个占位钮（点击 `toast("后续版本接入")`，sonner）+ planMode 时显示 `PLAN` 实心标签（`bg-bright text-background font-mono text-[9.5px] tracking-[0.12em]`）且容器边框变 `border-dashed`；右侧 `model-pill`（v1 静态展示 `kimi-k2` + ChevronDown，`font-mono text-[11.5px]`）+ 发送钮（`size-7 rounded-full bg-bright text-background`，ArrowUp size 13）。

- [ ] **Step 4: StatusStrip + 自动应答**

`StatusStrip`（props: `{ sessionId, planMode, swarmMode, onPlanMode, onSwarmMode, contextUsage, tokenUsage }`）：
- 左起：`PermissionModeSelect`（StatusPill + 上弹菜单，菜单项：批准=ShieldCheck「每个操作执行前逐一确认」/自动=Zap「安全操作自动批准，危险操作仍询问」/全放=Flame「全部自动批准，不再询问，风险自负」；当前项 ✓；选中后 pill 文案与 tone 联动：ask→neutral、auto→amber、yolo→red）
- swarm/plan 两个 `StatusPill on={...}` 开关
- 右侧：`ContextRing`（SVG 圆环 `stroke-dasharray` 按 `contextUsage*2πr`；文案 `{(contextUsage*100).toFixed(1)}%`；HoverCard 展开 tokenUsage 明细：Input(other/cache read/cache write)/Output，紧凑数字 `Intl.NumberFormat("en-US",{notation:"compact"})`）+ 快捷键提示 `font-mono text-[10.5px] text-faint`
- 自动应答副作用放在 `ConversationView`：`useEffect(() => { for (const m of messages) if (m.toolCall?.state === "approval-requested" && m.toolCall.approval && !m.toolCall.approval.submitted && !m.toolCall.approval.resolved && shouldAutoApprove(mode, m.toolCall.title)) void respondToApproval(m.toolCall.approval.id, "approve"); }, [messages, mode, respondToApproval]);`

- [ ] **Step 5: 测试 + build 绿 → Commit**

```powershell
npx vitest run src/modules/statusbar src/modules/composer
npm run build
git add -A; git commit -m "feat(composer): add composer with permission mode, swarm/plan toggles and context ring"
```

---

### Task 7: 右侧更改面板

**Files:**
- Create: `src/modules/workspace/derive-changes.ts`、`changes-panel.tsx`
- Modify: `src/app/app.tsx`（面板插槽接入；`panelOpen` 状态）
- Test: `src/modules/workspace/derive-changes.test.ts`

**Interfaces:**
- Consumes: `LiveMessage[]`（来自 ConversationView，通过 app.tsx 提升的 `onMessagesChange` 快照）；pending approvals（同源）
- Produces:
  - `type ChangeEntry = { path: string; adds: number; dels: number; display: DiffDisplayData }`
  - `deriveChanges(messages: LiveMessage[]): ChangeEntry[]`（遍历 toolCall display 中的 diff block，按 path 去重，后出现的覆盖先出现的；adds/dels 用 `diff` 的 structuredPatch 统计——测试注入假数据时允许传入可选 `computeStats` 参数便于断言）
  - `<ChangesPanel changes pendingApprovals onApproveAll onRejectAll onClose />`

- [ ] **Step 1: 失败测试 `derive-changes.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { deriveChanges } from "./derive-changes";

const toolMsg = (id: string, path: string, oldT: string, newT: string): LiveMessage => ({
	id, role: "assistant", variant: "tool",
	toolCall: {
		title: "Edit", type: "tool-Edit" as never, state: "output-available",
		display: [{ type: "diff", data: { type: "diff", path, old_text: oldT, new_text: newT } }],
	},
});

describe("deriveChanges", () => {
	it("提取 diff 变更并按 path 去重（后者覆盖前者）", () => {
		const changes = deriveChanges([
			toolMsg("1", "a.ts", "x", "y"),
			toolMsg("2", "b.ts", "1", "2"),
			toolMsg("3", "a.ts", "y", "z"),
		], () => ({ adds: 1, dels: 1 }));
		expect(changes.map((c) => c.path)).toEqual(["b.ts", "a.ts"]);
		expect(changes.find((c) => c.path === "a.ts")?.display.new_text).toBe("z");
	});
});
```

- [ ] **Step 2: 实现 `derive-changes.ts`**（Map<path, entry>，后写覆盖并维持插入序——后者覆盖时移到末尾：`map.delete(path); map.set(path, entry)`；`computeStats` 默认实现内部懒加载 `diff` 包，测试注入同步假实现）

- [ ] **Step 3: 实现 `ChangesPanel`**

- 头部 48px：页签「更改(n)/文件/Agent」（仅"更改"可用，其余点击 `toast("后续版本接入")`；n=`changes.length`，`font-mono text-[10px] text-faint`）+ 右侧关闭 IconButton（X）
- 列表：每个 `ChangeEntry` 一张卡（`rounded-r2 border border-line bg-elevated`），head=FileText 图标 + `font-mono text-[11.5px]` 路径 + `+adds −dels`；点击展开迷你 DiffView（复用 Task 5 组件，只显示首个 hunk 前 8 行）
- 底部固定：`全部接受`（primary）/`全部拒绝`（ghost），点击对 `pendingApprovals` 逐个 `respondToApproval(id, "approve"|"reject")`；`pendingApprovals.length===0` 时禁用
- app.tsx：`panelOpen` 状态（默认 `changes.length>0` 时自动开，手动关后不再自动开——用 ref 记录）；`onMessagesChange` 在 ConversationView 挂载时传入，把 messages 提升到 app.tsx 供面板派生

- [ ] **Step 4: 测试 + build 绿 → Commit**

```powershell
npx vitest run src/modules/workspace
npm run build
git add -A; git commit -m "feat(workspace): add slide-out changes panel derived from tool diffs"
```

---

### Task 8: 设置对话框 + 运行时就绪覆盖层

**Files:**
- Create: `src/modules/settings/settings-dialog.tsx`
- Create: `src/modules/readiness/readiness-overlay.tsx`
- Modify: `src/app/app.tsx`（替换占位 gate；图标轨设置钮接入）
- Test: `src/modules/readiness/readiness-overlay.test.tsx`

**Interfaces:**
- Consumes: `useGlobalConfig`（`@/hooks/useGlobalConfig`，返回 `{config, isLoading, isUpdating, error, refresh, update}`，`GlobalConfig` 类型见 `@/lib/api/models/GlobalConfig`）；`checkRuntimeReadiness/isTauri/openKimiCodeWebsite`（`@/lib/tauri-api`、`@/lib/kimi-code-link`）；`shouldPauseForRuntimeReadiness`（`@/lib/runtime-readiness`）；`useTheme`
- Produces: `<SettingsDialog open onOpenChange>`；`<ReadinessOverlay checking readiness error onRetry onContinue onOpenDownload>`

- [ ] **Step 1: 失败测试 `readiness-overlay.test.tsx`**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadinessOverlay } from "./readiness-overlay";

describe("ReadinessOverlay", () => {
	it("checking 时显示检测中文案", () => {
		render(<ReadinessOverlay checking readiness={null} error={null} onRetry={() => {}} onContinue={() => {}} onOpenDownload={() => {}} />);
		expect(screen.getByText(/正在检查运行环境/)).toBeInTheDocument();
	});
	it("error 时展示错误并可重试", () => {
		const onRetry = vi.fn();
		render(<ReadinessOverlay checking={false} readiness={null} error="boom" onRetry={onRetry} onContinue={() => {}} onOpenDownload={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(onRetry).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 实现 `ReadinessOverlay`**

全屏 `fixed inset-0 z-50 flex items-center justify-center bg-background/95`；居中卡片（logo 方块 + 标题「准备 Kimi Code 运行时」+ 状态区）：checking→spinner +「正在检查运行环境…」；error→`text-danger` 错误文本 + `重试`（primary）+ `仍要继续`（ghost）；readiness 缺 CLI→「未检测到 Kimi Code CLI」+ `前往下载`（primary→onOpenDownload）+ `重试`。文案结构参照旧 `runtime-readiness-overlay.tsx`（zip/git 历史可查）。

- [ ] **Step 3: 实现 `SettingsDialog`**

Radix Dialog（`bg-elevated border border-line-strong rounded-r3 shadow-pop`，宽 560px）。分区：
- 「外观」：主题三选（跟随系统/深色/浅色，radio，写 `useTheme().setTheme`，跟随系统=清 localStorage 偏好——`setTheme` 后 `localStorage.removeItem("kimi-theme")` 由 useTheme 内部处理则不额外做，直接提供深/浅/系统三个按钮，系统项调用 `setTheme` 前清 key——以 use-theme.ts 实际 API 为准：v1 提供 深色/浅色 两项即可，系统跟随为默认行为）
- 「全局配置」：`useGlobalConfig().config` 的关键字段表单（默认模型、默认 plan mode 等，按 `GlobalConfig` 类型实际字段渲染 disabled/enabled 控件），保存调 `update`
- 「关于」：`__APP_VERSION__`/`__KIMI_CLI_VERSION__`（vite define 注入的全局常量，直接引用并 `declare` 类型）+ Kimi Code 官网链接

- [ ] **Step 4: app.tsx 接入 + 测试 + build 绿 → Commit**

```powershell
npx vitest run src/modules/readiness src/modules/settings
npm run build
git add -A; git commit -m "feat(settings): reskin settings dialog and runtime readiness overlay"
```

---

### Task 9: 打磨 + 依赖清理 + 全量验收

**Files:**
- Modify: `src/index.css`（breathe/blink keyframes 若未加）、`src/app/*`（空态/错误 toast/快捷键）
- Modify: `package.json`、`vite.config.ts`（manualChunks 清理）
- Test: 补齐遗漏

- [ ] **Step 1: 快捷键与细节**

`⌘K/Ctrl+K` 聚焦侧栏搜索框（ref 透传 + window keydown）；`Esc` 关闭面板；`sessionsError` → `toast.error("Session Error", { description })`（sonner，`richColors` 关闭）；侧栏会话条目右键或 hover 操作（重命名 inline input、删除二次确认）若 Task 4 未完成则补齐；窄屏（<1024px）最小可用：侧栏默认收起，仅保证不报错不溢出。

- [ ] **Step 2: 依赖清理**

```powershell
rg -l "react-resizable-panels|@xyflow/react|embla-carousel|@tanstack/react-table|react-virtuoso|gitdiff-parser|cmdk|refractor" src
```

无命中的包从 `package.json` 移除并 `npm install` 更新 lock；`vite.config.ts` 的 `manualChunks` 删除对应分支（@xyflow/@tanstack）。**保留**：streamdown、shiki、diff、zustand、swr、sonner、use-stick-to-bottom、motion（后续动画用）、全部 @radix-ui、tailwind 体系。

- [ ] **Step 3: 全量验证**

```powershell
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run desktop   # 手测：新建会话→发消息→工具卡展开→审批三操作→权限三态→swarm/plan→主题切换→更改面板→设置
```

- [ ] **Step 4: Commit**

```powershell
git add -A; git commit -m "chore: polish V2 UI, prune unused deps, finalize phase 1"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §3 第一期各项 → Task 3–8；§4 归档 → Task 1；§6 tokens → Task 2；§10 顺序与本计划一致。后续阶段项（文件树/Agent 页签/side-chat/@ 引用/命令菜单/队列/todo/移动适配）明确不在本计划。
- **数据层冻结**：仅 Task 1 Step 3 改 useSessionStream.ts 三行 import；useSessionStream 依赖的 6 个模块已定位并随 Task 1 迁移（slash-command-catalog、tool/store+tool-registry、agent-monitor/store+sync，含 6 个测试文件——迁移后 `npm test` 覆盖回归）。
- **类型一致性**：`PermissionMode`、`shouldAutoApprove`、`deriveChanges`、`ChangeEntry`、`DiffDisplayData`、`groupSessionsByDay` 在产出/消费任务间签名一致；`respondToApproval(id, "approve"|"reject"|"approve_for_session")` 与 wireTypes 的 `ApprovalResponseDecision` 对齐。
- **风险点**：① `streamdown`/`use-stick-to-bottom` 保留在 deps 但新代码按需引入，未引入则在 Task 9 清理；② 旧 `chat-workspace-container` 的 `WorkbenceStreamSnapshot` 机制不迁移，Task 7 改为从 messages 派生（spec §7.5 同源数据）；③ 全部接受/拒绝的实现对齐旧版 stub 现实（旧版亦为回调占位），真实门控在审批卡。
