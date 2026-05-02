// Schroeder reverb — 4 parallel comb filters into 2 series allpasses.
// Cheap, stable, and recognisably "reverb-y". Phase-9 polish can swap
// in an FDN or convolution path; the descriptor surface stays.

use alloc::vec::Vec;
use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

pub const PID_PRE_DELAY: ParamId = 0;
pub const PID_ROOM_SIZE: ParamId = 1;
pub const PID_DAMPING: ParamId = 2;
pub const PID_MIX: ParamId = 3;

const DESCRIPTORS: [ParamDescriptor; 4] = [
    ParamDescriptor { id: PID_PRE_DELAY, name: "Pre-Delay", min: 0.0, max: 100.0, default: 10.0, unit: ParamUnit::Ms,   curve: ParamCurve::Linear, group: "rev" },
    ParamDescriptor { id: PID_ROOM_SIZE, name: "Room",      min: 0.0, max: 1.0,   default: 0.7,  unit: ParamUnit::None, curve: ParamCurve::Linear, group: "rev" },
    ParamDescriptor { id: PID_DAMPING,   name: "Damping",   min: 0.0, max: 1.0,   default: 0.4,  unit: ParamUnit::None, curve: ParamCurve::Linear, group: "rev" },
    ParamDescriptor { id: PID_MIX,       name: "Mix",       min: 0.0, max: 1.0,   default: 0.3,  unit: ParamUnit::None, curve: ParamCurve::Linear, group: "rev" },
];

// Comb / allpass delay lengths (samples at 44.1 kHz, scaled to actual sr).
// Standard Freeverb-style values.
const COMB_LENGTHS: [usize; 4] = [1116, 1188, 1277, 1356];
const ALLPASS_LENGTHS: [usize; 2] = [556, 441];

struct Comb {
    buf: Vec<f32>,
    pos: usize,
    feedback: f32,
    damp: f32,
    damp_state: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self {
            buf: alloc::vec![0.0; len.max(1)],
            pos: 0,
            feedback: 0.84,
            damp: 0.4,
            damp_state: 0.0,
        }
    }
    fn process(&mut self, x: f32) -> f32 {
        let out = self.buf[self.pos];
        self.damp_state = out * (1.0 - self.damp) + self.damp_state * self.damp;
        self.buf[self.pos] = x + self.damp_state * self.feedback;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }
    fn reset(&mut self) {
        for s in self.buf.iter_mut() {
            *s = 0.0;
        }
        self.damp_state = 0.0;
    }
}

struct Allpass {
    buf: Vec<f32>,
    pos: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self {
            buf: alloc::vec![0.0; len.max(1)],
            pos: 0,
        }
    }
    fn process(&mut self, x: f32) -> f32 {
        let buf_out = self.buf[self.pos];
        let out = -x + buf_out;
        self.buf[self.pos] = x + buf_out * 0.5;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }
    fn reset(&mut self) {
        for s in self.buf.iter_mut() {
            *s = 0.0;
        }
    }
}

pub struct Reverb {
    sample_rate: f32,
    pre_delay_ms: f32,
    room_size: f32, // 0..1 → comb feedback 0.7..0.98
    damping: f32,
    mix: f32,
    pre_buf: Vec<f32>,
    pre_pos: usize,
    combs: [Comb; 4],
    allpasses: [Allpass; 2],
}

impl Reverb {
    pub fn new(sample_rate: f32) -> Self {
        let scale = sample_rate / 44_100.0;
        let combs: [Comb; 4] = [
            Comb::new((COMB_LENGTHS[0] as f32 * scale) as usize),
            Comb::new((COMB_LENGTHS[1] as f32 * scale) as usize),
            Comb::new((COMB_LENGTHS[2] as f32 * scale) as usize),
            Comb::new((COMB_LENGTHS[3] as f32 * scale) as usize),
        ];
        let allpasses: [Allpass; 2] = [
            Allpass::new((ALLPASS_LENGTHS[0] as f32 * scale) as usize),
            Allpass::new((ALLPASS_LENGTHS[1] as f32 * scale) as usize),
        ];
        let pre_buf_len = ((100.0 * sample_rate) / 1000.0) as usize + 1;
        let mut r = Self {
            sample_rate,
            pre_delay_ms: 10.0,
            room_size: 0.7,
            damping: 0.4,
            mix: 0.3,
            pre_buf: alloc::vec![0.0; pre_buf_len],
            pre_pos: 0,
            combs,
            allpasses,
        };
        r.apply_room();
        r
    }

