//! Rust-side store for response bodies, keyed by response id.
//!
//! Bodies are kept as chunk lists (no copy on append) under an LRU byte cap; a single body
//! larger than the cap fails with `BodyTooLarge`.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use parking_lot::Mutex;

use crate::error::{CoreError, ErrorKind};

/// Bytes of the body returned inline with the response metadata.
pub const INLINE_PREFIX_BYTES: usize = 2 * 1024 * 1024;

/// Finished bodies in LRU order (front = least recently used) plus the byte total, which also
/// counts bodies still being written (those are not in `bodies`, so they are never evicted).
#[derive(Default)]
struct Inner {
    bodies: HashMap<String, Vec<Bytes>>,
    lru: VecDeque<String>,
    total: u64,
}

impl Inner {
    fn touch(&mut self, id: &str) {
        if let Some(pos) = self.lru.iter().position(|k| k == id) {
            if let Some(key) = self.lru.remove(pos) {
                self.lru.push_back(key);
            }
        }
    }

    fn remove(&mut self, id: &str) {
        if let Some(chunks) = self.bodies.remove(id) {
            self.total -= body_len(&chunks);
            self.lru.retain(|k| k != id);
        }
    }

    /// Evicts least-recently-used finished bodies until the total fits the cap.
    fn evict_to(&mut self, cap: u64) {
        while self.total > cap {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(chunks) = self.bodies.remove(&oldest) {
                self.total -= body_len(&chunks);
            }
        }
    }
}

fn body_len(chunks: &[Bytes]) -> u64 {
    chunks.iter().map(|c| c.len() as u64).sum()
}

type Shared = Arc<Mutex<Inner>>;

pub struct ResponseStore {
    inner: Shared,
    cap_bytes: Arc<AtomicU64>,
}

impl ResponseStore {
    pub fn new(cap_bytes: u64) -> Self {
        Self {
            inner: Arc::default(),
            cap_bytes: Arc::new(AtomicU64::new(cap_bytes)),
        }
    }

    /// Starts a body; it becomes visible to readers on [`BodyWriter::finish`].
    pub fn begin(&self, response_id: &str) -> BodyWriter {
        BodyWriter {
            inner: self.inner.clone(),
            cap_bytes: self.cap_bytes.clone(),
            response_id: response_id.to_string(),
            chunks: Vec::new(),
            len: 0,
            finished: false,
        }
    }

    /// Bytes held by finished and in-progress bodies.
    pub fn used_bytes(&self) -> u64 {
        self.inner.lock().total
    }

    /// Bytes `start..end` (end exclusive, clamped to the body length; `None` = to the end).
    pub fn get_range(&self, response_id: &str, start: u64, end: Option<u64>) -> Option<Bytes> {
        let mut inner = self.inner.lock();
        inner.touch(response_id);
        let chunks = inner.bodies.get(response_id)?;
        let total = body_len(chunks);
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
        let inner = self.inner.lock();
        inner.bodies.get(response_id).map(|c| body_len(c))
    }

    pub fn save_to_file(&self, response_id: &str, path: &Path) -> Result<(), CoreError> {
        let chunks = {
            let mut inner = self.inner.lock();
            inner.touch(response_id);
            inner.bodies.get(response_id).cloned()
        }
        .ok_or_else(|| {
            CoreError::new(
                ErrorKind::Other,
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
        self.inner.lock().evict_to(cap_bytes);
    }
}

/// Accumulates one response body. Dropping it without `finish` discards the body.
pub struct BodyWriter {
    inner: Shared,
    cap_bytes: Arc<AtomicU64>,
    response_id: String,
    chunks: Vec<Bytes>,
    len: u64,
    finished: bool,
}

impl BodyWriter {
    /// Appends a chunk. Fails with `BodyTooLarge` (and discards the partial body) if this body
    /// alone would exceed the cap; otherwise evicts older bodies to stay within it.
    pub fn push(&mut self, chunk: Bytes) -> Result<(), CoreError> {
        let cap = self.cap_bytes.load(Ordering::Relaxed);
        let added = chunk.len() as u64;
        if self.len + added > cap {
            self.release();
            return Err(CoreError::new(
                ErrorKind::BodyTooLarge,
                format!("response body exceeds the {cap}-byte store limit"),
            ));
        }
        self.len += added;
        self.chunks.push(chunk);
        let mut inner = self.inner.lock();
        inner.total += added;
        inner.evict_to(cap);
        Ok(())
    }

    /// Publishes the body under its response id and returns its length.
    pub fn finish(mut self) -> u64 {
        self.finished = true;
        let chunks = std::mem::take(&mut self.chunks);
        let id = std::mem::take(&mut self.response_id);
        let mut inner = self.inner.lock();
        inner.remove(&id);
        inner.bodies.insert(id.clone(), chunks);
        inner.lru.push_back(id);
        self.len
    }

    /// Drops the partial body and returns its bytes to the store's budget.
    fn release(&mut self) {
        self.chunks.clear();
        self.inner.lock().total -= self.len;
        self.len = 0;
    }
}

impl Drop for BodyWriter {
    fn drop(&mut self) {
        if !self.finished {
            self.release();
        }
    }
}
