# Desktop Single Instance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent repeated desktop-shortcut launches from creating multiple Kimi Code processes and focus the existing main window instead.

**Architecture:** Register Tauri's official single-instance plugin before every other plugin. When a second launch is intercepted, restore, show, and focus the existing `main` webview window.

**Tech Stack:** Rust, Tauri 2, `tauri-plugin-single-instance`

---

### Task 1: Enforce a single desktop instance

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Update: `src-tauri/Cargo.lock`

**Step 1: Add the desktop plugin dependency**

Add `tauri-plugin-single-instance = "2"` to the desktop target dependencies.

**Step 2: Register the plugin first**

Initialize the plugin before notification and other plugins. In its second-launch callback, look up the `main` window and call `unminimize`, `show`, and `set_focus`, ignoring individual window-operation errors so one failed operation does not prevent the remaining recovery steps.

**Step 3: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: the Rust application and the new plugin compile successfully.

**Step 4: Verify behavior manually**

Launch the packaged application twice from its desktop shortcut. Expected: only one application process remains, and the existing window is restored and focused on the second launch.
