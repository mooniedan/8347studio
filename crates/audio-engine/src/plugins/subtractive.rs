// First-party subtractive synth.
//
// Voice = 2 oscillators → mix → state-variable filter → amp envelope.
// Filter envelope modulates the cutoff in octaves. Polyphony via a Vec
// of voices; oldest-voice stealing when the pool is exhausted.

use alloc::vec::Vec;
use core::any::Any;

use crate::oscillator::{Oscillator, Waveform};
use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

pub const MAX_VOICES: usize = 128;
pub const DEFAULT_VOICES: usize = 16;

// Stable parameter ids — never reorder; UI and Y.Doc bindings rely on
// these values. Append new params at the end.
pub const PID_OSC_A_WAVE: ParamId = 0;
pub const PID_OSC_A_DETUNE: ParamId = 1;
pub const PID_OSC_B_WAVE: ParamId = 2;
pub const PID_OSC_B_DETUNE: ParamId = 3;
pub const PID_OSC_MIX: ParamId = 4;
pub const PID_FILTER_TYPE: ParamId = 5;
pub const PID_FILTER_CUTOFF: ParamId = 6;
pub const PID_FILTER_RES: ParamId = 7;
pub const PID_FILTER_ENV_AMT: ParamId = 8;
pub const PID_AMP_A: ParamId = 9;
pub const PID_AMP_D: ParamId = 10;
pub const PID_AMP_S: ParamId = 11;
pub const PID_AMP_R: ParamId = 12;
pub const PID_FILT_A: ParamId = 13;
pub const PID_FILT_D: ParamId = 14;
pub const PID_FILT_S: ParamId = 15;
pub const PID_FILT_R: ParamId = 16;
pub const PID_GAIN: ParamId = 17;

