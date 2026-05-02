// Audio-track region scheduling. Each region references an asset by
// id and lives at a fixed sample range on the timeline. The engine
// walks active regions per audio block and sums the corresponding
// PCM into the track's mono scratch.
//
// Phase-5 M1 ships sample-position-based regions only. M4 (warp /
// time-stretch) adds the FollowTempo path where the region's audible
// length recomputes when project tempo changes.

use crate::asset_cache::{AssetCache, AssetId};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioRegion {
    pub asset_id: AssetId,
    /// Absolute sample position on the timeline where the region
    /// begins playing. Computed on the host side from the region's
    /// startTick + project tempo at snapshot build time.
    pub start_sample: u64,
    /// Total number of samples the region occupies on the timeline.
    /// For Natural-warp regions this is just `asset_end - asset_start`.
    pub length_samples: u64,
    /// Sample offset into the asset's PCM where playback starts. Lets
    /// a region trim the asset without copying.
    pub asset_offset_samples: u64,
    pub gain: f32,
    pub fade_in_samples: u32,
    pub fade_out_samples: u32,
}

impl AudioRegion {
    /// Sum this region's PCM into `out` for the audio block beginning
    /// at absolute sample position `block_start`. Does nothing if the
    /// region doesn't intersect the block or the asset isn't cached.
    pub fn render_into(&self, out: &mut [f32], block_start: u64, cache: &AssetCache) {
        let frames = out.len() as u64;
        let region_end = self.start_sample.saturating_add(self.length_samples);
        if block_start >= region_end {
            return;
        }
        let block_end = block_start.saturating_add(frames);
        if block_end <= self.start_sample {
            return;
        }
        let Some(pcm) = cache.get(self.asset_id) else {
            return;
        };
        let pcm_len = pcm.len() as u64;
        // Compute the [first, last) sample-offset within the block
        // that the region covers.
        let block_first = self.start_sample.max(block_start) - block_start;
        let block_last = region_end.min(block_end) - block_start;
        let fade_in = self.fade_in_samples as u64;
        let fade_out = self.fade_out_samples as u64;
        for i in block_first..block_last {
            let absolute = block_start + i;
            // Position inside the region — used for fade math.
            let pos = absolute - self.start_sample;
            // Position inside the asset — clamps if the region runs
            // past the asset's PCM length (region will go silent
            // rather than read out of bounds).
            let asset_idx = self
                .asset_offset_samples
                .saturating_add(pos);
            if asset_idx >= pcm_len {
                continue;
            }
            let mut g = self.gain;
            if fade_in > 0 && pos < fade_in {
                g *= pos as f32 / fade_in as f32;
            }
            if fade_out > 0 {
                let pos_from_end = self.length_samples.saturating_sub(pos);
                if pos_from_end < fade_out {
                    g *= pos_from_end as f32 / fade_out as f32;
                }
            }
            out[i as usize] += pcm[asset_idx as usize] * g;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn cache_with(asset_id: AssetId, pcm: alloc::vec::Vec<f32>) -> AssetCache {
        let mut c = AssetCache::new();
        c.put(asset_id, pcm);
        c
    }

    #[test]
    fn block_before_region_renders_silence() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 1000,
            length_samples: 100,
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, vec![1.0; 200]);
        let mut out = vec![0.0f32; 64];
        region.render_into(&mut out, 0, &cache);
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn block_inside_region_writes_pcm() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 0,
            length_samples: 100,
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, vec![0.5; 200]);
        let mut out = vec![0.0f32; 32];
        region.render_into(&mut out, 0, &cache);
        for s in out.iter() {
            assert!((s - 0.5).abs() < 1e-6);
        }
    }

    #[test]
    fn region_starts_partway_through_block() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 16,
            length_samples: 16,
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, vec![0.5; 64]);
        let mut out = vec![0.0f32; 32];
        region.render_into(&mut out, 0, &cache);
        // First 16 frames silent; last 16 carry the asset.
        assert!(out[..16].iter().all(|s| *s == 0.0));
        for s in out[16..].iter() {
            assert!((s - 0.5).abs() < 1e-6);
        }
    }

    #[test]
    fn asset_offset_skips_into_pcm() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 0,
            length_samples: 8,
            asset_offset_samples: 4,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, (0..16).map(|i| i as f32).collect());
        let mut out = vec![0.0f32; 8];
        region.render_into(&mut out, 0, &cache);
        // Should start reading from index 4: 4, 5, 6, ...
        let expected: alloc::vec::Vec<f32> = (4..12).map(|i| i as f32).collect();
        for (a, b) in out.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn fade_in_ramps_gain_from_zero() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 0,
            length_samples: 8,
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 4,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, vec![1.0; 8]);
        let mut out = vec![0.0f32; 8];
        region.render_into(&mut out, 0, &cache);
        // Fade-in over samples 0..4 → gain 0.0, 0.25, 0.5, 0.75; then 1.0
        // for the rest of the region.
        let expected = [0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 1.0];
        for (a, b) in out.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-6, "got {:?} expected {:?}", out, expected);
        }
    }

    #[test]
    fn fade_out_ramps_gain_to_zero() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 0,
            length_samples: 8,
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 4,
        };
        let cache = cache_with(1, vec![1.0; 8]);
        let mut out = vec![0.0f32; 8];
        region.render_into(&mut out, 0, &cache);
        // Last 4 samples ramp 1.0, 0.75, 0.5, 0.25 (positions 4..7
        // from start; fade_out triggers when pos_from_end < 4).
        let tail = &out[4..];
        let expected = [1.0, 0.75, 0.5, 0.25];
        for (a, b) in tail.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-6, "got {:?} expected {:?}", tail, expected);
        }
    }

    #[test]
    fn missing_asset_id_writes_nothing() {
        let region = AudioRegion {
            asset_id: 99,
            start_sample: 0,
            length_samples: 16,
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, vec![1.0; 16]);
        let mut out = vec![0.0f32; 16];
        region.render_into(&mut out, 0, &cache);
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn region_runs_past_asset_end_clamps_silently() {
        let region = AudioRegion {
            asset_id: 1,
            start_sample: 0,
            length_samples: 16, // longer than asset (8 frames)
            asset_offset_samples: 0,
            gain: 1.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        };
        let cache = cache_with(1, vec![0.5; 8]);
        let mut out = vec![0.0f32; 16];
        region.render_into(&mut out, 0, &cache);
        // First 8 samples carry PCM; samples 8..16 stay silent.
        for s in out[..8].iter() {
            assert!((s - 0.5).abs() < 1e-6);
        }
        for s in out[8..].iter() {
            assert!(*s == 0.0);
        }
    }
}
