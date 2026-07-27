# Changelog Draft — since v0.1.10

> 对比范围：`v0.1.10` → **v0.1.11**  
> 正式版本：**0.1.11**  
> 整理日期：2026-07-27

---

## Kimi Code Desktop v0.1.11

相对 **v0.1.10** 的用户可见改动汇总。

### Composer / 文件

- 附件改为 CLI 风格 `@路径` 文本插入（与 `@` 文件引用一致），不再走 `attachment_ids`
- 剪贴板粘贴：上传到 pending 目录后插入绝对路径
- 原生多选文件选择器（`pick_files` / rfd）插入真实路径
- OS 拖放经 Tauri `tauri://drag-drop` 插入路径（`dragDropEnabled: true`）
- 修复多文件粘贴时 `draftRef` 未同步、只保留最后一个路径
- pending 上传目录与 `delete_pending_file`（含上一批提交）

### Skills / Slash 命令

- 后端 `list_available_skills`：扫描 `~/.agents/skills`、`$KIMI_CODE_HOME/skills`、managed plugins、`extra_skill_dirs`、daimon 插件目录
- 前端 `useSkillSlashCommands` + `mergeSlashCommands`：新会话即可用 `skill:<name>`，ACP 优先
- 扩充 `PRE_SESSION_SLASH_COMMANDS`；去掉 denylist 中的 `custom-theme`
- Composer 斜杠菜单取消 `.slice(0, 10)` 截断

### 设置 / 就绪

- 设置页通过 `getAppVersion` 显示运行中桌面版本
- optional-auth 就绪覆盖层与运行时检查调整（上一批提交）

### 其它 / 内部

- 新增 `rfd` 依赖；`skills.rs` 与前端测试补充
- README / package / Cargo / tauri 版本对齐 `0.1.11`

---

## 对比元数据

| 项 | 值 |
|---|---|
| 上一正式版 / tag | `v0.1.10` |
| 发布版本 | `0.1.11` |
