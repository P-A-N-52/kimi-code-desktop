# Source Backend 长期维护策略

状态：生效中
日期：2026-08-07
配套：架构决策 `2026-08-07-source-backend-architecture.md`；上游固定值见 `runtime/UPSTREAM.md`

## 1. 改动三分法（冲突隔离的根本）

| 改动类型 | 位置 | 上游同步冲突 |
| --- | --- | --- |
| 桌面壳（React/Rust） | `src/`、`src-tauri/`，在 `runtime/` 之外 | 零 |
| 自有后端 | `runtime/kimi-code/apps/desktop-runtime/`（新增目录，上游永远不会碰） | 接近零（仅 workspace 配置偶发） |
| 上游文件补丁 | 直接提交 + `runtime/PATCHES.md` 登记 | 逐条 rebase，数量压到最小 |

原则：**能不碰上游文件就不碰**。定制通过 `agent-core-v2` 的 DI×Scope、`hooks.ts`、`kaos` 执行环境抽象、`plugins/` 机制注入；补丁是最后手段。

## 2. 上游同步节奏

1. 只跟上游 tag（当前冻结 `@moonshot-ai/kimi-code@0.33.0` / commit `53c832df…`），不跟 main 分支。
2. 同步走专门分支：`git subtree pull` 进 `sync/kimi-code-<tag>`，先审 diff 再合并进主干。
3. 审查重点：`klient` contract 变化、`agent-core-v2` hooks 变化、`kosong` provider 接口变化、transcript/minidb schema 变化。
4. 每次同步后必跑：`smoke:runtime` + UI 兼容清单 golden tests + `npm test` + `cargo test`。
5. 同步完成后更新 `runtime/UPSTREAM.md` 的冻结 commit 与发布清单。

## 3. 补丁纪律（`runtime/PATCHES.md`）

- 每个补丁登记：id、文件、原因、上游 issue/PR 链接、移除条件。
- 能贡献回上游的优先贡献，下次同步时移除本地补丁。
- 补丁数量是健康指标：超过 5 个活跃补丁时停下来评估是否该推动上游开扩展点。

## 4. GUI 跟上 kimi 功能迭代

- 前端只认 runtime-neutral wire + capability snapshot；kimi 出新功能先以 generic fallback 形态可用，再按需补语义卡片。
- 新能力只有进入 handshake capability snapshot 后才允许启用对应 UI（如 fork、share）；没能力就不显示，不做假入口。
- 跟进流程：上游同步 → 审 contract/hook 变化 → adapter 映射 → 兼容清单 golden 更新 → （可选）语义卡片。

## 5. 版本与构建闸

- 工具链钉死：Node `24.15.0`、pnpm `10.33.0`（见 `.nvmrc`/`UPSTREAM.md`）；外层 Desktop 用 npm，runtime workspace 用 pnpm，两套锁文件不合并。
- 发布为每平台/架构的 Node SEA 单文件 sidecar；Tauri 只打包本次源码产生的 artifact。
- 发布门禁（`release:preflight`）至少校验：
  - artifact 报告的 source commit 与冻结值一致；
  - 运行不依赖 PATH 中的 `kimi`；
  - 安装包无 ACP/旧 sidecar 生产入口；
  - macOS 签名+公证、Windows 签名覆盖 runtime sidecar；
  - Runtime 缺失/损坏/握手失败时显示可操作错误，不下载或调用外部 CLI。

## 6. 数据安全纪律

- 测试只用临时 `KIMI_CODE_HOME`，永不覆盖用户真实 `~/.kimi-code`。
- 迁移：首启只读预检 → 备份 + migration marker → 原子提交；中断可重试；不产生双 writer。
- API key/token 不进 argv、stdout 协议、前端事件、普通日志、transcript、错误报告；走受限环境变量或系统凭据存储；崩溃报告落盘前 secret redaction。

## 7. 分支与交接

- 主干：`master`（源码基底 + 桌面壳）。
- 上游同步：`sync/kimi-code-<tag>`；大功能：`feat/*`。
- 交接必须区分三个状态：“代码存在”“测试通过”“真实桌面已验收”。
