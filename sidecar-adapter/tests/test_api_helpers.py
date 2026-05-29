import importlib
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path


def install_stub_modules() -> None:
    """Install the kimi-cli import surface needed to import api.py."""
    kaos = types.ModuleType("kaos")
    kaos_path = types.ModuleType("kaos.path")

    class KaosPath:
        @staticmethod
        def unsafe_from_local_path(path):
            return path

    kaos_path.KaosPath = KaosPath
    kaos.path = kaos_path
    sys.modules["kaos"] = kaos
    sys.modules["kaos.path"] = kaos_path

    kimi_cli = types.ModuleType("kimi_cli")

    class Logger:
        def warning(self, *_args, **_kwargs):
            pass

        def exception(self, *_args, **_kwargs):
            pass

    kimi_cli.logger = Logger()
    sys.modules["kimi_cli"] = kimi_cli

    stubs = {
        "kimi_cli.config": {
            "get_config_file": lambda: None,
            "load_config": lambda: None,
            "save_config": lambda _config: None,
        },
        "kimi_cli.metadata": {
            "load_metadata": lambda: None,
            "save_metadata": lambda _metadata: None,
        },
        "kimi_cli.session": {
            "Session": object,
        },
        "kimi_cli.session_state": {
            "load_session_state": lambda _session_dir: None,
            "save_session_state": lambda _state, _session_dir: None,
        },
        "kimi_cli.web.api.config": {
            "_build_global_config": lambda: None,
        },
        "kimi_cli.web.store.sessions": {
            "load_session_by_id": lambda _session_id: None,
            "load_sessions_page": lambda **_kwargs: [],
            "invalidate_sessions_cache": lambda: None,
        },
    }

    for name, attrs in stubs.items():
        module = types.ModuleType(name)
        for attr, value in attrs.items():
            setattr(module, attr, value)
        sys.modules[name] = module

    # Parent namespace packages for dotted imports.
    for name in [
        "kimi_cli.web",
        "kimi_cli.web.api",
        "kimi_cli.web.store",
    ]:
        sys.modules.setdefault(name, types.ModuleType(name))


install_stub_modules()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
api = importlib.import_module("kimi_desktop_sidecar.api")


class ApiHelperTests(unittest.TestCase):
    def test_bytes_from_json_array_accepts_byte_values(self):
        self.assertEqual(api._bytes_from_json_array([0, 127, 255]), b"\x00\x7f\xff")

    def test_bytes_from_json_array_rejects_non_list(self):
        with self.assertRaisesRegex(ValueError, "JSON byte array"):
            api._bytes_from_json_array("abc")

    def test_bytes_from_json_array_rejects_out_of_range_values(self):
        with self.assertRaisesRegex(ValueError, "between 0 and 255"):
            api._bytes_from_json_array([256])

    def test_bytes_from_json_array_enforces_size_limit(self):
        original_limit = api.MAX_DESKTOP_API_FILE_BYTES
        api.MAX_DESKTOP_API_FILE_BYTES = 2
        try:
            with self.assertRaisesRegex(ValueError, "too large"):
                api._bytes_from_json_array([1, 2, 3])
        finally:
            api.MAX_DESKTOP_API_FILE_BYTES = original_limit

    def test_sanitize_filename_removes_edge_dots_and_spaces(self):
        self.assertEqual(api._sanitize_filename(" ..my report.pdf "), "my_report.pdf")

    def test_sanitize_filename_falls_back_when_empty(self):
        self.assertEqual(api._sanitize_filename("...   "), "unnamed")

    def test_resolve_path_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ValueError, "path traversal"):
                api._resolve_path(temp_dir, "../outside.txt")

    def test_resolve_path_rejects_non_string_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ValueError, "path must be a string"):
                api._resolve_path(temp_dir, 123)

    def test_ensure_file_within_api_limit_enforces_size_limit(self):
        original_limit = api.MAX_DESKTOP_API_FILE_BYTES
        api.MAX_DESKTOP_API_FILE_BYTES = 2
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                file_path = Path(temp_dir) / "large.txt"
                file_path.write_bytes(b"abc")
                with self.assertRaisesRegex(ValueError, "too large"):
                    api._ensure_file_within_api_limit(file_path)
        finally:
            api.MAX_DESKTOP_API_FILE_BYTES = original_limit

    def test_hidden_subprocess_kwargs_hides_windows_console(self):
        kwargs = api._hidden_subprocess_kwargs()
        if os.name == "nt":
            self.assertEqual(kwargs, {"creationflags": subprocess.CREATE_NO_WINDOW})
        else:
            self.assertEqual(kwargs, {})


if __name__ == "__main__":
    unittest.main()
