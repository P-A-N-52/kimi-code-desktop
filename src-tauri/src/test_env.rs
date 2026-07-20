//! Shared test helpers for serializing environment variable mutations across crates.

#[cfg(test)]
pub mod lock {
    use std::ffi::OsString;
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub fn env_lock() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub struct KimiCodeHomeGuard {
        _lock: MutexGuard<'static, ()>,
        previous: Option<OsString>,
    }

    pub fn set_kimi_code_home(path: &Path) -> KimiCodeHomeGuard {
        let lock = env_lock();
        let previous = std::env::var_os("KIMI_CODE_HOME");
        std::env::set_var("KIMI_CODE_HOME", path);
        KimiCodeHomeGuard {
            _lock: lock,
            previous,
        }
    }

    impl Drop for KimiCodeHomeGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("KIMI_CODE_HOME", value),
                None => std::env::remove_var("KIMI_CODE_HOME"),
            }
        }
    }
}
