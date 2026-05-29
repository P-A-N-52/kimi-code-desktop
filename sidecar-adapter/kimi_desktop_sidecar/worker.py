"""Desktop worker: runs a session worker with upload encoding on stdin.

The Rust sidecar spawns ``kimi-sidecar __desktop-worker <session_id>`` and
communicates via stdio JSON-RPC (Wire protocol).  This module wraps the
standard wire worker with an upload-encoding layer that pre-processes any
incoming ``prompt`` message to include uploaded-file ContentParts, matching
the behaviour that ``SessionProcess._handle_in_message`` provides in the
web HTTP+WebSocket runner.

Because ``acp.stdio_streams()`` on Windows spawns a background thread that
calls ``sys.stdin.buffer.readline()``, we monkey-patch ``sys.stdin.buffer``
with a wrapper that intercepts each line, encodes uploads when the line is a
``prompt`` message, and returns the (possibly modified) line.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import mimetypes
import sys
from collections.abc import AsyncGenerator
from pathlib import Path
from uuid import UUID

from kosong.message import ContentPart, ImageURLPart, TextPart
from PIL import Image
from PIL.Image import Image as PILImage

from kimi_cli import logger
from kimi_cli.config import load_config
from kimi_cli.llm import ModelCapability
from kimi_cli.web.store.sessions import load_session_by_id


async def _encode_uploaded_files(
    session_dir: Path,
    sent_files: set[str],
) -> AsyncGenerator[ContentPart, None]:
    """Encode uploaded files as ContentParts for a prompt message.

    Adapted from ``SessionProcess._encode_uploaded_files()``.
    """
    uploads_dir = session_dir / "uploads"
    if not uploads_dir.exists():
        return

    # Load .sent marker left by fork to avoid re-sending inherited files
    sent_marker = uploads_dir / ".sent"
    if sent_marker.exists():
        try:
            already_sent = json.loads(sent_marker.read_text(encoding="utf-8"))
            sent_files.update(already_sent)
        except Exception:
            pass

    all_files = sorted(
        (f for f in uploads_dir.iterdir() if f.name != ".sent"),
        key=lambda x: x.name,
    )
    files = [f for f in all_files if f.name not in sent_files]

    if not files:
        return

    # Build file list with paths and mime types
    file_infos: list[tuple[Path, str]] = []
    for file in files:
        mime_type, _ = mimetypes.guess_type(file.name)
        file_infos.append((file, mime_type or "application/octet-stream"))

    # Output file list summary
    file_list_lines = ["<uploaded_files>"]
    for idx, (file, _) in enumerate(file_infos, start=1):
        file_list_lines.append(f"{idx}. {file}")
    file_list_lines.append("</uploaded_files>")
    yield TextPart(text="\n".join(file_list_lines) + "\n\n")

    # Text file extensions
    text_extensions = {
        ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".html",
        ".css", ".js", ".ts", ".py", ".sh", ".csv", ".log", ".rst",
        ".toml", ".ini",
    }

    # Check model capabilities
    config = load_config()
    capabilities: set[ModelCapability] = set()
    if config.default_model:
        capabilities = config.models[config.default_model].capabilities or set()
    is_vision = "image_in" in capabilities
    is_video_in = "video_in" in capabilities

    # Process each file
    for file, mime_type in file_infos:
        file_path = str(file)
        ext = file.suffix.lower()

        if is_vision and mime_type.startswith("image/"):
            try:
                content = file.read_bytes()
                with Image.open(io.BytesIO(content)) as img:
                    pil_img: PILImage = img
                    width, height = pil_img.size
                    max_side = max(width, height)
                    if max_side > 4096:
                        scale = 4096 / max_side
                        new_size = (int(width * scale), int(height * scale))
                        pil_img = pil_img.resize(new_size)
                    buffer = io.BytesIO()
                    pil_img.save(buffer, format="PNG")
                    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
                    tag = f'<image path="{file_path}" content_type="{mime_type}">'
                    yield TextPart(text=tag)
                    yield ImageURLPart(
                        image_url=ImageURLPart.ImageURL(
                            url=f"data:image/png;base64,{encoded}"
                        )
                    )
                    yield TextPart(text="</image>\n\n")
            except Exception:
                pass
        elif is_video_in and mime_type.startswith("video/"):
            yield TextPart(
                text=f'<video path="{file_path}" content_type="{mime_type}">'
            )
            yield TextPart(text="</video>\n\n")
        elif ext in text_extensions or mime_type.startswith("text/"):
            try:
                content = file.read_bytes()
                text_content = content.decode("utf-8", errors="replace")
                yield TextPart(
                    text=f'<document path="{file_path}" content_type="{mime_type}">'
                )
                yield TextPart(text=text_content)
                yield TextPart(text="</document>\n\n")
            except Exception:
                pass

    # Mark files as sent
    for file in files:
        sent_files.add(file.name)


def _encode_upload_message(
    msg_json: dict,
    session_dir: Path,
    sent_files: set[str],
) -> dict:
    """Modify a prompt JSON-RPC message dict to include uploaded files.

    Returns the (modified) message dict.
    """
    from kimi_cli.wire.jsonrpc import JSONRPCInMessageAdapter

    in_msg = JSONRPCInMessageAdapter.validate_python(msg_json)
    from kimi_cli.wire.jsonrpc import JSONRPCPromptMessage

    if not isinstance(in_msg, JSONRPCPromptMessage):
        return msg_json  # not a prompt, pass through unchanged

    # Collect upload content parts synchronously
    user_input: list[ContentPart] = []

    async def _collect_parts():
        async for part in _encode_uploaded_files(session_dir, sent_files):
            user_input.append(part)

    try:
        asyncio.get_running_loop()
        # Already in an async context – should not happen from feeder thread
        # but handle gracefully
        import asyncio as _asyncio_mod
        try:
            _asyncio_mod.run(_collect_parts())
        except RuntimeError:
            # Not in an event loop, run synchronously with a new loop
            loop = _asyncio_mod.new_event_loop()
            try:
                loop.run_until_complete(_collect_parts())
            finally:
                loop.close()
    except RuntimeError:
        # No running loop – we're in the feeder thread
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_collect_parts())
        finally:
            loop.close()

    # Build modified params
    if isinstance(in_msg.params.user_input, str):
        if in_msg.params.user_input != "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE":
            user_input.append(TextPart(text=in_msg.params.user_input))
    else:
        user_input += in_msg.params.user_input

    # Serialize the modified message
    modified = {
        "jsonrpc": "2.0",
        "method": "prompt",
        "id": in_msg.id,
        "params": {
            "user_input": [
                part.model_dump(mode="json") for part in user_input
            ]
        },
    }
    return modified


class _UploadEncodingStdin:
    """Proxy ``sys.stdin`` while replacing its read-only ``buffer`` attribute."""

    def __init__(self, stdin, buffer):
        self._stdin = stdin
        self.buffer = buffer

    def __getattr__(self, name: str):
        return getattr(self._stdin, name)

    def __iter__(self):
        return iter(self._stdin)


def _make_stdin_wrapper(
    session_dir: Path,
    sent_files: set[str],
    real_buffer=None,
):
    """Create a wrapper for a stdin buffer that encodes uploads.

    On Windows, ``acp._windows_stdio_streams`` spawns a feeder thread that
    calls ``sys.stdin.buffer.readline()`` in a blocking loop.  By wrapping
    the buffer exposed by ``sys.stdin`` we intercept each line and encode
    uploads when the line is a ``prompt`` message.
    """
    if real_buffer is None:
        real_buffer = sys.__stdin__.buffer  # the true OS-level stdin buffer

    class _UploadEncodingStdinBuffer:
        """Wraps the real stdin buffer to encode uploads on prompt messages."""

        def readline(self) -> bytes:
            data = real_buffer.readline()
            if not data:
                return data
            try:
                msg = json.loads(data.decode("utf-8", errors="replace"))
                if isinstance(msg, dict) and msg.get("method") == "prompt":
                    modified = _encode_upload_message(msg, session_dir, sent_files)
                    return (
                        json.dumps(modified, ensure_ascii=False) + "\n"
                    ).encode("utf-8")
            except Exception:
                pass
            return data

        def __getattr__(self, name: str):
            return getattr(real_buffer, name)

    return _UploadEncodingStdinBuffer()


def _install_upload_stdin_wrapper(session_dir: Path, sent_files: set[str]):
    """Install upload-aware stdin and return the original stdin object."""
    original_stdin = sys.stdin
    sys.stdin = _UploadEncodingStdin(
        original_stdin,
        _make_stdin_wrapper(session_dir, sent_files, original_stdin.buffer),
    )
    return original_stdin


async def run_desktop_worker(session_id: UUID) -> None:
    """Run the KimiCLI worker for a session (desktop variant).

    Compared to ``run_worker`` (the ``__web-worker`` entry point), this
    variant intercepts stdin to encode uploaded files into prompt messages,
    so that the desktop frontend (which sends plain-text prompts) gets the
    same upload behaviour as the web frontend.
    """
    from kimi_cli.app import KimiCLI
    from kimi_cli.cli.mcp import get_global_mcp_config_file

    # Find session by ID using the web store
    joint_session = load_session_by_id(session_id)
    if joint_session is None:
        raise ValueError(f"Session not found: {session_id}")

    session = joint_session.kimi_cli_session
    session_dir = session.dir

    # Load default MCP config file if it exists
    default_mcp_file = get_global_mcp_config_file()
    mcp_configs: list[dict] = []
    if default_mcp_file.exists():
        raw = default_mcp_file.read_text(encoding="utf-8")
        try:
            mcp_configs = [json.loads(raw)]
        except json.JSONDecodeError:
            logger.warning(
                "Invalid JSON in MCP config file: {path}",
                path=default_mcp_file,
            )

    # Detect whether this is a resumed session
    resumed = (session.dir / "state.json").exists()

    # Create KimiCLI instance with MCP configuration
    from kimi_cli.exception import MCPConfigError

    try:
        kimi_cli = await KimiCLI.create(
            session, mcp_configs=mcp_configs or None, resumed=resumed, ui_mode="wire"
        )
    except MCPConfigError as exc:
        logger.warning(
            "Invalid MCP config in {path}: {error}. Starting without MCP.",
            path=default_mcp_file,
            error=exc,
        )
        kimi_cli = await KimiCLI.create(
            session, mcp_configs=None, resumed=resumed, ui_mode="wire"
        )

    # Install stdin wrapper for upload encoding BEFORE WireServer.serve()
    # reads from stdin (via acp.stdio_streams -> _windows_stdio_streams ->
    # _start_stdin_feeder thread).
    sent_files: set[str] = set()
    original_stdin = _install_upload_stdin_wrapper(session_dir, sent_files)

    try:
        # Run in wire stdio mode (will use our wrapped stdin)
        await kimi_cli.run_wire_stdio()
    finally:
        sys.stdin = original_stdin


def main() -> None:
    """Entry point for the desktop worker subprocess."""
    from kimi_cli.utils.proctitle import set_process_title
    from kimi_cli.utils.proxy import normalize_proxy_env

    normalize_proxy_env()
    set_process_title("kimi-code-desktop-worker")

    if len(sys.argv) < 2:
        print(
            "Usage: python -m kimi_desktop_sidecar __desktop-worker <session_id>",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        session_id = UUID(sys.argv[1])
    except ValueError:
        print(f"Invalid session ID: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    from kimi_cli.app import enable_logging

    enable_logging(debug=False)
    asyncio.run(run_desktop_worker(session_id))


if __name__ == "__main__":
    main()
