"""Desktop API helper: one-shot JSON-in/JSON-out command handler.

Invoked as ``kimi-sidecar __desktop-api`` by the Rust sidecar.  Reads a
single JSON envelope from stdin, dispatches to the matching action handler,
and writes a single JSON envelope to stdout.  Actions correspond to those
listed in the Rust ``commands.rs`` module.

Protocol (one line per invocation):
  stdin:  {"action": "<action>", "params": {<params>}}
  stdout: {"ok": true, "result": <result>}   OR
          {"ok": false, "error": "<message>"}
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from kimi_desktop_sidecar.windows_subprocess import hidden_subprocess_kwargs

MAX_DESKTOP_API_FILE_BYTES = 25 * 1024 * 1024
MAX_SAFE_FILENAME_LENGTH = 255

# ── helpers ──────────────────────────────────────────────────────────────


def _ok(result: Any = None) -> dict:
    return {"ok": True, "result": result}


def _err(message: str) -> dict:
    return {"ok": False, "error": message}


def _hidden_subprocess_kwargs() -> dict[str, int]:
    """Hide helper child process console windows when the sidecar runs as a GUI app."""
    return hidden_subprocess_kwargs()


def _get_logger():
    from kimi_cli import logger

    return logger


def _kimi_root() -> Path:
    return Path.home() / ".kimi"


def _find_session_dir_by_id(session_id: UUID) -> Path | None:
    sessions_root = _kimi_root() / "sessions"
    if not sessions_root.is_dir():
        return None

    session_name = str(session_id)
    try:
        for work_dir in sessions_root.iterdir():
            if not work_dir.is_dir():
                continue
            candidate = work_dir / session_name
            if candidate.is_dir():
                return candidate
    except OSError:
        return None
    return None


def _work_dir_by_hash() -> dict[str, str]:
    metadata_path = _kimi_root() / "kimi.json"
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    result: dict[str, str] = {}
    for entry in data.get("work_dirs", []):
        if not isinstance(entry, dict):
            continue
        work_dir = entry.get("path")
        if not isinstance(work_dir, str):
            continue
        result[hashlib.md5(work_dir.encode("utf-8")).hexdigest()] = work_dir
    return result


def _resolve_work_dir_from_session_dir(session_dir: Path) -> Path | None:
    work_dir = _work_dir_by_hash().get(session_dir.parent.name)
    if not work_dir:
        return None
    return Path(work_dir).resolve()


def _read_request_line() -> str:
    """Read one UTF-8 protocol line from stdin."""
    stdin_buffer = getattr(sys.stdin, "buffer", None)
    if stdin_buffer is None:
        return sys.stdin.readline()

    raw_line = stdin_buffer.readline()
    if not raw_line:
        return ""
    return raw_line.decode("utf-8")


def _write_json_envelope(envelope: dict) -> None:
    """Write one UTF-8 JSON protocol line to stdout."""
    line = json.dumps(envelope, ensure_ascii=False) + "\n"
    stdout_buffer = getattr(sys.stdout, "buffer", None)
    if stdout_buffer is not None:
        stdout_buffer.write(line.encode("utf-8"))
        stdout_buffer.flush()
        return

    try:
        sys.stdout.write(line)
    except UnicodeEncodeError:
        sys.stdout.write(json.dumps(envelope) + "\n")
    sys.stdout.flush()


def _resolve_path(work_dir: str, rel_path: str) -> Path:
    """Resolve a relative path within work_dir, disallowing traversal."""
    if not isinstance(rel_path, str):
        raise ValueError("path must be a string")
    base = Path(work_dir).resolve()
    target = (base / rel_path).resolve()
    if not target.is_relative_to(base):
        raise ValueError("path traversal not allowed")
    return target


def _format_size(size: int) -> str:
    return f"{size / (1024 * 1024):.1f} MiB"


def _ensure_file_within_api_limit(file_path: Path) -> int:
    try:
        size = file_path.stat().st_size
    except OSError as e:
        raise ValueError(f"Unable to read file metadata: {e}") from e
    if size > MAX_DESKTOP_API_FILE_BYTES:
        raise ValueError(
            "File is too large for desktop API transfer "
            f"({_format_size(size)} > {_format_size(MAX_DESKTOP_API_FILE_BYTES)})"
        )
    return size


def _bytes_from_json_array(value: Any) -> bytes:
    if not isinstance(value, list):
        raise ValueError("file data must be a JSON byte array")
    if len(value) > MAX_DESKTOP_API_FILE_BYTES:
        raise ValueError(
            "File is too large for desktop API transfer "
            f"({_format_size(len(value))} > {_format_size(MAX_DESKTOP_API_FILE_BYTES)})"
        )
    try:
        return bytes(value)
    except (TypeError, ValueError) as e:
        raise ValueError("file data must contain integers between 0 and 255") from e


def _sanitize_filename(filename: Any) -> str:
    if not isinstance(filename, str):
        filename = "unnamed"
    safe_name = "".join(
        c for c in filename if c.isalnum() or c in "._- "
    ).strip(" .")
    if not safe_name:
        safe_name = "unnamed"
    safe_name = safe_name.replace(" ", "_")
    return safe_name[:MAX_SAFE_FILENAME_LENGTH]


def _list_directory_entries(dir_path: Path) -> list[dict]:
    entries: list[dict] = []
    with os.scandir(dir_path) as iterator:
        for entry in iterator:
            if entry.is_dir():
                entries.append({"name": entry.name, "type": "directory"})
                continue

            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            entries.append({"name": entry.name, "type": "file", "size": size})

    entries.sort(key=lambda item: (item["type"] == "file", item["name"]))
    return entries


# ── action handlers ──────────────────────────────────────────────────────


def handle_list_sessions(params: dict) -> dict:
    """List all sessions across all known work directories."""
    from kimi_cli.web.store.sessions import load_sessions_page

    limit = params.get("limit", 100)
    offset = params.get("offset", 0)
    query = params.get("q")
    archived = params.get("archived")

    if limit <= 0:
        limit = 100
    if limit > 500:
        limit = 500
    if offset < 0:
        offset = 0

    sessions = load_sessions_page(
        limit=limit, offset=offset, query=query, archived=archived
    )
    result = [s.model_dump(mode="json") for s in sessions]
    return _ok(result)


def handle_get_session(params: dict) -> dict:
    """Get a single session by ID."""
    from kimi_cli.web.store.sessions import load_session_by_id

    session_id = UUID(params["session_id"])
    session = load_session_by_id(session_id)
    if session is None:
        return _err("Session not found")
    return _ok(session.model_dump(mode="json"))


def handle_replay_session_history(params: dict) -> dict:
    """Return persisted wire history as JSON-RPC messages without starting a worker."""
    request_types = {"ApprovalRequest", "ToolCallRequest", "QuestionRequest", "HookRequest"}
    session_id = UUID(params["session_id"])
    session_dir = _find_session_dir_by_id(session_id)
    if session_dir is None:
        from kimi_cli.web.store.sessions import load_session_by_id

        session = load_session_by_id(session_id)
        if session is None:
            return _err("Session not found")
        session_dir = session.kimi_cli_session.dir

    wire_file = session_dir / "wire.jsonl"
    if not wire_file.exists():
        return _ok([])

    messages: list[str] = []
    with wire_file.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") == "metadata":
                continue
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            message_type = message.get("type")
            if not isinstance(message_type, str):
                continue
            if message_type in request_types:
                payload = message.get("payload")
                request_id = None
                if isinstance(payload, dict):
                    request_id = payload.get("id")
                envelope = {
                    "jsonrpc": "2.0",
                    "method": "request",
                    "id": str(request_id or f"history-{len(messages) + 1}"),
                    "params": message,
                }
            else:
                envelope = {
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": message,
                }
            messages.append(json.dumps(envelope, ensure_ascii=False))

    return _ok(messages)


def handle_create_session(params: dict) -> dict:
    """Create a new session, optionally with a work_dir."""
    from kaos.path import KaosPath
    from kimi_cli.session import Session as KimiCLISession
    from kimi_cli.web.store.sessions import invalidate_sessions_cache

    work_dir_str = params.get("work_dir")
    create_dir = params.get("create_dir", False)

    if work_dir_str:
        work_dir_path = Path(work_dir_str).expanduser().resolve()
        if not work_dir_path.exists():
            if create_dir:
                work_dir_path.mkdir(parents=True, exist_ok=True)
            else:
                return _err(f"Directory does not exist: {work_dir_str}")
        if not work_dir_path.is_dir():
            return _err(f"Path is not a directory: {work_dir_str}")
        work_dir = KaosPath.unsafe_from_local_path(work_dir_path)
    else:
        work_dir = KaosPath.unsafe_from_local_path(Path.home())

    async def _create():
        kimi_session = await KimiCLISession.create(work_dir=work_dir)
        context_file = kimi_session.dir / "context.jsonl"
        invalidate_sessions_cache()
        return {
            "session_id": kimi_session.id,
            "title": kimi_session.title,
            "last_updated": datetime.fromtimestamp(
                context_file.stat().st_mtime, tz=UTC
            ).isoformat(),
            "is_running": False,
            "status": None,
            "work_dir": str(work_dir),
            "session_dir": str(kimi_session.dir),
        }

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()

    if loop.is_running():
        # We're in an event loop already; this shouldn't normally happen
        # for __desktop-api but handle gracefully
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            fut = pool.submit(asyncio.run, _create())
            result = fut.result()
        return _ok(result)
    else:
        result = loop.run_until_complete(_create())
        loop.close()
        return _ok(result)


def handle_delete_session(params: dict) -> dict:
    """Delete a session by ID."""
    from kimi_cli.metadata import load_metadata, save_metadata
    from kimi_cli.web.store.sessions import load_session_by_id, invalidate_sessions_cache

    session_id = UUID(params["session_id"])
    session = load_session_by_id(session_id)
    if session is None:
        return _err("Session not found")

    kimi_session = session.kimi_cli_session
    wd_meta = kimi_session.work_dir_meta
    if wd_meta.last_session_id == str(session_id):
        metadata = load_metadata()
        for wd in metadata.work_dirs:
            if wd.path == wd_meta.path:
                wd.last_session_id = None
                break
        save_metadata(metadata)

    session_dir = kimi_session.dir
    if session_dir.exists():
        shutil.rmtree(session_dir)
    invalidate_sessions_cache()

    return _ok(None)


def handle_update_session(params: dict) -> dict:
    """Update session title or archived status."""
    from kimi_cli.session_state import load_session_state, save_session_state
    from kimi_cli.web.store.sessions import load_session_by_id, invalidate_sessions_cache

    session_id = UUID(params["session_id"])
    session = load_session_by_id(session_id)
    if session is None:
        return _err("Session not found")

    session_dir = session.kimi_cli_session.dir
    state = load_session_state(session_dir)

    title = params.get("title")
    archived = params.get("archived")

    if title is not None:
        state.custom_title = title
        state.title_generated = True

    if archived is not None:
        state.archived = archived
        if archived:
            state.archived_at = time.time()
            state.auto_archive_exempt = False
        else:
            state.archived_at = None
            state.auto_archive_exempt = True

    save_session_state(state, session_dir)
    invalidate_sessions_cache()

    updated = load_session_by_id(session_id)
    if updated is None:
        return _err("Failed to reload session after update")
    return _ok(updated.model_dump(mode="json"))


def handle_fork_session(params: dict) -> dict:
    """Fork a session at a specific turn index."""
    from kimi_cli.metadata import load_metadata
    from kimi_cli.session_state import load_session_state
    from kimi_cli.session_fork import fork_session as do_fork
    from kimi_cli.web.api.sessions import invalidate_work_dirs_cache
    from kimi_cli.web.store.sessions import load_session_by_id, invalidate_sessions_cache

    session_id = UUID(params["session_id"])
    turn_index = params.get("turn_index", 0)

    source_session = load_session_by_id(session_id)
    if source_session is None:
        return _err("Session not found")

    source_dir = source_session.kimi_cli_session.dir
    work_dir = source_session.kimi_cli_session.work_dir
    source_title = source_session.title

    async def _fork():
        return await do_fork(
            source_session_dir=source_dir,
            work_dir=work_dir,
            turn_index=turn_index,
            title_prefix="Fork",
            source_title=source_title,
        )

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()

    if loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            fut = pool.submit(asyncio.run, _fork())
            new_session_id = fut.result()
    else:
        new_session_id = loop.run_until_complete(_fork())
        loop.close()

    invalidate_sessions_cache()
    invalidate_work_dirs_cache()

    metadata = load_metadata()
    wd_meta = metadata.get_work_dir_meta(work_dir)
    assert wd_meta is not None
    new_session_dir = wd_meta.sessions_dir / new_session_id
    new_state = load_session_state(new_session_dir)
    fork_title = new_state.custom_title or f"Fork: {source_title}"
    context_file = new_session_dir / "context.jsonl"

    return _ok({
        "session_id": new_session_id,
        "title": fork_title,
        "last_updated": datetime.fromtimestamp(
            context_file.stat().st_mtime, tz=UTC
        ).isoformat(),
        "is_running": False,
        "status": None,
        "work_dir": str(work_dir),
        "session_dir": str(new_session_dir),
    })


def handle_generate_title(params: dict) -> dict:
    """Generate a session title using AI (fallback to text extraction)."""
    from kimi_cli.session_state import load_session_state, save_session_state
    from kimi_cli.web.api.sessions import extract_first_turn_from_wire
    from kimi_cli.web.store.sessions import load_session_by_id, invalidate_sessions_cache
    from kimi_cli.utils.string import shorten

    session_id = UUID(params["session_id"])
    session = load_session_by_id(session_id)
    if session is None:
        return _err("Session not found")

    session_dir = session.kimi_cli_session.dir
    state = load_session_state(session_dir)

    if state.title_generated:
        return _ok({"title": state.custom_title or "Untitled"})

    user_message = params.get("user_message")
    assistant_response = params.get("assistant_response")

    if not user_message or not assistant_response:
        first_turn = extract_first_turn_from_wire(session_dir)
        if first_turn:
            user_message, assistant_response = first_turn

    if not user_message:
        return _ok({"title": "Untitled"})

    user_text = " ".join(user_message.strip().split())
    fallback_title = shorten(user_text, width=50) or "Untitled"

    if state.title_generate_attempts >= 3:
        fresh = load_session_state(session_dir)
        if fresh.title_generated:
            invalidate_sessions_cache()
            return _ok({"title": fresh.custom_title or "Untitled"})
        fresh.custom_title = fallback_title
        fresh.title_generated = True
        save_session_state(fresh, session_dir)
        invalidate_sessions_cache()
        return _ok({"title": fallback_title})

    title = fallback_title
    ai_generated = False
    try:
        from kosong import generate
        from kosong.message import Message

        from kimi_cli.auth.oauth import OAuthManager
        from kimi_cli.config import load_config
        from kimi_cli.llm import create_llm

        config = load_config()
        model_name = config.default_model

        if model_name and model_name in config.models:
            model_config = config.models[model_name]
            provider_config = config.providers.get(model_config.provider)

            if provider_config:
                async def _gen():
                    oauth = OAuthManager(config)
                    await oauth.ensure_fresh()
                    llm = create_llm(provider_config, model_config, oauth=oauth)
                    if llm:
                        system_prompt = (
                            "Generate a concise session title (max 50 characters) "
                            "based on the conversation. "
                            "Only respond with the title text, nothing else. "
                            "No quotes, no explanation."
                        )
                        prompt = f"User: {user_message[:300]}\n"
                        prompt += f"Assistant: {(assistant_response or '')[:300]}\n\n"
                        prompt += "Title:"
                        result = await generate(
                            chat_provider=llm.chat_provider,
                            system_prompt=system_prompt,
                            tools=[],
                            history=[Message(role="user", content=prompt)],
                        )
                        return result.message.extract_text().strip().strip("\"'")
                    return None

                try:
                    loop = asyncio.get_running_loop()
                except RuntimeError:
                    loop = asyncio.new_event_loop()
                generated = loop.run_until_complete(_gen())
                if not loop.is_running():
                    loop.close()

                if generated and len(generated) <= 50:
                    title = generated
                    ai_generated = True
                elif generated:
                    title = shorten(generated, width=50)
                    ai_generated = True
    except Exception as e:
        _get_logger().warning(f"Failed to generate title using AI: {e}")

    fresh = load_session_state(session_dir)
    if fresh.title_generated:
        invalidate_sessions_cache()
        return _ok({"title": fresh.custom_title or "Untitled"})
    fresh.custom_title = title
    if ai_generated:
        fresh.title_generated = True
    else:
        fresh.title_generate_attempts = fresh.title_generate_attempts + 1
    save_session_state(fresh, session_dir)
    invalidate_sessions_cache()

    return _ok({"title": title})


def handle_upload_session_file(params: dict) -> dict:
    """Save a file to session uploads directory.

    params: {session_id, filename, data}  where data is a list[int] (byte array).
    Returns: {path, filename, size}
    """
    import mimetypes
    import os as _os

    session_id = UUID(params["session_id"])
    filename = _sanitize_filename(params.get("filename", "unnamed"))
    data_bytes = _bytes_from_json_array(params.get("data"))

    session_dir = _find_session_dir_by_id(session_id)
    if session_dir is None:
        from kimi_cli.web.store.sessions import load_session_by_id

        session = load_session_by_id(session_id)
        if session is None:
            return _err("Session not found")
        session_dir = session.kimi_cli_session.dir

    upload_dir = session_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Generate unique filename
    uid = str(uuid4())
    name, ext = _os.path.splitext(filename)
    name = name.strip(" .") or "unnamed"
    unique_name = f"{name}_{uid[:6]}{ext}"

    upload_path = upload_dir / unique_name
    upload_path.write_bytes(data_bytes)

    return _ok({
        "path": str(upload_path),
        "filename": unique_name,
        "size": len(data_bytes),
    })


def handle_list_session_directory(params: dict) -> dict:
    """List directory contents within a session's work_dir."""
    session_id = UUID(params["session_id"])
    rel_path = params.get("path", "")

    session_dir = _find_session_dir_by_id(session_id)
    work_dir = _resolve_work_dir_from_session_dir(session_dir) if session_dir else None
    if work_dir is None:
        from kimi_cli.web.store.sessions import load_session_by_id

        session = load_session_by_id(session_id)
        if session is None:
            return _err("Session not found")
        work_dir = Path(str(session.kimi_cli_session.work_dir)).resolve()

    try:
        dir_path = _resolve_path(str(work_dir), rel_path)
    except ValueError as e:
        return _err(str(e))

    if not dir_path.exists():
        return _err("Path not found")
    if not dir_path.is_dir():
        return _err("Path is not a directory")

    return _ok(_list_directory_entries(dir_path))


