// In-memory PCM cache keyed by an engine-assigned asset id. Held by
// the engine and consumed by Audio-track region rendering each block.
//
// Phase-5 M1 keeps it intentionally minimal — mono PCM at the engine
// sample rate, no eviction, no streaming. M2 wires OPFS-backed PCM
// upload from the host; M5 records straight into the cache. A future
// polish pass can add an LRU bytes budget so projects with hours of
// audio don't pin all PCM in RAM.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

pub type AssetId = u32;

#[derive(Default)]
pub struct AssetCache {
    pcm: BTreeMap<AssetId, Vec<f32>>,
}

impl AssetCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace the PCM frames for `asset_id`. Frames are
    /// mono at the engine's sample rate (the host downmixes / resamples
    /// before calling).
    pub fn put(&mut self, asset_id: AssetId, frames: Vec<f32>) {
        self.pcm.insert(asset_id, frames);
    }

    pub fn get(&self, asset_id: AssetId) -> Option<&[f32]> {
        self.pcm.get(&asset_id).map(|v| v.as_slice())
    }

    pub fn contains(&self, asset_id: AssetId) -> bool {
        self.pcm.contains_key(&asset_id)
    }

    pub fn remove(&mut self, asset_id: AssetId) {
        self.pcm.remove(&asset_id);
    }

    pub fn len(&self) -> usize {
        self.pcm.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pcm.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn put_then_get_returns_same_slice() {
        let mut c = AssetCache::new();
        c.put(7, vec![0.1, 0.2, 0.3]);
        assert_eq!(c.get(7).unwrap(), &[0.1, 0.2, 0.3]);
    }

    #[test]
    fn missing_id_returns_none() {
        let c = AssetCache::new();
        assert!(c.get(42).is_none());
    }

    #[test]
    fn put_replaces_existing_frames() {
        let mut c = AssetCache::new();
        c.put(1, vec![0.0; 4]);
        c.put(1, vec![1.0; 4]);
        assert_eq!(c.get(1).unwrap(), &[1.0; 4]);
    }
}