const DESCRIPTORS: [ParamDescriptor; 18] = [
    ParamDescriptor {
        id: PID_OSC_A_WAVE,
        name: "Osc A Wave",
        min: 0.0,
        max: 2.0,
        default: 0.0,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "osc",
    },
    ParamDescriptor {
        id: PID_OSC_A_DETUNE,
        name: "Osc A Detune",
        min: -100.0,
        max: 100.0,
        default: 0.0,
        unit: ParamUnit::Cents,
        curve: ParamCurve::Linear,
        group: "osc",
    },
    ParamDescriptor {
        id: PID_OSC_B_WAVE,
        name: "Osc B Wave",
        min: 0.0,
        max: 2.0,
        default: 1.0,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "osc",
    },
    ParamDescriptor {
        id: PID_OSC_B_DETUNE,
        name: "Osc B Detune",
        min: -100.0,
        max: 100.0,
        default: 7.0,
        unit: ParamUnit::Cents,
        curve: ParamCurve::Linear,
        group: "osc",
    },
    ParamDescriptor {
        id: PID_OSC_MIX,
        name: "Osc Mix",
        min: 0.0,
        max: 1.0,
        default: 0.5,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "osc",
    },
    ParamDescriptor {
        id: PID_FILTER_TYPE,
        name: "Filter Type",
        min: 0.0,
        max: 2.0,
        default: 0.0,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "filter",
    },
    ParamDescriptor {
        id: PID_FILTER_CUTOFF,
        name: "Cutoff",
        min: 20.0,
        max: 20000.0,
        default: 2000.0,
        unit: ParamUnit::Hz,
        curve: ParamCurve::Exp,
        group: "filter",
    },
    ParamDescriptor {
        id: PID_FILTER_RES,
        name: "Resonance",
        min: 0.0,
        max: 1.0,
        default: 0.0,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "filter",
    },
    ParamDescriptor {
        id: PID_FILTER_ENV_AMT,
        name: "Env Amount",
        min: -4.0,
        max: 4.0,
        default: 0.0,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "filter",
    },
    ParamDescriptor {
        id: PID_AMP_A,
        name: "Amp Attack",
        min: 0.001,
        max: 5.0,
        default: 0.005,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Exp,
        group: "amp",
    },
    ParamDescriptor {
        id: PID_AMP_D,
        name: "Amp Decay",
        min: 0.001,
        max: 5.0,
        default: 0.1,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Exp,
        group: "amp",
    },
    ParamDescriptor {
        id: PID_AMP_S,
        name: "Amp Sustain",
        min: 0.0,
        max: 1.0,
        default: 0.7,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "amp",
    },
    ParamDescriptor {
        id: PID_AMP_R,
        name: "Amp Release",
        min: 0.001,
        max: 5.0,
        default: 0.2,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Exp,
        group: "amp",
    },
    ParamDescriptor {
        id: PID_FILT_A,
        name: "Filter Attack",
        min: 0.001,
        max: 5.0,
        default: 0.005,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Exp,
        group: "filter_env",
    },
    ParamDescriptor {
        id: PID_FILT_D,
        name: "Filter Decay",
        min: 0.001,
        max: 5.0,
        default: 0.2,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Exp,
        group: "filter_env",
    },
    ParamDescriptor {
        id: PID_FILT_S,
        name: "Filter Sustain",
        min: 0.0,
        max: 1.0,
        default: 0.5,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "filter_env",
    },
    ParamDescriptor {
        id: PID_FILT_R,
        name: "Filter Release",
        min: 0.001,
        max: 5.0,
        default: 0.3,
        unit: ParamUnit::Seconds,
        curve: ParamCurve::Exp,
        group: "filter_env",
    },
    ParamDescriptor {
        id: PID_GAIN,
        name: "Gain",
        min: 0.0,
        max: 1.0,
        default: 0.5,
        unit: ParamUnit::None,
        curve: ParamCurve::Linear,
        group: "amp",
    },
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum AdsrPhase {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

struct Adsr {
    sample_rate: f32,
    attack_s: f32,
    decay_s: f32,
    sustain: f32,
    release_s: f32,
    phase: AdsrPhase,
    pos: f32,
    level: f32,
    release_from: f32,
}

impl Adsr {
    fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            attack_s: 0.005,
            decay_s: 0.1,
            sustain: 0.7,
            release_s: 0.2,
            phase: AdsrPhase::Idle,
            pos: 0.0,
            level: 0.0,
            release_from: 0.0,
        }
    }

    fn trigger(&mut self) {
        self.phase = AdsrPhase::Attack;
        self.pos = 0.0;
    }

    fn release(&mut self) {
        if self.phase == AdsrPhase::Idle {
            return;
        }
        self.release_from = self.level;
        self.phase = AdsrPhase::Release;
        self.pos = 0.0;
    }

    fn is_idle(&self) -> bool {
        self.phase == AdsrPhase::Idle
    }

    fn is_held(&self) -> bool {
        matches!(
            self.phase,
            AdsrPhase::Attack | AdsrPhase::Decay | AdsrPhase::Sustain
        )
    }

    fn next(&mut self) -> f32 {
        let sr = self.sample_rate;
        match self.phase {
            AdsrPhase::Idle => self.level = 0.0,
            AdsrPhase::Attack => {
                let n = (self.attack_s * sr).max(1.0);
                self.level = self.pos / n;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.phase = AdsrPhase::Decay;
                    self.pos = 0.0;
                } else {
                    self.pos += 1.0;
                }
            }
            AdsrPhase::Decay => {
                let n = (self.decay_s * sr).max(1.0);
                let t = self.pos / n;
                self.level = 1.0 + (self.sustain - 1.0) * t;
                if t >= 1.0 {
                    self.level = self.sustain;
                    self.phase = AdsrPhase::Sustain;
                    self.pos = 0.0;
                } else {
                    self.pos += 1.0;
                }
            }
            AdsrPhase::Sustain => {
                self.level = self.sustain;
            }
            AdsrPhase::Release => {
                let n = (self.release_s * sr).max(1.0);
                let t = self.pos / n;
                self.level = self.release_from * (1.0 - t).max(0.0);
                if t >= 1.0 {
                    self.level = 0.0;
                    self.phase = AdsrPhase::Idle;
                    self.pos = 0.0;
                } else {
                    self.pos += 1.0;
                }
            }
        }
        self.level
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FilterType {
    Lowpass,
    Highpass,
    Bandpass,
}

/// Trapezoidal state-variable filter (Zavalishin TPT form). Stable up
/// to ~nyquist; produces simultaneous LP/HP/BP outputs from one pass.
struct Svf {
    sample_rate: f32,
    ic1eq: f32,
    ic2eq: f32,
}

impl Svf {
    fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            ic1eq: 0.0,
            ic2eq: 0.0,
        }
    }

    fn process(&mut self, input: f32, cutoff_hz: f32, res: f32, ftype: FilterType) -> f32 {
        let cutoff = cutoff_hz.clamp(20.0, self.sample_rate * 0.45);
        let g = libm::tanf(core::f32::consts::PI * cutoff / self.sample_rate);
        // res 0..1 → q 0.5..20 (low to high resonance).
        let q = 0.5 + res.clamp(0.0, 1.0) * 19.5;
        let k = 1.0 / q;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;

        let v3 = input - self.ic2eq;
        let v1 = a1 * self.ic1eq + a2 * v3;
        let v2 = self.ic2eq + a2 * self.ic1eq + a3 * v3;
        self.ic1eq = 2.0 * v1 - self.ic1eq;
        self.ic2eq = 2.0 * v2 - self.ic2eq;

        match ftype {
            FilterType::Lowpass => v2,
            FilterType::Highpass => input - k * v1 - v2,
            FilterType::Bandpass => v1,
        }
    }

    fn reset(&mut self) {
        self.ic1eq = 0.0;
        self.ic2eq = 0.0;
    }
}

