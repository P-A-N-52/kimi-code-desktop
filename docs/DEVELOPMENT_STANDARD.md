# 开发标准 / Development Standard

本文档是日常开发、子代理协作、构建、发布验证和交接的项目标准。当其他文档或代理说明与本文件不一致时，应更新其他文档以匹配本文件。

English: This document is the project standard for everyday development, sub-agent work, builds, release validation, and handoff. When another document or agent disagrees with this file, update the other document to match this one.

## 运行模式 / Operating Mode

项目默认保持在主动开发模式。

English: The project stays in active development mode by default.

日常启动：

English: Daily launch:

```powershell
npm run desktop
```

批处理启动：

English: Batch launch:

```bat
start.bat
```

这两条路径都会启动 Tauri 开发应用，不应静默优先使用旧 release 可执行文件。

English: Both paths start the Tauri dev app. They must not silently prefer an old release executable.

release 启动必须显式指定：

English: Release launch is explicit:

```bat
start.bat release
```

release 模式只能启动由以下命令产出的已验证可执行文件：

English: Release mode may launch only a verified executable produced by:

```powershell
npm run desktop:release
```

## 标准命令 / Canonical Commands

在文档、issue、交接和代理提示中使用这些名称：

English: Use these names in docs, issues, handoffs, and agent prompts:

```powershell
npm run desktop          # daily development
npm run desktop:dev      # explicit Tauri dev
npm run desktop:release  # local runnable release exe
npm run release:preflight
npm run release:msi      # MSI installer and metadata
npm run sidecar:build
npm run version:sync
npm run version:set <version>
```

兼容别名可以保留在 `package.json` 中，但它们不是日常工作的首选表达：

English: Compatibility aliases may remain in `package.json`, but they are not the preferred language for normal work:

```powershell
npm run tauri:dev
npm run tauri:build
```

除非文档明确描述内部机制，否则不要把原始 Tauri 或 Cargo 命令写成 release 路径。

English: Do not document raw Tauri or Cargo commands as release paths unless the document is explicitly describing internals.

## 发布规则 / Release Rules

永远不要把以下命令作为可运行桌面 release 路径：

English: Never use this command as a runnable desktop release path:

```powershell
cargo build --release --manifest-path src-tauri/Cargo.toml
```

它可以只编译 Rust，而不运行 Tauri 前端资源流水线。典型症状是：

English: It can compile Rust without running the Tauri frontend asset pipeline. The typical symptom is:

```text
asset not found: index.html
```

`npm run desktop:release` 必须：

English: `npm run desktop:release` must:

- 构建前停止正在运行的桌面和 sidecar 进程； / stop running desktop and sidecar processes before build;
- 检查桌面外壳版本一致性； / check desktop shell version alignment;
- 运行 Tauri no-bundle 构建路径； / run the Tauri no-bundle build path;
- 产出 `src-tauri\target\release\kimi-code-desktop.exe`； / produce `src-tauri\target\release\kimi-code-desktop.exe`;
- 写入 `src-tauri\target\release\kimi-code-desktop.release.json`。 / write `src-tauri\target\release\kimi-code-desktop.release.json`.

`start.bat release` 必须在启动前验证 release manifest。单独存在 `.exe` 文件不足以证明可运行。

English: `start.bat release` must validate that release manifest before launch. A bare `.exe` file is not enough proof.

`npm run release:msi` 是公开 MSI 路径。它必须：

English: `npm run release:msi` is the public MSI path. It must:

- 即使跳过 preflight，也检查桌面外壳版本一致性； / check desktop shell version alignment even when preflight is skipped;
- 打包前清理旧 MSI 元数据； / clear previous MSI metadata before bundling;
- 通过内部 raw Tauri MSI 命令构建； / build through the internal raw Tauri MSI command;
- 只接受与当前 package 版本匹配的新 MSI； / accept only a fresh MSI matching the current package version;
- 验证 release exe 是新的； / verify the release exe is fresh;
- 验证 MSI 卸载支持，包括固定的 WiX `upgradeCode`、Windows Apps 卸载元数据，以及开始菜单 `Uninstall Kimi Code` 快捷方式； / validate MSI uninstall support, including the pinned WiX `upgradeCode`, Windows Apps uninstall metadata, and the Start Menu `Uninstall Kimi Code` shortcut;
- 写入 checksums 和 `release-manifest.json`； / write checksums and `release-manifest.json`;
- MSI patch 后刷新本地 release manifest。 / refresh the local release manifest after MSI patching.

