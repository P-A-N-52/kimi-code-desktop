from __future__ import annotations

import asyncio
import os
import subprocess
from typing import Any

_INSTALLED = False
_ORIGINAL_POPEN = subprocess.Popen
_ORIGINAL_CREATE_SUBPROCESS_EXEC = asyncio.create_subprocess_exec
_ORIGINAL_CREATE_SUBPROCESS_SHELL = asyncio.create_subprocess_shell


def hidden_subprocess_kwargs() -> dict[str, int]:
    """Return Windows-only kwargs that prevent helper console windows."""
    if os.name != "nt":
        return {}
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if not creationflags:
        return {}
    return {"creationflags": creationflags}


def _with_hidden_console(kwargs: dict[str, Any]) -> dict[str, Any]:
    hidden_kwargs = hidden_subprocess_kwargs()
    if not hidden_kwargs:
        return kwargs

    updated = dict(kwargs)
    updated["creationflags"] = int(updated.get("creationflags", 0)) | hidden_kwargs[
        "creationflags"
    ]
    return updated


def install_windows_subprocess_silencer() -> None:
    """Make subprocess launches inside the GUI sidecar windowless on Windows."""
    global _INSTALLED
    if _INSTALLED or os.name != "nt":
        return

    _INSTALLED = True

    class HiddenPopen(_ORIGINAL_POPEN):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **_with_hidden_console(kwargs))

    async def create_subprocess_exec(*args: Any, **kwargs: Any):
        return await _ORIGINAL_CREATE_SUBPROCESS_EXEC(
            *args,
            **_with_hidden_console(kwargs),
        )

    async def create_subprocess_shell(cmd: str | bytes, *args: Any, **kwargs: Any):
        return await _ORIGINAL_CREATE_SUBPROCESS_SHELL(
            cmd,
            *args,
            **_with_hidden_console(kwargs),
        )

    subprocess.Popen = HiddenPopen
    asyncio.create_subprocess_exec = create_subprocess_exec
    asyncio.create_subprocess_shell = create_subprocess_shell
