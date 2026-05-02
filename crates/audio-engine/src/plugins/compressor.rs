// Feedforward peak-detector compressor.
//
// Envelope follower tracks |x| with separate attack / release time
// constants. Gain reduction in dB derived from the envelope's
// distance above threshold; ratio scales it; soft knee smooths the
// kink around threshold. Makeup is a clean post-gain.
//
// Phase-4 M3 ships the basic shape; sidechain-input wiring is a
// polish item that lands when send routing meets the FX side.

use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

pub const PID_THRESHOLD: ParamId = 0;
pub const PID_RATIO: ParamId = 1;
pub const PID_ATTACK: ParamId = 2;
pub const PID_RELEASE: ParamId = 3;
pub const PID_MAKEUP: ParamId = 4;
pub const PID_KNEE: ParamId = 5;

const DESCRIPTORS: [ParamDescriptor; 6] = [
    ParamDescriptor { id: PID_THRESHOLD, name: "Threshold", min: -60.0, max: 0.0,  default: -18.0, unit: ParamUnit::Db,      curve: ParamCurve::Linear, group: "comp" },
    ParamDescriptor { id: PID_RATIO,     name: "Ratio",     min: 1.0,   max: 20.0, default: 4.0,   unit: ParamUnit::None,    curve: ParamCurve::Exp,    group: "comp" },
    ParamDescriptor { id: PID_ATTACK,    name: "Attack",    min: 0.001, max: 0.5,  default: 0.005, unit: ParamUnit::Seconds, curve: ParamCurve::Exp,    group: "comp" },
    ParamDescriptor { id: PID_RELEASE,   name: "Release",   min: 0.01,  max: 2.0,  default: 0.1,   unit: ParamUnit::Seconds, curve: ParamCurve::Exp,    group: "comp" },
    ParamDescriptor { id: PID_MAKEUP,    name: "Makeup",    min: 0.0,   max: 24.0, default: 0.0,   unit: ParamUnit::Db,      curve: ParamCurve::Linear, group: "comp" },
    ParamDescriptor { id: PID_KNEE,      name: "Knee",      min: 0.0,   max: 12.0, default: 6.0,   unit: ParamUnit::Db,      curve: ParamCurve::Linear, group: "comp" },
];

pub struct Compressor {
    sample_rate: f32,
    threshold_db: f32,
    ratio: f32,
    attack_s: f32,
    release_s: f32,
    makeup_db: f32,
    knee_db: f32,
    envelope: f32, // smoothed |x| in linear amplitude
}

impl Compressor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            threshold_db: -18.0,
            ratio: 4.0,
            attack_s: 0.005,
            release_s: 0.1,
            makeup_db: 0.0,
            knee_db: 6.0,
            envelope: 0.0,
        }
    }
}

fn lin_to_db(x: f32) -> f32 {
    20.0 * libm::log10f(x.max(1e-10))
}
fn db_to_lin(db: f32) -> f32 {
    libm::powf(10.0, db / 20.0)
}

impl Plugin for Compressor {
    fn descriptors(&self) -> &[ParamDescriptor] { &DESCRIPTORS }

