# Agent Swarm UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real per-session Swarm mode plus live multi-agent summaries in chat and detailed monitoring in the existing Workspace panel.

**Architecture:** Keep the desktop ACP-only runtime. Rust stores session mode state and translates ACP/tool updates into a stable desktop wire contract; React consumes that contract through one canonical Zustand task store shared by the chat Swarm card and Workspace Agents tab. The UI follows the existing quiet, work-focused visual language and never exposes a switch or cancel action without a working backend path.

**Tech Stack:** Rust/Tauri, ACP JSON-RPC, React 19, TypeScript, Zustand, Radix UI, Tailwind CSS, Vitest.

---

### Task 1: ACP Swarm State And Event Contract

**Files:**
- Modify: `src-tauri/src/acp.rs`
- Modify: `src-tauri/src/acp_translate.rs`
- Test: Rust unit tests colocated with those modules

**Steps:**
1. Add per-worker `plan_mode` and `swarm_mode` state and wire handlers for `set_plan_mode` and `set_swarm_mode`.
2. Apply modes to `session/prompt` using the Kimi ACP capability that is actually accepted; keep a compatibility fallback when the runtime lacks it.
3. Emit `StatusUpdate` mode acknowledgements so the UI reflects backend state rather than optimistic state alone.
4. Translate available ACP task/subagent updates into `TaskCreated`, `TaskProgress`, `TaskCompleted`, and lifecycle events without dropping generic tool updates.
5. Add focused Rust tests and run `cargo test --manifest-path src-tauri/Cargo.toml acp`.

### Task 2: Canonical Agent Task Store And Components

**Files:**
- Modify: `src/features/agent-monitor/agent-monitor-store.ts`
- Modify: `src/features/agent-monitor/agent-monitor-sync.ts`
- Modify: `src/features/agent-monitor/agent-monitor-panel.tsx`
- Modify: `src/features/agent-monitor/agent-monitor-item.tsx`
- Create: `src/features/agent-monitor/swarm-tool-card.tsx`
- Modify: `src/features/chat/components/assistant-message.tsx`
- Test: colocated Vitest files under `src/features/agent-monitor/`

**Steps:**
1. Replace simulated progress with event-derived task fields and lifecycle states.
2. Group swarm members by `parentToolCallId`, preserving standalone subagents.
3. Build the compact inline Swarm summary card with aggregate progress and member rows.
4. Upgrade the Agents panel with filters, grouped tasks, selected member details, empty/error states, and accessible controls.
5. Add parser/store/component tests and run the focused Vitest suite.

### Task 3: Session Stream And Mode Controls

**Files:**
- Modify: `src/hooks/wireTypes.ts`
- Modify: `src/hooks/useSessionStream.ts`
- Modify: `src/features/chat/global-config-controls.tsx`
- Modify: `src/features/chat/components/chat-prompt-composer.tsx`
- Modify: `src/features/chat/chat.tsx`
- Modify: `src/features/chat/chat-workspace-container.tsx`
- Modify: `src/features/workbench/workspace-panel.tsx`
- Test: `src/hooks/useSessionStream.test.tsx`

**Steps:**
1. Add typed task/lifecycle events and `swarm_mode` status updates.
2. Add `swarmMode` and `sendSetSwarmMode` to `useSessionStream`, reset it per session, and intercept `/swarm`, `/swarm on`, and `/swarm off` locally.
3. Feed task events into the canonical store and clear only the prior session's tasks during session switches.
4. Place the Swarm switch beside Plan on wide layouts and preserve wrapping on narrow layouts.
5. Surface active Swarm state and running counts in Workspace without changing the three-panel shell.
6. Add focused hook tests for mode acknowledgement, slash commands, and task events.

### Task 4: Integration And Verification

**Files:**
- Modify only files required by failures found during integration

**Steps:**
1. Run `npm test`.
2. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
3. Run `cargo check --manifest-path src-tauri/Cargo.toml`.
4. Run `npm run build`.
5. Start `npm run dev`, verify desktop and narrow layouts in the in-app browser, and inspect screenshots for overlap, wrapping, empty state, running state, and completed Swarm state.
6. Review the final diff to confirm unrelated dirty-worktree changes were preserved.