def handle_get_session_file(params: dict) -> dict:
    """Get a file from a session's work_dir.

    Returns: {data: [u8...], content_type: "...", filename?: "..."}
    """
    import mimetypes

    session_id = UUID(params["session_id"])
    rel_path = params.get("path", "")

    session_dir = _find_session_dir_by_id(session_id)
    work_dir = _resolve_work_dir_from_session_dir(session_dir) if session_dir else None
    if work_dir is None:
        from kimi_cli.web.store.sessions import load_session_by_id

        session = load_session_by_id(session_id)
        if session is None:
            return _err("Session not found")
        work_dir = Path(str(session.kimi_cli_session.work_dir)).resolve()

    try:
        file_path = _resolve_path(str(work_dir), rel_path)
    except ValueError as e:
        return _err(str(e))

    if not file_path.exists():
        return _err("File not found")
    if file_path.is_dir():
        return _err("Path is a directory, use list_session_directory")

    _ensure_file_within_api_limit(file_path)
    content = file_path.read_bytes()
    media_type, _ = mimetypes.guess_type(file_path.name)

    return _ok({
        "data": list(content),
        "content_type": media_type or "application/octet-stream",
        "filename": file_path.name,
    })


def handle_get_session_upload_file(params: dict) -> dict:
    """Get a file from a session's uploads directory.

    Returns: {data: [u8...], content_type: "...", filename?: "..."}
    """
    import mimetypes

    session_id = UUID(params["session_id"])
    rel_path = params.get("path") or params.get("filename") or ""

    session_dir = _find_session_dir_by_id(session_id)
    if session_dir is None:
        from kimi_cli.web.store.sessions import load_session_by_id

        session = load_session_by_id(session_id)
        if session is None:
            return _err("Session not found")
        session_dir = session.kimi_cli_session.dir

    uploads_dir = (session_dir / "uploads").resolve()
    if not uploads_dir.exists():
        return _err("Uploads directory not found")

    try:
        file_path = _resolve_path(str(uploads_dir), rel_path)
    except ValueError as e:
        return _err(str(e))

    if not file_path.exists() or not file_path.is_file():
        return _err("File not found")

    _ensure_file_within_api_limit(file_path)
    content = file_path.read_bytes()
    media_type, _ = mimetypes.guess_type(file_path.name)

    return _ok({
        "data": list(content),
        "content_type": media_type or "application/octet-stream",
        "filename": file_path.name,
    })


