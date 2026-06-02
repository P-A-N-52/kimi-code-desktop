# 发布指南 / Release Guide

本项目默认将 Windows 桌面应用发布为 MSI 包。MSI 路径可以避开 NSIS bootstrap 下载，是当前稳定的发布通道。发布工作必须遵循 `docs/DEVELOPMENT_STANDARD.md`。

English: This project publishes the Windows desktop app as an MSI bundle by default. The MSI path avoids the NSIS bootstrap download and is the stable release lane. Release work must follow `docs/DEVELOPMENT_STANDARD.md`.

## 前置条件 / Prerequisites

- Node.js 和 npm / Node.js and npm
- 带 MSVC target 的 Rust stable toolchain / Rust stable toolchain with the MSVC target
- Python 3.12 或更高版本 / Python 3.12 or newer
- `uv`
- 通过 `uv tool install kimi-cli` 安装的 Kimi CLI / Kimi CLI installed with `uv tool install kimi-cli`
- 用于高置信密钥扫描的 `rg` / `rg` for the high-confidence secret scan
- `src-tauri/sidecar/kimi-sidecar-x86_64-pc-windows-msvc.exe`

使用以下命令构建 sidecar：

English: Build the sidecar with:

```powershell
npm run sidecar:build
```

## 预检 / Preflight

运行所有发布门禁，但不生成安装器：

English: Run all release gates without producing an installer:

```powershell
npm run release:preflight
```

预检会检查：

English: The preflight checks:

- sidecar 重建和 sidecar manifest 校验 / sidecar rebuild and sidecar manifest validation
- 前端生产构建 / frontend production build
- Rust 编译检查 / Rust compile check
- Rust clippy lint 门禁 / Rust clippy lint gate
- Python sidecar 编译检查 / Python sidecar compile check
- Python sidecar 测试 / Python sidecar tests
- npm 高危或严重漏洞审计 / npm audit for high or critical advisories
- 高置信密钥模式扫描 / high-confidence secret patterns
- git 发布可追溯性 / git release traceability

通过 MSI 安装后的应用会直接启动 Tauri 可执行文件，因此发布就绪不能依赖 `start.bat`。应用会先通过 `kimi-sidecar __desktop-runtime-info` 检查随包 sidecar 运行时，再检查用户 `config.toml`、凭据来源，以及可选外部 `kimi` 登录辅助命令，然后再加载会话 API。

English: The installed MSI starts the Tauri executable directly, so release readiness must not depend on `start.bat`. The app checks the bundled sidecar runtime through `kimi-sidecar __desktop-runtime-info`, then checks user `config.toml`, credential sources, and the optional external `kimi` login helper before session APIs are loaded.

## 构建 MSI / Build MSI

```powershell
npm run release:msi
```

该脚本会写入 MSI 以及以下文件：

English: The script writes the MSI plus:

- `SHA256SUMS.txt`
- `release-manifest.json`

这些文件会放在 MSI 旁边：

English: Both files are placed next to the MSI under:

```text
src-tauri/target/release/bundle/msi/
```

构建前，发布脚本会清理该目录中的旧 MSI 元数据。随后它只接受与当前 `package.json` 版本匹配的新 MSI，避免失败构建意外发布旧安装包。

English: Before building, the release script clears previous MSI metadata in that folder. It then accepts only a fresh MSI that matches the current `package.json` version, so a failed build cannot accidentally publish an older installer.

MSI 构建还会验证生成的 WiX manifest 是否支持卸载：WiX `upgradeCode` 必须固定，Windows Apps 卸载元数据必须存在，开始菜单中必须包含指向 `msiexec /x [ProductCode]` 的 `Uninstall Kimi Code`。

English: The MSI build also validates uninstall support in the generated WiX manifest: the WiX `upgradeCode` must be pinned, Windows Apps uninstall metadata must be present, and the Start Menu must contain `Uninstall Kimi Code` pointing to `msiexec /x [ProductCode]`.

## 卸载 / Uninstall

打包应用可通过任一标准 Windows 入口卸载：

English: The packaged app can be removed through either normal Windows entry point:

- Windows 设置 > 应用 > 已安装的应用 > Kimi Code > 卸载 / Windows Settings > Apps > Installed apps > Kimi Code > Uninstall
- 开始菜单 > Kimi Code > Uninstall Kimi Code / Start Menu > Kimi Code > Uninstall Kimi Code

