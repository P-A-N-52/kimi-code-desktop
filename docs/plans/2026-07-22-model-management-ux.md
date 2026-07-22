# 桌面端模型管理 / Thinking 切换 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 聊天区就地切换模型；支持 thinking 的模型可开关；Settings 只保留「配置/管理」，不再作为日常切换入口。

**Architecture:** 模型列表与默认项以 `~/.kimi-code/config.toml` 为唯一真相源，经 Tauri `get_global_config` / `update_global_config`（或 HTTP Config API）暴露为 `GlobalConfig`。聊天 chrome 用 inline popover 读写 `default_model` / `default_thinking`；capability 来自各 `[models.*].capabilities`。v1 不做 per-session 模型覆写。

**Tech Stack:** React 19 + Vite（`kimi-code-desktop/`）、Tauri 2（`src-tauri/src/global_config.rs`）、既有 `useGlobalConfig`、ACP worker 重启路径。

**状态说明（2026-07-22）：** 工作区里已有未提交的草稿改动（`model-picker.tsx`、`composer.tsx`、`conversation-view.tsx` 等）。**本计划优先于继续写代码**——实现前请先评审本计划；草稿可保留作参考，也可整段 revert 后按阶段重做。不要 commit，除非用户明确要求。

---

## 1. 当前问题（代码 + 用户痛点）

### 用户痛点
- 点模型 chip → 跳进 Settings，日常切换太重。
- 部分模型支持 Thinking，桌面端没有按能力露出开关。
- 「模型管理」感觉乱：切换、默认值、TOML 编辑、能力位没有清晰分层。

### 代码现状（落地事实）
| 现象 | 位置 |
|------|------|
| Composer 模型按钮只调 `onOpenModelSettings` → 打开 Settings | `src/modules/composer/composer.tsx`、`conversation-view.tsx`、`app.tsx` |
| Settings「通用」里有默认模型 `<select>` + 无条件 Thinking Switch | `src/modules/settings/settings-dialog.tsx` |
| 配置读写已存在 | `useGlobalConfig` → `tauri-api.updateGlobalConfig` / `ConfigApi`；后端 `commands::update_global_config` → `global_config.rs` |
| 模型列表来自 TOML `[models.*]`，含 `capabilities` | `global_config.rs` `build_models_array`；前端 `ConfigModel` + `ModelCapability`（`thinking` / `always_thinking`） |
| `/model` 被 denylist，提示去 Settings | `slash-command-catalog.ts` |
| **没有 per-session 模型字段**；会话侧只读全局 `defaultModel`（如 status/usage） | `useSessionStream.ts` 等 |
| 改 `default_model` / `default_thinking` 默认会 `restart_running_workers` | `commands.rs` `update_global_config`（`restart_running_sessions` 默认 `true`） |

### 「一团糟」的根因（管理视角）
1. **交互层**：切换入口放错地方（Settings ≠ chat chrome）。
2. **能力层**：`capabilities` 已进 API，UI 未消费。
3. **语义层**：全局默认 vs「当前会话用的模型」未产品化区分——今天实际只有全局默认。
4. **副作用层**：切换触发 ACP 重启，用户体感像「不稳定/乱」，需在文案与策略上说清楚。

---

## 2. 目标 UX

### 聊天区（日常）
- **模型 chip（Composer 底栏右侧）**：点击 → **向上弹出的 popover**（风格对齐 `status-strip` 权限菜单：`rounded-r3` / `shadow-pop` / Check 选中态）。
- 列表：`config.models`（显示 `name`，副文案 `provider` · API `model`）。
- 选中 → 写 `default_model`，toast 成功；忙碌会话被 skip 时给出轻量提示。
- **Thinking**：仅当当前选中模型 `capabilities` 含 `thinking` 或 `always_thinking` 时显示：
  - `thinking` → 可开关，绑定 `default_thinking`
  - `always_thinking` → 开且 disabled，文案「由模型强制启用」
  - 无 capability → 不显示（不要假开关）

### Settings（管理，非日常切换）
- **保留**：默认模型下拉（与 chat 同源）、Plan 默认、Thinking（同样按 capability 门控）、`config.toml` / `mcp.json` 全文编辑、用量。
- **职责**：加模型、改 provider、改 capability、高级 TOML——走 Config 页，不在 chat popover 里做 CRUD。
- Chat popover **可选**底部链「在设置中管理配置…」（次要），**禁止**把打开 Settings 当成主路径。

### 不放进 v1 chat chrome
- Provider 登录 / 绑定新模型向导
- Per-session 模型覆写 UI
- 多模型对比、收藏、搜索过滤（模型很多时再做）

---

## 3. 数据 / 管理模型

```
~/.kimi-code/config.toml
  default_model = "<alias>"          # 全局默认，聊天切换写这里
  default_thinking = true|false      # 全局默认思考；CLI/ACP 启动读
  [providers.*]                      # type / 凭证等（Settings Config）
  [models.<alias>]
    provider = "..."
    model = "..."                    # 上游 API model id
    max_context_size = ...
    capabilities = ["thinking"|"always_thinking"|...]

        │
        ▼  get_global_config / update_global_config
GlobalConfig { defaultModel, defaultThinking, models: ConfigModel[] }
        │
        ▼  useGlobalConfig (+ kimi:config-update 广播)
Composer ModelPicker / Settings 通用页
        │
        ▼  update 默认 restart ACP workers
运行中会话进程重新读配置 → 之后的 turn 用新默认
```

