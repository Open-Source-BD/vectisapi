//! WebSocket client over tokio-tungstenite (rustls). Proxy settings are not applied to
//! WebSockets in v1; TLS verification follows the settings.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::{COOKIE, SEC_WEBSOCKET_PROTOCOL, SET_COOKIE};
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;
use url::Url;

use super::{ConnTask, RtEvent, CLOSED_BY_USER};
use crate::cookies::CookieJar;
use crate::error::{CoreError, ErrorKind};

/// How long a user close waits for the server's closing handshake.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

pub(super) struct WsParams {
    pub request: Request,
    pub verify_tls: bool,
    /// Bounds the TCP/TLS/upgrade handshake; `0` = none.
    pub connect_timeout_ms: u64,
    pub jar: Arc<CookieJar>,
    pub open: Arc<AtomicBool>,
    pub outgoing: mpsc::UnboundedReceiver<String>,
}

/// Builds the upgrade request: user headers in order, subprotocols, and the jar's cookies for
/// the URL unless the user set `Cookie`.
pub(super) fn build_request(
    raw_url: &str,
    headers: &[(String, String)],
    protocols: &[String],
    jar: &CookieJar,
) -> Result<Request, CoreError> {
    let url = parse_ws_url(raw_url)?;
    let mut request = url.as_str().into_client_request().map_err(|e| {
        CoreError::new(
            ErrorKind::InvalidUrl,
            format!("invalid URL \"{raw_url}\": {e}"),
        )
    })?;
    let map = request.headers_mut();
    for (name, value) in headers {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            CoreError::new(ErrorKind::Other, format!("invalid header name: {name}"))
        })?;
        let header_value = HeaderValue::from_str(value).map_err(|_| {
            CoreError::new(ErrorKind::Other, format!("invalid value for header {name}"))
        })?;
        map.append(header_name, header_value);
    }
    let protocols: Vec<&str> = protocols
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if !protocols.is_empty() {
        let value = HeaderValue::from_str(&protocols.join(", "))
            .map_err(|_| CoreError::new(ErrorKind::Other, "invalid subprotocol"))?;
        map.insert(SEC_WEBSOCKET_PROTOCOL, value);
    }
    if !map.contains_key(COOKIE) {
        if let Some(cookie) = jar.header_for(&http_url(&url)) {
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                map.insert(COOKIE, value);
            }
        }
    }
    Ok(request)
}

fn parse_ws_url(raw: &str) -> Result<Url, CoreError> {
    let invalid = |reason: &str| {
        CoreError::new(
            ErrorKind::InvalidUrl,
            format!("invalid URL \"{raw}\": {reason}"),
        )
    };
    let mut url = Url::parse(raw.trim()).map_err(|e| invalid(&e.to_string()))?;
    let scheme = match url.scheme() {
        "ws" | "http" => "ws",
        "wss" | "https" => "wss",
        _ => return Err(invalid("scheme must be ws or wss")),
    };
    if url.host_str().is_none_or(str::is_empty) {
        return Err(invalid("missing host"));
    }
    if url.scheme() != scheme {
        url.set_scheme(scheme)
            .map_err(|()| invalid("cannot map scheme"))?;
    }
    Ok(url)
}

/// The http(s) URL the cookie jar sees for a ws(s) URL.
fn http_url(url: &Url) -> Url {
    let mut mapped = url.clone();
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    // ws→http and wss→https are both "special" schemes, so this cannot fail.
    let _ = mapped.set_scheme(scheme);
    mapped
}

pub(super) async fn run(task: ConnTask, params: WsParams) {
    let WsParams {
        request,
        verify_tls,
        connect_timeout_ms,
        jar,
        open,
        mut outgoing,
    } = params;
    let cookie_url = Url::parse(&request.uri().to_string())
        .ok()
        .map(|u| http_url(&u));

    let connector = match tls_connector(verify_tls) {
        Ok(c) => c,
        Err(message) => return task.end(RtEvent::Error { message }),
    };
    let handshake =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector);
    let connected = tokio::select! {
        () = task.cancelled() => return,
        r = with_timeout(connect_timeout_ms, handshake) => r,
    };
    let (mut socket, response) = match connected {
        Some(Ok(ok)) => ok,
        Some(Err(e)) => {
            return task.end(RtEvent::Error {
                message: format!("WebSocket connection failed: {e}"),
            })
        }
        None => {
            return task.end(RtEvent::Error {
                message: "WebSocket connection timed out".to_string(),
            })
        }
    };
    if let Some(url) = &cookie_url {
        let set_cookies: Vec<String> = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect();
        if !set_cookies.is_empty() {
            jar.store_response(url, &set_cookies);
        }
    }
    open.store(true, Ordering::Release);
    if !task.emit(RtEvent::Open) {
        return;
    }

    let terminal = loop {
        tokio::select! {
            () = task.cancelled() => {
                // User close (or failed sink): polite closing handshake, no more events.
                let frame = CloseFrame { code: CloseCode::Normal, reason: CLOSED_BY_USER.into() };
                let _ = tokio::time::timeout(CLOSE_GRACE, async {
                    if socket.close(Some(frame)).await.is_ok() {
                        while let Some(Ok(_)) = socket.next().await {}
                    }
                })
                .await;
                return;
            }
            Some(text) = outgoing.recv() => {
                if let Err(e) = socket.send(Message::text(text)).await {
                    break RtEvent::Error { message: format!("WebSocket send failed: {e}") };
                }
            }
            frame = socket.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    let text = text.as_str().to_string();
                    let bytes = text.len() as u64;
                    if !task.emit(RtEvent::Message { text, bytes, binary: false }) {
                        return;
                    }
                }
                Some(Ok(Message::Binary(data))) => {
                    let n = data.len();
                    let event = RtEvent::Message {
                        text: format!("[binary {n} bytes]"),
                        bytes: n as u64,
                        binary: true,
                    };
                    if !task.emit(event) {
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    // tungstenite queues the close reply; flush it before reporting.
                    let _ = tokio::time::timeout(CLOSE_GRACE, socket.flush()).await;
                    break match frame {
                        Some(f) => RtEvent::Closed { code: Some(u16::from(f.code)), reason: f.reason.to_string() },
                        None => RtEvent::Closed { code: Some(1005), reason: String::new() },
                    };
                }
                Some(Ok(_)) => {} // ping/pong (answered by tungstenite) and raw frames
                Some(Err(e)) => break RtEvent::Error { message: format!("WebSocket error: {e}") },
                None => break RtEvent::Closed {
                    code: Some(1006),
                    reason: "connection closed without a close frame".to_string(),
                },
            }
        }
    };
    open.store(false, Ordering::Release);
    task.end(terminal);
}

async fn with_timeout<F: std::future::Future>(ms: u64, fut: F) -> Option<F::Output> {
    if ms == 0 {
        Some(fut.await)
    } else {
        tokio::time::timeout(Duration::from_millis(ms), fut)
            .await
            .ok()
    }
}

/// `None` uses tokio-tungstenite's default (rustls with the OS root store); verification off
/// uses a rustls config that accepts any certificate.
fn tls_connector(verify_tls: bool) -> Result<Option<Connector>, String> {
    if verify_tls {
        return Ok(None);
    }
    let provider = CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider)))
        .with_no_client_auth();
    Ok(Some(Connector::Rustls(Arc::new(config))))
}

/// Skips certificate checks (settings: verify TLS off) but still checks handshake signatures.
#[derive(Debug)]
struct AcceptAnyCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}
