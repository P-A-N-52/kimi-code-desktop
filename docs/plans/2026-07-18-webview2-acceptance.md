# WebView2 ACP UI Acceptance Plan

> **For Claude:** REQUIRED SUB-SKILL: Use the Code workflow to execute and verify each checkpoint.

**Goal:** Validate the newly connected frontend UI against the real Tauri IPC and authenticated `kimi acp` runtime while retaining browser-grade DOM and console inspection.

**Architecture:** Launch the real Tauri development app with a localhost-only WebView2 remote-debugging port. Attach through the Chrome DevTools Protocol to inspect and operate the actual WebView DOM; do not use the obsolete port 5494 HTTP API and do not add a production bridge.

**Tech Stack:** React, Tauri 2, Edge WebView2, CDP, Kimi ACP.

---

### Task 1: Runtime preflight

- Run `npm.cmd run smoke:acp`.
- Require `ok: true` and `authenticated: true`.
- Record the installed `kimi --version`.

### Task 2: Start the real desktop development runtime

- Set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` for the launched process only.
- Run `npm.cmd run desktop:dev`.
- Require a WebView target at `http://127.0.0.1:9222/json/list`.

### Task 3: Session and prompt acceptance

- Create a session using the repository working directory.
- Send a read-only prompt that requires reading `package.json` without modifying files.
- Require a visible user turn, at least one tool surface, and a final assistant answer containing the expected package name.
- Capture console errors and the visible DOM state.

### Task 4: Workspace and settings acceptance

- Open Changes, Files, Agents, and Tasks tabs.
- Open Settings, Config, MCP, and About.
- Require each surface to render without a React exception and require the real config path/content to load through Tauri IPC.

### Task 5: Regression gate and cleanup

- Close the test application and remote-debugging session.
- Run `npm.cmd test`, `npm.cmd run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo check --manifest-path src-tauri/Cargo.toml`.
- Report real-path successes separately from unexercised or blocked surfaces.
