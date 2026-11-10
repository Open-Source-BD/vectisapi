//! Shared `reqwest::Client`, rebuilt only when settings change.

use std::sync::Arc;

use parking_lot::RwLock;

use crate::error::{CoreError, ErrorKind};
use crate::settings::Settings;

/// `VectisAPI/<version>`, sent unless settings or the request set a User-Agent.
pub const DEFAULT_USER_AGENT: &str = concat!("VectisAPI/", env!("CARGO_PKG_VERSION"));

struct Pooled {
    client: reqwest::Client,
    /// Settings timeout; applied per request so a request can override it.
    timeout_ms: u64,
    /// Set when the settings could not be applied (e.g. a bad proxy URL); sends fail with it.
    build_error: Option<String>,
}

/// Cheap to clone; clones share the same client.
#[derive(Clone)]
pub struct ClientPool {
    inner: Arc<RwLock<Pooled>>,
}

impl ClientPool {
    pub fn new(settings: &Settings) -> Self {
        Self {
            inner: Arc::new(RwLock::new(build(settings))),
        }
    }

    /// Rebuilds the client for new settings; in-flight requests keep the old one.
    pub fn update(&self, settings: &Settings) {
        *self.inner.write() = build(settings);
    }

    pub fn client(&self) -> reqwest::Client {
        self.inner.read().client.clone()
    }

    /// Default request timeout from settings (`0` = none).
    pub(crate) fn timeout_ms(&self) -> u64 {
        self.inner.read().timeout_ms
    }

    pub(crate) fn check(&self) -> Result<(), CoreError> {
        match &self.inner.read().build_error {
            Some(msg) => Err(CoreError::new(ErrorKind::Other, msg.clone())),
            None => Ok(()),
        }
    }
}

fn build(settings: &Settings) -> Pooled {
    let (client, build_error) = match make_client(settings) {
        Ok(client) => (client, None),
        Err(msg) => (reqwest::Client::new(), Some(msg)),
    };
    Pooled {
        client,
        timeout_ms: settings.timeout_ms,
        build_error,
    }
}

fn make_client(settings: &Settings) -> Result<reqwest::Client, String> {
    let redirect = if settings.follow_redirects {
        reqwest::redirect::Policy::limited(settings.max_redirects)
    } else {
        reqwest::redirect::Policy::none()
    };
    // Cookies are handled by our own jar, so reqwest's cookie store stays off (feature not enabled).
    let mut b = reqwest::Client::builder()
        .user_agent(
            settings
                .user_agent
                .clone()
                .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string()),
        )
        .redirect(redirect)
        .tls_danger_accept_invalid_certs(!settings.verify_tls)
        // System/env proxies are off by default; only the configured proxy is used.
        .no_proxy();
    if let Some(url) = settings
        .proxy_url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
    {
        let proxy = reqwest::Proxy::all(url).map_err(|e| format!("invalid proxy url: {e}"))?;
        b = b.proxy(proxy);
    }
    b.build()
        .map_err(|e| format!("invalid settings: {}", CoreError::from(e).message))
}
