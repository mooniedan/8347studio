// First-party Gain effect. The simplest possible insert plugin —
// multiply input by a linear factor. Useful as a per-slot trim and as
// the M1 fixture that proves the insert-chain mechanics work without
// dragging in the full M3 effect kit.

use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

pub const PID_GAIN: ParamId = 0;

const DESCRIPTORS: [ParamDescriptor; 1] = [ParamDescriptor {
    id: PID_GAIN,
    name: "Gain",
    min: 0.0,
    max: 2.0,
    default: 1.0,
    unit: ParamUnit::None,
    curve: ParamCurve::Linear,
    group: "gain",
}];

pub struct Gain {
    gain: f32,
}

impl Gain {
    pub fn new() -> Self {
        Self { gain: 1.0 }
    }
}

impl Default for Gain {
    fn default() -> Self {
        Self::new()
    }
}

impl Plugin for Gain {
    fn descriptors(&self) -> &[ParamDescriptor] {
        &DESCRIPTORS
    }

    fn set_param(&mut self, id: ParamId, value: f32) {
        if id == PID_GAIN {
            self.gain = value.clamp(0.0, 2.0);
        }
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        if id == PID_GAIN {
            Some(self.gain)
        } else {
            None
        }
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let g = self.gain;
        if let Some(out) = outputs.get_mut(0) {
            if let Some(input) = inputs.first() {
                for i in 0..frames {
                    out[i] = input[i] * g;
                }
            } else {
                // No input → write silence (effects never generate from
                // nothing; if the host wires us as an instrument by
                // mistake we don't blow up).
                for s in out[..frames].iter_mut() {
                    *s = 0.0;
                }
            }
        }
    }

    fn reset(&mut self) {}

    fn kind(&self) -> PluginKind {
        PluginKind::Effect
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

    fn run(plugin: &mut Gain, input: &[f32]) -> alloc::vec::Vec<f32> {
        let frames = input.len();
        let mut out = alloc::vec![0.0f32; frames];
        let in_arr: [&[f32]; 1] = [input];
        let mut out_arr: [&mut [f32]; 1] = [&mut out[..]];
        plugin.process(&in_arr, &mut out_arr, frames);
        out
    }

    #[test]
    fn unity_gain_passes_signal_through() {
        let mut g = Gain::new();
        let input = [0.5f32, -0.5, 0.25, -0.25];
        let out = run(&mut g, &input);
        assert_eq!(out.as_slice(), &input);
    }

    #[test]
    fn zero_gain_silences() {
        let mut g = Gain::new();
        g.set_param(PID_GAIN, 0.0);
        let input = [0.5f32; 16];
        let out = run(&mut g, &input);
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn half_gain_attenuates_by_two() {
        let mut g = Gain::new();
        g.set_param(PID_GAIN, 0.5);
        let input = [1.0f32, -0.5, 0.25, 0.0];
        let out = run(&mut g, &input);
        for (a, b) in out.iter().zip(&[0.5f32, -0.25, 0.125, 0.0]) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn descriptors_expose_one_param() {
        let g = Gain::new();
        let d = g.descriptors();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].id, PID_GAIN);
    }

    #[test]
    fn kind_is_effect() {
        let g = Gain::new();
        assert_eq!(g.kind(), PluginKind::Effect);
    }
}
