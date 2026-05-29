"""Kimi desktop sidecar adapter package.

This package lives outside of ``kimi_cli`` and imports ``kimi_cli`` as a
runtime dependency.  It provides the desktop-only sidecar entry points used by
Tauri:

- ``__desktop-api``: one-shot JSON-in/JSON-out helper
- ``__desktop-worker <session_id>``: stdio Wire worker for one session
"""
