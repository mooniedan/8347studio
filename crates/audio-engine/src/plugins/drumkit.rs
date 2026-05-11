// Phase-8 M2 — first-party rudimentary drum machine.
//
// Five synthesized voices triggered by MIDI pitches in the General-MIDI
// drum-map subset:
//
//   C2 / 36  — Kick   (pitched sine with fast frequency-drop)
//   D2 / 38  — Snare  (noise + tonal body)
//   D#2 / 39 — Clap   (multi-burst noise)
//   F#2 / 42 — Closed Hat (high-passed noise, short release)
//   A#2 / 46 — Open Hat   (high-passed noise, long release)
//
// All DSP is single-voice-per-pitch (no voice stealing): every NoteOn
// retriggers that voice from the top of its envelope. Velocity scales
// the per-voice amp peak. NoteOff is ignored — drum hits are
// "one-shot," ending when the envelope finishes.
//
// Audio-thread contract per the trait: no allocations, no
// JS-touchable state, no locks. Vec sizes are fixed at construction.

use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

// ---------- General-MIDI drum-map pitches ----------------------------
pub const PITCH_KICK: u8 = 36;
pub const PITCH_SNARE: u8 = 38;
pub const PITCH_CLAP: u8 = 39;
pub const PITCH_CHAT: u8 = 42;
pub const PITCH_OHAT: u8 = 46;

// ---------- Stable parameter ids -------------------------------------
// Never reorder; the Y.Doc and snapshot wire format depend on the
// numeric values. Append new params at the end.
pub const PID_KICK_LEVEL: ParamId = 0;
pub const PID_KICK_TUNE: ParamId = 1; // ±12 semitones, centred at 50 Hz
pub const PID_KICK_DECAY: ParamId = 2; // seconds
pub const PID_SNARE_LEVEL: ParamId = 3;
pub const PID_SNARE_TUNE: ParamId = 4; // ±12 semitones, tonal body
pub const PID_SNARE_DECAY: ParamId = 5;
pub const PID_CLAP_LEVEL: ParamId = 6;
pub const PID_CLAP_DECAY: ParamId = 7;
pub const PID_CHAT_LEVEL: ParamId = 8;
pub const PID_CHAT_DECAY: ParamId = 9;
pub const PID_OHAT_LEVEL: ParamId = 10;
pub const PID_OHAT_DECAY: ParamId = 11;
pub const PID_GAIN: ParamId = 12;

const DESCRIPTORS: [ParamDescriptor; 13] = [
    p_level(PID_KICK_LEVEL, "Kick Level", "kick"),
    p_tune(PID_KICK_TUNE, "Kick Tune", "kick"),
    p_decay(PID_KICK_DECAY, "Kick Decay", 0.30, "kick"),
    p_level(PID_SNARE_LEVEL, "Snare Level", "snare"),
    p_tune(PID_SNARE_TUNE, "Snare Tune", "snare"),
    p_decay(PID_SNARE_DECAY, "Snare Decay", 0.18, "snare"),
    p_level(PID_CLAP_LEVEL, "Clap Level", "clap"),
    p_decay(PID_CLAP_DECAY, "Clap Decay", 0.20, "clap"),
    p_level(PID_CHAT_LEVEL, "Closed Hat Level", "hat"),
    p_decay(PID_CHAT_DECAY, "Closed Hat Decay", 0.05, "hat"),
    p_level(PID_OHAT_LEVEL, "Open Hat Level", "hat"),
    p_decay(PID_OHAT_DECAY, "Open Hat Decay", 0.30, "hat"),
    ParamDescriptor {
        id: PID_GAIN,
        name: "Master Gain",
        min: 0.0,
        max: 1.0,
        default: 0.8,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "master",
    },
];

const fn p_level(id: ParamId, name: &'static str, group: &'static str) -> ParamDescriptor {
    ParamDescriptor {
        id,
        name,
        min: 0.0,
        max: 1.0,
        default: 0.8,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group,
    }
}
const fn p_tune(id: ParamId, name: &'static str, group: &'static str) -> ParamDescriptor {
    ParamDescriptor {
        id,
        name,
        min: -12.0,
        max: 12.0,
        default: 0.0,
        unit: ParamUnit::Semitones,
        curve: ParamCurve::Linear,
        group,
    }
}
const fn p_decay(id: ParamId, name: &'static str, default: f32, group: &'static str) -> ParamDescriptor {
    ParamDescriptor {
        id,
        name,
        min: 0.01,
        max: 1.5,
        default,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Linear,
        group,
    }
}

