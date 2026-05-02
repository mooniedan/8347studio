// 4-band parametric EQ. Band 0 is a low-shelf, bands 1 and 2 are peak
// (bell), band 3 is a high-shelf. Each band has freq, gain (dB), Q,
// and an enable flag.
//
// DSP: RBJ Audio EQ Cookbook coefficients implemented as a transposed
// direct-form-II biquad. Coefficients recompute on every set_param of
// a band parameter; not allocation-free in the strictest sense (no
// allocs, but ~30 floats of arithmetic per param write — fine on the
// audio thread).

use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};

const N_BANDS: usize = 4;
const PARAMS_PER_BAND: u32 = 4; // freq, gain, Q, enable

// Param ids: bands × {0:freq, 1:gain, 2:Q, 3:enable} = 16 ids.
// id = band * 4 + offset.
fn pid(band: u32, offset: u32) -> ParamId {
    band * PARAMS_PER_BAND + offset
}

const PID_FREQ: u32 = 0;
const PID_GAIN: u32 = 1;
const PID_Q: u32 = 2;
const PID_ENABLE: u32 = 3;

const DESCRIPTORS: [ParamDescriptor; 16] = [
    // Band 0 (lo-shelf)
    ParamDescriptor { id: 0,  name: "Lo Freq",  min: 20.0,    max: 1000.0, default: 100.0,  unit: ParamUnit::Hz, curve: ParamCurve::Exp,    group: "lo" },
    ParamDescriptor { id: 1,  name: "Lo Gain",  min: -24.0,   max: 24.0,   default: 0.0,    unit: ParamUnit::Db, curve: ParamCurve::Linear, group: "lo" },
    ParamDescriptor { id: 2,  name: "Lo Q",     min: 0.1,     max: 4.0,    default: 0.707,  unit: ParamUnit::None, curve: ParamCurve::Exp,  group: "lo" },
    ParamDescriptor { id: 3,  name: "Lo On",    min: 0.0,     max: 1.0,    default: 1.0,    unit: ParamUnit::None, curve: ParamCurve::Linear, group: "lo" },
    // Band 1 (peak low-mid)
    ParamDescriptor { id: 4,  name: "LM Freq",  min: 80.0,    max: 4000.0, default: 400.0,  unit: ParamUnit::Hz, curve: ParamCurve::Exp,    group: "lo_mid" },
    ParamDescriptor { id: 5,  name: "LM Gain",  min: -24.0,   max: 24.0,   default: 0.0,    unit: ParamUnit::Db, curve: ParamCurve::Linear, group: "lo_mid" },
    ParamDescriptor { id: 6,  name: "LM Q",     min: 0.1,     max: 10.0,   default: 1.0,    unit: ParamUnit::None, curve: ParamCurve::Exp,  group: "lo_mid" },
    ParamDescriptor { id: 7,  name: "LM On",    min: 0.0,     max: 1.0,    default: 1.0,    unit: ParamUnit::None, curve: ParamCurve::Linear, group: "lo_mid" },
    // Band 2 (peak high-mid)
    ParamDescriptor { id: 8,  name: "HM Freq",  min: 500.0,   max: 12000.0, default: 2000.0, unit: ParamUnit::Hz, curve: ParamCurve::Exp,    group: "hi_mid" },
    ParamDescriptor { id: 9,  name: "HM Gain",  min: -24.0,   max: 24.0,   default: 0.0,    unit: ParamUnit::Db, curve: ParamCurve::Linear, group: "hi_mid" },
    ParamDescriptor { id: 10, name: "HM Q",     min: 0.1,     max: 10.0,   default: 1.0,    unit: ParamUnit::None, curve: ParamCurve::Exp,  group: "hi_mid" },
    ParamDescriptor { id: 11, name: "HM On",    min: 0.0,     max: 1.0,    default: 1.0,    unit: ParamUnit::None, curve: ParamCurve::Linear, group: "hi_mid" },
    // Band 3 (hi-shelf)
    ParamDescriptor { id: 12, name: "Hi Freq",  min: 1000.0,  max: 20000.0, default: 8000.0, unit: ParamUnit::Hz, curve: ParamCurve::Exp,    group: "hi" },
    ParamDescriptor { id: 13, name: "Hi Gain",  min: -24.0,   max: 24.0,   default: 0.0,    unit: ParamUnit::Db, curve: ParamCurve::Linear, group: "hi" },
    ParamDescriptor { id: 14, name: "Hi Q",     min: 0.1,     max: 4.0,    default: 0.707,  unit: ParamUnit::None, curve: ParamCurve::Exp,  group: "hi" },
    ParamDescriptor { id: 15, name: "Hi On",    min: 0.0,     max: 1.0,    default: 1.0,    unit: ParamUnit::None, curve: ParamCurve::Linear, group: "hi" },
];

