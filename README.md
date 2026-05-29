# Kimi Desktop

独立的 Kimi Code 桌面版项目，通过 Wire 协议连接 Kimi CLI runtime。

## 启动开发版

```bat
start.bat
```

或：

```bat
npm run tauri:dev
```

桌面端不需要单独启动本地 HTTP 后端，也不强制 `kimi login`。它使用正常 Kimi CLI 配置：

```text
%USERPROFILE%\.kimi\config.toml
```

你可以在其中配置任意支持的 provider/model/API key，或使用已有官方登录态。

## 结构

```text
src/                      React/Vite frontend
src-tauri/                Tauri v2 Rust shell
sidecar-adapter/          独立 Python sidecar adapter
src-tauri/sidecar/        Tauri externalBin 输出位置
```

## 验证

```bat
npm run build
cargo check --manifest-path src-tauri\Cargo.toml
cd sidecar-adapter
python -m compileall -q kimi_desktop_sidecar
```

## 打包

```bat
npm run tauri:build
```

打包前需要确保存在：

```text
src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe
```

后续应由 `sidecar-adapter` 构建该 exe。