// ---------- Voices ---------------------------------------------------
//
// Each voice carries its own phase / envelope counters in samples; all
// time-domain math runs against `sample_rate`. A voice is "idle" when
// its envelope position has passed its decay duration — `process`
// short-circuits idle voices to skip work.

struct KickVoice {
    sr: f32,
    pos: u32,    // samples since trigger
    velocity: f32,
    phase: f32,  // oscillator phase in radians
}

impl KickVoice {
    fn new(sr: f32) -> Self {
        Self { sr, pos: u32::MAX, velocity: 0.0, phase: 0.0 }
    }
    fn trigger(&mut self, velocity: f32) {
        self.pos = 0;
        self.velocity = velocity;
        self.phase = 0.0;
    }
    fn step(&mut self, base_hz: f32, decay_s: f32) -> f32 {
        let n = (decay_s * self.sr).max(1.0);
        let t = self.pos as f32 / n;
        if t >= 1.0 {
            self.pos = u32::MAX;
            return 0.0;
        }
        // Pitch envelope: start ~3× base, exp decay to base within ~30 ms.
        let pitch_t = (self.pos as f32 / (0.030 * self.sr)).min(1.0);
        let hz = base_hz * (3.0 - 2.0 * pitch_t);
        // Amp envelope: instant attack, exp decay across the voice's
        // total `decay_s` window.
        let amp = libm::expf(-3.5 * t) * self.velocity;
        let phase_inc = 2.0 * core::f32::consts::PI * hz / self.sr;
        self.phase += phase_inc;
        if self.phase > 2.0 * core::f32::consts::PI {
            self.phase -= 2.0 * core::f32::consts::PI;
        }
        // Brief click at attack so the kick has body even at low
        // gain (the click adds ~6 ms of broadband energy).
        let click = if self.pos < (0.003 * self.sr) as u32 { 0.5 } else { 0.0 };
        self.pos += 1;
        libm::sinf(self.phase) * amp + click * amp
    }
}

struct SnareVoice {
    sr: f32,
    pos: u32,
    velocity: f32,
    rng: u32,
    body_phase: f32,
}

impl SnareVoice {
    fn new(sr: f32) -> Self {
        Self { sr, pos: u32::MAX, velocity: 0.0, rng: 0xC0FFEE, body_phase: 0.0 }
    }
    fn trigger(&mut self, velocity: f32) {
        self.pos = 0;
        self.velocity = velocity;
        self.body_phase = 0.0;
    }
    fn step(&mut self, body_hz: f32, decay_s: f32) -> f32 {
        let n = (decay_s * self.sr).max(1.0);
        let t = self.pos as f32 / n;
        if t >= 1.0 {
            self.pos = u32::MAX;
            return 0.0;
        }
        // White noise via xorshift32.
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        let noise = ((self.rng as i32) as f32) / (i32::MAX as f32);

        // Body tone — faster decay than the noise.
        let body_amp = libm::expf(-12.0 * t);
        let body_inc = 2.0 * core::f32::consts::PI * body_hz / self.sr;
        self.body_phase += body_inc;
        if self.body_phase > 2.0 * core::f32::consts::PI {
            self.body_phase -= 2.0 * core::f32::consts::PI;
        }
        let body = libm::sinf(self.body_phase) * body_amp;

        let noise_amp = libm::expf(-4.5 * t);
        // 70% noise, 30% body — classic crack.
        let mix = noise * noise_amp * 0.7 + body * 0.3;
        self.pos += 1;
        mix * self.velocity
    }
}

struct ClapVoice {
    sr: f32,
    pos: u32,
    velocity: f32,
    rng: u32,
}

impl ClapVoice {
    fn new(sr: f32) -> Self {
        Self { sr, pos: u32::MAX, velocity: 0.0, rng: 0xABCDEF01 }
    }
    fn trigger(&mut self, velocity: f32) {
        self.pos = 0;
        self.velocity = velocity;
    }
    fn step(&mut self, decay_s: f32) -> f32 {
        let n = (decay_s * self.sr).max(1.0);
        let t = self.pos as f32 / n;
        if t >= 1.0 {
            self.pos = u32::MAX;
            return 0.0;
        }
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        let noise = ((self.rng as i32) as f32) / (i32::MAX as f32);

        // Three short bursts at 0 / 10 / 20 ms, then a longer tail
        // from 30 ms onward — gives the "ch-ch-CHHH" clap profile.
        let ms = self.pos as f32 / self.sr * 1000.0;
        let burst_env = if ms < 6.0 {
            0.8
        } else if (10.0..16.0).contains(&ms) {
            0.8
        } else if (20.0..26.0).contains(&ms) {
            0.8
        } else {
            libm::expf(-6.0 * t) * 0.6
        };
        self.pos += 1;
        noise * burst_env * self.velocity
    }
}