def handle_list_work_dirs(params: dict) -> dict:
    """List all known work directories from metadata.

    params is ignored (unused).
    """
    from kimi_cli.metadata import load_metadata

    metadata = load_metadata()
    work_dirs: list[str] = []
    for wd in metadata.work_dirs:
        # Filter out temporary directories
        if "/tmp" in wd.path or "/var/folders" in wd.path or "/.cache/" in wd.path:
            continue
        if Path(wd.path).exists():
            work_dirs.append(wd.path)
    return _ok(work_dirs[:20])


def handle_get_startup_dir(params: dict) -> dict:
    """Get the startup directory (the current working directory).

    params is ignored (unused).
    """
    return _ok(str(Path.cwd()))


def handle_get_global_config(params: dict) -> dict:
    """Get the global config snapshot."""
    from kimi_cli.web.api.config import _build_global_config

    config = _build_global_config()
    return _ok(config.model_dump(mode="json"))


def handle_update_global_config(params: dict) -> dict:
    """Update the global config (default_model, default_thinking).

    Does NOT restart workers – the Rust side manages worker lifecycle.
    """
    from kimi_cli.config import load_config, save_config
    from kimi_cli.web.api.config import _build_global_config

    config = load_config()

    default_model = params.get("default_model")
    default_thinking = params.get("default_thinking")

    if default_model is not None:
        if default_model not in config.models:
            return _err(f"Model '{default_model}' not found in config")
        config.default_model = default_model

    if default_thinking is not None:
        config.default_thinking = default_thinking

    save_config(config)

    updated = _build_global_config()
    return _ok(updated.model_dump(mode="json"))


