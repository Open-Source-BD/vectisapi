//! User-configurable settings shared by the engine and the Settings modal.

use serde::{Deserialize, Serialize};

/// App settings. `Default` holds the spec defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Request timeout in milliseconds; `0` means no timeout.
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub max_redirects: usize,
    pub verify_tls: bool,
    pub proxy_url: Option<String>,
    /// Default User-Agent; `None` means `VectisAPI/<version>`.
    pub user_agent: Option<String>,
    pub response_store_cap_bytes: u64,
    pub history_limit: u32,
    pub theme: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            timeout_ms: 30_000,
            follow_redirects: true,
            max_redirects: 10,
            verify_tls: true,
            proxy_url: None,
            user_agent: None,
            response_store_cap_bytes: 512 * 1024 * 1024,
            history_limit: 1_000,
            theme: None,
        }
    }
}
