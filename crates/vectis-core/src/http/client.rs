//! Shared `reqwest::Client`, rebuilt only when settings change.

use std::sync::Arc;

use parking_lot::RwLock;

use crate::error::{CoreError, ErrorKind};
use crate::settings::Settings;

/// `VectisAPI/<version>`, sent unless settings or the request set a User-Agent.
pub const DEFAULT_USER_AGENT: &str = concat!("VectisAPI/", env!("CARGO_PKG_VERSION"));

struct Pooled {
    /// The last client that built successfully; `None` only if no settings ever built one.
    client: Option<reqwest::Client>,
    /// Settings timeout; applied per request so a request can override it.
    timeout_ms: u64,
    /// Redirect cap when following is on; `None` when redirects are returned as-is.
    max_redirects: Option<usize>,
    verify_tls: bool,
    /// Settings User-Agent or `DEFAULT_USER_AGENT`.
    user_agent: String,
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
            inner: Arc::new(RwLock::new(build(settings, None))),
        }
    }

    /// Rebuilds the client for new settings; in-flight requests keep the old one. When the new
    /// settings cannot build a client, the previous client is kept and sends fail with the error
    /// until valid settings are applied.
    pub fn update(&self, settings: &Settings) {
        let mut inner = self.inner.write();
        let previous = inner.client.take();
        *inner = build(settings, previous);
    }

    /// The shared client, or the settings error that keeps requests from being sent.
    pub fn client(&self) -> Result<reqwest::Client, CoreError> {
        self.check()?;
        self.inner
            .read()
            .client
            .clone()
            .ok_or_else(|| CoreError::new(ErrorKind::Other, "HTTP client unavailable"))
    }

    /// Default request timeout from settings (`0` = none).
    pub(crate) fn timeout_ms(&self) -> u64 {
        self.inner.read().timeout_ms
    }

    /// Redirect cap when the engine should follow redirects; `None` when it should not.
    pub(crate) fn max_redirects(&self) -> Option<usize> {
        self.inner.read().max_redirects
    }

    /// Whether TLS certificates are verified (used by clients that cannot share `client()`).
    pub(crate) fn verify_tls(&self) -> bool {
        self.inner.read().verify_tls
    }

    /// The User-Agent sent unless a request sets its own (used by clients that cannot share
    /// `client()`).
    pub(crate) fn user_agent(&self) -> String {
        self.inner.read().user_agent.clone()
    }

    pub(crate) fn check(&self) -> Result<(), CoreError> {
        match &self.inner.read().build_error {
            Some(msg) => Err(CoreError::new(ErrorKind::Other, msg.clone())),
            None => Ok(()),
        }
    }
}

/// Never panics: a failed build keeps `previous` (which may be `None`) and records the error.
fn build(settings: &Settings, previous: Option<reqwest::Client>) -> Pooled {
    let (client, build_error) = match make_client(settings) {
        Ok(client) => (Some(client), None),
        Err(msg) => (previous, Some(msg)),
    };
    Pooled {
        client,
        timeout_ms: settings.timeout_ms,
        max_redirects: settings.follow_redirects.then_some(settings.max_redirects),
        verify_tls: settings.verify_tls,
        user_agent: user_agent(settings),
        build_error,
    }
}

fn make_client(settings: &Settings) -> Result<reqwest::Client, String> {
    // Redirects are followed by the engine (so the cookie jar sees every hop), and cookies are
    // handled by our own jar, so reqwest's cookie store stays off (feature not enabled).
    let mut b = reqwest::Client::builder()
        .user_agent(user_agent(settings))
        .redirect(reqwest::redirect::Policy::none())
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

fn user_agent(settings: &Settings) -> String {
    settings
        .user_agent
        .clone()
        .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string())
}
