// Musical-time accounting for the engine.
//
// Phase 1 only ever stores a single segment (constant tempo); the data
// shape is the multi-segment one the dream specifies so multi-segment
// tempo automation in Phase 4 doesn't need a reshuffle. ppq is fixed at
// 960 to match `dream.md` and `lib/project.ts`.

use alloc::vec;
use alloc::vec::Vec;

pub const PPQ: u32 = 960;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TempoSegment {
    pub tick: u64,
    pub bpm: f32,
    pub num: u8,
    pub den: u8,
}

pub struct TempoMap {
    pub segments: Vec<TempoSegment>,
    pub sample_rate: f32,
    pub ppq: u32,
}

impl TempoMap {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            segments: vec![TempoSegment {
                tick: 0,
                bpm: 120.0,
                num: 4,
                den: 4,
            }],
            sample_rate,
            ppq: PPQ,
        }
    }

    pub fn set_bpm(&mut self, bpm: f32) {
        if let Some(seg) = self.segments.first_mut() {
            seg.bpm = bpm.clamp(20.0, 300.0);
        }
    }

    pub fn bpm_at(&self, tick: u64) -> f32 {
        // Single-segment Phase 1: always the first segment's bpm. Phase 4
        // walks the segments to find the active one.
        let mut active = &self.segments[0];
        for seg in self.segments.iter() {
            if seg.tick <= tick {
                active = seg;
            } else {
                break;
            }
        }
        active.bpm
    }

    /// Number of ticks elapsed across `samples` audio frames at the given
    /// tick position. Returned as f64 so callers can accumulate fractional
    /// remainders without drift.
    pub fn ticks_for_samples(&self, samples: usize, at_tick: u64) -> f64 {
        let bpm = self.bpm_at(at_tick) as f64;
        // ticks_per_sample = ppq * bpm / (sr * 60)
        let tps = self.ppq as f64 * bpm / (self.sample_rate as f64 * 60.0);
        tps * samples as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_for_samples_matches_120bpm_48k() {
        // 1 beat at 120 BPM = 0.5 s = 24,000 samples at 48k.
        // 1 beat = 960 ticks.
        let tm = TempoMap::new(48_000.0);
        let ticks = tm.ticks_for_samples(24_000, 0);
        assert!((ticks - 960.0).abs() < 1e-3, "got {}", ticks);
    }

    #[test]
    fn set_bpm_clamps_into_range() {
        let mut tm = TempoMap::new(48_000.0);
        tm.set_bpm(5.0);
        assert!((tm.bpm_at(0) - 20.0).abs() < 1e-6);
        tm.set_bpm(900.0);
        assert!((tm.bpm_at(0) - 300.0).abs() < 1e-6);
    }

    #[test]
    fn higher_bpm_means_more_ticks_per_sample() {
        let mut tm = TempoMap::new(48_000.0);
        let slow = tm.ticks_for_samples(1_000, 0);
        tm.set_bpm(240.0);
        let fast = tm.ticks_for_samples(1_000, 0);
        assert!((fast - 2.0 * slow).abs() < 1e-3, "slow={slow} fast={fast}");
    }
}