def handle_get_git_diff_stats(params: dict) -> dict:
    """Get git diff stats for a session's work directory."""
    import asyncio as _asyncio
    from kimi_cli.web.models import GitDiffStats
    from kimi_cli.utils.subprocess_env import get_clean_env
    from kimi_cli.web.store.sessions import load_session_by_id

    session_id = UUID(params["session_id"])
    session = load_session_by_id(session_id)
    if session is None:
        return _err("Session not found")

    work_dir = Path(str(session.kimi_cli_session.work_dir))

    if not (work_dir / ".git").exists():
        return _ok(GitDiffStats(is_git_repo=False).model_dump(mode="json"))

    async def _get_diff():
        try:
            files: list[dict] = []
            total_add, total_del = 0, 0

            # Check if HEAD exists
            check_proc = await _asyncio.create_subprocess_exec(
                "git", "rev-parse", "--verify", "HEAD",
                cwd=str(work_dir),
                stdout=_asyncio.subprocess.DEVNULL,
                stderr=_asyncio.subprocess.DEVNULL,
                env=get_clean_env(),
                **_hidden_subprocess_kwargs(),
            )
            await check_proc.wait()
            has_head = check_proc.returncode == 0

            if has_head:
                proc = await _asyncio.create_subprocess_exec(
                    "git", "diff", "--numstat", "HEAD",
                    cwd=str(work_dir),
                    stdout=_asyncio.subprocess.PIPE,
                    stderr=_asyncio.subprocess.PIPE,
                    env=get_clean_env(),
                    **_hidden_subprocess_kwargs(),
                )
                stdout, _ = await _asyncio.wait_for(
                    proc.communicate(), timeout=5.0
                )

                for line in stdout.decode().strip().split("\n"):
                    if not line:
                        continue
                    parts = line.split("\t")
                    if len(parts) >= 3:
                        add = int(parts[0]) if parts[0] != "-" else 0
                        dele = int(parts[1]) if parts[1] != "-" else 0
                        total_add += add
                        total_del += dele
                        status = "modified"
                        if dele == 0 and add > 0:
                            status = "added"
                        elif add == 0 and dele > 0:
                            status = "deleted"
                        files.append({
                            "path": parts[2],
                            "additions": add,
                            "deletions": dele,
                            "status": status,
                        })

            # Untracked files
            untracked_proc = await _asyncio.create_subprocess_exec(
                "git", "ls-files", "--others", "--exclude-standard",
                cwd=str(work_dir),
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.DEVNULL,
                env=get_clean_env(),
                **_hidden_subprocess_kwargs(),
            )
            untracked_stdout, _ = await _asyncio.wait_for(
                untracked_proc.communicate(), timeout=5.0
            )

            for line in untracked_stdout.decode().strip().split("\n"):
                if line:
                    files.append({
                        "path": line,
                        "additions": 0,
                        "deletions": 0,
                        "status": "added",
                    })

            return {
                "is_git_repo": True,
                "has_changes": len(files) > 0,
                "total_additions": total_add,
                "total_deletions": total_del,
                "files": files,
                "error": None,
            }
        except TimeoutError:
            return {
                "is_git_repo": True,
                "has_changes": False,
                "error": "Git command timed out",
            }
        except Exception as e:
            return {
                "is_git_repo": True,
                "has_changes": False,
                "error": str(e),
            }

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()

    if loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            fut = pool.submit(asyncio.run, _get_diff())
            result = fut.result()
        return _ok(result)
    else:
        result = loop.run_until_complete(_get_diff())
        loop.close()
        return _ok(result)


