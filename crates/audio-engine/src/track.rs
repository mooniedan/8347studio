use crate::plugin::Plugin;
use crate::snapshot::TrackKind;

pub const DEFAULT_VOICES: u32 = 16;

pub struct InsertSlot {
    pub plugin: Box<dyn Plugin>,
    pub bypass: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Send {
    /// Index of the target track. The target should be a Bus and
    /// should sit later in the track list than the sender (the engine
    /// processes tracks in order; sends to earlier tracks are dropped).
    pub target_track: u32,
    pub level: f32,
    /// Pre/post fader. Phase-4 M2 always treats sends as post-fader
    /// (after gain/pan/mute/solo). Pre-fader is a polish item.
    pub pre_fader: bool,
}

pub struct TrackEngine {
    pub instrument: Box<dyn Plugin>,
    /// Insert FX chain. Processed in order, instrument → inserts[0] →
    /// inserts[1] → ... → mix bus. Bypassed slots are skipped.
    pub inserts: Vec<InsertSlot>,
    /// Sends to bus tracks. Read each block by the engine to mix
    /// (this track's mono × send.level) into the target's bus input.
    pub sends: Vec<Send>,
    pub kind: TrackKind,
    pub gain: f32,
    pub pan: f32, // -1.0 = full L, 0.0 = center, 1.0 = full R
    pub mute: bool,
    pub solo: bool,
    pub voices: u32,
    /// Decaying peak meter — updated each render. Reading is fine on
    /// any thread (single u32 bit-pattern under wasm32).
    pub peak: f32,
    pub scratch: Vec<f32>,
    /// Second mono scratch — ping-pong target for insert processing.
    pub scratch2: Vec<f32>,
}

impl TrackEngine {
    pub fn new(instrument: Box<dyn Plugin>) -> Self {
        let voices = instrument.voice_count_hint().unwrap_or(DEFAULT_VOICES);
        Self {
            instrument,
            inserts: Vec::new(),
            sends: Vec::new(),
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

    /// Compute the post-insert mono signal into self.scratch[..frames].
    /// For a non-bus track, the source is the instrument. For a bus,
    /// the source is the accumulated send sum the caller passes in.
    pub fn compute_mono(&mut self, frames: usize, bus_input: Option<&[f32]>) {
        if self.scratch.len() < frames {
            self.scratch.resize(frames, 0.0);
        }
        if self.scratch2.len() < frames {
            self.scratch2.resize(frames, 0.0);
        }
        // Source: bus_input if Some, else instrument output.
        if let Some(input) = bus_input {
            self.scratch[..frames].copy_from_slice(input);
        } else {
            let mut outs: [&mut [f32]; 1] = [&mut self.scratch[..frames]];
            self.instrument.process(&[], &mut outs, frames);
        }
        // Run inserts: copy scratch→scratch2 as input, write back to scratch.
        for slot in self.inserts.iter_mut() {
            if slot.bypass {
                continue;
            }
            self.scratch2[..frames].copy_from_slice(&self.scratch[..frames]);
            let in_arr: [&[f32]; 1] = [&self.scratch2[..frames]];
            let mut out_arr: [&mut [f32]; 1] = [&mut self.scratch[..frames]];
            slot.plugin.process(&in_arr, &mut out_arr, frames);
        }
    }

    /// Read the mono signal computed by compute_mono.
    pub fn mono_output(&self, frames: usize) -> &[f32] {
        &self.scratch[..frames]
    }

    /// Apply gain/pan and contribute to the stereo bus L/R. Updates
    /// the decaying peak meter as a side-effect (post-gain, post-mute/
    /// solo so the meter matches what the user hears).
    pub fn mix_to_master(&mut self, frames: usize, left: &mut [f32], right: &mut [f32], silenced: bool) {
        let mono = &self.scratch[..frames];
        let mut block_peak = 0.0f32;
        let effective_gain = if silenced || self.mute { 0.0 } else { self.gain };
        for s in mono.iter() {
            let v = (s * effective_gain).abs();
            if v > block_peak {
                block_peak = v;
            }
        }
        const DECAY: f32 = 0.85;
        if block_peak > self.peak {
            self.peak = block_peak;
        } else {
            self.peak = self.peak * DECAY + block_peak * (1.0 - DECAY);
        }
        if silenced || self.mute {
            return;
        }
        let theta = (self.pan.clamp(-1.0, 1.0) + 1.0) * core::f32::consts::FRAC_PI_4;
        let gl = self.gain * libm::cosf(theta);
        let gr = self.gain * libm::sinf(theta);
        for (i, s) in mono.iter().enumerate() {
            left[i] += s * gl;
            right[i] += s * gr;
        }
    }

    /// Convenience wrapper for tests: instrument → inserts → master.
    /// Production audio path uses compute_mono / mix_to_master in
    /// engine.rs so buses can splice their accumulated send sum in.
    pub fn render_into_stereo(&mut self, left: &mut [f32], right: &mut [f32], silenced: bool) {
        debug_assert_eq!(left.len(), right.len());
        let frames = left.len();
        self.compute_mono(frames, None);
        self.mix_to_master(frames, left, right, silenced);
    }
}