struct HatVoice {
    sr: f32,
    pos: u32,
    velocity: f32,
    rng: u32,
    // Simple one-pole high-pass running state.
    hp_prev_in: f32,
    hp_prev_out: f32,
}

impl HatVoice {
    fn new(sr: f32, rng_seed: u32) -> Self {
        Self {
            sr,
            pos: u32::MAX,
            velocity: 0.0,
            rng: rng_seed,
            hp_prev_in: 0.0,
            hp_prev_out: 0.0,
        }
    }
    fn trigger(&mut self, velocity: f32) {
        self.pos = 0;
        self.velocity = velocity;
        self.hp_prev_in = 0.0;
        self.hp_prev_out = 0.0;
    }
    fn step(&mut self, decay_s: f32) -> f32 {
        let n = (decay_s * self.sr).max(1.0);
        let t = self.pos as f32 / n;
        if t >= 1.0 {
            self.pos = u32::MAX;
            return 0.0;
        }
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        let raw = ((self.rng as i32) as f32) / (i32::MAX as f32);

        // First-order high-pass at ~7 kHz so the hat isn't tubby.
        // alpha ≈ RC / (RC + dt) for RC = 1 / (2π f_c).
        let f_c = 7000.0;
        let dt = 1.0 / self.sr;
        let rc = 1.0 / (2.0 * core::f32::consts::PI * f_c);
        let alpha = rc / (rc + dt);
        let hp = alpha * (self.hp_prev_out + raw - self.hp_prev_in);
        self.hp_prev_in = raw;
        self.hp_prev_out = hp;

        let amp = libm::expf(-3.0 * t) * self.velocity;
        self.pos += 1;
        hp * amp
    }
}

// ---------- Plugin ---------------------------------------------------

pub struct Drumkit {
    /// Carried for parity with the other plugin constructors — voices
    /// own their own sample-rate state, so the struct itself only needs
    /// it for debug / future param remapping.
    #[allow(dead_code)]
    sr: f32,

    // Per-voice params.
    kick_level: f32,
    kick_tune: f32, // semitones offset from 50 Hz base
    kick_decay: f32,
    snare_level: f32,
    snare_tune: f32, // semitones offset from 200 Hz body
    snare_decay: f32,
    clap_level: f32,
    clap_decay: f32,
    chat_level: f32,
    chat_decay: f32,
    ohat_level: f32,
    ohat_decay: f32,
    gain: f32,

    kick: KickVoice,
    snare: SnareVoice,
    clap: ClapVoice,
    chat: HatVoice,
    ohat: HatVoice,
}

impl Drumkit {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sr: sample_rate,
            kick_level: 0.8,
            kick_tune: 0.0,
            kick_decay: 0.30,
            snare_level: 0.8,
            snare_tune: 0.0,
            snare_decay: 0.18,
            clap_level: 0.8,
            clap_decay: 0.20,
            chat_level: 0.8,
            chat_decay: 0.05,
            ohat_level: 0.8,
            ohat_decay: 0.30,
            gain: 0.8,
            kick: KickVoice::new(sample_rate),
            snare: SnareVoice::new(sample_rate),
            clap: ClapVoice::new(sample_rate),
            chat: HatVoice::new(sample_rate, 0x1234_5678),
            ohat: HatVoice::new(sample_rate, 0x9876_5432),
        }
    }

    fn note_on(&mut self, pitch: u8, velocity: u8) {
        let vel = (velocity as f32 / 127.0).clamp(0.0, 1.0);
        match pitch {
            PITCH_KICK => self.kick.trigger(vel),
            PITCH_SNARE => self.snare.trigger(vel),
            PITCH_CLAP => self.clap.trigger(vel),
            PITCH_CHAT => {
                // Closed hat chokes the open hat (classic TR behaviour).
                self.ohat.pos = u32::MAX;
                self.chat.trigger(vel);
            }
            PITCH_OHAT => self.ohat.trigger(vel),
            _ => {}
        }
    }
}

fn semitones_to_ratio(semis: f32) -> f32 {
    libm::powf(2.0_f32, semis / 12.0)
}

