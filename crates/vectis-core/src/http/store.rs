//! Rust-side store for response bodies, keyed by response id.
//!
//! Minimal version: bodies are kept unbounded. Task 3 adds the LRU byte cap and `BodyTooLarge`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use parking_lot::Mutex;

use crate::error::CoreError;

/// Bytes of the body returned inline with the response metadata.
pub const INLINE_PREFIX_BYTES: usize = 2 * 1024 * 1024;

type Bodies = Arc<Mutex<HashMap<String, Vec<Bytes>>>>;

pub struct ResponseStore {
    bodies: Bodies,
    cap_bytes: AtomicU64,
}

impl ResponseStore {
    pub fn new(cap_bytes: u64) -> Self {
        Self {
            bodies: Arc::default(),
            cap_bytes: AtomicU64::new(cap_bytes),
        }
    }

    /// Starts a body; it becomes visible to readers on [`BodyWriter::finish`].
    pub fn begin(&self, response_id: &str) -> BodyWriter {
        BodyWriter {
            bodies: self.bodies.clone(),
            response_id: response_id.to_string(),
            chunks: Vec::new(),
            len: 0,
        }
    }

    /// Bytes `start..end` (end exclusive, clamped to the body length; `None` = to the end).
    pub fn get_range(&self, response_id: &str, start: u64, end: Option<u64>) -> Option<Bytes> {
        let bodies = self.bodies.lock();
        let chunks = bodies.get(response_id)?;
        let total: u64 = chunks.iter().map(|c| c.len() as u64).sum();
        let end = end.unwrap_or(total).min(total);
        let start = start.min(end);
        let mut out = BytesMut::with_capacity((end - start) as usize);
        let mut offset = 0u64;
        for chunk in chunks {
            let chunk_end = offset + chunk.len() as u64;
            if chunk_end > start && offset < end {
                let from = start.saturating_sub(offset) as usize;
                let to = (end.min(chunk_end) - offset) as usize;
                out.extend_from_slice(&chunk[from..to]);
            }
            offset = chunk_end;
            if offset >= end {
                break;
            }
        }
        Some(out.freeze())
    }

    pub fn len(&self, response_id: &str) -> Option<u64> {
        let bodies = self.bodies.lock();
        bodies
            .get(response_id)
            .map(|chunks| chunks.iter().map(|c| c.len() as u64).sum())
    }

    pub fn save_to_file(&self, response_id: &str, path: &Path) -> Result<(), CoreError> {
        let chunks = self
            .bodies
            .lock()
            .get(response_id)
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    crate::error::ErrorKind::Other,
                    format!("response {response_id} is no longer available"),
                )
            })?;
        let mut file = std::io::BufWriter::new(std::fs::File::create(path)?);
        for chunk in &chunks {
            std::io::Write::write_all(&mut file, chunk)?;
        }
        std::io::Write::flush(&mut file)?;
        Ok(())
    }

    pub fn set_cap(&self, cap_bytes: u64) {
        self.cap_bytes.store(cap_bytes, Ordering::Relaxed);
    }
}

/// Accumulates one response body. Dropping it without `finish` discards the body.
pub struct BodyWriter {
    bodies: Bodies,
    response_id: String,
    chunks: Vec<Bytes>,
    len: u64,
}

impl BodyWriter {
    pub fn push(&mut self, chunk: Bytes) -> Result<(), CoreError> {
        self.len += chunk.len() as u64;
        self.chunks.push(chunk);
        Ok(())
    }

    /// Publishes the body under its response id and returns its length.
    pub fn finish(self) -> u64 {
        self.bodies.lock().insert(self.response_id, self.chunks);
        self.len
    }
}
