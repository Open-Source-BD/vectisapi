//! RFC 6265 cookie jar behaviour.

use url::Url;
use vectis_core::cookies::{CookieJar, CookieView};

fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
}

fn set(jar: &CookieJar, url: &str, values: &[&str]) {
    let values: Vec<String> = values.iter().map(|v| v.to_string()).collect();
    jar.store_response(&u(url), &values);
}

#[test]
fn domain_cookie_sent_to_subdomain() {
    let jar = CookieJar::new();
    set(
        &jar,
        "http://example.com/",
        &["sid=1; Domain=example.com; Path=/"],
    );
    assert_eq!(
        jar.header_for(&u("http://api.example.com/x")).as_deref(),
        Some("sid=1")
    );
    assert_eq!(
        jar.header_for(&u("http://example.com/")).as_deref(),
        Some("sid=1")
    );
    assert_eq!(jar.header_for(&u("http://notexample.com/")), None);
}

#[test]
fn host_only_cookie_not_sent_to_subdomain() {
    let jar = CookieJar::new();
    set(&jar, "http://example.com/", &["sid=1; Path=/"]);
    assert_eq!(
        jar.header_for(&u("http://example.com/a")).as_deref(),
        Some("sid=1")
    );
    assert_eq!(jar.header_for(&u("http://api.example.com/a")), None);
}

#[test]
fn domain_attribute_for_other_site_rejected() {
    let jar = CookieJar::new();
    set(&jar, "http://example.com/", &["evil=1; Domain=other.com"]);
    assert!(jar.list().is_empty());
}

#[test]
fn path_matching() {
    let jar = CookieJar::new();
    set(
        &jar,
        "http://example.com/",
        &["root=r; Path=/", "api=a; Path=/api"],
    );
    assert_eq!(
        jar.header_for(&u("http://example.com/")).as_deref(),
        Some("root=r")
    );
    // Longer paths first (RFC 6265 §5.4).
    assert_eq!(
        jar.header_for(&u("http://example.com/api/users"))
            .as_deref(),
        Some("api=a; root=r")
    );
    assert_eq!(
        jar.header_for(&u("http://example.com/api")).as_deref(),
        Some("api=a; root=r")
    );
    assert_eq!(
        jar.header_for(&u("http://example.com/apix")).as_deref(),
        Some("root=r")
    );

    // No Path attribute → default-path is the request path's directory.
    let jar = CookieJar::new();
    set(&jar, "http://example.com/docs/page", &["d=1"]);
    assert_eq!(
        jar.header_for(&u("http://example.com/docs/other"))
            .as_deref(),
        Some("d=1")
    );
    assert_eq!(jar.header_for(&u("http://example.com/")), None);
}

#[test]
fn expired_not_sent() {
    let jar = CookieJar::new();
    set(
        &jar,
        "http://example.com/",
        &[
            "old=1; Expires=Thu, 01 Jan 1970 00:00:01 GMT",
            "zero=1; Max-Age=0",
            "live=1; Max-Age=3600",
        ],
    );
    assert_eq!(
        jar.header_for(&u("http://example.com/")).as_deref(),
        Some("live=1")
    );

    // A server deletes a cookie by re-sending it already expired.
    set(&jar, "http://example.com/", &["live=1; Max-Age=0"]);
    assert_eq!(jar.header_for(&u("http://example.com/")), None);
    assert!(jar.list().is_empty());
}

#[test]
fn secure_only_on_https() {
    let jar = CookieJar::new();
    set(
        &jar,
        "https://example.com/",
        &["s=1; Secure; Path=/", "p=2; Path=/"],
    );
    assert_eq!(
        jar.header_for(&u("https://example.com/")).as_deref(),
        Some("p=2; s=1")
    );
    assert_eq!(
        jar.header_for(&u("http://example.com/")).as_deref(),
        Some("p=2")
    );
}

#[test]
fn list_delete_and_clear() {
    let jar = CookieJar::new();
    set(
        &jar,
        "https://example.com/",
        &[
            "a=1; Path=/; HttpOnly; Secure; Max-Age=3600",
            "b=2; Path=/x",
        ],
    );
    set(&jar, "http://other.test/", &["c=3"]);

    let list = jar.list();
    assert_eq!(list.len(), 3);
    let a = list.iter().find(|c| c.name == "a").unwrap();
    assert_eq!(a.domain, "example.com");
    assert_eq!(a.path, "/");
    assert_eq!(a.value, "1");
    assert!(a.secure && a.http_only);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let expires = a.expires.unwrap();
    assert!((now + 3590..=now + 3610).contains(&expires), "{expires}");
    let b = list.iter().find(|c| c.name == "b").unwrap();
    assert_eq!(b.path, "/x");
    assert_eq!(b.expires, None);

    jar.delete("example.com", "/x", "b");
    assert!(jar.list().iter().all(|c| c.name != "b"));

    jar.clear_domain("example.com");
    let names: Vec<String> = jar.list().into_iter().map(|c| c.name).collect();
    assert_eq!(names, vec!["c"]);

    jar.clear();
    assert!(jar.list().is_empty());
}

#[test]
fn json_roundtrip() {
    let jar = CookieJar::new();
    set(
        &jar,
        "https://example.com/app/",
        &[
            "persist=1; Domain=example.com; Path=/; Max-Age=3600; Secure; HttpOnly",
            "session=\"quoted\"; Path=/app",
        ],
    );
    let json = jar.to_json();
    let restored = CookieJar::load_json(&json);

    let sorted = |mut v: Vec<CookieView>| {
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    };
    assert_eq!(sorted(restored.list()), sorted(jar.list()));
    assert_eq!(restored.list().len(), 2);
    assert_eq!(
        restored.header_for(&u("https://api.example.com/app/x")),
        jar.header_for(&u("https://api.example.com/app/x"))
    );
    assert_eq!(
        restored
            .header_for(&u("https://example.com/app/x"))
            .as_deref(),
        Some("session=\"quoted\"; persist=1")
    );

    // Garbage and an empty store load as an empty jar.
    assert!(CookieJar::load_json("not json").list().is_empty());
    assert!(CookieJar::load_json(&CookieJar::new().to_json())
        .list()
        .is_empty());
}