impl Plugin for Drumkit {
    fn descriptors(&self) -> &[ParamDescriptor] {
        &DESCRIPTORS
    }

    fn kind(&self) -> PluginKind {
        PluginKind::Instrument
    }

    fn set_param(&mut self, id: ParamId, value: f32) {
        match id {
            PID_KICK_LEVEL => self.kick_level = value.clamp(0.0, 1.0),
            PID_KICK_TUNE => self.kick_tune = value.clamp(-12.0, 12.0),
            PID_KICK_DECAY => self.kick_decay = value.clamp(0.01, 1.5),
            PID_SNARE_LEVEL => self.snare_level = value.clamp(0.0, 1.0),
            PID_SNARE_TUNE => self.snare_tune = value.clamp(-12.0, 12.0),
            PID_SNARE_DECAY => self.snare_decay = value.clamp(0.01, 1.5),
            PID_CLAP_LEVEL => self.clap_level = value.clamp(0.0, 1.0),
            PID_CLAP_DECAY => self.clap_decay = value.clamp(0.01, 1.5),
            PID_CHAT_LEVEL => self.chat_level = value.clamp(0.0, 1.0),
            PID_CHAT_DECAY => self.chat_decay = value.clamp(0.01, 1.5),
            PID_OHAT_LEVEL => self.ohat_level = value.clamp(0.0, 1.0),
            PID_OHAT_DECAY => self.ohat_decay = value.clamp(0.01, 1.5),
            PID_GAIN => self.gain = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        Some(match id {
            PID_KICK_LEVEL => self.kick_level,
            PID_KICK_TUNE => self.kick_tune,
            PID_KICK_DECAY => self.kick_decay,
            PID_SNARE_LEVEL => self.snare_level,
            PID_SNARE_TUNE => self.snare_tune,
            PID_SNARE_DECAY => self.snare_decay,
            PID_CLAP_LEVEL => self.clap_level,
            PID_CLAP_DECAY => self.clap_decay,
            PID_CHAT_LEVEL => self.chat_level,
            PID_CHAT_DECAY => self.chat_decay,
            PID_OHAT_LEVEL => self.ohat_level,
            PID_OHAT_DECAY => self.ohat_decay,
            PID_GAIN => self.gain,
            _ => return None,
        })
    }

    fn handle_event(&mut self, ev: PluginEvent) {
        match ev {
            PluginEvent::NoteOn { pitch, velocity } => self.note_on(pitch, velocity),
            // Drum hits are one-shots — NoteOff is ignored.
            PluginEvent::NoteOff { .. } => {}
            PluginEvent::AllNotesOff => {
                self.kick.pos = u32::MAX;
                self.snare.pos = u32::MAX;
                self.clap.pos = u32::MAX;
                self.chat.pos = u32::MAX;
                self.ohat.pos = u32::MAX;
            }
            PluginEvent::MidiCc { .. } => {}
        }
    }

    fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let kick_hz = 50.0 * semitones_to_ratio(self.kick_tune);
        let snare_body_hz = 200.0 * semitones_to_ratio(self.snare_tune);

        for i in 0..frames {
            let mut s = 0.0;
            s += self.kick.step(kick_hz, self.kick_decay) * self.kick_level;
            s += self.snare.step(snare_body_hz, self.snare_decay) * self.snare_level;
            s += self.clap.step(self.clap_decay) * self.clap_level;
            s += self.chat.step(self.chat_decay) * self.chat_level;
            s += self.ohat.step(self.ohat_decay) * self.ohat_level;
            s *= self.gain;
            for ch in outputs.iter_mut() {
                ch[i] = s;
            }
        }
    }