### 默认 vs 会话
| | v1 真相源 | 说明 |
|--|-----------|------|
| 模型列表 | TOML `[models.*]` | 桌面不维护第二份列表 |
| 「当前模型」展示 | `GlobalConfig.defaultModel` | 全应用一致，非 per-session |
| Thinking 开关 | `GlobalConfig.defaultThinking` | 同上 |
| 会话级覆写 | **无（v1 非目标）** | 若以后要做，需 session metadata + ACP 协议支持，另开计划 |

### Capability 检测
- 读 `ConfigModel.capabilities: Set<ModelCapability>`
- 助手函数建议集中：`src/lib/model-capabilities.ts`
  - `modelHasThinkingCapability` → `thinking` \| `always_thinking`
  - `modelForcesThinking` → `always_thinking`
- **缺失 capabilities**：视为不支持 Thinking（不猜）

### 与 CLI / ACP / Provider
- Desktop 不直接改 provider 实现；切换只改 TOML 顶层默认值。
- ACP 子进程通过重启（或下次 spawn）吃到新配置；busy 时可 skip（API 已有 `skippedBusySessionIds`）。
- Provider / 模型定义仍靠用户编辑 TOML 或未来的管理 UI；v1 chat 只 **选择已配置 alias**。

---

## 4. 分阶段实现（可单独交付）

### Phase 0 — 对齐与清理（计划评审后）
- [ ] 确认本计划；决定工作区草稿：`keep and polish` / `revert model-* 相关文件后重做`
- [ ] 相关草稿文件（若保留）：`model-picker.tsx`、`model-capabilities.ts`、`composer.tsx`、`conversation-view.tsx`、`settings-dialog.tsx`、`slash-command-catalog.ts`、`app.tsx`

### Phase 1 — Inline 模型选择（最小可用）
**目标：** 不再跳 Settings 也能换模型。

**触点：**
- Create: `src/modules/composer/model-picker.tsx`
- Modify: `composer.tsx`（chip → picker）、`conversation-view.tsx`（`update({ defaultModel })`）、`app.tsx`（去掉 ConversationView→Settings 仅为换模型的链路）
- Modify: `slash-command-catalog.ts`（`/model` 提示改为指向 composer picker）
- Test: `composer.test.tsx`

**验收：** 点 chip → 列表 → 选中 → toast；Settings 仍可改同一 `defaultModel`；两边经 `kimi:config-update` 同步。

### Phase 2 — Thinking 门控开关
**目标：** 有能力才显示；写 `default_thinking`。

**触点：**
- Create: `src/lib/model-capabilities.ts` (+ unit test)
- Modify: `model-picker.tsx`（footer Switch）、`settings-dialog.tsx`（同样门控 + forced）
- Modify: `conversation-view.tsx`（`update({ defaultThinking })`）

**验收：** 带 `thinking` 的模型可开关；`always_thinking` 强制开；无 capability 无开关；Settings 与 picker 行为一致。

### Phase 3 — 管理语义打磨（仍聚焦，不重写 Settings）
**目标：** 「切换」vs「管理」文案与布局说清。

**触点：**
- Settings 通用：默认模型说明「新会话 / 重启后的默认」；Thinking 旁注能力来源
- Config 页：保持「加模型 / 改 capabilities」主入口
- 可选：picker 底链「打开设置 → Config」
- 重启副作用：toast 说明「将重启空闲会话以应用」；尊重 `skippedBusySessionIds`

**验收：** 用户能回答「日常在哪切、加模型去哪、Thinking 何时出现」。

### Phase 4（可选后续，非 v1）
- Per-session 模型（需后端/ACP）
- Picker 搜索 / 按 provider 分组
- StatusStrip 上独立 Thinking pill（与 plan/swarm 并列）——仅当发现 picker 内开关不够发现时再做

---

## 5. v1 非目标

- 不在桌面内 CRUD 完整 provider/model 市场
- 不做 per-session / per-turn 模型覆写
- 不重写 Settings 信息架构 / 不做新「模型中心」大页
- 不改 ACP 协议本身；不绕开 `config.toml`
- 不把 `/model` 斜杠命令做成第二套切换 UI（继续 denylist，只改提示）
- 不处理 OAuth / Kimi 登录流（其他线程）

---

## 6. 待你确认的问题

1. **作用域：** v1 切换全局默认（重启 ACP）是否可接受？还是必须「仅当前会话、不碰全局」才算完成？（后者工作量大，现栈无现成字段。）
2. **Thinking 位置：** 只放在模型 popover 内，还是还要在 StatusStrip 加一颗 pill？
3. **草稿代码：** 工作区已有未提交 model picker 实现——评审计划后是 **基于草稿打磨**，还是 **先 revert 再按 Phase 落地**？
4. **忙碌会话：** 切换时 busy session 被 skip，是 toast 提示即可，还是要强制重启 / 排队重启？

---

## 建议执行顺序（评审通过后）

1. 回答上面 4 个问题
2. Phase 1 → 可手动点测
3. Phase 2 → 用真实带/不带 `capabilities` 的 TOML 各测一遍
4. Phase 3 文案与 Settings 门控对齐
5. 再谈 commit / PR

**不要在计划未确认前继续扩大实现范围。**
