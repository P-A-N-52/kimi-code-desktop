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

    pub struct EnvVarGuard {
        _lock: MutexGuard<'static, ()>,
        name: String,
        previous: Option<OsString>,
    }

    pub fn set_env_var(name: &str, value: &str) -> EnvVarGuard {
        let lock = env_lock();
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        EnvVarGuard {
            _lock: lock,
            name: name.to_string(),
            previous,
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var(&self.name, value),
                None => std::env::remove_var(&self.name),
            }
        }
    }

    pub struct EnvVarsGuard {
        _lock: MutexGuard<'static, ()>,
        previous: Vec<(String, Option<OsString>)>,
    }

    pub fn set_env_vars(values: &[(&str, Option<&str>)]) -> EnvVarsGuard {
        let lock = env_lock();
        let mut previous = Vec::with_capacity(values.len());
        for (name, value) in values {
            previous.push(((*name).to_string(), std::env::var_os(name)));
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        EnvVarsGuard {
            _lock: lock,
            previous,
        }
    }

    impl Drop for EnvVarsGuard {
        fn drop(&mut self) {
            for (name, previous) in self.previous.drain(..) {
                match previous {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}