#[derive(Clone, Copy)]
enum BandType {
    LowShelf,
    Peak,
    HighShelf,
}

#[derive(Clone, Copy)]
struct Band {
    band_type: BandType,
    freq: f32,
    gain_db: f32,
    q: f32,
    enabled: bool,
    // Biquad coefficients.
    b0: f32, b1: f32, b2: f32, a1: f32, a2: f32,
    // State (transposed direct form II).
    z1: f32, z2: f32,
}

impl Band {
    fn new(band_type: BandType, freq: f32, q: f32) -> Self {
        let mut b = Self {
            band_type,
            freq,
            gain_db: 0.0,
            q,
            enabled: true,
            b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0,
            z1: 0.0, z2: 0.0,
        };
        b.recompute(48_000.0);
        b
    }

    fn recompute(&mut self, sample_rate: f32) {
        // RBJ Audio EQ Cookbook coefficients.
        let a = libm::powf(10.0, self.gain_db / 40.0); // sqrt(linear gain)
        let omega = 2.0 * core::f32::consts::PI * self.freq / sample_rate;
        let cos_w = libm::cosf(omega);
        let sin_w = libm::sinf(omega);
        let alpha = sin_w / (2.0 * self.q.max(0.01));

        let (mut b0, mut b1, mut b2, mut a0, mut a1, mut a2);
        match self.band_type {
            BandType::Peak => {
                b0 = 1.0 + alpha * a;
                b1 = -2.0 * cos_w;
                b2 = 1.0 - alpha * a;
                a0 = 1.0 + alpha / a;
                a1 = -2.0 * cos_w;
                a2 = 1.0 - alpha / a;
            }
            BandType::LowShelf => {
                let two_sqrt_a = 2.0 * libm::sqrtf(a);
                let beta = two_sqrt_a * alpha;
                b0 = a * ((a + 1.0) - (a - 1.0) * cos_w + beta);
                b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w);
                b2 = a * ((a + 1.0) - (a - 1.0) * cos_w - beta);
                a0 = (a + 1.0) + (a - 1.0) * cos_w + beta;
                a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w);
                a2 = (a + 1.0) + (a - 1.0) * cos_w - beta;
            }
            BandType::HighShelf => {
                let two_sqrt_a = 2.0 * libm::sqrtf(a);
                let beta = two_sqrt_a * alpha;
                b0 = a * ((a + 1.0) + (a - 1.0) * cos_w + beta);
                b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w);
                b2 = a * ((a + 1.0) + (a - 1.0) * cos_w - beta);
                a0 = (a + 1.0) - (a - 1.0) * cos_w + beta;
                a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w);
                a2 = (a + 1.0) - (a - 1.0) * cos_w - beta;
            }
        }
        b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
        self.b0 = b0; self.b1 = b1; self.b2 = b2; self.a1 = a1; self.a2 = a2;
    }

    fn process(&mut self, x: f32) -> f32 {
        if !self.enabled || self.gain_db == 0.0 {
            return x;
        }
        // Transposed direct form II.
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

pub struct Eq {
    sample_rate: f32,
    bands: [Band; N_BANDS],
}

impl Eq {
    pub fn new(sample_rate: f32) -> Self {
        let bands = [
            Band::new(BandType::LowShelf, 100.0, 0.707),
            Band::new(BandType::Peak, 400.0, 1.0),
            Band::new(BandType::Peak, 2000.0, 1.0),
            Band::new(BandType::HighShelf, 8000.0, 0.707),
        ];
        let mut eq = Self { sample_rate, bands };
        for b in eq.bands.iter_mut() {
            b.recompute(sample_rate);
        }
        eq
    }
}

impl Plugin for Eq {
    fn descriptors(&self) -> &[ParamDescriptor] { &DESCRIPTORS }

    fn set_param(&mut self, id: ParamId, value: f32) {
        let band = (id / PARAMS_PER_BAND) as usize;
        if band >= N_BANDS { return; }
        let off = id % PARAMS_PER_BAND;
        let b = &mut self.bands[band];
        match off {
            x if x == PID_FREQ => b.freq = value.clamp(20.0, 22_000.0),
            x if x == PID_GAIN => b.gain_db = value.clamp(-24.0, 24.0),
            x if x == PID_Q => b.q = value.clamp(0.1, 18.0),
            x if x == PID_ENABLE => b.enabled = value >= 0.5,
            _ => return,
        }
        b.recompute(self.sample_rate);
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        let band = (id / PARAMS_PER_BAND) as usize;
        if band >= N_BANDS { return None; }
        let b = &self.bands[band];
        match id % PARAMS_PER_BAND {
            x if x == PID_FREQ => Some(b.freq),
            x if x == PID_GAIN => Some(b.gain_db),
            x if x == PID_Q => Some(b.q),
            x if x == PID_ENABLE => Some(if b.enabled { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let Some(out) = outputs.get_mut(0) else { return };
        let input = inputs.first().copied().unwrap_or(&[]);
        for i in 0..frames {
            let mut s = if i < input.len() { input[i] } else { 0.0 };
            for b in self.bands.iter_mut() {
                s = b.process(s);
            }
            out[i] = s;
        }
    }

    fn reset(&mut self) {
        for b in self.bands.iter_mut() {
            b.reset();
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

    fn render(eq: &mut Eq, input: &[f32]) -> alloc::vec::Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];
        let in_arr: [&[f32]; 1] = [input];
        let mut out_arr: [&mut [f32]; 1] = [&mut out[..]];
        eq.process(&in_arr, &mut out_arr, n);
        out
    }

    fn rms(buf: &[f32]) -> f32 {
        let sum_sq: f32 = buf.iter().map(|s| s * s).sum();
        libm::sqrtf(sum_sq / buf.len() as f32)
    }

    fn sine(freq: f32, sample_rate: f32, n: usize) -> alloc::vec::Vec<f32> {
        (0..n)
            .map(|i| libm::sinf(2.0 * core::f32::consts::PI * freq * i as f32 / sample_rate))
            .collect()
    }

    #[test]
    fn flat_eq_passes_signal_unchanged() {
        let mut eq = Eq::new(48_000.0);
        let input = sine(1000.0, 48_000.0, 4_800);
        let out = render(&mut eq, &input);
        // No band has gain != 0 so output rms ≈ input rms.
        let r_in = rms(&input);
        let r_out = rms(&out);
        assert!(
            (r_in - r_out).abs() < 0.05,
            "flat EQ changed RMS: in {}, out {}",
            r_in,
            r_out
        );
    }

    #[test]
    fn peak_band_amplifies_at_center_frequency() {
        // Boost +12 dB at 1 kHz peak band; sine at 1 kHz should be
        // ~4× louder than passthrough (12 dB ≈ ×3.98).
        let mut eq = Eq::new(48_000.0);
        eq.set_param(pid(2, PID_FREQ), 1_000.0); // band 2 freq
        eq.set_param(pid(2, PID_GAIN), 12.0);
        eq.set_param(pid(2, PID_Q), 1.0);
        let input = sine(1_000.0, 48_000.0, 12_000);
        let out = render(&mut eq, &input);
        // Skip the first half-second so the filter has settled.
        let tail = &out[6_000..];
        let r_out = rms(tail);
        let r_in = rms(&input[6_000..]);
        let ratio = r_out / r_in;
        assert!(
            (ratio - 3.98).abs() < 0.6,
            "peak band gain ratio at center freq was {} (expected ≈ 4)",
            ratio
        );
    }

    #[test]
    fn descriptors_count_matches_bands_times_params() {
        let eq = Eq::new(48_000.0);
        assert_eq!(eq.descriptors().len(), 16);
    }

    #[test]
    fn disabled_band_passes_signal() {
        let mut eq = Eq::new(48_000.0);
        eq.set_param(pid(2, PID_GAIN), 24.0); // big boost
        eq.set_param(pid(2, PID_ENABLE), 0.0); // but disabled
        let input = sine(2_000.0, 48_000.0, 4_800);
        let out = render(&mut eq, &input);
        let ratio = rms(&out) / rms(&input);
        assert!((ratio - 1.0).abs() < 0.05, "disabled band leaked gain: {}", ratio);
    }
}
