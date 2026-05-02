// Mono delay with feedback. Time is in milliseconds (Phase-9 polish
// adds tempo-sync subdivision dropdown). Low/high shelf cuts shape
// the feedback path so each repeat darkens or thins out.

use alloc::vec::Vec;
use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

pub const PID_TIME_MS: ParamId = 0;
pub const PID_FEEDBACK: ParamId = 1;
pub const PID_HIGH_CUT: ParamId = 2;
pub const PID_LOW_CUT: ParamId = 3;
pub const PID_MIX: ParamId = 4;

const DESCRIPTORS: [ParamDescriptor; 5] = [
    ParamDescriptor { id: PID_TIME_MS,  name: "Time",     min: 1.0,   max: 2000.0, default: 250.0,  unit: ParamUnit::Ms,   curve: ParamCurve::Exp,    group: "delay" },
    ParamDescriptor { id: PID_FEEDBACK, name: "Feedback", min: 0.0,   max: 0.95,   default: 0.4,    unit: ParamUnit::None, curve: ParamCurve::Linear, group: "delay" },
    ParamDescriptor { id: PID_HIGH_CUT, name: "High Cut", min: 200.0, max: 20000.0, default: 8000.0, unit: ParamUnit::Hz, curve: ParamCurve::Exp,    group: "delay" },
    ParamDescriptor { id: PID_LOW_CUT,  name: "Low Cut",  min: 20.0,  max: 2000.0, default: 100.0,  unit: ParamUnit::Hz, curve: ParamCurve::Exp,    group: "delay" },
    ParamDescriptor { id: PID_MIX,      name: "Mix",      min: 0.0,   max: 1.0,    default: 0.3,    unit: ParamUnit::None, curve: ParamCurve::Linear, group: "delay" },
];

const MAX_DELAY_MS: f32 = 2000.0;

pub struct Delay {
    sample_rate: f32,
    time_ms: f32,
    feedback: f32,
    high_cut_hz: f32,
    low_cut_hz: f32,
    mix: f32,
    buf: Vec<f32>,
    write_pos: usize,
    // 1-pole LP/HP states for the feedback path.
    lp_state: f32,
    hp_state: f32,
}

impl Delay {
    pub fn new(sample_rate: f32) -> Self {
        let len = ((MAX_DELAY_MS * sample_rate) / 1000.0) as usize + 1;
        Self {
            sample_rate,
            time_ms: 250.0,
            feedback: 0.4,
            high_cut_hz: 8_000.0,
            low_cut_hz: 100.0,
            mix: 0.3,
            buf: alloc::vec![0.0; len],
            write_pos: 0,
            lp_state: 0.0,
            hp_state: 0.0,
        }
    }

    fn lp_coef(&self) -> f32 {
        // 1-pole LP: y = y_prev + alpha * (x - y_prev).
        let cutoff = self.high_cut_hz.clamp(20.0, self.sample_rate * 0.45);
        let dt = 1.0 / self.sample_rate;
        let rc = 1.0 / (2.0 * core::f32::consts::PI * cutoff);
        dt / (rc + dt)
    }
    fn hp_coef(&self) -> f32 {
        // 1-pole HP via complement of LP.
        let cutoff = self.low_cut_hz.clamp(10.0, self.sample_rate * 0.45);
        let dt = 1.0 / self.sample_rate;
        let rc = 1.0 / (2.0 * core::f32::consts::PI * cutoff);
        rc / (rc + dt)
    }
}

impl Plugin for Delay {
    fn descriptors(&self) -> &[ParamDescriptor] { &DESCRIPTORS }