# ── action dispatch table ─────────────────────────────────────────────────

ACTION_HANDLERS: dict[str, callable] = {
    "list_sessions": handle_list_sessions,
    "get_session": handle_get_session,
    "replay_session_history": handle_replay_session_history,
    "create_session": handle_create_session,
    "delete_session": handle_delete_session,
    "update_session": handle_update_session,
    "fork_session": handle_fork_session,
    "generate_title": handle_generate_title,
    "upload_session_file": handle_upload_session_file,
    "list_session_directory": handle_list_session_directory,
    "get_session_file": handle_get_session_file,
    "get_session_upload_file": handle_get_session_upload_file,
    "list_work_dirs": handle_list_work_dirs,
    "get_startup_dir": handle_get_startup_dir,
    "get_global_config": handle_get_global_config,
    "update_global_config": handle_update_global_config,
    "get_git_diff_stats": handle_get_git_diff_stats,
}


def _dispatch_desktop_api_request(request: Any) -> dict:
    request_id = None
    if not isinstance(request, dict):
        return _err("Request must be a JSON object")

    raw_request_id = request.get("request_id")
    if isinstance(raw_request_id, str):
        request_id = raw_request_id

    action = request.get("action")
    params = request.get("params", {})

    if not action or not isinstance(action, str):
        result = _err("Missing or invalid 'action' field")
        if request_id:
            result["request_id"] = request_id
        return result

    if not isinstance(params, dict):
        result = _err("Missing or invalid 'params' field")
        if request_id:
            result["request_id"] = request_id
        return result

    if action not in ACTION_HANDLERS:
        result = _err(f"Unknown action: {action}")
        if request_id:
            result["request_id"] = request_id
        return result

    handler = ACTION_HANDLERS[action]
    try:
        result = handler(params)
    except ValueError as e:
        result = _err(str(e))
    except KeyError as e:
        missing = e.args[0] if e.args else "unknown"
        _get_logger().exception(f"Desktop API action '{action}' is missing a parameter")
        result = _err(f"Missing parameter '{missing}' for action '{action}'")
    except TypeError:
        _get_logger().exception(f"Desktop API action '{action}' received invalid parameters")
        result = _err(f"Invalid parameters for action '{action}'")
    except Exception:
        _get_logger().exception(f"Desktop API action '{action}' failed")
        result = _err(f"Desktop API action '{action}' failed")

    if request_id:
        result["request_id"] = request_id
    return result


