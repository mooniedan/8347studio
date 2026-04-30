use crate::plugin::Plugin;

pub const DEFAULT_VOICES: u32 = 16;

pub struct TrackEngine {
    pub instrument: Box<dyn Plugin>,
    pub gain: f32,
    pub pan: f32, // -1.0 = full L, 0.0 = center, 1.0 = full R
    pub mute: bool,
    pub solo: bool,
    pub voices: u32,
    scratch: Vec<f32>,
}

impl TrackEngine {
    pub fn new(instrument: Box<dyn Plugin>) -> Self {
        let voices = instrument.voice_count_hint().unwrap_or(DEFAULT_VOICES);
        Self {
            instrument,
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            voices,
            scratch: Vec::new(),
        }
    }

    /// Render this track's contribution and add it into the stereo bus.
    /// Caller decides `silenced` (e.g. solo-disabled). Even when silenced,
    /// the instrument still ticks so internal transport stays in sync.
    pub fn render_into_stereo(&mut self, left: &mut [f32], right: &mut [f32], silenced: bool) {
        debug_assert_eq!(left.len(), right.len());
        if self.scratch.len() < left.len() {
            self.scratch.resize(left.len(), 0.0);
        }
        let mono = &mut self.scratch[..left.len()];
        self.instrument.process(mono);
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
