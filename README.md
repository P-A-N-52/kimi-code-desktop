# Kimi Code Desktop

Kimi Code Desktop is the Windows desktop shell for the Kimi CLI runtime.
The desktop app owns the React/Tauri user experience and process orchestration.
AI session logic, model configuration, tools, and runtime behavior stay in the
Kimi CLI Python stack and are reached through the desktop sidecar adapter.

The authoritative development rules live in `docs/DEVELOPMENT_STANDARD.md`.
Keep launch, build, release, sidecar, and version changes aligned with that
file.

## Canonical Workflow

Use these commands as the source of truth:

```powershell
npm run desktop          # Daily development app, same as desktop:dev
npm run desktop:dev      # Explicit Tauri dev mode with hot reload
npm run desktop:release  # Build the local runnable release exe
npm run release:msi      # Build the MSI installer and release metadata
npm run release:preflight
npm run sidecar:build
```

The root `start.bat` and this folder's `start.bat` both default to development
mode:

```bat
start.bat
start.bat dev
```

Run a built release executable only when you ask for it explicitly:

```bat
start.bat release
```

Do not use `cargo build --release` as the runnable desktop release path. It
bypasses Tauri's frontend build pipeline and can produce a window that fails
with `asset not found: index.html`.

## Build Artifacts

Local release exe:

```text
src-tauri\target\release\kimi-code-desktop.exe
```

MSI installer:

```text
src-tauri\target\release\bundle\msi\Kimi Code_<version>_x64_en-US.msi
```

GitHub releases are built by `.github/workflows/release.yml`. Push a `v*` tag
or run the `Release` workflow manually to publish the MSI, `SHA256SUMS.txt`, and
release manifests to GitHub Releases.

The app can be shipped as a normal Windows desktop application with one
user-facing launcher. Internally, the current architecture still includes a
sidecar executable, so the installed files are not expected to be one single
standalone portable file.

The installed MSI launches the Tauri executable directly, not `start.bat`.
Startup readiness checks therefore run inside the app itself. On first window
load, the desktop app verifies the bundled sidecar/Kimi CLI runtime,
`config.toml`, credential sources, and the optional external `kimi` command used
for terminal login/setup before it loads sessions.

The MSI also installs normal Windows uninstall entry points. Users can remove
the app from Windows Settings > Apps or from the Start Menu shortcut named
`Uninstall Kimi Code`. MSI uninstall removes the app files and shortcuts, but it
does not delete `~\.kimi` because that config and credential store belongs to
the Kimi CLI runtime and should survive upgrades or reinstall attempts.

## Sidecar

The Tauri external binary source must exist here:

```text
src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe
```

Build or refresh it with:

```powershell
npm run sidecar:build
```

When `start.bat release` launches the workspace release exe, it refreshes the
neighboring `kimi-sidecar.exe` from this source binary before launch.

The packaged sidecar also exposes a hidden `__desktop-runtime-info` command.
The installed app uses that command to verify the bundled runtime instead of
assuming an external `kimi` command is on PATH.

## Validation

For normal development changes:

```powershell
npm test
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

For release confidence:

```powershell
npm run release:preflight
```

`release:preflight` checks the sidecar binary, frontend tests, version
alignment, frontend production build, Rust check/clippy, Tauri no-bundle release
build, Python sidecar compile/tests, npm audit for high severity advisories,
secret scan, and git traceability.

## Project Layout

```text
src/                      React/Vite frontend
src-tauri/                Tauri v2 Rust shell
sidecar-adapter/          Python sidecar adapter
src-tauri/sidecar/        Tauri externalBin source location
docs/DEVELOPMENT_STANDARD.md
docs/RELEASE.md
.github/workflows/ci.yml  CI checks for the repository root
.github/workflows/release.yml  Windows MSI release publisher
```

## Versioning

The desktop shell version must stay aligned across:

```text
package.json
package-lock.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

Check alignment:

```powershell
npm run version:sync
```

Set a new desktop shell version:

```powershell
npm run version:set 0.1.0
```

The Kimi CLI runtime version is separate. UI surfaces that show the CLI version
must read the installed/runtime CLI, not the desktop shell version.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE` for details.
