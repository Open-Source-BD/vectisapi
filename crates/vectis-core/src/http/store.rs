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

/// Zero-copy slices of `chunks` covering `start..end` (clamped like [`ResponseStore::get_range`]).
fn range_slices(chunks: &[Bytes], start: u64, end: Option<u64>) -> Vec<Bytes> {
    let total = body_len(chunks);
    let end = end.unwrap_or(total).min(total);
    let start = start.min(end);
    let mut parts = Vec::new();
    if start == end {
        return parts;
    }
    let mut offset = 0u64;
    for chunk in chunks {
        if offset >= end {
            break;
        }
        let chunk_end = offset + chunk.len() as u64;
        if chunk_end > start {
            let from = start.saturating_sub(offset) as usize;
            let to = (end.min(chunk_end) - offset) as usize;
            parts.push(chunk.slice(from..to));
        }
        offset = chunk_end;
    }
    parts
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
    /// The store lock is held only to take refcounted slices of the chunks; the copy into one
    /// buffer happens after it is released, and a range inside one chunk is not copied at all.
    pub fn get_range(&self, response_id: &str, start: u64, end: Option<u64>) -> Option<Bytes> {
        let parts = {
            let mut inner = self.inner.lock();
            inner.touch(response_id);
            range_slices(inner.bodies.get(response_id)?, start, end)
        };
        Some(match parts.as_slice() {
            [] => Bytes::new(),
            [one] => one.clone(),
            _ => {
                let mut out = BytesMut::with_capacity(parts.iter().map(Bytes::len).sum());
                for part in &parts {
                    out.extend_from_slice(part);
                }
                out.freeze()
            }
        })
    }

    pub fn len(&self, response_id: &str) -> Option<u64> {
        let inner = self.inner.lock();
        inner.bodies.get(response_id).map(|c| body_len(c))
    }

    /// Writes the body to `path`. Only refcounted chunk handles are taken under the lock; the
    /// disk write happens after it is released.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(chunks: &[&'static [u8]]) -> ResponseStore {
        let store = ResponseStore::new(u64::MAX);
        let mut writer = store.begin("r");
        for chunk in chunks {
            writer.push(Bytes::from_static(chunk)).unwrap();
        }
        writer.finish();
        store
    }

    /// What runs under the store lock only takes refcounted views of the stored chunks: every
    /// slice points into stored memory, so no body bytes are copied while the lock is held.
    #[test]
    fn range_slices_are_zero_copy_views() {
        let chunks = [
            Bytes::from_static(b"abcd"),
            Bytes::from_static(b"efgh"),
            Bytes::from_static(b"ijkl"),
        ];
        let parts = range_slices(&chunks, 2, Some(10));
        let joined: Vec<u8> = parts.iter().flat_map(|p| p.iter().copied()).collect();
        assert_eq!(joined, b"cdefghij");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].as_ptr(), chunks[0][2..].as_ptr());
        assert_eq!(parts[1].as_ptr(), chunks[1].as_ptr());
        assert_eq!(parts[2].as_ptr(), chunks[2].as_ptr());
        assert!(range_slices(&chunks, 5, Some(5)).is_empty());
        assert!(range_slices(&chunks, 50, None).is_empty());
    }

    #[test]
    fn get_range_within_one_chunk_is_not_copied() {
        static FIRST: &[u8] = b"hello ";
        let store = store_with(&[FIRST, b"world"]);
        let got = store.get_range("r", 1, Some(4)).unwrap();
        assert_eq!(&got[..], b"ell");
        assert_eq!(got.as_ptr(), FIRST[1..].as_ptr());
    }

    #[test]
    fn get_range_across_chunks_concatenates() {
        let store = store_with(&[b"hello ", b"wor", b"ld"]);
        assert_eq!(&store.get_range("r", 4, None).unwrap()[..], b"o world");
        assert_eq!(&store.get_range("r", 0, Some(0)).unwrap()[..], b"");
    }

    /// While a caller holds a large multi-chunk range (being copied outside the lock), other
    /// store users are not blocked.
    #[test]
    fn get_range_does_not_hold_lock_during_copy() {
        let chunk = Bytes::from(vec![7u8; 1024 * 1024]);
        let store = Arc::new(ResponseStore::new(u64::MAX));
        let mut writer = store.begin("big");
        for _ in 0..64 {
            writer.push(chunk.clone()).unwrap();
        }
        writer.finish();
        let reader = {
            let store = store.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    assert_eq!(
                        store.get_range("big", 1, None).unwrap().len(),
                        64 * 1024 * 1024 - 1
                    );
                }
            })
        };
        // The lock is only taken briefly by each get_range, so pushes keep going.
        let mut max_wait = std::time::Duration::ZERO;
        while !reader.is_finished() {
            let t = std::time::Instant::now();
            drop(store.inner.lock());
            max_wait = max_wait.max(t.elapsed());
        }
        reader.join().unwrap();
        // Copying 64 MB under the lock took ~200 ms here (debug); a brief lock is far below this.
        assert!(
            max_wait < std::time::Duration::from_millis(20),
            "{max_wait:?}"
        );
    }
}
