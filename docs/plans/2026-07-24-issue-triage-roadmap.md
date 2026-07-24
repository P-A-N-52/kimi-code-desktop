# 2026-07-24：17 项问题修复路线图 / Issue Triage Roadmap

来源：用户手机待办清单（两张截图，共 17 项）。所有根因已通过代码调查定位到具体文件。
本文件为排期规划。P0 七项已于 2026-07-24 落地（并按 MoonshotAI/kimi-cli 核对过 Escape / TaskCompleted 语义）。

**工作区注意**：规划时 `master` 与 `origin/master` 同步，但有 12 个未暂存修改（模型管理 UX 进行中：`useSessions.ts`、`model-capabilities.ts`、`slash-command-catalog.ts`、`tauri-api.ts`、`model-picker.tsx`、`kimi-login-panel.tsx`、`usage-panel.tsx` 等）。修复时避开这些文件，不 reset、不 checkout、不代为暂存。

---

## P0 — 快速 bug 修复（小改动、根因已定位，7 项）

| # | 问题 | 根因 | 修复点 |
|---|------|------|--------|
| 1 | ✅ 已修（2026-07-24）：表格出现下载按钮 | streamdown `controls` 默认 `true` | `src/modules/conversation/markdown.tsx:25` 传 `controls={{ table: false }}`（保留 code 复制按钮） |
| 2 | ✅ 已修（2026-07-24）：快捷键显示苹果图标且不可用 | `⌘K`/`⌘N` 硬编码；`Ctrl+N` 根本没有 handler | `platformModLabel()` + `hasPlatformModifier`；`app.tsx` 补 `Ctrl/Cmd+N` → 新建会话 |
| 3 | ✅ 已修（2026-07-24）：命令菜单不选就无法退出 | Escape 被 `visibleCommands.length > 0` 守卫；无外部点击关闭 | Escape 去守卫 + 外部点击关闭（对齐 CLI web：继续输入 `/…` 可重开） |
| 4 | ✅ 已修（2026-07-24）：快速切主题 STATUS_BREAKPOINT | WebView2 上 `pseudoElement.animate` + 并发 VT 会崩 | 保留圆形揭示（CSS clip-path）；禁用 JS pseudo 动画；连点排队 + cooldown；Tauri setTheme 延后 |
| 5 | ✅ 已修（2026-07-24）：小窗口双开侧栏 UI 崩 | 右面板有 `max-[900px]` overlay 兜底，左侧栏没有；901–1060px 双开时对话列被挤没 | 左栏 `max-[900px]` overlay；双开时再抬到 `max-[1100px]` |
| 6 | ✅ 已修（2026-07-24）：事件没完成就打勾 | `sync.ts` 把 running/in_progress 强制改成 success | 显式活跃态保持 active；status 缺失按 CLI/`acp_translate` 视为 completed |
| 7 | ✅ 已修（2026-07-24）：CLI 意外死亡后对话"还在继续" | error 只是一条小字 StatusMessage；`stream.reconnect` 有导出但全仓无调用方；composer 不禁用 | 持久错误横幅 + 重新连接；`sendDisabled` 禁用 composer |

**验证**：`npm test`、`npm run check:quick`；项 3/4/5/7 补 focused 测试（composer Escape/blur、use-theme 守卫、sync 状态映射）。

## P1 — 体验改进（中等改动，6 项）

| # | 问题 | 根因 | 修复点 |
|---|------|------|--------|
| 1 | ✅ 已修（2026-07-24）：指令区加载不全（plugin/skill 类缺失） | `available_commands_update` 全量替换；未知形状静默丢弃 | `useSessionStream` 按名合并多波命令；`acp_translate` 未知形状走 fallback；会话切换保留缓存直至首个 update |
| 2 | ✅ 已修（2026-07-24）：会话按项目文件夹归纳 | 元数据已有 `workDir`，侧栏只有按天分组 | `groupSessionsByWorkDir` + 侧栏「按天/按项目」切换并持久化 localStorage |
| 3 | ✅ 已修（2026-07-24）：加载对话状态过慢 | wire 双读；同步重放；空闲也 spawn ACP；swarm 迁移串行 | replay 同读产出 usage StatusUpdate；分批重放；idle 懒 connect；swarm 迁移并发 |
| 4 | ✅ 已修（2026-07-24）：拖入文件功能 | 无 drop 处理，只有隐藏 file input | `composer.tsx` dragover/drop 复用 `uploadFiles` |
| 5 | ✅ 已修（2026-07-24）：/usage、/status 与 CLI 不一致 | 桌面本地拦截自绘面板格式旧（Plan quotas / % left / 缺 Title·thinking） | `managed-usage.ts` 对齐 CLI TUI：Session usage、Context `█░`、Plan `% used`；`/status` 含 `>_ Kimi Code (v…)`、Model (thinking …)、Title 等 |
| 6 | ✅ 已修（2026-07-24）：点击"上下文"弹出的是文件面板；补 `@` 文件引用与按项目分组 | 按钮名不副实；无 `@` 菜单；按项目仅用 basename；归档 workDir 缺失 | 文案改「文件」；composer `@` 引用；`session-groups` 按完整路径 + 可折叠；Rust 回填 workDir / 默认排除归档 |

**验证**：P0 门禁 + `npm run smoke:acp`（命令合并、connect 策略变更涉及 ACP 链路）；项 1/2/3 补测试。

## P2 — 架构级功能（大改动，各需独立计划，3 项）

1. **多个活跃对话 / 多窗口**：Rust 已支持每会话独立 worker（`acp.rs:356`），瓶颈在前端单 stream 架构（`app.tsx:160-166`）+ 切会话即 `wireDisconnect` 杀进程。演进方向：`Map<sessionId, ViewState>`（`useSessionStream.ts:87-107` 已有草图）+ 后台保活策略；多窗口需放弃 single-instance 插件（与 `docs/plans/2026-07-22-single-instance.md` 冲突，需先决策）。
2. **goal 模式**：底层已有覆盖（/goal 转发、CreateGoal/UpdateGoal 工具事件、Tasks 目标卡片），缺：GetGoal 主动查询、常驻目标指示、/goal 桌面面板。属中等功能，可提前到 P1 尾部。
3. **多模型子代理**：⚠️ 上游阻塞（2026-07-24 用户确认）：这是 CLI 刚更新的功能，**目前只在 Kimi web 端可用**，CLI/ACP 侧尚未暴露。桌面端 wire 类型、Rust 翻译、UI 三层也都无 model 字段管线。结论：桌面暂不立项，等 CLI/ACP 开放子代理 model 参数后再评估；届时先做"显示子代理实际使用的模型"（只读展示），再谈"指定模型"。

## P3 — 未来期许（1 项）

- 更流畅动画、更好界面：随上述修复顺带打磨（主题切换动画已在 P0-4 修正），不立专项。

---

## 执行约定

- 每完成一项跑 `npm test` + `npm run check:quick`；涉及 ACP 链路加 `npm run smoke:acp`（环境阻塞与代码回归分开报告）。
- 遵守 AGENTS.md：不碰进行中的未提交文件；通用 fallback 不得破坏；UI 完成度以真实 Tauri/WebView2 验收为准。
- P1 已全部完成；会话列表改为全量加载（分页仅作内部拉取）；P2 项各需独立计划后再开做。