    fn reset(&mut self) {
        self.kick.pos = u32::MAX;
        self.snare.pos = u32::MAX;
        self.clap.pos = u32::MAX;
        self.chat.pos = u32::MAX;
        self.ohat.pos = u32::MAX;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peak_after_note(pitch: u8, frames: usize) -> f32 {
        let mut k = Drumkit::new(48_000.0);
        k.handle_event(PluginEvent::NoteOn { pitch, velocity: 100 });
        let mut buf = alloc::vec![0.0f32; frames];
        let mut outs: [&mut [f32]; 1] = [&mut buf];
        k.process(&[], &mut outs, frames);
        let mut peak = 0.0f32;
        for s in &buf {
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        peak
    }

    #[test]
    fn descriptors_list_thirteen_params() {
        let k = Drumkit::new(48_000.0);
        assert_eq!(k.descriptors().len(), 13);
    }

    #[test]
    fn kick_produces_audible_output() {
        assert!(peak_after_note(PITCH_KICK, 4800) > 0.1);
    }

    #[test]
    fn snare_produces_audible_output() {
        assert!(peak_after_note(PITCH_SNARE, 4800) > 0.05);
    }

    #[test]
    fn clap_produces_audible_output() {
        assert!(peak_after_note(PITCH_CLAP, 4800) > 0.05);
    }

    #[test]
    fn closed_hat_produces_audible_output() {
        assert!(peak_after_note(PITCH_CHAT, 4800) > 0.01);
    }

    #[test]
    fn open_hat_produces_audible_output() {
        assert!(peak_after_note(PITCH_OHAT, 4800) > 0.01);
    }

    #[test]
    fn unmapped_pitch_is_silent() {
        // Pitch 60 (middle C) is not in the drum map.
        assert_eq!(peak_after_note(60, 4800), 0.0);
    }

    #[test]
    fn closed_hat_chokes_open_hat() {
        let mut k = Drumkit::new(48_000.0);
        // Trigger open hat, let it ring briefly, then close.
        k.handle_event(PluginEvent::NoteOn { pitch: PITCH_OHAT, velocity: 100 });
        let mut buf = alloc::vec![0.0f32; 240]; // ~5 ms @ 48 kHz
        let mut outs: [&mut [f32]; 1] = [&mut buf];
        k.process(&[], &mut outs, 240);
        // Now close — choke the open hat.
        k.handle_event(PluginEvent::NoteOn { pitch: PITCH_CHAT, velocity: 100 });
        // After the closed-hat envelope ends (~60 ms × 4 = well past
        // chat_decay default 0.05 s), there should be silence.
        let mut tail = alloc::vec![0.0f32; 9600]; // 200 ms @ 48 kHz
        let mut outs2: [&mut [f32]; 1] = [&mut tail];
        k.process(&[], &mut outs2, 9600);
        let tail_peak = tail[tail.len() - 200..]
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(tail_peak < 0.001, "expected silence after choke, got {}", tail_peak);
    }

    #[test]
    fn note_off_does_not_silence_a_drum_hit() {
        let mut k = Drumkit::new(48_000.0);
        k.handle_event(PluginEvent::NoteOn { pitch: PITCH_KICK, velocity: 127 });
        k.handle_event(PluginEvent::NoteOff { pitch: PITCH_KICK });
        let mut buf = alloc::vec![0.0f32; 480];
        let mut outs: [&mut [f32]; 1] = [&mut buf];
        k.process(&[], &mut outs, 480);
        let peak = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.1);
    }

    #[test]
    fn set_param_round_trips_via_get_param() {
        let mut k = Drumkit::new(48_000.0);
        k.set_param(PID_KICK_TUNE, 7.0);
        assert!((k.get_param(PID_KICK_TUNE).unwrap() - 7.0).abs() < 1e-6);
        k.set_param(PID_SNARE_DECAY, 0.5);
        assert!((k.get_param(PID_SNARE_DECAY).unwrap() - 0.5).abs() < 1e-6);
        k.set_param(PID_GAIN, 0.5);
        assert!((k.get_param(PID_GAIN).unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn level_param_attenuates_voice() {
        let mut k = Drumkit::new(48_000.0);
        k.set_param(PID_KICK_LEVEL, 0.0);
        k.handle_event(PluginEvent::NoteOn { pitch: PITCH_KICK, velocity: 127 });
        let mut buf = alloc::vec![0.0f32; 4800];
        let mut outs: [&mut [f32]; 1] = [&mut buf];
        k.process(&[], &mut outs, 4800);
        let peak = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak < 0.001, "kick should be silenced at level=0, got {}", peak);
    }

    #[test]
    fn reset_silences_all_voices() {
        let mut k = Drumkit::new(48_000.0);
        for &p in &[PITCH_KICK, PITCH_SNARE, PITCH_CLAP, PITCH_CHAT, PITCH_OHAT] {
            k.handle_event(PluginEvent::NoteOn { pitch: p, velocity: 100 });
        }
        k.reset();
        let mut buf = alloc::vec![0.0f32; 4800];
        let mut outs: [&mut [f32]; 1] = [&mut buf];
        k.process(&[], &mut outs, 4800);
        let peak = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert_eq!(peak, 0.0);
    }
}