struct Voice {
    osc_a: Oscillator,
    osc_b: Oscillator,
    filter: Svf,
    amp_env: Adsr,
    filt_env: Adsr,
    midi: i32,
    last_triggered: u64,
}

impl Voice {
    fn new(sample_rate: f32) -> Self {
        let mut osc_a = Oscillator::new(sample_rate);
        osc_a.set_gain(1.0);
        let mut osc_b = Oscillator::new(sample_rate);
        osc_b.set_gain(1.0);
        Self {
            osc_a,
            osc_b,
            filter: Svf::new(sample_rate),
            amp_env: Adsr::new(sample_rate),
            filt_env: Adsr::new(sample_rate),
            midi: -1,
            last_triggered: 0,
        }
    }
}

fn midi_to_hz(m: f32) -> f32 {
    440.0 * libm::exp2f((m - 69.0) / 12.0)
}

pub struct Subtractive {
    sample_rate: f32,
    voices: Vec<Voice>,
    next_trigger_tick: u64,

    osc_a_wave: Waveform,
    osc_a_detune_cents: f32,
    osc_b_wave: Waveform,
    osc_b_detune_cents: f32,
    osc_mix: f32,
    filter_type: FilterType,
    filter_cutoff_hz: f32,
    filter_res: f32,
    filter_env_amount_oct: f32,
    amp_a: f32,
    amp_d: f32,
    amp_s: f32,
    amp_r: f32,
    filt_a: f32,
    filt_d: f32,
    filt_s: f32,
    filt_r: f32,
    master_gain: f32,
}

impl Subtractive {
    pub fn new(sample_rate: f32) -> Self {
        let voices: Vec<Voice> = (0..DEFAULT_VOICES).map(|_| Voice::new(sample_rate)).collect();
        let mut s = Self {
            sample_rate,
            voices,
            next_trigger_tick: 1,
            osc_a_wave: Waveform::Sine,
            osc_a_detune_cents: 0.0,
            osc_b_wave: Waveform::Saw,
            osc_b_detune_cents: 7.0,
            osc_mix: 0.5,
            filter_type: FilterType::Lowpass,
            filter_cutoff_hz: 2000.0,
            filter_res: 0.0,
            filter_env_amount_oct: 0.0,
            amp_a: 0.005,
            amp_d: 0.1,
            amp_s: 0.7,
            amp_r: 0.2,
            filt_a: 0.005,
            filt_d: 0.2,
            filt_s: 0.5,
            filt_r: 0.3,
            master_gain: 0.5,
        };
        s.apply_envelope_params();
        s
    }

