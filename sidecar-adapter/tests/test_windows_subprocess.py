import asyncio
import importlib
import inspect
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
windows_subprocess = importlib.import_module(
    "kimi_desktop_sidecar.windows_subprocess"
)


class WindowsSubprocessTests(unittest.TestCase):
    def test_hidden_subprocess_kwargs_is_windows_only(self):
        with patch.object(windows_subprocess.os, "name", "posix"):
            self.assertEqual(windows_subprocess.hidden_subprocess_kwargs(), {})

    def test_hidden_subprocess_kwargs_uses_create_no_window(self):
        with (
            patch.object(windows_subprocess.os, "name", "nt"),
            patch.object(windows_subprocess.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        ):
            self.assertEqual(
                windows_subprocess.hidden_subprocess_kwargs(),
                {"creationflags": 0x08000000},
            )

    def test_with_hidden_console_preserves_existing_flags(self):
        with (
            patch.object(windows_subprocess.os, "name", "nt"),
            patch.object(windows_subprocess.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        ):
            self.assertEqual(
                windows_subprocess._with_hidden_console({"creationflags": 0x10}),
                {"creationflags": 0x08000010},
            )

    def test_install_is_noop_off_windows(self):
        original_popen = subprocess.Popen
        original_run = subprocess.run
        original_exec = asyncio.create_subprocess_exec
        original_shell = asyncio.create_subprocess_shell
        original_installed = windows_subprocess._INSTALLED

        try:
            windows_subprocess._INSTALLED = False
            with patch.object(windows_subprocess.os, "name", "posix"):
                windows_subprocess.install_windows_subprocess_silencer()

            self.assertIs(subprocess.Popen, original_popen)
            self.assertIs(subprocess.run, original_run)
            self.assertIs(asyncio.create_subprocess_exec, original_exec)
            self.assertIs(asyncio.create_subprocess_shell, original_shell)
        finally:
            windows_subprocess._INSTALLED = original_installed

    def test_install_keeps_popen_type_subscriptable(self):
        original_popen = subprocess.Popen
        original_run = subprocess.run
        original_exec = asyncio.create_subprocess_exec
        original_shell = asyncio.create_subprocess_shell
        original_installed = windows_subprocess._INSTALLED

        try:
            windows_subprocess._INSTALLED = False
            with (
                patch.object(windows_subprocess.os, "name", "nt"),
                patch.object(
                    windows_subprocess.subprocess,
                    "CREATE_NO_WINDOW",
                    0x08000000,
                    create=True,
                ),
            ):
                windows_subprocess.install_windows_subprocess_silencer()

            self.assertTrue(inspect.isclass(subprocess.Popen))
            self.assertTrue(issubclass(subprocess.Popen, original_popen))
            self.assertIs(subprocess.run, original_run)
            self.assertIsNotNone(subprocess.Popen[bytes])
        finally:
            subprocess.Popen = original_popen
            subprocess.run = original_run
            asyncio.create_subprocess_exec = original_exec
            asyncio.create_subprocess_shell = original_shell
            windows_subprocess._INSTALLED = original_installed


if __name__ == "__main__":
    unittest.main()
