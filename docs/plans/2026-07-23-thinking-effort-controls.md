# Thinking Effort Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make forced Thinking controls visibly disabled and expose only the thinking-effort levels supported by the selected model.

**Architecture:** Extend the existing global-config bridge to carry each model's `support_efforts` and `default_effort`, plus the active `[thinking].effort`. Validate writes in Rust against the selected model, then render the same state in the composer model picker and Settings.

**Tech Stack:** Rust/Tauri, TOML, React, TypeScript, Radix UI, Vitest.

---

### Task 1: Extend and validate the config contract

**Files:**
- Modify: `src-tauri/src/global_config.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/tauri-api.ts`
- Modify: `src/lib/api/models/ConfigModel.ts`
- Modify: `src/lib/api/models/GlobalConfig.ts`
- Modify: `src/lib/api/models/UpdateGlobalConfigRequest.ts`
- Modify: `src/hooks/useGlobalConfig.ts`

1. Add failing Rust assertions for model effort metadata, active effort, valid updates, rejected unsupported values, and model-switch fallback.
2. Run the focused Rust test and confirm failure.
3. Parse `support_efforts`, `default_effort`, and `[thinking].effort`; add a validated `thinking_effort` update argument.
4. Thread the fields through the Tauri and TypeScript normalization layers.
5. Run focused Rust and TypeScript tests.

### Task 2: Add effort selection and a clear locked state

**Files:**
- Modify: `src/ui/switch.tsx`
- Modify: `src/lib/model-capabilities.ts`
- Modify: `src/lib/model-capabilities.test.ts`
- Modify: `src/modules/composer/model-picker.tsx`
- Modify: `src/modules/composer/composer.tsx`
- Modify: `src/modules/composer/composer.test.tsx`
- Modify: `src/modules/conversation/conversation-view.tsx`
- Modify: `src/modules/settings/settings-dialog.tsx`

1. Add failing tests for disabled gray styling and model-specific effort options.
2. Run the focused Vitest tests and confirm failure.
3. Add explicit disabled colors to the shared Switch.
4. Show an effort selector only when the selected model advertises supported efforts; pass updates through the existing config mutation path.
5. Mirror the selector in Settings so both configuration surfaces stay consistent.
6. Run focused tests.

### Task 3: Verify the integrated behavior

1. Run `npm test -- --run`.
2. Run `npm run build`.
3. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
4. Run `cargo fmt --all -- --check` and `git diff --check`.
5. Inspect the final diff and confirm `src-tauri/src/git_diff.rs` remains untouched.
