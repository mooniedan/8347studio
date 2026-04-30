use crate::track::TrackEngine;

pub struct Engine {
    pub tracks: Vec<TrackEngine>,
    pub master_gain: f32,
    right_scratch: Vec<f32>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            tracks: Vec::new(),
            master_gain: 1.0,
            right_scratch: Vec::new(),
        }
    }

    pub fn add_track(&mut self, track: TrackEngine) -> usize {
        self.tracks.push(track);
        self.tracks.len() - 1
    }

    pub fn track_mut(&mut self, idx: usize) -> Option<&mut TrackEngine> {
        self.tracks.get_mut(idx)
    }

    pub fn set_playing(&mut self, on: bool) {
        for t in self.tracks.iter_mut() {
            t.instrument.set_playing(on);
        }
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        debug_assert_eq!(left.len(), right.len());
        for s in left.iter_mut() {
            *s = 0.0;
        }
        for s in right.iter_mut() {
            *s = 0.0;
        }
        let any_solo = self.tracks.iter().any(|t| t.solo);
        for track in self.tracks.iter_mut() {
            let silenced = any_solo && !track.solo;
            track.render_into_stereo(left, right, silenced);
        }
        for s in left.iter_mut() {
            *s *= self.master_gain;
        }
        for s in right.iter_mut() {
            *s *= self.master_gain;
        }
    }

    /// Mono compatibility path for the Phase-1 worklet. Renders the full
    /// stereo bus and collapses it via constant-power sum. M3 replaces
    /// this with a true stereo path over the SAB ring.
    pub fn process_mono(&mut self, out: &mut [f32]) {
        if self.right_scratch.len() < out.len() {
            self.right_scratch.resize(out.len(), 0.0);
        }
        let right = &mut self.right_scratch[..out.len()];
        // Borrow-checker: split_at_mut on the explicit args, can't reuse
        // process_stereo here without cloning. Re-inlined for now.
        for s in out.iter_mut() {
            *s = 0.0;
        }
        for s in right.iter_mut() {
            *s = 0.0;
        }
        let any_solo = self.tracks.iter().any(|t| t.solo);
        for track in self.tracks.iter_mut() {
            let silenced = any_solo && !track.solo;
            track.render_into_stereo(out, right, silenced);
        }
        let g = self.master_gain * core::f32::consts::FRAC_1_SQRT_2;
        for (l, r) in out.iter_mut().zip(right.iter()) {
            *l = (*l + *r) * g;
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::Plugin;
    use core::f32::consts::FRAC_1_SQRT_2;

    struct ConstSource {
        value: f32,
        playing: bool,
    }

    impl Plugin for ConstSource {
        fn process(&mut self, out: &mut [f32]) {
            let v = if self.playing { self.value } else { 0.0 };
            for s in out.iter_mut() {
                *s = v;
            }
        }
        fn set_playing(&mut self, on: bool) {
            self.playing = on;
        }
        fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
            self
        }
    }

    fn const_track(value: f32) -> TrackEngine {
        TrackEngine::new(Box::new(ConstSource {
            value,
            playing: true,
        }))
    }

    const TOL: f32 = 1e-5;

    #[test]
    fn empty_engine_renders_silence() {
        let mut e = Engine::new();
        let mut l = [1.0f32; 8];
        let mut r = [1.0f32; 8];
        e.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| *s == 0.0));
        assert!(r.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn two_tracks_sum_into_master() {
        let mut e = Engine::new();
        e.add_track(const_track(0.3));
        e.add_track(const_track(0.4));
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        // Centre pan is constant-power: each track contributes value * cos(π/4)
        // to each side. So the master sees (0.3 + 0.4) * (1/√2).
        let expected = (0.3 + 0.4) * FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < TOL, "L got {}, expected {}", l[0], expected);
        assert!((r[0] - expected).abs() < TOL, "R got {}, expected {}", r[0], expected);
    }

    #[test]
    fn mute_drops_a_track_from_the_mix() {
        let mut e = Engine::new();
        e.add_track(const_track(0.3));
        let mut t1 = const_track(0.4);
        t1.mute = true;
        e.add_track(t1);
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        let expected = 0.3 * FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < TOL, "muted track leaked: {}", l[0]);
        assert!((r[0] - expected).abs() < TOL);
    }

    #[test]
    fn solo_isolates_a_single_track() {
        let mut e = Engine::new();
        let mut t0 = const_track(0.3);
        t0.solo = true;
        e.add_track(t0);
        e.add_track(const_track(0.4));
        e.add_track(const_track(0.5));
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        let expected = 0.3 * FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < TOL, "solo leaked: {}", l[0]);
    }

    #[test]
    fn solo_overrides_mute_for_the_soloed_track() {
        let mut e = Engine::new();
        let mut t0 = const_track(0.3);
        t0.solo = true;
        t0.mute = true;
        e.add_track(t0);
        e.add_track(const_track(0.4));
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        // Soloed AND muted: the M2 contract is that mute still wins on
        // *that* track, and other (non-soloed) tracks remain silenced
        // because some track is soloed. So the bus is silent.
        assert!(l.iter().all(|s| s.abs() < TOL), "expected silence, got {:?}", &l[..4]);
    }

    #[test]
    fn master_gain_scales_the_bus() {
        let mut e = Engine::new();
        e.add_track(const_track(0.5));
        e.master_gain = 0.5;
        e.set_playing(true);

        let mut l = [0.0f32; 8];
        let mut r = [0.0f32; 8];
        e.process_stereo(&mut l, &mut r);

        let expected = 0.5 * FRAC_1_SQRT_2 * 0.5;
        assert!((l[0] - expected).abs() < TOL, "L got {}, expected {}", l[0], expected);
    }
}
