# Changelog Draft — since v0.1.9

> 对比范围：`v0.1.9`（`3f430d4`）→ **v0.1.10**  
> 正式版本：**0.1.10**  
> 整理日期：2026-07-25

---

## Kimi Code Desktop v0.1.10

相对 **v0.1.9** 的用户可见改动汇总。

### 新会话 / 工作目录

- 新建会话改为完整「新会话」页（替换空状态），可先选工作目录再发首条消息
- 工作目录选择器：最近目录列表 + 自定义路径
- 新会话阶段即可使用部分 slash 命令（如 `/help`、`/compact`、`/mcp`、`/tasks` 等）与模型切换
- 未选工作目录时，`@` 文件引用会明确提示先选目录
- 新会话页增加状态条（连接 / 模型 / 权限等上下文）
- 已有会话的工作目录选择器改为只读展示，避免误改会话根目录

### 窗口（无边框、拖拽、窗口按钮）

- 窗口改为无边框（`decorations: false`）
- 顶栏提供最小化 / 最大化·还原 / 关闭按钮
- 顶栏与侧栏增加可拖拽区域，便于移动窗口；搜索与按钮区域保持可点击

### 侧栏（搜索、项目分组、归档）

- 会话列表支持搜索
- 分组模式可在「按时间 / 按项目」之间切换，并记住选择与折叠状态
- 按项目分组按完整工作目录路径归类（同名文件夹自动区分父目录）
- 「进行中 / 已归档」切换；支持单条、批量、按项目、一键归档（按未活跃天数），以及从归档恢复
- 会话元数据回填缺失的 `workDir`；列表默认排除已归档项

### Composer（@ 文件、按钮文案、布局）

- 支持 `@` 引用工作区内文件（可浏览目录、模糊匹配）
- 支持将文件拖入 Composer 上传（原仅有附件按钮）
- 原「上下文」按钮文案改为「文件」，与实际面板一致
- 占位符更新为「给 Kimi 布置任务…（@ 文件 / 命令）」等更清晰提示
- 斜杠命令菜单：Escape / 点击外部可关闭；继续输入 `/…` 可再次打开
- CLI 断开时 Composer 禁用发送，并提示先重新连接
- 修复快速连点导致的重复发送（double-send）

### 字体 / 视觉

- 界面主字体改为 HarmonyOS Sans SC（替代 Inter）
- 主题切换：圆形揭示动画更稳妥；快速连点排队 + 冷却，降低 WebView2 崩溃风险
- 窄窗口下左右侧栏改为 overlay，避免双开时对话区被挤没

### CLI 对等（usage / status 等）

- `/usage`、`/status` 输出格式对齐 Kimi Code CLI TUI（进度条、`% used`、Session usage、Context 等）
- `/status` 补充版本行、Model（含 thinking effort）、Title、目录与权限等信息
- ACP `available_commands_update`：兼容 plugin/skill 等非常规命令形状，多波更新按名合并，减少指令菜单缺项

### Agent / Swarm 工具卡片

- Agent、Swarm 工具结果与 Web 对齐的专用卡片 UI（可展开步骤 / 行项目）
- 解析与行映射逻辑独立为 `src/lib/agent`、`src/lib/swarm`，并补充测试
- 新增 `Expandable`、`StatusDot` 等 UI 原语支撑卡片状态展示
- Tool registry 注册 Agent/Swarm 卡片渲染路径

### 设置 / 配置与运行时模式

- 正确持久化 `[thinking].enabled`（配置读写与设置面板一致）
- 权限 / 运行时模式映射与状态栏展示修复（含测试）
- 配置更新 toast 与 settings API 对齐 thinking 等字段

### 对话与稳定性

- CLI/会话异常断开后显示持久错误横幅，并提供「重新连接」
- Agent 监控事件：进行中的任务不再被错误标成已完成（勾选打早）
- 打开会话：分批回放、空闲懒连接、swarm 迁移并发，减轻「加载对话过慢」
- Markdown 表格不再显示多余下载控件（保留代码块复制）
- 快捷键：按平台显示 Ctrl/Cmd；补充 `Ctrl/Cmd+N` 新建会话
- Subagent 步骤展示与 conversation 视图联动整理

### 其它 / 内部

- 新增 `list_work_dir_directory` 等后端能力，支撑 `@` 与工作区浏览
- 移除 `@fontsource-variable/inter` 依赖；内置 HarmonyOS 字体资源与许可说明
- 补充多项前端测试与 issue 排期文档（`docs/plans/2026-07-24-issue-triage-roadmap.md`）
- README 版本号与壳版本对齐说明

---

## 对比元数据

| 项 | 值 |
|---|---|
| 上一正式版 / tag | `v0.1.9` @ `3f430d4`（2026-07-23） |
| 功能 tip | `a812b86` — `feat: agent/swarm cards, config thinking fix, and session UX polish` |
| 另含提交 | `d1264f1` README；`5848954` shell UX |
| `package.json` / Tauri / Cargo | `0.1.10`（随 bump 提交） |
| 发布版本 | `0.1.10` |