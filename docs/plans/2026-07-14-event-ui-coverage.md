# Event And Tool UI Coverage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make persisted steering, tool semantics, todo/file side effects, and media content visible in the desktop UI without creating bespoke UI for every tool.

**Architecture:** Keep the existing ACP wire contract and generic tool card as the fallback. Add the missing replay translation for `turn.steer`, normalize current and legacy tool names through one frontend registry, feed semantic tool results into the existing Zustand stores, and represent media content with the existing message attachment model. Reuse the existing Agent monitor and Plan status surfaces instead of introducing parallel state.

**Tech Stack:** Rust/Tauri, React 19, TypeScript, Zustand, Tailwind CSS, Vitest.

---

### Task 1: Steering Event Replay And UI

**Files:**
- Modify: `src-tauri/src/session_store.rs`
- Modify: `src/hooks/useSessionStream.ts`
- Modify: `src/features/chat/types.ts`
- Modify: `src/features/chat/virtualized-message-list.tsx`
- Test: colocated Rust tests and `src/hooks/useSessionStream.test.tsx`

**Steps:**
1. Translate persisted `turn.steer` records into `SteerInput` wire events.
2. Reconcile live optimistic input and replayed input without creating duplicate turns.
3. Render steering as a labeled user instruction distinct from a new turn.
4. Cover replay and live event handling with focused tests.

### Task 2: Tool Name Registry And Semantic Side Effects

**Files:**
- Create: `src/features/tool/tool-registry.ts`
- Modify: `src/components/ai-elements/tool.tsx`
- Modify: `src/features/tool/store.ts`
- Test: colocated Vitest files under `src/features/tool/`

**Steps:**
1. Normalize current ACP names such as `Read`, `Write`, `Edit`, `Bash`, `WebSearch`, and `TodoList` to the existing visual vocabulary.
2. Add semantic labels/icons for Agent, task, goal, plan-mode, and skill tools while keeping the generic card fallback.
3. Track successful `Write` calls as file creation.
4. Parse `TodoList.todos` into the existing todo store during both live processing and replay.

### Task 3: Media Content Parts

**Files:**
- Modify: `src/hooks/useSessionStream.ts`
- Test: `src/hooks/useSessionStream.test.tsx`

**Steps:**
1. Convert image, video, and audio URL content parts into message attachments.
2. Preserve normal text/thinking aggregation and ordering.
3. Add focused state-level tests for each supported media type.

### Task 4: Integration Verification

**Steps:**
1. Run focused frontend and Rust tests while iterating.
2. Run `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.
3. Run `cargo check --manifest-path src-tauri/Cargo.toml` and `npm run build`.
4. Review the final diff to confirm existing Agent/Swarm and ACP migration work remains intact.
