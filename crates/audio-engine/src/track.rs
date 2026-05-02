use crate::plugin::Plugin;
use crate::snapshot::TrackKind;

pub const DEFAULT_VOICES: u32 = 16;

pub struct InsertSlot {
    pub plugin: Box<dyn Plugin>,
    pub bypass: bool,
}

pub struct TrackEngine {
    pub instrument: Box<dyn Plugin>,
    /// Insert FX chain. Processed in order, instrument → inserts[0] →
    /// inserts[1] → ... → mix bus. Bypassed slots are skipped.
    pub inserts: Vec<InsertSlot>,
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
    /// Second mono scratch — ping-pong target for insert processing.
    scratch2: Vec<f32>,
}

impl TrackEngine {
    pub fn new(instrument: Box<dyn Plugin>) -> Self {
        let voices = instrument.voice_count_hint().unwrap_or(DEFAULT_VOICES);
        Self {
            instrument,
            inserts: Vec::new(),
            kind: TrackKind::Midi,
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            voices,
            peak: 0.0,
            scratch: Vec::new(),
            scratch2: Vec::new(),
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
        if self.scratch2.len() < frames {
            self.scratch2.resize(frames, 0.0);
        }
        // 1. Instrument writes into scratch.
        {
            let mono = &mut self.scratch[..frames];
            let mut outs: [&mut [f32]; 1] = [mono];
            self.instrument.process(&[], &mut outs, frames);
        }
        // 2. Run each non-bypassed insert in order, ping-ponging
        //    between scratch (current) and scratch2 (next). After the
        //    loop, `output_in_scratch` says where the final mono
        //    signal lives.
        let mut output_in_scratch = true;
        for slot in self.inserts.iter_mut() {
            if slot.bypass {
                continue;
            }
            if output_in_scratch {
                let input = &self.scratch[..frames];
                let output = &mut self.scratch2[..frames];
                let in_arr: [&[f32]; 1] = [input];
                let mut out_arr: [&mut [f32]; 1] = [output];
                slot.plugin.process(&in_arr, &mut out_arr, frames);
            } else {
                let input = &self.scratch2[..frames];
                let output = &mut self.scratch[..frames];
                let in_arr: [&[f32]; 1] = [input];
                let mut out_arr: [&mut [f32]; 1] = [output];
                slot.plugin.process(&in_arr, &mut out_arr, frames);
            }
            output_in_scratch = !output_in_scratch;
        }
        let mono: &[f32] = if output_in_scratch {
            &self.scratch[..frames]
        } else {
            &self.scratch2[..frames]
        };
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
