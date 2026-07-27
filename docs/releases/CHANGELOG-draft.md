# Changelog Draft — since v0.1.11

> 对比范围：`v0.1.11` → **v0.1.12**  
> 正式版本：**0.1.12**（热修复；四段号 `0.1.11.1` 不符合 Cargo semver）  
> 整理日期：2026-07-27

---

## Kimi Code Desktop v0.1.12

相对 **v0.1.11** 的用户可见改动汇总。

### 严重修复

- 修复 ACP 审批 `optionId` 与 Kimi Code 0.29.1 不兼容：桌面 `allow-once` 会被 CLI 当成未知 ID 直接拒绝；现改为 `approve_once` / `approve_always` / `reject`
- 修复 auto + Plan/Swarm 下权限模式被打回 manual、以及工具（含 AgentSwarm）假「用户拒绝」

### 稳定性

- 权限 / Plan / Swarm 模式切换单飞、prompt 前落盘；避免 StatusUpdate 覆盖本地意图
- ACP Plan/权限 `set_mode` 序列化，减少 wire 上 auto↔manual 抖动

### UI

- Swarm 卡拒绝态显示「已拒绝 / 未执行」，不再假「等待子代理启动…」

### 其它 / 内部

- README / package / Cargo / tauri 版本对齐 `0.1.12`

---

## 对比元数据

| 项 | 值 |
|---|---|
| 上一正式版 / tag | `v0.1.11` |
| 发布版本 | `0.1.12` |
