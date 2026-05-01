use crate::plugin::Plugin;
use crate::snapshot::TrackKind;

pub const DEFAULT_VOICES: u32 = 16;

pub struct TrackEngine {
    pub instrument: Box<dyn Plugin>,
    pub kind: TrackKind,
    pub gain: f32,
    pub pan: f32, // -1.0 = full L, 0.0 = center, 1.0 = full R
    pub mute: bool,
    pub solo: bool,
    pub voices: u32,
    /// Decaying peak meter — updated each render. Reading is fine on
    /// any thread (single u32 bit-pattern under wasm32).
    pub peak: f32,
    scratch: Vec<f32>,
}

impl TrackEngine {
    pub fn new(instrument: Box<dyn Plugin>) -> Self {
        let voices = instrument.voice_count_hint().unwrap_or(DEFAULT_VOICES);
        Self {
            instrument,
            kind: TrackKind::Midi,
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            voices,
            peak: 0.0,
            scratch: Vec::new(),
        }
    }

    /// Render this track's contribution and add it into the stereo bus.
    /// Caller decides `silenced` (e.g. solo-disabled). Even when silenced,
    /// the instrument still ticks so internal transport stays in sync.
    pub fn render_into_stereo(&mut self, left: &mut [f32], right: &mut [f32], silenced: bool) {
        debug_assert_eq!(left.len(), right.len());
        let frames = left.len();
        if self.scratch.len() < frames {
            self.scratch.resize(frames, 0.0);
        }
        {
            let mono = &mut self.scratch[..frames];
            let mut outs: [&mut [f32]; 1] = [mono];
            self.instrument.process(&[], &mut outs, frames);
        }
        let mono = &self.scratch[..frames];
        // Peak meter — reflects what the user *hears* (post-gain,
        // post-mute/solo) so the UI matches their action.
        let mut block_peak = 0.0f32;
        let effective_gain = if silenced || self.mute { 0.0 } else { self.gain };
        for s in mono.iter() {
            let v = (s * effective_gain).abs();
            if v > block_peak {
                block_peak = v;
            }
        }
        // Smooth decay: ~10× per second of release. Block_peak wins on
        // attack; otherwise the meter falls.
        const DECAY: f32 = 0.85;
        if block_peak > self.peak {
            self.peak = block_peak;
        } else {
            self.peak = self.peak * DECAY + block_peak * (1.0 - DECAY);
        }

        if silenced || self.mute {
            return;
        }
        // Constant-power pan: theta in [0, π/2], cos(L) and sin(R).
        let theta = (self.pan.clamp(-1.0, 1.0) + 1.0) * core::f32::consts::FRAC_PI_4;
        let gl = self.gain * libm::cosf(theta);
        let gr = self.gain * libm::sinf(theta);
        for (i, s) in mono.iter().enumerate() {
            left[i] += s * gl;
            right[i] += s * gr;
        }
    }
}
