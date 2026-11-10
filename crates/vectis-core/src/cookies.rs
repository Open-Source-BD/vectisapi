//! RFC 6265 cookie jar (Domain/Path matching, Expires/Max-Age, Secure, HttpOnly), backed by
//! `cookie_store`. `Domain=` attributes naming a public suffix are rejected using the Public
//! Suffix List compiled into the binary (`psl` crate; no network access).

use cookie_store::{Cookie, CookieExpiration, CookieStore, RawCookie};
use parking_lot::RwLock;
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
pub struct CookieJar {
    store: RwLock<CookieStore>,
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Restores a jar written by [`to_json`](Self::to_json). Unreadable input yields an empty
    /// jar; unreadable or expired entries are skipped.
    pub fn load_json(s: &str) -> Self {
        let entries: Vec<serde_json::Value> = serde_json::from_str(s).unwrap_or_default();
        let cookies = entries
            .into_iter()
            .filter_map(|v| serde_json::from_value::<Cookie<'static>>(v).ok())
            .map(Ok::<_, ()>);
        let store = CookieStore::from_cookies(cookies, false).unwrap_or_default();
        Self {
            store: RwLock::new(store),
        }
    }

    /// Serializes every unexpired cookie, session cookies included (they last until the user
    /// clears them, as in Postman).
    pub fn to_json(&self) -> String {
        let store = self.store.read();
        let cookies: Vec<&Cookie<'static>> = store.iter_unexpired().collect();
        serde_json::to_string(&cookies).unwrap_or_else(|_| "[]".to_string())
    }

    /// The `Cookie` header value to send to `url`, if any cookie matches. Cookies with longer
    /// paths come first (RFC 6265 §5.4); ties are ordered by name.
    pub fn header_for(&self, url: &Url) -> Option<String> {
        let store = self.store.read();
        let mut matches = store.matches(url);
        if matches.is_empty() {
            return None;
        }
        matches.sort_by(|a, b| {
            b.path
                .len()
                .cmp(&a.path.len())
                .then_with(|| a.name().cmp(b.name()))
        });
        let pairs: Vec<String> = matches
            .iter()
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect();
        Some(pairs.join("; "))
    }

    /// Records the `Set-Cookie` values received from `url`. Values that are malformed or not
    /// allowed for `url` (a foreign or public-suffix `Domain=`) are ignored, as browsers do.
    pub fn store_response(&self, url: &Url, set_cookie_values: &[String]) {
        let mut store = self.store.write();
        for value in set_cookie_values {
            let Ok(mut raw) = RawCookie::parse(value.as_str()) else {
                continue;
            };
            if let Some(domain) = raw
                .domain()
                .map(|d| d.trim_matches('.').to_ascii_lowercase())
            {
                if is_public_suffix(&domain) {
                    // RFC 6265 §5.3 step 5: a public-suffix Domain equal to the request host
                    // becomes a host-only cookie; any other is ignored.
                    if url
                        .host_str()
                        .is_some_and(|h| h.eq_ignore_ascii_case(&domain))
                    {
                        raw.unset_domain();
                    } else {
                        continue;
                    }
                }
            }
            let _ = store.insert_raw(&raw, url);
        }
    }

    /// Every unexpired cookie, ordered by domain, path, then name.
    pub fn list(&self) -> Vec<CookieView> {
        let store = self.store.read();
        let mut views: Vec<CookieView> = store.iter_unexpired().map(view).collect();
        views.sort_by(|a, b| (&a.domain, &a.path, &a.name).cmp(&(&b.domain, &b.path, &b.name)));
        views
    }

    pub fn delete(&self, domain: &str, path: &str, name: &str) {
        self.store.write().remove(domain, path, name);
    }

    /// Removes every cookie whose domain is exactly `domain` (one group in the Cookies modal).
    pub fn clear_domain(&self, domain: &str) {
        let mut store = self.store.write();
        let doomed: Vec<(String, String)> = store
            .iter_any()
            .filter(|c| String::from(&c.domain) == domain)
            .map(|c| (String::from(&c.path), c.name().to_string()))
            .collect();
        for (path, name) in doomed {
            store.remove(domain, &path, &name);
        }
    }

    pub fn clear(&self) {
        self.store.write().clear();
    }
}

/// True when `domain` is itself a public suffix (`com`, `co.uk`, `vercel.app`, ...).
fn is_public_suffix(domain: &str) -> bool {
    !domain.is_empty() && psl::suffix_str(domain) == Some(domain)
}

fn view(cookie: &Cookie<'static>) -> CookieView {
    CookieView {
        domain: String::from(&cookie.domain),
        path: String::from(&cookie.path),
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        expires: match cookie.expires {
            CookieExpiration::AtUtc(at) => Some(at.unix_timestamp()),
            CookieExpiration::SessionEnd => None,
        },
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
    }
}
