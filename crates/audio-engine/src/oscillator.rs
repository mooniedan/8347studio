use core::f32::consts::{PI, TAU};

#[derive(Copy, Clone, PartialEq, Eq)]
pub enum Waveform {
    Sine,
    Saw,
    Square,
}

pub struct Oscillator {
    sample_rate: f32,
    phase: f32,
    phase_inc: f32,
    gain: f32,
    waveform: Waveform,
}

impl Oscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            phase: 0.0,
            phase_inc: 0.0,
            gain: 1.0,
            waveform: Waveform::Sine,
        }
    }

    pub fn set_frequency(&mut self, hz: f32) {
        self.phase_inc = TAU * hz / self.sample_rate;
    }

    pub fn set_gain(&mut self, g: f32) {
        self.gain = g;
    }

    pub fn set_waveform(&mut self, w: Waveform) {
        self.waveform = w;
    }

    pub fn next_sample(&mut self) -> f32 {
        let shape = match self.waveform {
            Waveform::Sine => libm::sinf(self.phase),
            // Naive saw/square — cheap; will alias at high fundamentals but fine for this range.
            Waveform::Saw => self.phase / PI - 1.0,
            Waveform::Square => {
                if self.phase < PI {
                    1.0
                } else {
                    -1.0
                }
            }
        };
        let s = shape * self.gain;
        self.phase += self.phase_inc;
        if self.phase >= TAU {
            self.phase -= TAU;
        }
        s
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            *s = self.next_sample();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sine_has_expected_amplitude_and_no_nans() {
        let mut osc = Oscillator::new(48_000.0);
        osc.set_frequency(440.0);
        osc.set_gain(0.5);
        let mut buf = [0.0f32; 4800];
        osc.process(&mut buf);
        let peak = buf.iter().cloned().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(buf.iter().all(|s| s.is_finite()));
        assert!(peak > 0.49 && peak <= 0.5 + 1e-3, "peak was {peak}");
    }

    #[test]
    fn saw_reaches_both_rails() {
        let mut osc = Oscillator::new(48_000.0);
        osc.set_waveform(Waveform::Saw);
        osc.set_frequency(440.0);
        let mut buf = [0.0f32; 4800];
        osc.process(&mut buf);
        let (mn, mx) = buf.iter().fold((0.0f32, 0.0f32), |(a, b), &s| (a.min(s), b.max(s)));
        assert!(mn < -0.9 && mx > 0.9, "saw range was {mn}..{mx}");
        assert!(buf.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn square_is_bipolar_unit() {
        let mut osc = Oscillator::new(48_000.0);
        osc.set_waveform(Waveform::Square);
        osc.set_frequency(440.0);
        let mut buf = [0.0f32; 4800];
        osc.process(&mut buf);
        assert!(buf.iter().all(|s| (s.abs() - 1.0).abs() < 1e-4));
    }

    #[test]
    fn frequency_affects_zero_crossings() {
        let mut osc = Oscillator::new(48_000.0);
        osc.set_frequency(1000.0);
        osc.set_gain(1.0);
        let mut buf = [0.0f32; 48_000];
        osc.process(&mut buf);
        let crossings = buf
            .windows(2)
            .filter(|w| (w[0] <= 0.0 && w[1] > 0.0) || (w[0] >= 0.0 && w[1] < 0.0))
            .count();
        assert!((1900..=2100).contains(&crossings), "got {crossings}");
    }
}
