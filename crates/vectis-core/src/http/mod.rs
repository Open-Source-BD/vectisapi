//! HTTP engine: request specs, pooled clients, sending and the response body store.

mod client;
mod engine;
mod spec;
mod store;

pub use client::ClientPool;
pub use engine::HttpEngine;
pub use spec::{BodySpec, HttpRequestSpec, MultipartPart, PartValue, ResponseMeta, Timing};
pub use store::{BodyWriter, ResponseStore, INLINE_PREFIX_BYTES};
