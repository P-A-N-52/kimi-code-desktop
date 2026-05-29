import importlib
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


def install_stub_modules() -> None:
    """Install the import surface needed to import worker.py."""
    kosong = types.ModuleType("kosong")
    message = types.ModuleType("kosong.message")

    class TextPart:
        def __init__(self, text=""):
            self.text = text

        def model_dump(self, mode="json"):
            return {"type": "text", "text": self.text}

    class ImageURLPart:
        class ImageURL:
            def __init__(self, url):
                self.url = url

        def __init__(self, image_url):
            self.image_url = image_url

        def model_dump(self, mode="json"):
            return {"type": "image_url", "image_url": {"url": self.image_url.url}}

    message.ContentPart = object
    message.ImageURLPart = ImageURLPart
    message.TextPart = TextPart
    kosong.message = message
    sys.modules["kosong"] = kosong
    sys.modules["kosong.message"] = message

    pil = types.ModuleType("PIL")
    pil_image = types.ModuleType("PIL.Image")

    class PILImage:
        pass

    pil_image.Image = PILImage
    pil_image.open = lambda *_args, **_kwargs: None
    pil.Image = pil_image
    sys.modules["PIL"] = pil
    sys.modules["PIL.Image"] = pil_image

    kimi_cli = sys.modules.get("kimi_cli", types.ModuleType("kimi_cli"))

    class Logger:
        def warning(self, *_args, **_kwargs):
            pass

        def exception(self, *_args, **_kwargs):
            pass

    kimi_cli.logger = Logger()
    sys.modules["kimi_cli"] = kimi_cli

    stubs = {
        "kimi_cli.config": {
            "load_config": lambda: types.SimpleNamespace(
                default_model=None,
                models={},
            ),
        },
        "kimi_cli.llm": {
            "ModelCapability": str,
        },
        "kimi_cli.web.store.sessions": {
            "load_session_by_id": lambda _session_id: None,
        },
    }

    for name, attrs in stubs.items():
        module = types.ModuleType(name)
        for attr, value in attrs.items():
            setattr(module, attr, value)
        sys.modules[name] = module

    for name in [
        "kimi_cli.web",
        "kimi_cli.web.store",
    ]:
        sys.modules.setdefault(name, types.ModuleType(name))


install_stub_modules()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
worker = importlib.import_module("kimi_desktop_sidecar.worker")


class WorkerStdinTests(unittest.TestCase):
    def test_upload_wrapper_replaces_stdin_instead_of_readonly_buffer(self):
        original_sys_stdin = sys.stdin
        original_encoder = worker._encode_upload_message
        fake_stdin = io.TextIOWrapper(
            io.BytesIO(
                b'{"jsonrpc":"2.0","method":"prompt","id":1,"params":{}}\n'
            ),
            encoding="utf-8",
        )

        with self.assertRaises(AttributeError):
            fake_stdin.buffer = io.BytesIO()

        def encode_upload_message(msg, _session_dir, _sent_files):
            updated = dict(msg)
            updated["params"] = {
                "user_input": [{"type": "text", "text": "wrapped"}],
            }
            return updated

        worker._encode_upload_message = encode_upload_message
        sys.stdin = fake_stdin
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                original_stdin = worker._install_upload_stdin_wrapper(
                    Path(temp_dir),
                    set(),
                )

                self.assertIs(original_stdin, fake_stdin)
                self.assertIsNot(sys.stdin, fake_stdin)

                line = sys.stdin.buffer.readline()
                decoded = json.loads(line.decode("utf-8"))
                self.assertEqual(
                    decoded["params"]["user_input"],
                    [{"type": "text", "text": "wrapped"}],
                )
        finally:
            sys.stdin = original_sys_stdin
            worker._encode_upload_message = original_encoder


if __name__ == "__main__":
    unittest.main()
