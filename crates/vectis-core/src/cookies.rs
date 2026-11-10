//! Cookie jar. Minimal no-op stub with the final interface; Task 4 implements RFC 6265 behaviour.

use serde::{Deserialize, Serialize};
use url::Url;

/// A cookie as shown in the Cookies modal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieView {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    /// Unix seconds; `None` for session cookies.
    pub expires: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
}

/// Cookie jar shared by all requests.
#[derive(Debug, Default)]
pub struct CookieJar {}

impl CookieJar {
    pub fn new() -> Self {
        Self {}
    }

    pub fn load_json(_s: &str) -> Self {
        Self::new()
    }

    pub fn to_json(&self) -> String {
        "[]".to_string()
    }

    /// The `Cookie` header value to send to `url`, if any cookie matches.
    pub fn header_for(&self, _url: &Url) -> Option<String> {
        None
    }

    /// Records the `Set-Cookie` values received from `url`.
    pub fn store_response(&self, _url: &Url, _set_cookie_values: &[String]) {}

    pub fn list(&self) -> Vec<CookieView> {
        Vec::new()
    }

    pub fn delete(&self, _domain: &str, _path: &str, _name: &str) {}

    pub fn clear_domain(&self, _domain: &str) {}

    pub fn clear(&self) {}
}
