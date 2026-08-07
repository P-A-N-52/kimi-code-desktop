# 参与贡献 / Contributing

感谢你愿意帮助改进 Kimi Code Desktop。

Kimi Code Desktop 是 Kimi Code CLI 的独立桌面外壳：React 与 Tauri 负责桌面交互、
进程编排和本地集成，用户安装的 Kimi Code CLI 通过 ACP（`kimi acp`）提供会话、
模型、工具和智能体运行时。提交改动前，请先理解这个边界。

Thank you for helping improve Kimi Code Desktop.

Kimi Code Desktop is an independent desktop shell for Kimi Code CLI. React and
Tauri own the desktop experience, process orchestration, and local integration,
while the user-installed Kimi Code CLI provides sessions, models, tools, and agent
runtime behavior through ACP (`kimi acp`). Please understand this boundary before
making changes.

## 目录 / Contents

- [贡献方式](#贡献方式--ways-to-contribute)
- [提交 Issue](#提交-issue--reporting-issues)
- [开发环境](#开发环境--development-environment)
- [开发流程](#开发流程--development-workflow)
- [架构与修改边界](#架构与修改边界--architecture-and-change-boundaries)
- [代码与文档规范](#代码与文档规范--code-and-documentation-standards)
- [验证矩阵](#验证矩阵--verification-matrix)
- [专项变更要求](#专项变更要求--change-specific-requirements)
- [提交与 Pull Request](#提交与-pull-request--commits-and-pull-requests)
- [评审与社区行为](#评审与社区行为--reviews-and-community-conduct)
- [许可证](#许可证--license)

## 贡献方式 / Ways to contribute

欢迎以下类型的贡献：

- 可复现的 Bug 报告；
- 清晰说明使用场景的功能建议；
- React、Tauri、Rust、测试、可访问性、国际化或性能改进；
- Windows 和 macOS Apple Silicon 的真实运行验证；
- 文档、示例、错误提示和开发者体验改进；
- 对现有 Pull Request 的复现、测试和建设性评审。

Good contributions include:

- Reproducible bug reports;
- Feature proposals grounded in a clear use case;
- React, Tauri, Rust, testing, accessibility, internationalization, or
  performance improvements;
- Real runtime validation on Windows and macOS Apple Silicon;
- Documentation, examples, error messages, and developer-experience
  improvements;
- Reproduction, testing, and constructive review of existing pull requests.

较大的功能、架构调整、依赖替换或用户数据格式变更，请先提交 Issue 讨论范围和兼容性。
小型修复、测试和文档改进可以直接提交 Pull Request。

For substantial features, architecture changes, dependency replacements, or
user-data format changes, open an issue first to discuss scope and compatibility.
Small fixes, tests, and documentation improvements may go directly to a pull
request.

## 提交 Issue / Reporting issues

### 提交前 / Before opening an issue

请先：

1. 搜索现有 Issue 和 Pull Request，避免重复；
2. 使用当前源码或最新发布版本复现；
3. 确认问题来自桌面壳，而不是 Kimi Code CLI、provider 或模型服务；
4. 移除日志、截图和配置中的 API key、Token、凭据、用户名、私有路径及会话内容。

Before reporting:

1. Search existing issues and pull requests for duplicates.
2. Reproduce against the current source or latest release.
3. Determine whether the problem belongs to the desktop shell rather than Kimi
   Code CLI, a provider, or a model service.
4. Remove API keys, tokens, credentials, usernames, private paths, and session
   content from logs, screenshots, and configuration.

### Bug 报告 / Bug reports

一份有效的 Bug 报告应包含：

- 清晰、可检索的标题；
- 桌面端版本、Kimi Code CLI 版本和操作系统版本；
- 安装方式，以及 Windows 架构或 macOS 芯片类型；
- 最小复现步骤、预期结果和实际结果；
- 问题是否可稳定复现；
- 已脱敏的控制台、终端、Tauri 或 ACP 日志；
- 相关截图或录屏；
- 是否使用真实 `kimi acp` 和已配置可用的 provider；
- 最近一次正常工作的版本（如果已知）。

A useful bug report includes:

- A clear, searchable title;
- Desktop version, Kimi Code CLI version, and operating-system version;
- Installation method and Windows architecture or macOS chip type;
- Minimal reproduction steps, expected behavior, and actual behavior;
- Whether the issue reproduces consistently;
- Sanitized console, terminal, Tauri, or ACP logs;
- Relevant screenshots or recordings;
- Whether the test used a real `kimi acp` process with a working provider;
- The last known working version, if known.

### 功能建议 / Feature requests

请描述目标用户、当前痛点、期望行为、可接受的边界以及为什么该能力属于桌面端。
如果建议需要新的 CLI 或 ACP 能力，请明确说明依赖，桌面端不会用假的入口或 legacy
API 模拟不存在的运行时契约。

Describe the target user, current problem, desired behavior, acceptable scope,
and why the capability belongs in the desktop app. If the proposal requires new
CLI or ACP support, call out that dependency explicitly. The desktop app will not
fake unsupported runtime contracts or route them through a legacy API.

### 敏感问题 / Sensitive reports

仓库目前没有单独发布 `SECURITY.md` 或专用安全邮箱。不要在公开 Issue、Pull Request、
日志或截图中披露凭据、私有会话数据或可直接利用的敏感细节。请先使用仓库当时明确提供的
私密 GitHub 联系方式联系维护者；如果没有可用的私密渠道，只公开经过脱敏且无法直接利用的
最小问题描述。

The repository does not currently publish a separate `SECURITY.md` or dedicated
security email. Do not disclose credentials, private session data, or directly
exploitable sensitive details in public issues, pull requests, logs, or
screenshots. First use a private GitHub contact method explicitly offered by the
repository at that time. If no private channel is available, publish only a
sanitized, non-exploitable minimum description.

## 开发环境 / Development environment

### Windows 主开发环境 / Primary Windows environment

准备以下工具：

- Git；
- Node.js 22 和 npm；
- Rust stable toolchain；项目最低 Rust 版本为 1.78；
- Windows 的 MSVC Rust target 和对应的 Visual Studio Build Tools；
- Microsoft Edge WebView2 Runtime；
- 位于 `PATH` 中的 Kimi Code CLI；
- 可运行的 `kimi acp`，以及在 `~/.kimi-code/config.toml` 中配置好的 provider。

Install:

- Git;
- Node.js 22 and npm;
- The stable Rust toolchain; the project minimum is Rust 1.78;
- The MSVC Rust target and matching Visual Studio Build Tools on Windows;
- Microsoft Edge WebView2 Runtime;
- Kimi Code CLI available on `PATH`;
- A working `kimi acp` process and a configured provider in
  `~/.kimi-code/config.toml`.

纯前端单元测试通常不需要真实 provider，但桌面运行时、ACP smoke 和端到端验收需要。
桌面端不要求 `kimi login`，只要求 CLI 能解析出可用配置。

Pure frontend unit tests generally do not require a real provider, but desktop
runtime checks, ACP smoke tests, and end-to-end acceptance do. The desktop app
does not require `kimi login`; it requires the CLI to resolve a usable
configuration.

### macOS Apple Silicon / macOS Apple Silicon

macOS 构建当前只支持 Apple Silicon（`aarch64-apple-darwin`）和 macOS 12 或更高版本。
macOS CI 只证明前端构建和 ARM64 Rust target 可以编译，不等同于签名、公证或真实桌面验收。
Windows 仍是主要产品与 WebView2 验收环境。

The macOS build currently supports Apple Silicon (`aarch64-apple-darwin`) on
macOS 12 or later. macOS CI proves that the frontend and ARM64 Rust target compile;
it does not prove signing, notarization, or real desktop acceptance. Windows
remains the primary product and WebView2 acceptance environment.

### 获取源码 / Get the source

```powershell
git clone https://github.com/P-A-N-52/kimi-code-desktop.git
cd kimi-code-desktop
npm ci
npm run desktop
```

使用 `npm ci` 可按锁文件获得可复现的依赖；只有确实需要更新依赖或锁文件时才使用
`npm install`。

Use `npm ci` for a reproducible install from the lockfile. Use `npm install` only
when intentionally changing dependencies or the lockfile.

## 开发流程 / Development workflow

1. Fork 仓库，并同步上游目标分支。
2. 从目标分支创建聚焦的功能分支，例如 `feat/session-search`、`fix/acp-replay` 或
   `docs/contributing-guide`。
3. 开始前运行 `git status --short --branch`，识别 staged、unstaged、untracked
   和本地已提交改动。
4. 只修改当前任务需要的文件；不要 reset、checkout、覆盖、删除或重新暂存其他人的改动。
5. 先补充或更新测试，再实现最小且完整的改动。
6. 运行与改动匹配的验证，并记录不能运行的检查及原因。
7. 自查 diff 后提交 Pull Request。

1. Fork the repository and synchronize the upstream target branch.
2. Create a focused branch from the target branch, such as
   `feat/session-search`, `fix/acp-replay`, or `docs/contributing-guide`.
3. Run `git status --short --branch` before starting to distinguish staged,
   unstaged, untracked, and locally committed changes.
4. Change only files required by the task. Do not reset, check out, overwrite,
   delete, or restage someone else's work.
5. Add or update tests, then implement the smallest complete change.
6. Run verification appropriate to the change and record any skipped checks with
   a reason.
7. Review the diff before opening a pull request.

`main` 和 `master` 是永久保护分支。所有开发都必须通过功能分支和正常 Pull Request
集成；不得强制推送、改写历史、破坏性重置或绕过分支保护、评审与状态检查。

`main` and `master` are permanently protected. All development must use feature
branches and normal pull requests. Never force-push, rewrite protected history,
perform destructive resets, or bypass branch protection, review, or status
checks.

如果使用 Codex 或其他自动化代理，请先完整阅读 [`AGENTS.md`](AGENTS.md)。代理在编辑
代码、测试、脚本、配置或工作流前，还必须遵守其中的 Goal、文件所有权和安全规则。

If you use Codex or another automated agent, read [`AGENTS.md`](AGENTS.md) in
full first. Before editing code, tests, scripts, configuration, or workflows,
agents must also follow its Goal, file-ownership, and safety requirements.

## 架构与修改边界 / Architecture and change boundaries

核心运行链路如下：

```text
React app shell / useSessionStream
  -> Tauri IPC / events
     -> AcpProcessManager
        -> per-session user-installed `kimi acp`
     -> AcpDesktopClient
     -> session_store.rs
     -> global_config.rs / mcp_config.rs
     -> session_files.rs / git_diff.rs
```

The core runtime chain is:

```text
React app shell / useSessionStream
  -> Tauri IPC / events
     -> AcpProcessManager
        -> per-session user-installed `kimi acp`
     -> AcpDesktopClient
     -> session_store.rs
     -> global_config.rs / mcp_config.rs
     -> session_files.rs / git_diff.rs
```

主要目录职责：

| 路径 | 职责 |
| --- | --- |
| `src/app/` | 应用级装配与单一活动会话 stream |
| `src/hooks/` | live/replay 归一化、会话与 wire 类型 |
| `src/modules/` | V2 会话、Composer、Workspace、Settings 等 UI |
| `src/lib/tool-events/` | 工具语义、side effects 与通用 fallback |
| `src-tauri/src/` | ACP、Tauri commands、配置、文件、Git 和历史回放 |
| `scripts/` | 检查、smoke、桌面构建与发布脚本 |
| `docs/plans/` | 尚需结合源码核实的设计与验收计划 |

Primary directory ownership:

| Path | Responsibility |
| --- | --- |
| `src/app/` | Application wiring and the single active session stream |
| `src/hooks/` | Live/replay normalization, sessions, and wire types |
| `src/modules/` | V2 conversation, Composer, Workspace, Settings, and other UI |
| `src/lib/tool-events/` | Tool semantics, side effects, and generic fallback |
| `src-tauri/src/` | ACP, Tauri commands, configuration, files, Git, and replay |
| `scripts/` | Checks, smoke tests, desktop builds, and release tooling |
| `docs/plans/` | Design and acceptance plans that must still be checked against code |

必须保持以下约束：

- 运行时是 ACP-only；不要恢复 Python sidecar、bundled `kimi-sidecar` 或 legacy
  runtime fallback。
- `src-tauri/src/acp_translate.rs` 中的 `legacy` 通常表示前端兼容数据形状，不授权
  恢复旧运行时。
- `useSessionStream` 是 live/replay wire 的统一归一化入口，AppShell 只持有一个活动
  session stream。
- 新增或修改 wire、tool、media、subagent 或 steering 事件时，必须一起核对类型契约、
  ACP translator、live dispatcher、`session_store` replay、state store、语义 UI
  和 generic fallback。
- 未知事件、工具和 display payload 必须继续有可见、可调试的通用 fallback。
- 不要恢复已删除的旧组件树；当前 UI 主路径是 `src/modules/` 和现有 Zustand stores。
- 测试不得覆盖、删除或迁移真实的 `~/.kimi-code` 配置、凭据或历史会话，应使用临时目录。

Preserve these constraints:

- The runtime is ACP-only. Do not restore the Python sidecar, bundled
  `kimi-sidecar`, or a legacy runtime fallback.
- A `legacy` name in `src-tauri/src/acp_translate.rs` usually describes a
  frontend compatibility shape; it does not authorize the old runtime.
- `useSessionStream` is the shared normalization point for live and replay wire
  events, and AppShell owns exactly one active session stream.
- When adding or changing wire, tool, media, subagent, or steering events, check
  the type contract, ACP translator, live dispatcher, `session_store` replay,
  state store, semantic UI, and generic fallback together.
- Unknown events, tools, and display payloads must retain a visible, debuggable
  generic fallback.
- Do not restore the deleted component tree. The current UI path is
  `src/modules/` plus the existing Zustand stores.
- Tests must not overwrite, delete, or migrate real `~/.kimi-code`
  configuration, credentials, or session history. Use temporary directories.

## 代码与文档规范 / Code and documentation standards

### TypeScript 与 React / TypeScript and React

- 遵循现有 TypeScript 严格类型和 React 组件模式；
- 使用 Biome 格式化和检查，2 空格缩进、双引号、分号、100 字符行宽；
- 新 UI 使用现有 V2 modules、设计 token 和组件，不复制旧组件树；
- 用户可见文字必须接入现有 i18n catalog，并通过 `npm run i18n:check`；
- 修复用户可见事件时覆盖完整数据链路，而不只修改 TypeScript union。

- Follow existing strict TypeScript and React component patterns.
- Use Biome formatting and checks: two-space indentation, double quotes,
  semicolons, and a 100-character line width.
- Build new UI from the current V2 modules, design tokens, and components; do
  not duplicate the old component tree.
- Add user-visible copy to the existing i18n catalog and pass
  `npm run i18n:check`.
- For user-visible event fixes, cover the complete data path rather than only
  changing a TypeScript union.

`npm run lint` 会写入文件。审查或 CI 对齐时使用不会改写文件的 `npm run lint:check`。

`npm run lint` rewrites files. Use the non-mutating `npm run lint:check` for
review and CI parity.

### Rust / Rust

- 使用稳定 Rust，并保持最低版本 1.78 兼容；
- 提交前运行 `cargo fmt`，使用 `cargo fmt --check` 验证；
- Clippy warning 按错误处理；
- Tauri command、ACP 消息和持久化数据变更应有单元或集成测试；
- 平台相关代码使用明确的 `cfg` 边界，不破坏 Windows 或 macOS ARM64 检查。

- Use stable Rust while remaining compatible with the minimum Rust version 1.78.
- Run `cargo fmt` before committing and verify with `cargo fmt --check`.
- Treat Clippy warnings as errors.
- Add unit or integration coverage for Tauri commands, ACP messages, and
  persisted-data changes.
- Keep platform code behind explicit `cfg` boundaries and preserve both Windows
  and macOS ARM64 checks.

### 文档 / Documentation

- 让命令、文件名和能力描述与当前源码、测试和 `package.json` 一致；
- 区分“工作区已有代码”“自动化测试通过”“真实桌面已验收”和“可发布”；
- 不要引用已移除的文档或把 `docs/plans/` 中的计划当成已发布事实；
- 面向用户的主要文档保持中文与英文含义一致；
- 使用相对链接，并在提交前检查 Markdown 标题、表格和代码块。

- Keep commands, filenames, and capability claims aligned with current source,
  tests, and `package.json`.
- Distinguish “implemented in the worktree,” “automated tests pass,” “accepted
  on a real desktop,” and “release ready.”
- Do not reference removed documentation or treat plans under `docs/plans/` as
  released facts.
- Keep Chinese and English meaning aligned in primary user-facing documentation.
- Use relative links and inspect Markdown headings, tables, and code blocks
  before submitting.

## 验证矩阵 / Verification matrix

先运行与改动范围匹配的 focused tests，再选择以下门禁。文档或小范围前端改动至少应运行
相关检查和 `git diff --check`。

Run focused tests for the changed area first, then select the appropriate gates
below. Documentation or small frontend changes require at least the relevant
checks and `git diff --check`.

### 日常快速门禁 / Daily quick gate

```powershell
npm run check:quick
```

### 前端与共享资源 / Frontend and shared assets

```powershell
npm run lint:check
npm run i18n:check
npm test
npx tsc -b
npm run build
```

CI 还运行 `npm audit --audit-level moderate`，但当前将审计结果作为非阻塞信号。

CI also runs `npm audit --audit-level moderate`, currently as a non-blocking
signal.

### Rust 与 Tauri / Rust and Tauri

```powershell
npm run rust:check
npm run rust:clippy
npm run rust:test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

如需完全匹配 CI 的 all-targets 范围：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

For exact CI parity across all targets:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

### ACP 与本地集成 / ACP and local integration

```powershell
npm run smoke:acp
```

按改动范围还可运行：

```powershell
npm run smoke:mcp
npm run smoke:skill
```

这些 smoke test 可能依赖本机 CLI、配置和认证状态。报告失败时，请区分环境阻塞和代码回归。

Depending on the change, also run:

```powershell
npm run smoke:mcp
npm run smoke:skill
```

These smoke tests may depend on the local CLI, configuration, and authentication
state. When reporting failures, distinguish environmental blockers from code
regressions.

### 真实桌面验收 / Real desktop acceptance

浏览器 mock、Vitest 和生产构建都不能替代真实 Tauri 验收。用户可见运行时变更应使用
`npm run desktop` 或 `start.bat`，连接已配置的真实 `kimi acp`，并检查：

- 可见 DOM 与交互；
- WebView2/开发者工具控制台错误；
- 真实 Tauri IPC 与事件；
- 新建、恢复及历史回放会话；
- prompt、工具、审批、Workspace 和 Settings；
- 通知、窗口、托盘或平台集成（如果相关）。

Browser mocks, Vitest, and production builds do not replace real Tauri
acceptance. For user-visible runtime changes, use `npm run desktop` or
`start.bat` with a configured real `kimi acp`, and inspect:

- Visible DOM and interactions;
- WebView2/developer-tools console errors;
- Real Tauri IPC and events;
- New, resumed, and replayed sessions;
- Prompts, tools, approvals, Workspace, and Settings;
- Notifications, windows, tray behavior, or platform integration when relevant.

### 状态声明 / Status claims

请分别报告：

1. 代码是否存在于工作区；
2. 哪些自动化测试通过；
3. 是否完成真实桌面验收；
4. 是否通过发布门禁。

不要用其中一项推断另一项。

Report separately:

1. Whether the code exists in the worktree;
2. Which automated tests passed;
3. Whether real desktop acceptance was completed;
4. Whether release gates passed.

Do not infer one state from another.

## 专项变更要求 / Change-specific requirements

### 依赖 / Dependencies

- 解释新增或升级依赖的必要性、体积、许可证和安全影响；
- 同步提交 `package-lock.json` 或 `Cargo.lock`；
- 避免为已有平台能力引入重复库；
- 运行相应构建、测试和审计。

- Explain the necessity, size, license, and security impact of a new or upgraded
  dependency.
- Commit the matching `package-lock.json` or `Cargo.lock`.
- Avoid duplicating capabilities already provided by the platform.
- Run the relevant build, tests, and audit.

### 版本 / Versioning

桌面壳版本必须在以下四个文件中一致：

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

使用以下命令检查：

```powershell
npm run version:sync
```

The desktop shell version must match across:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Verify it with:

```powershell
npm run version:sync
```

桌面壳版本和 Kimi Code CLI 版本是两个独立概念。任何 CLI 版本 UI 都必须探测实际安装
或运行的 CLI，不能复用桌面版本。

The desktop shell version and Kimi Code CLI version are separate concepts. Any
CLI version UI must detect the actually installed or running CLI rather than
reuse the desktop version.

### 发布 / Releases

只有发布相关改动才需要运行完整发布门禁：

```powershell
npm run release:preflight
npm run release:msi
npm run release:macos
```

- `npm run desktop:release` 生成本地可运行的 release executable；
- `npm run release:msi` 生成 Windows MSI 和发布元数据；
- `npm run release:macos` 仅用于 macOS Apple Silicon；
- 不要使用裸 `cargo build --release` 代替桌面构建，它会绕过 Tauri 前端构建流程；
- 未通过 `release:preflight` 及对应平台打包前，不要声明“可发布”。

Only release-related changes need the complete release gates:

```powershell
npm run release:preflight
npm run release:msi
npm run release:macos
```

- `npm run desktop:release` produces a locally runnable release executable.
- `npm run release:msi` produces the Windows MSI and release metadata.
- `npm run release:macos` is for macOS Apple Silicon only.
- Do not substitute a bare `cargo build --release`; it bypasses the Tauri
  frontend build pipeline.
- Do not claim release readiness before `release:preflight` and the relevant
  platform package complete successfully.

只运行与你的平台和变更相关的打包命令，并在 Pull Request 中注明未运行的其他平台验证。

Run only packaging commands relevant to your platform and change, and note
unverified platforms in the pull request.

## 提交与 Pull Request / Commits and pull requests

### 提交 / Commits

提交应小而聚焦，并使用仓库现有的 Conventional Commits 风格：

```text
feat: add session search filters
fix: preserve unknown ACP display payloads
test: cover replayed approval events
docs: clarify Windows development setup
chore: update desktop dependencies
style: apply rustfmt to ACP tests
```

- 使用祈使、具体的标题；
- 一个 commit 只表达一个逻辑意图；
- 不提交生成的 `dist/`、本机配置、凭据、日志或无关格式化；
- 不使用宽泛的全仓暂存把他人的改动混入提交；
- 合并、rebase 或 fixup 前先确认不会改写共享历史。

Commits should be small and focused, following the repository's existing
Conventional Commits style:

```text
feat: add session search filters
fix: preserve unknown ACP display payloads
test: cover replayed approval events
docs: clarify Windows development setup
chore: update desktop dependencies
style: apply rustfmt to ACP tests
```

- Use an imperative, specific subject.
- Keep one logical intent per commit.
- Do not commit generated `dist/` output, local configuration, credentials,
  logs, or unrelated formatting.
- Do not use broad repository-wide staging that captures someone else's work.
- Before merging, rebasing, or fixing up, verify that shared history will not be
  rewritten.

### 拉取请求 / Pull requests

Pull Request 应尽量保持可独立评审，并包含：

- **动机**：解决什么问题、面向谁；
- **实现**：关键行为和数据流如何改变；
- **范围**：明确包含和不包含的内容；
- **风险**：兼容性、用户数据、性能、安全和平台影响；
- **验证**：实际运行的命令及结果；
- **运行时证据**：真实 Tauri/ACP 验收状态；
- **UI 证据**：视觉改动的截图或录屏，必要时同时覆盖深色和浅色主题；
- **平台**：已验证的 Windows 版本、架构或 macOS ARM64 环境；
- **关联项**：相关 Issue、设计、计划或后续任务；
- **未验证项**：受环境限制未运行的检查及原因。

A pull request should be independently reviewable and include:

- **Motivation**: the problem, affected users, and intended outcome;
- **Implementation**: key behavior and data-flow changes;
- **Scope**: what is and is not included;
- **Risk**: compatibility, user-data, performance, security, and platform impact;
- **Verification**: commands actually run and their results;
- **Runtime evidence**: real Tauri/ACP acceptance status;
- **UI evidence**: screenshots or recordings for visual changes, covering both
  dark and light themes when relevant;
- **Platform**: tested Windows version and architecture or macOS ARM64
  environment;
- **Links**: related issues, designs, plans, or follow-up tasks;
- **Not verified**: checks skipped because of environment constraints and why.

在请求评审前：

- 自查完整 diff 和新增文件；
- 处理调试日志、临时代码和无关改动；
- 确认 generic fallback、错误态和空态没有退化；
- 确认 CI 所需检查通过，或清楚解释阻塞；
- 解决合并冲突，但不要借机重写无关文件。

Before requesting review:

- Review the complete diff and all new files.
- Remove debug logging, temporary code, and unrelated changes.
- Confirm generic fallbacks, error states, and empty states have not regressed.
- Pass required CI checks or clearly explain blockers.
- Resolve merge conflicts without rewriting unrelated files.

## 评审与社区行为 / Reviews and community conduct

仓库目前没有单独的 `CODE_OF_CONDUCT.md`。参与 Issue、Pull Request 和评审时，请：

- 尊重不同背景、经验和观点；
- 针对代码、行为和证据讨论，不针对个人；
- 给出具体、可执行且说明原因的反馈；
- 对维护者请求及时响应，或说明需要更多时间；
- 不骚扰、歧视、威胁、泄露隐私或发布不当内容；
- 接受维护者可能为架构一致性、维护成本或产品范围关闭提案。

The repository does not currently publish a separate `CODE_OF_CONDUCT.md`. In
issues, pull requests, and reviews:

- Respect different backgrounds, experience levels, and viewpoints.
- Discuss code, behavior, and evidence rather than individuals.
- Give specific, actionable feedback with rationale.
- Respond to maintainer requests promptly or state that more time is needed.
- Do not harass, discriminate, threaten, expose private information, or post
  inappropriate content.
- Accept that maintainers may close proposals for architecture consistency,
  maintenance cost, or product-scope reasons.

评审意见不必全部照单全收，但应明确回应：接受并修改、提供反证，或说明建议为何超出当前
Pull Request 范围。重要的后续工作应记录为 Issue，而不是遗留在未解决的评论中。

You do not have to accept every review suggestion, but respond explicitly:
apply the change, provide counter-evidence, or explain why it is outside the
pull request's scope. Record substantial follow-up work as an issue rather than
leaving it only in unresolved comments.

## 许可证 / License

本项目基于 [Apache License 2.0](LICENSE) 发布。提交贡献即表示：

- 你有权提交这些内容；
- 你的贡献可以按 Apache License 2.0 分发；
- 你没有故意加入不兼容许可、机密或第三方专有材料。

This project is distributed under the [Apache License 2.0](LICENSE). By
contributing, you represent that:

- You have the right to submit the contribution.
- Your contribution may be distributed under the Apache License 2.0.
- You have not knowingly included incompatibly licensed, confidential, or
  proprietary third-party material.

感谢你的贡献。

Thank you for contributing.
