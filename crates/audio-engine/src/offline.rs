//! Phase-10 M7d — offline (faster-than-realtime) render.
//!
//! Drives an already-built [`Engine`] from its current transport
//! position until it reaches `end_tick`, returning interleaved stereo
//! PCM (`L, R, L, R …`). The render-to-audio Web Worker calls this
//! through the wasm-bridge `offline_render` export.
//!
//! Rendering by *target tick* rather than a sample count lets the
//! engine own the tempo → sample math, so the JS side only needs to
//! know where the project ends in ticks — never the sample rate's
//! interaction with BPM.

use crate::engine::Engine;
use alloc::vec::Vec;

/// Block size mirrors the realtime path so per-block behaviour (note
/// onsets, automation steps) lands identically offline.
const BLOCK: usize = 128;

/// Render from the engine's current position until `current_tick`
/// reaches `end_tick`, capped at `max_frames` stereo frames as a
/// runaway guard. Returns interleaved stereo PCM (length = frames*2).
pub fn render_until_tick(engine: &mut Engine, end_tick: f64, max_frames: usize) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::new();
    engine.set_playing(true);
    let mut left = [0.0f32; BLOCK];
    let mut right = [0.0f32; BLOCK];
    while (engine.current_tick() as f64) < end_tick && out.len() / 2 < max_frames {
        left = [0.0; BLOCK];
        right = [0.0; BLOCK];
        engine.process_stereo(&mut left, &mut right);
        let take = BLOCK.min(max_frames - out.len() / 2);
        for i in 0..take {
            out.push(left[i]);
            out.push(right[i]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::Plugin;
    use crate::track::TrackEngine;
    use alloc::boxed::Box;

    /// Minimal always-on source so we can assert the render path sums
    /// real audio (independent of the synth/sequencer fixtures).
    struct ConstSource {
        value: f32,
    }
    impl Plugin for ConstSource {
        fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
            if let Some(ch) = outputs.get_mut(0) {
                for s in ch[..frames].iter_mut() {
                    *s = self.value;
                }
            }
        }
        fn set_playing(&mut self, _on: bool) {}
        fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
            self
        }
        fn as_any(&self) -> &dyn core::any::Any {
            self
        }
    }

    #[test]
    fn empty_engine_renders_silence_for_the_requested_span() {
        let mut e = Engine::new(48_000.0);
        // 120 bpm default → 1 beat (960 ticks) = 0.5 s = 24_000 frames.
        let pcm = render_until_tick(&mut e, 960.0, 1_000_000);
        let frames = pcm.len() / 2;
        assert!(
            (frames as i64 - 24_000).abs() <= BLOCK as i64,
            "frames={frames}"
        );
        assert!(pcm.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn renders_non_silent_interleaved_stereo_from_a_sounding_track() {
        let mut e = Engine::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(ConstSource { value: 0.5 })));
        let pcm = render_until_tick(&mut e, 480.0, 1_000_000);
        assert_eq!(pcm.len() % 2, 0, "interleaved stereo must be even-length");
        assert!(pcm.iter().any(|s| s.abs() > 0.1), "expected non-silent output");
    }

    #[test]
    fn respects_the_max_frames_cap() {
        let mut e = Engine::new(48_000.0);
        let pcm = render_until_tick(&mut e, 1.0e9, 500);
        assert_eq!(pcm.len(), 1000); // 500 frames × 2 channels
    }
}
