from __future__ import annotations

import asyncio
import sys
from uuid import UUID

from kimi_desktop_sidecar.windows_subprocess import install_windows_subprocess_silencer

install_windows_subprocess_silencer()


def desktop_worker(session_id: str) -> None:
    """Run one desktop Wire worker session."""
    from kimi_cli.app import enable_logging
    from kimi_cli.utils.proctitle import set_process_title
    from kimi_cli.utils.proxy import normalize_proxy_env

    from kimi_desktop_sidecar.worker import run_desktop_worker

    normalize_proxy_env()
    set_process_title("kimi-code-desktop-worker")

    try:
        parsed_session_id = UUID(session_id)
    except ValueError as exc:
        raise SystemExit(f"Invalid session ID: {session_id}") from exc

    enable_logging(debug=False)
    asyncio.run(run_desktop_worker(parsed_session_id))


def desktop_api() -> None:
    """Run one-shot desktop API helper."""
    from kimi_cli.utils.proctitle import set_process_title
    from kimi_cli.utils.proxy import normalize_proxy_env

    from kimi_desktop_sidecar.api import handle_desktop_api

    normalize_proxy_env()
    set_process_title("kimi-code-desktop-api")
    handle_desktop_api()


def desktop_api_server() -> None:
    """Run a long-lived desktop API helper."""
    from kimi_cli.utils.proctitle import set_process_title
    from kimi_cli.utils.proxy import normalize_proxy_env

    from kimi_desktop_sidecar.api import handle_desktop_api_server

    normalize_proxy_env()
    set_process_title("kimi-code-desktop-api")
    handle_desktop_api_server()


def run_typer_cli(args: list[str]) -> int | None:
    import typer

    cli = typer.Typer(add_completion=False, context_settings={"help_option_names": ["-h", "--help"]})
    cli.command(name="__desktop-worker", hidden=True)(desktop_worker)
    cli.command(name="__desktop-api", hidden=True)(desktop_api)
    cli.command(name="__desktop-api-server", hidden=True)(desktop_api_server)
    try:
        return cli(args=args, prog_name="kimi-sidecar")
    except SystemExit as exc:
        return exc.code


def main() -> int | None:
    args = sys.argv[1:]
    if args[:1] == ["__desktop-api-server"]:
        desktop_api_server()
        return 0
    if args[:1] == ["__desktop-api"]:
        desktop_api()
        return 0
    if args[:1] == ["__desktop-worker"]:
        if len(args) < 2:
            raise SystemExit("Missing session ID")
        desktop_worker(args[1])
        return 0
    return run_typer_cli(args)


if __name__ == "__main__":
    raise SystemExit(main())
