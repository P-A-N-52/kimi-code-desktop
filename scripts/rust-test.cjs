/**
 * Run `cargo test` for the desktop shell.
 *
 * On Windows, test binaries have no application manifest, so the loader
 * binds the classic System32 comctl32.dll (v5.82) whose export table lacks
 * TaskDialogIndirect. tauri-runtime-wry links that import through its
 * dialog::error path (common-controls-v6 feature) once any AppHandle code
 * is pulled in, crashing the test exe at startup with 0xc0000139. Embed a
 * common-controls v6 manifest via --config rustflags so the loader binds the
 * WinSxS comctl32 v6. Release builds are unaffected (tauri embeds its own
 * manifest). Spawning cargo directly from Node avoids shell quoting
 * differences between cmd.exe and POSIX shells.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const manifestPath = path.resolve(__dirname, "test-windows-manifest.xml");

const manifestInput = `/MANIFESTINPUT:"${manifestPath}"`;
const rustflags = ["-C", "link-arg=/MANIFEST:EMBED", "-C", `link-arg=${manifestInput}`];

const args = [
  "test",
  "--manifest-path",
  path.join(projectRoot, "src-tauri", "Cargo.toml"),
  "--config",
  `target."cfg(windows)".rustflags=${JSON.stringify(rustflags)}`,
];

const result = spawnSync("cargo", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