MSI 启动不能依赖 `start.bat`。已安装应用的入口是 Tauri 可执行文件，所以运行时就绪检查也必须位于桌面应用内部。启动时，应用必须先检查随包 sidecar/运行时、`config.toml`、凭据来源和可选外部 `kimi` 登录辅助命令，然后再加载会话。

English: MSI startup must not depend on `start.bat`. The installed app entrypoint is the Tauri executable, so runtime readiness checks must also live inside the desktop app. On startup, the app must check the bundled sidecar/runtime, `config.toml`, credential sources, and the optional external `kimi` login helper before loading sessions.

MSI 卸载必须移除已安装的应用文件和快捷方式，但默认不得删除 `~\.kimi`。该目录归 Kimi CLI 运行时所有，可能包含可复用配置或凭据。

English: MSI uninstall must remove installed app files and shortcuts but must not remove `~\.kimi` by default. That directory is owned by the Kimi CLI runtime and may contain reusable config or credentials.

## Sidecar 规则 / Sidecar Rules

sidecar 源二进制位于：

English: The source sidecar binary is:

```text
src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe
```

使用以下命令构建：

English: Build it with:

```powershell
npm run sidecar:build
```

sidecar 构建必须在原生命令失败时快速失败，并写入：

English: The sidecar build must fail fast on failed native commands and write:

```text
src-tauri\sidecar\kimi-sidecar.manifest.json
```

发布验证不能只依赖“sidecar exe 存在”。它必须验证 sidecar manifest 和 hash。

English: Release validation must not rely only on "the sidecar exe exists." It must verify the sidecar manifest and hash.

打包后的 sidecar 必须提供 `__desktop-runtime-info`，这样已安装应用就能验证随包 `kimi_cli` 包可导入，并报告运行时版本，而不依赖 PATH。

English: The packaged sidecar must expose `__desktop-runtime-info` so the installed app can verify that the bundled `kimi_cli` package is importable and report its runtime version without relying on PATH.

`npm run sidecar:build` 必须对构建出的 exe 执行该隐藏 runtime-info 命令；如果无法从 stdout 解析出可用 JSON，则必须失败。

English: `npm run sidecar:build` must execute that hidden runtime-info command against the built exe and fail if it cannot parse usable JSON from stdout.

## 版本规则 / Version Rules

桌面外壳版本必须在以下四个文件中匹配：

English: The desktop shell version must match in all four files:

```text
package.json
package-lock.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

检查：

English: Check:

```powershell
npm run version:sync
```

设置：

English: Set:

```powershell
npm run version:set <version>
```

运行时 Kimi CLI 版本与桌面外壳版本不同。展示 CLI 版本的 UI 必须探测已安装 CLI/运行时，不能复用外壳版本。

English: The runtime Kimi CLI version is separate from the desktop shell version. UI that shows the CLI version must probe the installed CLI/runtime, not reuse the shell version.

## 验证标准 / Verification Standard

普通开发变更使用：

English: For normal development changes:

```powershell
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

发布、打包、sidecar、版本或启动脚本变更使用：

English: For release, packaging, sidecar, version, or launch-script changes:

```powershell
npm run release:preflight
```

MSI 专项变更使用：

English: For MSI-specific changes:

```powershell
npm run release:msi
```

如果某个命令无法运行，最终交接中必须明确记录原因和剩余风险。

English: If a command cannot be run, record that explicitly in the final handoff with the reason and the residual risk.

## 子代理标准 / Sub-Agent Standard

将子代理用于可并行检查的独立工作。保持写入所有权分离：

English: Use sub-agents for independent work that can be checked in parallel. Keep write ownership separate:

```text
Frontend agent: src/
Rust agent: src-tauri/src/
Sidecar agent: sidecar-adapter/
Release/docs agent: package.json, scripts/*.ps1, docs/, start.bat
```

子代理必须：

English: Sub-agents must:

- 先检查当前 worktree 状态再做结论； / inspect current worktree state before making claims;
- 避免回退无关改动； / avoid reverting unrelated edits;
- 报告发现时给出精确文件路径和行号； / report exact file paths and line numbers for findings;
- 保持命令名称与本标准一致； / keep command names aligned with this standard;
- 验证自己负责的范围，或明确说明剩余未验证事项。 / verify their assigned scope or clearly state what remains unverified.

## 文档标准 / Documentation Standard

公开文档应指向本文件作为权威工作流。保持以下文件一致：

English: Public docs should point to this file for the authoritative workflow. Keep these files aligned:

```text
README.md
AGENTS.md
docs/RELEASE.md
```

修改启动、构建、发布、sidecar 或版本行为时，必须在同一变更中更新文档。

English: When changing launch, build, release, sidecar, or version behavior, update the docs in the same change.
