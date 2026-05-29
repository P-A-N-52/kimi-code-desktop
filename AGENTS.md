# Kimi Desktop

独立的 Kimi Code 桌面项目。这个项目不是 `kimi-cli` 源码的一部分；它通过 Wire 协议和独立 sidecar adapter 复用 `kimi-cli` 的会话、模型配置和 Agent runtime。

## Runtime 链路

```text
Tauri React frontend
  -> Tauri IPC/events
  -> Rust WireProcessManager (`src-tauri/src/sidecar.rs`)
  -> `kimi-sidecar __desktop-worker <session_id>`
  -> stdio JSON-RPC Wire protocol (NDJSON, Wire 1.10)
```

Native API 操作走一次性 helper：

```text
Tauri command -> Rust `call_desktop_api()` -> `kimi-sidecar __desktop-api`
```

## 与 kimi-cli 的关系

- `kimi-cli/` 是核心 CLI 项目。
- `kimi-desktop/` 是独立桌面壳项目。
- Python adapter 位于 `sidecar-adapter/kimi_desktop_sidecar/`，它 import `kimi_cli.*` 作为依赖，但不要把桌面 helper 放回 `kimi_cli` 包内。
- 桌面使用不强制 `kimi login`；模型/API 配置来自 `~/.kimi/config.toml`，可使用任意支持的 provider/model/API key，也可使用已有官方登录态。

## 关键文件

- `src/hooks/useSessionStream.ts`：Tauri Wire transport + UI stream reducer。
- `src/lib/tauri-api.ts`：Tauri IPC wrapper。
- `src-tauri/src/sidecar.rs`：Rust WireProcessManager，管理 worker/stdin/stdout NDJSON。
- `src-tauri/src/commands.rs`：Tauri command surface。
- `sidecar-adapter/kimi_desktop_sidecar/worker.py`：Wire worker + 上传文件注入。
- `sidecar-adapter/kimi_desktop_sidecar/api.py`：native API helper。
- `sidecar-adapter/kimi_desktop_sidecar/__main__.py`：sidecar adapter CLI 入口。

## 启动

```bat
start.bat
```

或：

```bat
npm run tauri:dev
```

## 验证

```bat
npm run build
cargo check --manifest-path src-tauri\Cargo.toml
cd sidecar-adapter
python -m compileall -q kimi_desktop_sidecar
```

## 注意事项

- 不要把 `kimi web` 作为 Tauri 桌面的最终后端。
- 保留 Rust sidecar stdout NDJSON line buffering；Tauri shell stdout 是 byte chunks，不保证一条事件就是一行 JSON。
- Tauri externalBin 期望 Windows sidecar 文件：`src-tauri/sidecar/kimi-sidecar-x86_64-pc-windows-msvc.exe`。
- 后续打包时，确保该 sidecar 来自本项目 `sidecar-adapter`，而不是来自修改过的 `kimi-cli` hidden command。