如果原始 MSI 仍可用，也可以通过命令行卸载：

English: For command-line uninstall while the original MSI is available:

```powershell
msiexec.exe /x ".\Kimi Code_<version>_x64_en-US.msi"
```

卸载会移除已安装的应用文件和快捷方式。它会有意保留 `~\.kimi`，包括 `config.toml` 和凭据，因为这些文件属于共享的 Kimi CLI 运行时，应在升级或重新安装后继续保留。

English: Uninstall removes installed app files and shortcuts. It intentionally preserves `~\.kimi`, including `config.toml` and credentials, because those files belong to the shared Kimi CLI runtime and should survive upgrades or reinstall attempts.

## GitHub 发布 / GitHub Release

仓库包含 `.github/workflows/release.yml`，用于公开 Windows 发布通道。它会在 `windows-latest` 上构建 MSI，上传 workflow artifact，并把以下文件发布到 GitHub Release：

English: The repository includes `.github/workflows/release.yml` for the public Windows release lane. It builds the MSI on `windows-latest`, uploads the workflow artifact, and publishes these files to a GitHub Release:

- `*.msi`
- `SHA256SUMS.txt`
- `release-manifest.json`
- `kimi-code-desktop.release.json`

该工作流会先通过 `uv tool install kimi-cli` 安装 Kimi CLI 运行时，再运行 `npm run release:msi`，以匹配 `scripts/build-sidecar.ps1` 在干净 Windows runner 上发现运行时的路径。

English: The workflow installs the Kimi CLI runtime with `uv tool install kimi-cli` before running `npm run release:msi`, matching the path that `scripts/build-sidecar.ps1` discovers on a clean Windows runner.

通过推送版本标签发布：

English: Publish by pushing a version tag:

```powershell
npm run version:set 0.1.0
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release v0.1.0"
git tag v0.1.0
git push origin master --tags
```

也可以在 GitHub Actions 中手动运行 `Release` 工作流。提供类似 `v0.1.0` 的 tag，或留空以使用 `v<package.json version>`。

English: You can also run the `Release` workflow manually from GitHub Actions. Provide a tag such as `v0.1.0`, or leave it blank to use `v<package.json version>`.

## NSIS 安装器 / NSIS Installer

仍然可以显式构建 NSIS：

English: NSIS can still be built explicitly:

```powershell
npm run tauri:build:nsis
```

该路径可能会从 Tauri binary release mirror 下载 NSIS。只有在构建机器已缓存依赖，或网络访问稳定时才使用。

English: This path may download NSIS from the Tauri binary release mirror. Use it only when the build machine has the dependency cached or network access is stable.

## Windows 代码签名 / Windows Code Signing

未签名的 Windows 构建可能触发 SmartScreen 或发布者警告。若要在 MSI 构建后签名 artifact，请安装 Windows SDK，并提供 PFX 证书或证书指纹：

English: Unsigned Windows builds may trigger SmartScreen or publisher warnings. To sign artifacts after an MSI build, install the Windows SDK and provide either a PFX certificate or a certificate thumbprint:

```powershell
$env:WINDOWS_CERT_PATH = "C:\path\to\certificate.pfx"
$env:WINDOWS_CERT_PASSWORD = "pfx-password"
npm run release:msi -- -Sign
```

也可以使用已安装在 Windows 证书存储中的证书签名：

English: Or sign with a certificate installed in the Windows certificate store:

```powershell
$env:WINDOWS_CERT_SHA1 = "CERTIFICATE_THUMBPRINT"
npm run release:msi -- -Sign
```

可选配置：

English: Optional:

```powershell
$env:SIGNTOOL_EXE = "C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe"
$env:WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"
```

## 版本规则 / Versioning

公开发布前，保持以下值一致：

English: Keep these values in sync before a public release:

- `package.json` version
- `package-lock.json` version
- `src-tauri/tauri.conf.json` version
- `src-tauri/Cargo.toml` version

用以下命令检查或设置：

English: Check or set them with:

```powershell
npm run version:sync
npm run version:set 0.1.0
```

项目位于 git 仓库中时，release manifest 会记录 git commit。公开发布请创建 tag：

English: The release manifest records the git commit when the project is inside a git repository. Create a tag for public releases:

```powershell
git tag v<version>
```
