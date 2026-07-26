# Optional Authentication Readiness Implementation Plan

**Goal:** Make Kimi account login optional while preserving provider/API-key use, the settings login controls, and the ACP protocol handshake.

**Architecture:** Runtime readiness checks only whether the installed Kimi CLI, ACP entry point, and configuration are usable. OAuth login remains an optional account-management action in Settings and is never rendered as a startup requirement. `kimi acp` still receives the protocol-required `authenticate` request because it succeeds for any credential source accepted by the CLI, including configured providers.

**Tech Stack:** React, TypeScript, Tauri, Rust, Vitest, Cargo

---

### Task 1: Remove login from startup readiness

**Files:**
- Modify: `src-tauri/src/runtime_check.rs`
- Modify: `src/modules/readiness/readiness-overlay.tsx`

**Steps:**
1. Remove the credential-file readiness check and warning.
2. Remove login-panel detection and rendering from the readiness overlay.
3. Verify the focused readiness tests.

### Task 2: Preserve optional account login

**Files:**
- Modify: `src/modules/settings/settings-dialog.tsx`
- Verify: `src/modules/settings/kimi-login-panel.tsx`
- Verify: `src/modules/settings/kimi-login-panel.test.tsx`
- Verify: `src-tauri/src/oauth_login.rs`

**Steps:**
1. Keep the device-code login, logout, and terminal fallback controls in Settings.
2. Label the Settings section as optional.
3. Keep login IPC and credential helpers isolated from runtime readiness.
4. Verify both login-panel behavior and the absence of login UI in the readiness overlay.

### Task 3: Preserve provider-compatible ACP behavior

**Files:**
- Modify: `src-tauri/src/acp.rs`
- Modify: `src/lib/slash-command-catalog.ts`
- Modify: `README.md`

**Steps:**
1. Keep the ACP `authenticate` method call.
2. Change errors and command guidance to accept any CLI-configured credential source.
3. Document provider/API-key configuration rather than mandatory `kimi login`.

### Task 4: Verify

**Steps:**
1. Run focused frontend tests.
2. Run the complete frontend suite and build.
3. Run Rust tests and `cargo check`.
4. Run `git diff --check` and audit remaining login references.