    fn set_param(&mut self, id: ParamId, value: f32) {
        match id {
            PID_THRESHOLD => self.threshold_db = value.clamp(-80.0, 0.0),
            PID_RATIO => self.ratio = value.clamp(1.0, 50.0),
            PID_ATTACK => self.attack_s = value.max(0.0001),
            PID_RELEASE => self.release_s = value.max(0.001),
            PID_MAKEUP => self.makeup_db = value.clamp(-24.0, 36.0),
            PID_KNEE => self.knee_db = value.clamp(0.0, 24.0),
            _ => {}
        }
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        Some(match id {
            PID_THRESHOLD => self.threshold_db,
            PID_RATIO => self.ratio,
            PID_ATTACK => self.attack_s,
            PID_RELEASE => self.release_s,
            PID_MAKEUP => self.makeup_db,
            PID_KNEE => self.knee_db,
            _ => return None,
        })
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let Some(out) = outputs.get_mut(0) else { return };
        let input = inputs.first().copied().unwrap_or(&[]);
        let attack_coef = libm::expf(-1.0 / (self.attack_s * self.sample_rate));
        let release_coef = libm::expf(-1.0 / (self.release_s * self.sample_rate));
        let makeup_lin = db_to_lin(self.makeup_db);
        let half_knee = self.knee_db * 0.5;
        let inv_ratio = 1.0 / self.ratio;
        for i in 0..frames {
            let x = if i < input.len() { input[i] } else { 0.0 };
            let abs_x = x.abs();
            let coef = if abs_x > self.envelope { attack_coef } else { release_coef };
            self.envelope = abs_x + (self.envelope - abs_x) * coef;
            let env_db = lin_to_db(self.envelope);
            // Soft-knee gain reduction (cubic interpolation across the
            // knee region).
            let over = env_db - self.threshold_db;
            let gr_db = if over <= -half_knee {
                0.0
            } else if over >= half_knee {
                -over * (1.0 - inv_ratio)
            } else {
                // In the knee: smooth via (over + half_knee)^2 / (2 * knee).
                let t = over + half_knee;
                -(t * t) / (2.0 * self.knee_db) * (1.0 - inv_ratio)
            };
            out[i] = x * db_to_lin(gr_db) * makeup_lin;
        }
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
    }

    fn kind(&self) -> PluginKind { PluginKind::Effect }
    fn as_any_mut(&mut self) -> &mut dyn Any { self }
    fn as_any(&self) -> &dyn Any { self }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn render(c: &mut Compressor, input: &[f32]) -> alloc::vec::Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];
        let in_arr: [&[f32]; 1] = [input];
        let mut out_arr: [&mut [f32]; 1] = [&mut out[..]];
        c.process(&in_arr, &mut out_arr, n);
        out
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |a, x| a.max(x.abs()))
    }

    #[test]
    fn signal_below_threshold_is_unchanged() {
        // Threshold at 0 dB → -18 dB signal stays clean (well below
        // even the knee region).
        let mut c = Compressor::new(48_000.0);
        c.set_param(PID_THRESHOLD, 0.0);
        c.set_param(PID_KNEE, 0.0);
        c.set_param(PID_RELEASE, 0.001);
        let input = vec![0.1f32; 4_800];
        let out = render(&mut c, &input);
        // After envelope settles (let it run for ~50 ms = 2400 samples).
        let tail = &out[2_400..];
        let p = peak(tail);
        assert!((p - 0.1).abs() < 0.005, "below-threshold peak shifted: {}", p);
    }

    #[test]
    fn signal_above_threshold_is_attenuated_at_4_to_1() {
        // Threshold = -18 dB; ratio 4:1; signal at 0 dB (1.0 amplitude).
        // At steady state: env_db = 0; over = 18; gr = -18 * 0.75 = -13.5 dB.
        // Output amplitude ≈ 10^(-13.5/20) ≈ 0.21.
        let mut c = Compressor::new(48_000.0);
        c.set_param(PID_THRESHOLD, -18.0);
        c.set_param(PID_RATIO, 4.0);
        c.set_param(PID_KNEE, 0.0); // hard knee for predictable math
        c.set_param(PID_ATTACK, 0.001);
        c.set_param(PID_RELEASE, 0.05);
        let input = vec![1.0f32; 24_000]; // 0.5 s at 48k
        let out = render(&mut c, &input);
        // Skip past the attack window to steady state.
        let tail = &out[12_000..];
        let p = peak(tail);
        assert!(
            (p - 0.21).abs() < 0.05,
            "expected ≈0.21 (-13.5 dB GR), got {}",
            p
        );
    }

    #[test]
    fn descriptors_advertise_six_params() {
        let c = Compressor::new(48_000.0);
        assert_eq!(c.descriptors().len(), 6);
    }

    #[test]
    fn makeup_gain_lifts_output() {
        let mut c = Compressor::new(48_000.0);
        c.set_param(PID_THRESHOLD, 0.0); // never engaged
        c.set_param(PID_KNEE, 0.0);
        c.set_param(PID_MAKEUP, 6.0); // +6 dB
        let input = vec![0.1f32; 1_000];
        let out = render(&mut c, &input);
        let p = peak(&out[200..]);
        let expected = 0.1 * db_to_lin(6.0);
        assert!((p - expected).abs() < 0.005, "got {}, expected {}", p, expected);
    }
}
