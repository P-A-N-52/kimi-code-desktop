use crate::runtime_check;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static PROVIDER_ENDPOINT_REPAIR_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEndpointRepair {
    pub model_alias: String,
    pub provider: String,
    pub provider_type: String,
    pub previous_base_url: String,
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeModeDefaults {
    pub plan_mode: bool,
    pub permission_mode: String,
}

impl Default for RuntimeModeDefaults {
    fn default() -> Self {
        Self {
            plan_mode: false,
            permission_mode: "manual".to_string(),
        }
    }
}

pub fn get_global_config() -> Result<Value, String> {
    let parsed = load_config_toml()?;
    Ok(build_global_config_json(&parsed))
}

/// Look up `max_context_size` for a model alias (e.g. `kimi-code/kimi-for-coding`).
/// Falls back to `default_model` when `model_name` is empty or unknown.
pub fn max_context_size_for_model(model_name: &str) -> Option<u64> {
    let parsed = load_config_toml().ok()?;
    let models = parsed.get("models")?.as_table()?;

    let resolve = |name: &str| -> Option<u64> {
        models
            .get(name)?
            .get("max_context_size")?
            .as_integer()
            .map(|n| n.max(0) as u64)
            .filter(|n| *n > 0)
    };

    if !model_name.is_empty() {
        if let Some(size) = resolve(model_name) {
            return Some(size);
        }
    }

    let default_model = parsed.get("default_model").and_then(toml::Value::as_str)?;
    resolve(default_model)
}

pub(crate) fn runtime_mode_defaults() -> Result<RuntimeModeDefaults, String> {
    let parsed = load_config_toml()?;
    Ok(RuntimeModeDefaults {
        plan_mode: parsed
            .get("default_plan_mode")
            .and_then(toml::Value::as_bool)
            .unwrap_or(false),
        permission_mode: normalized_permission_mode(&parsed),
    })
}

fn normalized_permission_mode(parsed: &toml::Value) -> String {
    match parsed
        .get("default_permission_mode")
        .and_then(toml::Value::as_str)
    {
        Some("auto") => "auto".to_string(),
        Some("yolo") => "yolo".to_string(),
        _ => "manual".to_string(),
    }
}

pub fn update_global_config_fields(
    default_model: Option<&str>,
    default_thinking: Option<bool>,
    default_plan_mode: Option<bool>,
) -> Result<Value, String> {
    let path = config_path()?;
    let mut parsed = load_config_toml()?;

    if let Some(model) = default_model {
        if !model_exists(&parsed, model) {
            return Err(format!("Model '{model}' not found in config"));
        }
        set_top_level_string(&mut parsed, "default_model", model);
    }

    if let Some(thinking) = default_thinking {
        set_top_level_bool(&mut parsed, "default_thinking", thinking);
    }

    if let Some(plan_mode) = default_plan_mode {
        set_top_level_bool(&mut parsed, "default_plan_mode", plan_mode);
    }

    write_config_toml(&path, &parsed)?;
    Ok(build_global_config_json(&parsed))
}

/// Repair an unambiguous protocol/base-URL mismatch for the active model.
///
/// Kimi Code providers store an API *base* URL and append their protocol's
/// endpoint path themselves. A copied URL for another protocol (for example an
/// OpenAI provider pointing at `/anthropic/v1`) therefore produces a 404. Keep
/// this deliberately conservative: only the active provider is considered and
/// only well-known cross-protocol or duplicated endpoint suffixes are changed.
pub fn repair_active_provider_endpoint() -> Result<Option<ProviderEndpointRepair>, String> {
    let _guard = PROVIDER_ENDPOINT_REPAIR_LOCK
        .lock()
        .map_err(|_| "Provider endpoint repair lock is poisoned".to_string())?;
    let path = config_path()?;
    let mut parsed = load_config_toml()?;
    let repair = repair_active_provider_endpoint_on_value(&mut parsed)?;
    if repair.is_some() {
        write_config_toml(&path, &parsed)?;
    }
    Ok(repair)
}

fn repair_active_provider_endpoint_on_value(
    parsed: &mut toml::Value,
) -> Result<Option<ProviderEndpointRepair>, String> {
    let default_model = parsed
        .get("default_model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let Some(model_alias) = default_model else {
        return Ok(None);
    };

    let provider = parsed
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get(&model_alias))
        .and_then(toml::Value::as_table)
        .and_then(|model| model.get("provider"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Active model '{model_alias}' has no provider"))?;

    let provider_table = parsed
        .get("providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(&provider))
        .and_then(toml::Value::as_table)
        .ok_or_else(|| {
            format!("Provider '{provider}' not found for active model '{model_alias}'")
        })?;
    let provider_type = provider_table
        .get("type")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Provider '{provider}' has no type"))?;
    let previous_base_url = provider_table
        .get("base_url")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let Some(previous_base_url) = previous_base_url else {
        return Ok(None);
    };
    let Some(base_url) = normalized_provider_base_url(&provider_type, &previous_base_url) else {
        return Ok(None);
    };
    if base_url == previous_base_url {
        return Ok(None);
    }

    parsed
        .get_mut("providers")
        .and_then(toml::Value::as_table_mut)
        .and_then(|providers| providers.get_mut(&provider))
        .and_then(toml::Value::as_table_mut)
        .ok_or_else(|| format!("Provider '{provider}' cannot be updated"))?
        .insert(
            "base_url".to_string(),
            toml::Value::String(base_url.clone()),
        );

    Ok(Some(ProviderEndpointRepair {
        model_alias,
        provider,
        provider_type,
        previous_base_url,
        base_url,
    }))
}

fn normalized_provider_base_url(provider_type: &str, base_url: &str) -> Option<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !has_valid_http_origin(trimmed) {
        return None;
    }
    let lowered_type = provider_type.trim().to_ascii_lowercase();

    match lowered_type.as_str() {
        "openai" | "openai_legacy" | "openai_responses" | "kimi" => {
            if let Some(prefix) = truncate_at_path_segment(trimmed, "anthropic") {
                return Some(prefix);
            }
            strip_endpoint_suffix(trimmed, &["/v1/messages", "/messages"])
                .or_else(|| strip_endpoint_suffix(trimmed, &["/chat/completions", "/responses"]))
        }
        "anthropic" => strip_endpoint_suffix(trimmed, &["/v1/messages", "/v1"])
            .or_else(|| strip_endpoint_suffix(trimmed, &["/chat/completions", "/responses"])),
        "google-genai" | "vertexai" => strip_endpoint_suffix(trimmed, &["/v1beta1", "/v1beta"]),
        _ => None,
    }
}

fn has_valid_http_origin(value: &str) -> bool {
    let Some((scheme, remainder)) = value.split_once("://") else {
        return false;
    };
    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        && remainder
            .split('/')
            .next()
            .is_some_and(|host| !host.trim().is_empty())
}

fn truncate_at_path_segment(value: &str, segment: &str) -> Option<String> {
    let scheme_end = value.find("://")? + 3;
    let path_start = value[scheme_end..]
        .find('/')
        .map(|index| scheme_end + index)?;
    let path = &value[path_start..];
    let lowered = path.to_ascii_lowercase();
    let marker = format!("/{segment}");
    let relative = lowered.find(&marker)?;
    let marker_end = relative + marker.len();
    if marker_end < lowered.len() && lowered.as_bytes().get(marker_end) != Some(&b'/') {
        return None;
    }
    let prefix = value[..path_start + relative].trim_end_matches('/');
    has_valid_http_origin(prefix).then(|| prefix.to_string())
}

fn strip_endpoint_suffix(value: &str, suffixes: &[&str]) -> Option<String> {
    let lowered = value.to_ascii_lowercase();
    for suffix in suffixes {
        if lowered.ends_with(suffix) {
            let prefix = value[..value.len() - suffix.len()].trim_end_matches('/');
            if has_valid_http_origin(prefix) {
                return Some(prefix.to_string());
            }
        }
    }
    None
}

fn config_path() -> Result<PathBuf, String> {
    runtime_check::kimi_code_config_path()
}

fn load_config_toml() -> Result<toml::Value, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    content
        .parse::<toml::Value>()
        .map_err(|e| format!("Invalid Kimi config TOML: {}", e))
}

fn write_config_toml(path: &PathBuf, parsed: &toml::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    let content = toml::to_string_pretty(parsed)
        .map_err(|e| format!("Failed to serialize config TOML: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

pub(crate) fn build_global_config_json(parsed: &toml::Value) -> Value {
    let default_model = parsed
        .get("default_model")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .to_string();
    let default_thinking = parsed
        .get("default_thinking")
        .and_then(toml::Value::as_bool)
        .unwrap_or(false);
    let default_plan_mode = parsed
        .get("default_plan_mode")
        .and_then(toml::Value::as_bool)
        .unwrap_or(false);
    let default_permission_mode = normalized_permission_mode(parsed);

    json!({
        "default_model": default_model,
        "default_thinking": default_thinking,
        "default_plan_mode": default_plan_mode,
        "default_permission_mode": default_permission_mode,
        "models": build_models_array(parsed),
    })
}

fn build_models_array(parsed: &toml::Value) -> Vec<Value> {
    let providers = parsed.get("providers").and_then(toml::Value::as_table);
    let models = parsed
        .get("models")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();

    let mut entries: Vec<(String, Value)> = models
        .iter()
        .map(|(name, model_table)| {
            let provider = model_table
                .get("provider")
                .and_then(toml::Value::as_str)
                .unwrap_or(name.as_str())
                .to_string();
            let model = model_table
                .get("model")
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .to_string();
            let max_context_size = model_table
                .get("max_context_size")
                .and_then(toml::Value::as_integer)
                .unwrap_or(0);
            let capabilities = model_table
                .get("capabilities")
                .and_then(toml::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(toml::Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .filter(|items| !items.is_empty());
            let provider_type = providers
                .and_then(|table| table.get(&provider))
                .and_then(|provider_table| provider_table.get("type"))
                .and_then(toml::Value::as_str)
                .unwrap_or(provider.as_str())
                .to_string();

            let mut entry = json!({
                "name": name,
                "provider": provider,
                "model": model,
                "max_context_size": max_context_size,
                "provider_type": provider_type,
            });
            if let Some(caps) = capabilities {
                entry
                    .as_object_mut()
                    .expect("model entry object")
                    .insert("capabilities".to_string(), json!(caps));
            }
            (name.clone(), entry)
        })
        .collect();

    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    entries.into_iter().map(|(_, value)| value).collect()
}

fn model_exists(parsed: &toml::Value, model_name: &str) -> bool {
    parsed
        .get("models")
        .and_then(toml::Value::as_table)
        .map(|table| table.contains_key(model_name))
        .unwrap_or(false)
}

fn set_top_level_string(parsed: &mut toml::Value, key: &str, value: &str) {
    let table = parsed.as_table_mut().expect("config root must be a table");
    table.insert(key.to_string(), toml::Value::String(value.to_string()));
}

fn set_top_level_bool(parsed: &mut toml::Value, key: &str, value: bool) {
    let table = parsed.as_table_mut().expect("config root must be a table");
    table.insert(key.to_string(), toml::Value::Boolean(value));
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CONFIG: &str = r#"default_model = "kimi"
default_thinking = true
default_plan_mode = false
default_permission_mode = "auto"

[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi-k2"
max_context_size = 128000
capabilities = ["thinking"]
"#;

    #[test]
    fn build_global_config_json_matches_legacy_shape() {
        let parsed: toml::Value = SAMPLE_CONFIG.parse().expect("sample config parses");
        let config = build_global_config_json(&parsed);

        assert_eq!(config["default_model"], "kimi");
        assert_eq!(config["default_thinking"], true);
        assert_eq!(config["default_plan_mode"], false);
        assert_eq!(config["default_permission_mode"], "auto");

        let models = config["models"].as_array().expect("models array");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["name"], "kimi");
        assert_eq!(models[0]["provider"], "kimi");
        assert_eq!(models[0]["model"], "kimi-k2");
        assert_eq!(models[0]["max_context_size"], 128000);
        assert_eq!(models[0]["provider_type"], "kimi");
        assert_eq!(models[0]["capabilities"], json!(["thinking"]));
    }

    #[test]
    fn runtime_mode_defaults_normalize_unknown_permission_to_manual() {
        let parsed: toml::Value = r#"
default_plan_mode = true
default_permission_mode = "unexpected"
"#
        .parse()
        .expect("sample config parses");

        assert_eq!(
            RuntimeModeDefaults {
                plan_mode: parsed
                    .get("default_plan_mode")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(false),
                permission_mode: normalized_permission_mode(&parsed),
            },
            RuntimeModeDefaults {
                plan_mode: true,
                permission_mode: "manual".to_string(),
            }
        );
    }

    #[test]
    fn update_global_config_fields_rejects_unknown_model() {
        let parsed: toml::Value = SAMPLE_CONFIG.parse().expect("sample config parses");
        let err = update_fields_on_value(&parsed, Some("missing"), None, None).unwrap_err();
        assert!(err.contains("not found in config"));
    }

    #[test]
    fn update_global_config_fields_updates_defaults() {
        let parsed: toml::Value = SAMPLE_CONFIG.parse().expect("sample config parses");
        let updated = update_fields_on_value(&parsed, None, Some(false), Some(true))
            .expect("update succeeds");

        assert_eq!(updated["default_thinking"], false);
        assert_eq!(updated["default_plan_mode"], true);
    }

    #[test]
    fn repairs_cross_protocol_base_url_for_active_openai_model() {
        let mut parsed: toml::Value = r#"default_model = "deepseek/pro"

[providers.deepseek]
type = "openai"
base_url = "https://api.example.com/anthropic/v1"
api_key = "secret"

[models."deepseek/pro"]
provider = "deepseek"
model = "pro"
max_context_size = 1000000
"#
        .parse()
        .expect("sample config parses");

        let repair = repair_active_provider_endpoint_on_value(&mut parsed)
            .expect("repair succeeds")
            .expect("mismatched endpoint is repaired");

        assert_eq!(repair.model_alias, "deepseek/pro");
        assert_eq!(repair.provider, "deepseek");
        assert_eq!(repair.provider_type, "openai");
        assert_eq!(
            repair.previous_base_url,
            "https://api.example.com/anthropic/v1"
        );
        assert_eq!(repair.base_url, "https://api.example.com");
        assert_eq!(
            parsed["providers"]["deepseek"]["base_url"].as_str(),
            Some("https://api.example.com")
        );
        assert_eq!(
            parsed["providers"]["deepseek"]["api_key"].as_str(),
            Some("secret")
        );
    }

    #[test]
    fn repairs_duplicate_version_suffix_for_active_anthropic_model() {
        let mut parsed: toml::Value = r#"default_model = "custom/claude"

[providers.custom]
type = "anthropic"
base_url = "https://gateway.example/anthropic/v1"
api_key = "secret"

[models."custom/claude"]
provider = "custom"
model = "claude-opus"
max_context_size = 200000
"#
        .parse()
        .expect("sample config parses");

        let repair = repair_active_provider_endpoint_on_value(&mut parsed)
            .expect("repair succeeds")
            .expect("duplicated Anthropic version is repaired");

        assert_eq!(repair.base_url, "https://gateway.example/anthropic");
    }

    #[test]
    fn leaves_compatible_and_inactive_provider_urls_unchanged() {
        let mut parsed: toml::Value = r#"default_model = "openai/gpt"

[providers.openai]
type = "openai"
base_url = "https://gateway.example/v1"
api_key = "secret"

[providers.inactive]
type = "openai"
base_url = "https://inactive.example/anthropic/v1"
api_key = "secret"

[models."openai/gpt"]
provider = "openai"
model = "gpt"
max_context_size = 128000

[models."inactive/model"]
provider = "inactive"
model = "model"
max_context_size = 128000
"#
        .parse()
        .expect("sample config parses");

        assert!(repair_active_provider_endpoint_on_value(&mut parsed)
            .expect("inspection succeeds")
            .is_none());
        assert_eq!(
            parsed["providers"]["inactive"]["base_url"].as_str(),
            Some("https://inactive.example/anthropic/v1")
        );
    }

    #[test]
    fn persists_only_the_repaired_endpoint_to_the_runtime_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_env::lock::set_kimi_code_home(dir.path());
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"default_model = "provider/model"

[providers.provider]
type = "openai"
base_url = "https://api.example.com/anthropic/v1"
api_key = "secret"

[models."provider/model"]
provider = "provider"
model = "model"
max_context_size = 128000
"#,
        )
        .expect("config written");

        let repair = repair_active_provider_endpoint()
            .expect("repair succeeds")
            .expect("repair is persisted");
        let repaired: toml::Value = fs::read_to_string(path)
            .expect("config readable")
            .parse()
            .expect("config remains valid TOML");

        assert_eq!(repair.base_url, "https://api.example.com");
        assert_eq!(
            repaired["providers"]["provider"]["base_url"].as_str(),
            Some("https://api.example.com")
        );
        assert_eq!(
            repaired["providers"]["provider"]["api_key"].as_str(),
            Some("secret")
        );
        assert_eq!(repaired["default_model"].as_str(), Some("provider/model"));
    }

    fn update_fields_on_value(
        parsed: &toml::Value,
        default_model: Option<&str>,
        default_thinking: Option<bool>,
        default_plan_mode: Option<bool>,
    ) -> Result<Value, String> {
        let mut next = parsed.clone();

        if let Some(model) = default_model {
            if !model_exists(&next, model) {
                return Err(format!("Model '{model}' not found in config"));
            }
            set_top_level_string(&mut next, "default_model", model);
        }
        if let Some(thinking) = default_thinking {
            set_top_level_bool(&mut next, "default_thinking", thinking);
        }
        if let Some(plan_mode) = default_plan_mode {
            set_top_level_bool(&mut next, "default_plan_mode", plan_mode);
        }

        Ok(build_global_config_json(&next))
    }
}
