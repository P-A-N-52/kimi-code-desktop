// Facade module: each Tauri command family lives in its own file under
// `commands/`, and this module re-exports the full surface (command functions
// plus the `__cmd__*` / `__tauri_command_name_*` macros each `#[tauri::command]`
// generates) so lib.rs's `commands::<name>` generate_handler! paths keep
// resolving unchanged.
pub mod auth;
pub mod config;
pub mod sessions;
pub mod system;
pub mod wire;
pub mod workspace;

pub use auth::*;
pub use config::*;
pub use sessions::*;
pub use system::*;
pub use wire::*;
pub use workspace::*;