def handle_desktop_api() -> None:
    """Main entry point for ``__desktop-api``.

    Reads one JSON envelope line from stdin, dispatches to the handler,
    writes one JSON envelope line to stdout, and exits.
    """
    try:
        line = _read_request_line()
    except UnicodeDecodeError as e:
        _write_json_envelope(_err(f"Invalid UTF-8 request: {e}"))
        sys.exit(1)
    except (EOFError, KeyboardInterrupt):
        sys.exit(0)

    if not line:
        sys.exit(0)

    try:
        request = json.loads(line.strip())
    except json.JSONDecodeError as e:
        _write_json_envelope(_err(f"Invalid JSON: {e}"))
        sys.exit(1)

    result = _dispatch_desktop_api_request(request)
    _write_json_envelope(result)


def handle_desktop_api_server() -> None:
    """Run a long-lived desktop API helper.

    Each stdin line is a request envelope.  Each stdout line is a response
    envelope carrying the same optional ``request_id``.
    """
    while True:
        try:
            line = _read_request_line()
        except UnicodeDecodeError as e:
            _write_json_envelope(_err(f"Invalid UTF-8 request: {e}"))
            continue
        except (EOFError, KeyboardInterrupt):
            return

        if not line:
            return

        try:
            request = json.loads(line.strip())
        except json.JSONDecodeError as e:
            _write_json_envelope(_err(f"Invalid JSON: {e}"))
            continue

        result = _dispatch_desktop_api_request(request)
        _write_json_envelope(result)


def main() -> None:
    """Entry point for the desktop API subprocess."""
    from kimi_cli.utils.proctitle import set_process_title
    from kimi_cli.utils.proxy import normalize_proxy_env

    normalize_proxy_env()
    set_process_title("kimi-code-desktop-api")
    handle_desktop_api()


if __name__ == "__main__":
    main()