    fn set_param(&mut self, id: ParamId, value: f32) {
        match id {
            PID_TIME_MS => self.time_ms = value.clamp(1.0, MAX_DELAY_MS),
            PID_FEEDBACK => self.feedback = value.clamp(0.0, 0.98),
            PID_HIGH_CUT => self.high_cut_hz = value.clamp(20.0, self.sample_rate * 0.45),
            PID_LOW_CUT => self.low_cut_hz = value.clamp(10.0, self.sample_rate * 0.45),
            PID_MIX => self.mix = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        Some(match id {
            PID_TIME_MS => self.time_ms,
            PID_FEEDBACK => self.feedback,
            PID_HIGH_CUT => self.high_cut_hz,
            PID_LOW_CUT => self.low_cut_hz,
            PID_MIX => self.mix,
            _ => return None,
        })
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let Some(out) = outputs.get_mut(0) else { return };
        let input = inputs.first().copied().unwrap_or(&[]);
        let len = self.buf.len();
        let delay_samples = ((self.time_ms * self.sample_rate) / 1000.0) as usize;
        let delay_samples = delay_samples.clamp(1, len - 1);
        let lp_alpha = self.lp_coef();
        let hp_alpha = self.hp_coef();
        let mix = self.mix;
        let fb = self.feedback;
        for i in 0..frames {
            let x = if i < input.len() { input[i] } else { 0.0 };
            let read_pos = (self.write_pos + len - delay_samples) % len;
            let delayed = self.buf[read_pos];
            // Apply LP then HP to the feedback path so successive
            // repeats get darker / thinner.
            self.lp_state += lp_alpha * (delayed - self.lp_state);
            let lp_out = self.lp_state;
            self.hp_state = hp_alpha * (self.hp_state + lp_out - self.hp_state);
            let shaped = lp_out - self.hp_state * 0.5; // very gentle HP
            self.buf[self.write_pos] = x + shaped * fb;
            self.write_pos = (self.write_pos + 1) % len;
            out[i] = x * (1.0 - mix) + delayed * mix;
        }
    }

    fn reset(&mut self) {
        for s in self.buf.iter_mut() {
            *s = 0.0;
        }
        self.lp_state = 0.0;
        self.hp_state = 0.0;
    }

    fn kind(&self) -> PluginKind { PluginKind::Effect }
    fn as_any_mut(&mut self) -> &mut dyn Any { self }
    fn as_any(&self) -> &dyn Any { self }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn render(d: &mut Delay, input: &[f32]) -> alloc::vec::Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];
        let in_arr: [&[f32]; 1] = [input];
        let mut out_arr: [&mut [f32]; 1] = [&mut out[..]];
        d.process(&in_arr, &mut out_arr, n);
        out
    }

    #[test]
    fn impulse_produces_an_echo_at_delay_time() {
        let mut d = Delay::new(48_000.0);
        d.set_param(PID_TIME_MS, 100.0); // 4800 samples
        d.set_param(PID_MIX, 1.0);
        d.set_param(PID_FEEDBACK, 0.0);
        d.set_param(PID_HIGH_CUT, 20_000.0); // bypass shaping
        d.set_param(PID_LOW_CUT, 20.0);
        let mut input = vec![0.0f32; 12_000];
        input[0] = 1.0;
        let out = render(&mut d, &input);
        // Tap at sample 4800 should carry the echo (within +/-2 because
        // of integer rounding).
        let around = &out[4_795..4_805];
        let max_around = around.iter().fold(0.0f32, |a, x| a.max(x.abs()));
        assert!(max_around > 0.5, "no echo at expected tap: max {} in {:?}", max_around, around);
    }

    #[test]
    fn feedback_zero_yields_one_echo_only() {
        let mut d = Delay::new(48_000.0);
        d.set_param(PID_TIME_MS, 50.0); // 2400 samples
        d.set_param(PID_MIX, 1.0);
        d.set_param(PID_FEEDBACK, 0.0);
        let mut input = vec![0.0f32; 24_000];
        input[0] = 1.0;
        let out = render(&mut d, &input);
        // Look at the second tap region (4800..5000); should be near
        // silent because feedback is 0.
        let second_tap = &out[4_800..5_000];
        let p = second_tap.iter().fold(0.0f32, |a, x| a.max(x.abs()));
        assert!(p < 0.05, "second tap leaked at fb=0: {}", p);
    }

    #[test]
    fn dry_only_passes_signal_through() {
        let mut d = Delay::new(48_000.0);
        d.set_param(PID_MIX, 0.0);
        let input = vec![0.4f32, -0.4, 0.2, -0.2];
        let out = render(&mut d, &input);
        for (a, b) in out.iter().zip(&input) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn descriptors_advertise_five_params() {
        let d = Delay::new(48_000.0);
        assert_eq!(d.descriptors().len(), 5);
    }
}