    pub fn set_voice_count(&mut self, count: u32) {
        let count = (count as usize).clamp(1, MAX_VOICES);
        if count > self.voices.len() {
            for _ in self.voices.len()..count {
                self.voices.push(Voice::new(self.sample_rate));
            }
        } else {
            self.voices.truncate(count);
        }
        self.apply_envelope_params();
    }

    fn apply_envelope_params(&mut self) {
        for v in self.voices.iter_mut() {
            v.amp_env.attack_s = self.amp_a;
            v.amp_env.decay_s = self.amp_d;
            v.amp_env.sustain = self.amp_s;
            v.amp_env.release_s = self.amp_r;
            v.filt_env.attack_s = self.filt_a;
            v.filt_env.decay_s = self.filt_d;
            v.filt_env.sustain = self.filt_s;
            v.filt_env.release_s = self.filt_r;
        }
    }

    fn note_on(&mut self, pitch: u8, _velocity: u8) {
        let tick = self.next_trigger_tick;
        self.next_trigger_tick = tick.wrapping_add(1);
        let idx = self
            .voices
            .iter()
            .position(|v| v.amp_env.is_idle())
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.last_triggered)
                    .map(|(i, _)| i)
                    .unwrap()
            });
        let base = midi_to_hz(pitch as f32);
        let detune_a = libm::exp2f(self.osc_a_detune_cents / 1200.0);
        let detune_b = libm::exp2f(self.osc_b_detune_cents / 1200.0);
        let v = &mut self.voices[idx];
        v.midi = pitch as i32;
        v.last_triggered = tick;
        v.osc_a.set_waveform(self.osc_a_wave);
        v.osc_a.set_frequency(base * detune_a);
        v.osc_b.set_waveform(self.osc_b_wave);
        v.osc_b.set_frequency(base * detune_b);
        v.amp_env.trigger();
        v.filt_env.trigger();
    }

    fn note_off(&mut self, pitch: u8) {
        let p = pitch as i32;
        for v in self.voices.iter_mut() {
            if v.midi == p && v.amp_env.is_held() {
                v.amp_env.release();
                v.filt_env.release();
            }
        }
    }

    fn all_notes_off(&mut self) {
        for v in self.voices.iter_mut() {
            v.amp_env.release();
            v.filt_env.release();
        }
    }
}

impl Plugin for Subtractive {
    fn descriptors(&self) -> &[ParamDescriptor] {
        &DESCRIPTORS
    }

    fn set_param(&mut self, id: ParamId, value: f32) {
        match id {
            PID_OSC_A_WAVE => self.osc_a_wave = wave_from_f32(value),
            PID_OSC_A_DETUNE => self.osc_a_detune_cents = value,
            PID_OSC_B_WAVE => self.osc_b_wave = wave_from_f32(value),
            PID_OSC_B_DETUNE => self.osc_b_detune_cents = value,
            PID_OSC_MIX => self.osc_mix = value.clamp(0.0, 1.0),
            PID_FILTER_TYPE => self.filter_type = filter_type_from_f32(value),
            PID_FILTER_CUTOFF => self.filter_cutoff_hz = value.clamp(20.0, 20_000.0),
            PID_FILTER_RES => self.filter_res = value.clamp(0.0, 1.0),
            PID_FILTER_ENV_AMT => self.filter_env_amount_oct = value.clamp(-8.0, 8.0),
            PID_AMP_A => {
                self.amp_a = value.max(0.0001);
                self.apply_envelope_params();
            }
            PID_AMP_D => {
                self.amp_d = value.max(0.0001);
                self.apply_envelope_params();
            }
            PID_AMP_S => {
                self.amp_s = value.clamp(0.0, 1.0);
                self.apply_envelope_params();
            }
            PID_AMP_R => {
                self.amp_r = value.max(0.0001);
                self.apply_envelope_params();
            }
            PID_FILT_A => {
                self.filt_a = value.max(0.0001);
                self.apply_envelope_params();
            }
            PID_FILT_D => {
                self.filt_d = value.max(0.0001);
                self.apply_envelope_params();
            }
            PID_FILT_S => {
                self.filt_s = value.clamp(0.0, 1.0);
                self.apply_envelope_params();
            }
            PID_FILT_R => {
                self.filt_r = value.max(0.0001);
                self.apply_envelope_params();
            }
            PID_GAIN => self.master_gain = value.max(0.0),
            _ => {}
        }
    }

