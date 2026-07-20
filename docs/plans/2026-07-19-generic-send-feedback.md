# Generic Send Feedback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every prompt show an immediate sending indicator, replace it on the first visible response, and surface every terminal failure without model- or provider-specific logic.

**Architecture:** Keep the UI contract intentionally small: awaiting the first visible response, visible response received, or a persistent error. The Rust ACP bridge must emit an `error` session status for every prompt failure path; the React stream hook must treat a successful terminal result with no visible response as an error instead of silently returning to ready.

**Tech Stack:** Rust/Tauri ACP bridge, React hooks, TypeScript, Vitest.

---

### Task 1: Lock the frontend lifecycle with regression tests

**Files:**
- Modify: `src/hooks/useSessionStream.test.tsx`
- Test: `src/hooks/useSessionStream.test.tsx`

**Step 1: Write the failing tests**

Add provider-agnostic cases proving that a prompt starts in the awaiting state, a terminal `finished` result without visible content becomes `模型未返回可显示内容`, a first visible content event suppresses that error, and a later `idle` snapshot does not erase a prompt error.

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/hooks/useSessionStream.test.tsx`

Expected: the new empty-response and persistent-error assertions fail against the current reducer.

### Task 2: Make ACP prompt failures terminal errors

**Files:**
- Modify: `src-tauri/src/acp.rs`

**Step 1: Replace silent idle fallbacks**

Convert upload expansion, unavailable RPC, and transport request failures into `session_status(state = "error")` with a safe reason and useful detail while clearing the prompt from the in-flight set.

**Step 2: Check the Rust implementation**

Run: `cargo test --manifest-path src-tauri/Cargo.toml acp --lib`

Expected: PASS.

### Task 3: Implement the model-independent frontend terminal rules

**Files:**
- Modify: `src/hooks/useSessionStream.ts`

**Step 1: Add one prompt-error helper**

Centralize error state, callback notification, awaiting-state cleanup, and stream completion so every failure path behaves consistently.

**Step 2: Detect empty terminal responses**

When the tracked prompt finishes while still awaiting its first visible response, report `模型未返回可显示内容` instead of silently clearing the indicator. Preserve an existing error when later idle/stopped snapshots arrive.

**Step 3: Run the focused tests**

Run: `npm test -- --run src/hooks/useSessionStream.test.tsx src/modules/conversation/message-list.test.tsx`

Expected: PASS.

### Task 4: Full verification

**Files:**
- Verify only; no external Kimi configuration files may be modified.

**Step 1: Run project checks**

Run: `npm test -- --run src/hooks/useSessionStream.test.tsx src/modules/conversation/message-list.test.tsx`

Run: `cargo test --manifest-path src-tauri/Cargo.toml acp --lib`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Run: `npm run build`

Expected: all commands pass.

**Step 2: Inspect the source-built UI**

Verify the sequence `消息发送中` -> first visible response, and verify a simulated terminal failure remains as `错误报告`.