    fn apply_room(&mut self) {
        // Map 0..1 → 0.7..0.98.
        let fb = 0.7 + self.room_size.clamp(0.0, 1.0) * 0.28;
        for c in self.combs.iter_mut() {
            c.feedback = fb;
            c.damp = self.damping.clamp(0.0, 0.99);
        }
    }
}

impl Plugin for Reverb {
    fn descriptors(&self) -> &[ParamDescriptor] { &DESCRIPTORS }

    fn set_param(&mut self, id: ParamId, value: f32) {
        match id {
            PID_PRE_DELAY => self.pre_delay_ms = value.clamp(0.0, 100.0),
            PID_ROOM_SIZE => {
                self.room_size = value.clamp(0.0, 1.0);
                self.apply_room();
            }
            PID_DAMPING => {
                self.damping = value.clamp(0.0, 1.0);
                self.apply_room();
            }
            PID_MIX => self.mix = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        Some(match id {
            PID_PRE_DELAY => self.pre_delay_ms,
            PID_ROOM_SIZE => self.room_size,
            PID_DAMPING => self.damping,
            PID_MIX => self.mix,
            _ => return None,
        })
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let Some(out) = outputs.get_mut(0) else { return };
        let input = inputs.first().copied().unwrap_or(&[]);
        let pre_samples = (self.pre_delay_ms * self.sample_rate / 1000.0) as usize;
        let pre_len = self.pre_buf.len();
        let mix = self.mix;
        for i in 0..frames {
            let x = if i < input.len() { input[i] } else { 0.0 };
            // Pre-delay.
            self.pre_buf[self.pre_pos] = x;
            let read = (self.pre_pos + pre_len - pre_samples.min(pre_len - 1)) % pre_len;
            let pre = self.pre_buf[read];
            self.pre_pos = (self.pre_pos + 1) % pre_len;
            // Combs in parallel — sum / 4.
            let mut wet = 0.0f32;
            for c in self.combs.iter_mut() {
                wet += c.process(pre);
            }
            wet *= 0.25;
            // Allpasses in series.
            for a in self.allpasses.iter_mut() {
                wet = a.process(wet);
            }
            out[i] = x * (1.0 - mix) + wet * mix;
        }
    }

    fn reset(&mut self) {
        for s in self.pre_buf.iter_mut() {
            *s = 0.0;
        }
        for c in self.combs.iter_mut() {
            c.reset();
        }
        for a in self.allpasses.iter_mut() {
            a.reset();
        }
    }

    fn kind(&self) -> PluginKind { PluginKind::Effect }
    fn as_any_mut(&mut self) -> &mut dyn Any { self }
    fn as_any(&self) -> &dyn Any { self }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn render(rev: &mut Reverb, input: &[f32]) -> alloc::vec::Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];
        let in_arr: [&[f32]; 1] = [input];
        let mut out_arr: [&mut [f32]; 1] = [&mut out[..]];
        rev.process(&in_arr, &mut out_arr, n);
        out
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |a, x| a.max(x.abs()))
    }

    #[test]
    fn impulse_produces_a_decaying_tail() {
        let mut rev = Reverb::new(48_000.0);
        rev.set_param(PID_MIX, 1.0);
        rev.set_param(PID_PRE_DELAY, 0.0);
        rev.set_param(PID_ROOM_SIZE, 0.9);
        rev.set_param(PID_DAMPING, 0.3);
        // Single impulse, then 1 s of silence.
        let mut input = vec![0.0f32; 48_000];
        input[0] = 1.0;
        let out = render(&mut rev, &input);
        // The early tail (0..200 ms) should be loud; the late tail
        // (800..1000 ms) should be quieter but still non-zero.
        let early = peak(&out[100..9_600]);
        let late = peak(&out[38_400..47_900]);
        assert!(early > 0.05, "early tail too quiet: {}", early);
        assert!(late > 0.0 && late < early, "decay did not progress (early {}, late {})", early, late);
    }

    #[test]
    fn dry_only_passes_signal_through() {
        let mut rev = Reverb::new(48_000.0);
        rev.set_param(PID_MIX, 0.0);
        let input = vec![0.5f32, -0.5, 0.25, -0.25];
        let out = render(&mut rev, &input);
        for (a, b) in out.iter().zip(&input) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn descriptors_advertise_four_params() {
        let r = Reverb::new(48_000.0);
        assert_eq!(r.descriptors().len(), 4);
    }
}
