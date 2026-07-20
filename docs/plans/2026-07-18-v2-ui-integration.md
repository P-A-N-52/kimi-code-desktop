# V2 UI Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the event, tool, workspace, composer, session, settings, and native UI capabilities that were intentionally deferred by the Monochrome V2 rewrite while preserving the new visual system and the ACP-only runtime.

**Architecture:** Keep `useSessionStream`, `useSessions`, the tool-event store, and the agent-monitor store as canonical data sources. Hoist the single active session stream to the app shell, then add small V2 renderers and workspace/composer adapters instead of restoring the deleted legacy component tree. Use the legacy source snapshot only as a behavioral reference and retain generic fallbacks for unknown event and tool payloads.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind CSS 4, Radix UI, Tauri 2, Vitest, Testing Library.

**Worktree note:** Execute in the current checkout because it contains the V2 commits and staged ACP-only backend migration that must be tested together. Do not commit or alter unrelated staged files.

---

### Task 1: Hoist the active session stream

**Files:**
- Modify: `src/app/app.tsx`
- Modify: `src/modules/conversation/conversation-view.tsx`
- Modify: `src/hooks/useSessionStream.ts`
- Test: `src/hooks/useSessionStream.test.tsx`

**Steps:**
1. Export the stream return type.
2. Create exactly one `useSessionStream` instance in `App` for the selected session.
3. Pass the stream into `ConversationView` and remove the message/API callback bridge.
4. Keep session-switch teardown, history replay, readiness gating, and status callbacks unchanged.
5. Run `npx vitest run src/hooks/useSessionStream.test.tsx` and `npm run build`.

### Task 2: Restore complete message rendering

**Files:**
- Create: `src/modules/conversation/attachments.tsx`
- Create: `src/modules/conversation/status-message.tsx`
- Modify: `src/modules/conversation/message-list.tsx`
- Modify: `src/modules/conversation/user-message.tsx`
- Modify: `src/modules/conversation/ai-message.tsx`
- Test: `src/modules/conversation/message-list.test.tsx`

**Steps:**
1. Write failing tests for user/assistant image, audio, video, and no-preview attachments.
2. Write failing tests showing `steer` as a labeled in-turn instruction and `message-id` as non-rendering metadata.
3. Implement accessible media links/previews with a safe fallback.
4. Render status messages as compact status rows instead of assistant messages.
5. Run the focused tests and `npm run build`.

### Task 3: Restore semantic tool and subagent rendering

**Files:**
- Create: `src/modules/conversation/tool-display-content.tsx`
- Create: `src/modules/conversation/subagent-steps.tsx`
- Modify: `src/modules/conversation/tool-card.tsx`
- Modify: `src/lib/tool-events/tool-registry.ts`
- Test: `src/modules/conversation/tool-card.test.tsx`

**Steps:**
1. Add failing tests for normalized tool labels/icons, display blocks, media results, and subagent steps.
2. Support `mcp_content`, `image`, `search_response`, `diff`, `shell`, `todo`, and `brief` display blocks.
3. Keep a JSON renderer for unknown display types.
4. Render subagent state and accumulated steps inside Agent tool cards.
5. Run focused tests, then `npm test` and `npm run build`.

### Task 4: Connect the workspace tabs

**Files:**
- Create: `src/modules/workspace/files-tab.tsx`
- Create: `src/modules/workspace/agents-tab.tsx`
- Create: `src/modules/workspace/tasks-summary.tsx`
- Modify: `src/modules/workspace/changes-panel.tsx`
- Modify: `src/app/app.tsx`
- Test: `src/modules/workspace/changes-panel.test.tsx`

**Steps:**
1. Make Changes, Files, and Agent real selectable tabs.
2. Use `useGitDiffStats` as the authoritative changed-file list and merge message-derived diff previews by path.
3. Use `listSessionDirectory` and `getSessionFile` for the file browser.
4. Filter `useAgentMonitorStore` by active session and show grouped task state.
5. Show goal/todo/new-file state from `useToolEventsStore`.
6. Rename batch approval actions so they do not imply Git accept/revert.
7. Add focused tests and run `npm run build`.

### Task 5: Connect composer controls safely

**Files:**
- Create: `src/modules/composer/slash-command-menu.tsx`
- Create: `src/modules/composer/context-menu.tsx`
- Create: `src/modules/composer/use-prompt-queue.ts`
- Modify: `src/modules/composer/composer.tsx`
- Modify: `src/modules/conversation/conversation-view.tsx`
- Modify: `src/app/app.tsx`
- Test: `src/modules/composer/composer.test.tsx`

**Steps:**
1. Feed `stream.slashCommands` into a keyboard-accessible slash menu.
2. Connect attachment upload through the active session's `uploadSessionFile`, then insert the returned workspace path into the prompt.
3. Connect Context to the current file/task context surfaces.
4. Display the actual global model and route model changes through the existing global-config update path; do not pretend the backend supports per-session model switching.
5. Queue prompts while ACP is busy and send the next item only after the session returns to ready; do not label this as live steering.
6. Add tests for menu selection, upload, model display, queueing, send, and cancel.

### Task 6: Restore session management surfaces

**Files:**
- Modify: `src/modules/sessions/sessions-sidebar.tsx`
- Modify: `src/app/app.tsx`
- Test: `src/modules/sessions/sessions-sidebar.test.tsx`

**Steps:**
1. Add pagination/load-more and archived-session views.
2. Add archive/unarchive, AI title generation, fork-at-turn, and explicit delete confirmation.
3. Add selection plus bulk archive/unarchive/delete without changing current session IDs.
4. Run focused tests and `npm run build`.

### Task 7: Restore settings and native entry points

**Files:**
- Modify: `src/modules/settings/settings-dialog.tsx`
- Modify: `src/modules/topbar/topbar.tsx`
- Modify: `src/app/app.tsx`
- Reuse: `src/lib/settings-api.ts`
- Reuse: `src/lib/tauri-api.ts`
- Test: `src/modules/settings/settings-dialog.test.tsx`

**Steps:**
1. Add system theme, raw `config.toml`, and MCP configuration tabs with explicit save/error states.
2. Connect the title menu to session details and Explorer/editor actions.
3. Remove or disable Share until a real share contract exists.
4. Restore desktop notifications only for completed background sessions and keep web mode inert.
5. Run focused tests and `npm run build`.

### Task 8: End-to-end verification

**Files:**
- Modify only files required by verification failures.

**Steps:**
1. Run `npm test`.
2. Run `npm run build`.
3. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
4. Run `cargo check --manifest-path src-tauri/Cargo.toml`.
5. Start the current V2 app and visually verify live and replayed text, media, tools, approvals, questions, tasks, workspace tabs, composer menus, sessions, and settings.
6. Review `git diff --check` and confirm unrelated staged ACP/release changes were preserved.
