# Release Guide

This project publishes the Windows desktop app as an MSI bundle by default.
The MSI path avoids the NSIS bootstrap download and is the stable release lane.

## Prerequisites

- Node.js and npm
- Rust stable toolchain with the MSVC target
- Python 3.12 or newer
- `uv`
- `rg` for the high-confidence secret scan
- `src-tauri/sidecar/kimi-sidecar-x86_64-pc-windows-msvc.exe`

Build the sidecar with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-sidecar.ps1
```

## Preflight

Run all release gates without producing an installer:

```powershell
npm run release:preflight
```

The preflight checks:

- frontend production build
- Rust compile check
- Python sidecar compile check
- Python sidecar tests
- npm audit for high or critical advisories
- high-confidence secret patterns
- git release traceability

## Build MSI

```powershell
npm run release:msi
```

The script writes the MSI plus:

- `SHA256SUMS.txt`
- `release-manifest.json`

Both files are placed next to the MSI under:

```text
src-tauri/target/release/bundle/msi/
```

## NSIS Installer

NSIS can still be built explicitly:

```powershell
npm run tauri:build:nsis
```

This path may download NSIS from the Tauri binary release mirror. Use it only
when the build machine has the dependency cached or network access is stable.

## Windows Code Signing

Unsigned Windows builds may trigger SmartScreen or publisher warnings. To sign
artifacts after an MSI build, install the Windows SDK and provide either a PFX
certificate or a certificate thumbprint:

```powershell
$env:WINDOWS_CERT_PATH = "C:\path\to\certificate.pfx"
$env:WINDOWS_CERT_PASSWORD = "pfx-password"
npm run release:msi -- -Sign
```

Or sign with a certificate installed in the Windows certificate store:

```powershell
$env:WINDOWS_CERT_SHA1 = "CERTIFICATE_THUMBPRINT"
npm run release:msi -- -Sign
```

Optional:

```powershell
$env:SIGNTOOL_EXE = "C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe"
$env:WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"
```

## Versioning

Keep these values in sync before a public release:

- `package.json` version
- `src-tauri/tauri.conf.json` version
- `src-tauri/Cargo.toml` version

The release manifest records the git commit when the project is inside a git
repository. Create a tag for public releases:

```powershell
git tag v1.44.0
```