    fn handle_event(&mut self, ev: PluginEvent) {
        match ev {
            PluginEvent::NoteOn { pitch, velocity } => self.note_on(pitch, velocity),
            PluginEvent::NoteOff { pitch } => self.note_off(pitch),
            PluginEvent::AllNotesOff => self.all_notes_off(),
            PluginEvent::MidiCc { .. } => {}
        }
    }

    fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        if outputs.is_empty() {
            return;
        }
        let out = &mut outputs[0][..frames];
        for s in out.iter_mut() {
            *s = 0.0;
        }
        for v in self.voices.iter_mut() {
            if v.amp_env.is_idle() {
                continue;
            }
            for s in out.iter_mut() {
                let a = v.osc_a.next_sample();
                let b = v.osc_b.next_sample();
                let mix = a * (1.0 - self.osc_mix) + b * self.osc_mix;
                let filt_env = v.filt_env.next();
                let amp_env = v.amp_env.next();
                let mod_cutoff =
                    self.filter_cutoff_hz * libm::exp2f(filt_env * self.filter_env_amount_oct);
                let filtered = v.filter.process(mix, mod_cutoff, self.filter_res, self.filter_type);
                *s += filtered * amp_env;
            }
        }
        let g = self.master_gain;
        for s in out.iter_mut() {
            *s *= g;
        }
    }

    fn reset(&mut self) {
        for v in self.voices.iter_mut() {
            v.amp_env.phase = AdsrPhase::Idle;
            v.amp_env.level = 0.0;
            v.amp_env.pos = 0.0;
            v.filt_env.phase = AdsrPhase::Idle;
            v.filt_env.level = 0.0;
            v.filt_env.pos = 0.0;
            v.filter.reset();
        }
    }

    fn kind(&self) -> PluginKind {
        PluginKind::Instrument
    }

    fn voice_count_hint(&self) -> Option<u32> {
        Some(self.voices.len() as u32)
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

fn wave_from_f32(v: f32) -> Waveform {
    match libm::roundf(v) as i32 {
        1 => Waveform::Saw,
        2 => Waveform::Square,
        _ => Waveform::Sine,
    }
}

fn filter_type_from_f32(v: f32) -> FilterType {
    match libm::roundf(v) as i32 {
        1 => FilterType::Highpass,
        2 => FilterType::Bandpass,
        _ => FilterType::Lowpass,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn render(synth: &mut Subtractive, frames: usize) -> Vec<f32> {
        let mut buf = vec![0.0f32; frames];
        let mut outs: [&mut [f32]; 1] = [&mut buf[..]];
        synth.process(&[], &mut outs, frames);
        buf
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |a, x| a.max(x.abs()))
    }

    #[test]
    fn idle_synth_renders_silence() {
        let mut s = Subtractive::new(48_000.0);
        let buf = render(&mut s, 1024);
        assert!(buf.iter().all(|x| *x == 0.0));
    }

    #[test]
    fn descriptors_cover_full_param_set() {
        let s = Subtractive::new(48_000.0);
        let descs = s.descriptors();
        assert_eq!(descs.len(), 18);
        assert!(descs
            .iter()
            .any(|d| d.id == PID_FILTER_CUTOFF && d.unit == ParamUnit::Hz));
        assert!(descs
            .iter()
            .any(|d| d.id == PID_AMP_A && d.unit == ParamUnit::Seconds));
        // Param ids should be unique.
        let mut ids: Vec<ParamId> = descs.iter().map(|d| d.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), descs.len(), "duplicate param ids");
    }

    #[test]
    fn note_on_then_note_off_shapes_envelope() {
        let mut s = Subtractive::new(48_000.0);
        s.set_param(PID_GAIN, 1.0);
        s.set_param(PID_AMP_A, 0.01);
        s.set_param(PID_AMP_D, 0.05);
        s.set_param(PID_AMP_S, 0.5);
        s.set_param(PID_AMP_R, 0.1);
        s.set_param(PID_FILTER_CUTOFF, 8000.0);
        s.set_param(PID_FILTER_ENV_AMT, 0.0);

        s.handle_event(PluginEvent::NoteOn {
            pitch: 60,
            velocity: 100,
        });

        // Render 1s held. Window 1: first 80 ms covers attack→decay peak.
        // Window 2: last 100 ms is sustain.
        let held = render(&mut s, 48_000);
        let attack_peak = peak(&held[..3840]);
        let sustain_peak = peak(&held[held.len() - 4_800..]);
        assert!(
            attack_peak > 0.3,
            "attack peak too low: {attack_peak}"
        );
        assert!(
            sustain_peak > 0.05 && sustain_peak < attack_peak,
            "sustain ({sustain_peak}) should be present and below attack ({attack_peak})"
        );

        // Note off → 0.5s release. Tail of release window should be silent.
        s.handle_event(PluginEvent::NoteOff { pitch: 60 });
        let rel = render(&mut s, 24_000);
        let tail = peak(&rel[rel.len() - 4_800..]);
        assert!(tail < 0.02, "release tail not silent: {tail}");
    }

    #[test]
    fn note_off_idles_voice_after_release() {
        let mut s = Subtractive::new(48_000.0);
        s.set_param(PID_AMP_R, 0.05);
        s.handle_event(PluginEvent::NoteOn {
            pitch: 60,
            velocity: 100,
        });
        let _ = render(&mut s, 4_800);
        s.handle_event(PluginEvent::NoteOff { pitch: 60 });
        // 0.05s release → drain a generous window.
        let _ = render(&mut s, 24_000);
        assert!(s.voices.iter().all(|v| v.amp_env.is_idle()));
    }

    #[test]
    fn polyphonic_chord_is_louder_than_single_note() {
        let mut single = Subtractive::new(48_000.0);
        single.set_param(PID_GAIN, 1.0);
        single.set_param(PID_AMP_A, 0.001);
        single.handle_event(PluginEvent::NoteOn {
            pitch: 60,
            velocity: 100,
        });
        let p1 = peak(&render(&mut single, 4_800));

        let mut triad = Subtractive::new(48_000.0);
        triad.set_param(PID_GAIN, 1.0);
        triad.set_param(PID_AMP_A, 0.001);
        triad.handle_event(PluginEvent::NoteOn {
            pitch: 60,
            velocity: 100,
        });
        triad.handle_event(PluginEvent::NoteOn {
            pitch: 64,
            velocity: 100,
        });
        triad.handle_event(PluginEvent::NoteOn {
            pitch: 67,
            velocity: 100,
        });
        let p3 = peak(&render(&mut triad, 4_800));

        assert!(
            p3 > p1 * 1.4,
            "triad peak {p3} not substantially louder than single {p1}"
        );
    }

    #[test]
    fn voice_stealing_caps_active_voices() {
        let mut s = Subtractive::new(48_000.0);
        s.set_voice_count(4);
        for n in 60..68u8 {
            s.handle_event(PluginEvent::NoteOn {
                pitch: n,
                velocity: 100,
            });
        }
        let active = s.voices.iter().filter(|v| !v.amp_env.is_idle()).count();
        assert_eq!(active, 4, "voice pool should cap at 4, got {active}");
    }

    #[test]
    fn all_notes_off_releases_everything() {
        let mut s = Subtractive::new(48_000.0);
        s.set_param(PID_AMP_R, 0.05);
        for n in 60..64u8 {
            s.handle_event(PluginEvent::NoteOn {
                pitch: n,
                velocity: 100,
            });
        }
        s.handle_event(PluginEvent::AllNotesOff);
        let _ = render(&mut s, 24_000);
        assert!(s.voices.iter().all(|v| v.amp_env.is_idle()));
    }

    #[test]
    fn reset_silences_all_voices_immediately() {
        let mut s = Subtractive::new(48_000.0);
        s.handle_event(PluginEvent::NoteOn {
            pitch: 60,
            velocity: 100,
        });
        let _ = render(&mut s, 1024);
        s.reset();
        let after = render(&mut s, 1024);
        assert!(peak(&after) < 1e-6, "audio after reset: {}", peak(&after));
    }

    #[test]
    fn filter_env_amount_changes_brightness() {
        // With the filter mostly closed and env amount opening it up, a
        // saw passed through should be significantly brighter (more
        // energy in the high-frequency band) than the same saw with no
        // env modulation. Compare peaks because high-freq content boosts
        // peak amplitude through a resonant LP.
        fn run(env_amount: f32) -> f32 {
            let mut s = Subtractive::new(48_000.0);
            s.set_param(PID_GAIN, 1.0);
            s.set_param(PID_AMP_A, 0.001);
            s.set_param(PID_OSC_A_WAVE, 1.0); // saw
            s.set_param(PID_OSC_B_WAVE, 1.0);
            s.set_param(PID_OSC_MIX, 0.5);
            s.set_param(PID_FILTER_CUTOFF, 200.0);
            s.set_param(PID_FILT_A, 0.001);
            s.set_param(PID_FILT_D, 0.5);
            s.set_param(PID_FILT_S, 1.0);
            s.set_param(PID_FILTER_ENV_AMT, env_amount);
            s.handle_event(PluginEvent::NoteOn {
                pitch: 60,
                velocity: 100,
            });
            // Render past the filter env attack so the filter is open.
            peak(&render(&mut s, 9_600))
        }

        let closed = run(0.0);
        let open = run(4.0);
        assert!(
            open > closed * 1.2,
            "env-modulated cutoff did not brighten the signal: closed={closed} open={open}"
        );
    }

    #[test]
    fn ode_to_joy_offline_render_is_finite_and_audible() {
        // Audio regression: render a fixed melody and assert the result
        // is non-silent and non-NaN. A future hash-based snapshot can
        // tighten this once the synth's voicing stabilizes.
        let mut s = Subtractive::new(48_000.0);
        s.set_param(PID_GAIN, 0.5);
        // Ode to joy — first phrase: E E F G G F E D C C D E E D D.
        let melody: [u8; 15] = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62];
        let mut buf = vec![0.0f32; 0];
        let beat = 4_800; // 0.1s per note
        for n in melody {
            s.handle_event(PluginEvent::NoteOn {
                pitch: n,
                velocity: 100,
            });
            let mut chunk = vec![0.0f32; beat];
            {
                let mut outs: [&mut [f32]; 1] = [&mut chunk[..]];
                s.process(&[], &mut outs, beat);
            }
            buf.extend_from_slice(&chunk);
            s.handle_event(PluginEvent::NoteOff { pitch: n });
        }
        // Tail to drain releases.
        let mut chunk = vec![0.0f32; 24_000];
        let tail_len = chunk.len();
        {
            let mut outs: [&mut [f32]; 1] = [&mut chunk[..]];
            s.process(&[], &mut outs, tail_len);
        }
        buf.extend_from_slice(&chunk);

        assert!(buf.iter().all(|s| s.is_finite()));
        assert!(peak(&buf) > 0.05, "render too quiet: {}", peak(&buf));
    }
}
