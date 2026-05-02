// Time-stretch via overlap-add (OLA). Given an input PCM buffer and a
// stretch ratio (>1 → longer / slower, <1 → shorter / faster), writes
// output_frames samples that span the same frequency content as the
// input but at a different duration. Pitch is preserved because each
// window is read from the input at native rate; phase artifacts at
// window boundaries are accepted as the cheap-quality cost. A future
// polish pass can swap WSOLA in for similarity-aware window placement.
//
// The standard 50%-overlap Hann window sums to constant 1 across the
// signal interior, so at ratio = 1.0 the OLA reconstructs the input
// exactly (up to half-a-window trim at the edges).

use alloc::vec::Vec;

const WINDOW: usize = 1024;
const HOP_OUT: usize = WINDOW / 2; // 50% overlap → ΣHann = 1 inside the signal

/// Stretch `input` to fill `output_frames` samples in `out`, scaling
/// duration by the implicit ratio output_frames / input_frames.
pub fn ola_stretch(input: &[f32], output_frames: usize, out: &mut [f32]) {
    if output_frames == 0 || out.is_empty() {
        return;
    }
    let n = output_frames.min(out.len());
    for s in out[..n].iter_mut() {
        *s = 0.0;
    }
    if input.is_empty() {
        return;
    }
    let ratio = output_frames as f32 / input.len() as f32;
    if (ratio - 1.0).abs() < 1e-6 {
        let take = n.min(input.len());
        out[..take].copy_from_slice(&input[..take]);
        return;
    }
    let hann = hann_window();
    let hop_in_f = HOP_OUT as f32 / ratio;
    // Cover the output with windows starting at i * HOP_OUT.
    let mut win_idx = 0usize;
    loop {
        let out_start = win_idx * HOP_OUT;
        if out_start >= n {
            break;
        }
        let in_start_f = win_idx as f32 * hop_in_f;
        let in_start = in_start_f as usize;
        for k in 0..WINDOW {
            let o = out_start + k;
            let i = in_start + k;
            if o >= n {
                break;
            }
            if i >= input.len() {
                break;
            }
            out[o] += input[i] * hann[k];
        }
        win_idx += 1;
    }
}

/// Convenience wrapper: allocate the output buffer and return it.
pub fn ola_stretch_to_vec(input: &[f32], output_frames: usize) -> Vec<f32> {
    let mut out = alloc::vec![0.0f32; output_frames];
    ola_stretch(input, output_frames, &mut out);
    out
}

fn hann_window() -> [f32; WINDOW] {
    let mut h = [0.0f32; WINDOW];
    let denom = (WINDOW - 1) as f32;
    for i in 0..WINDOW {
        h[i] = 0.5 - 0.5 * libm::cosf(2.0 * core::f32::consts::PI * i as f32 / denom);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn sine(freq: f32, sample_rate: f32, n: usize) -> alloc::vec::Vec<f32> {
        (0..n)
            .map(|i| libm::sinf(2.0 * core::f32::consts::PI * freq * i as f32 / sample_rate))
            .collect()
    }

    fn zero_crossings(buf: &[f32]) -> usize {
        buf.windows(2)
            .filter(|w| (w[0] <= 0.0 && w[1] > 0.0) || (w[0] > 0.0 && w[1] <= 0.0))
            .count()
    }

    fn rms(buf: &[f32]) -> f32 {
        let s: f32 = buf.iter().map(|x| x * x).sum();
        libm::sqrtf(s / buf.len() as f32)
    }

    #[test]
    fn ratio_one_reconstructs_input_to_within_window_trim() {
        // 0.1 s of 1 kHz sine.
        let input = sine(1_000.0, 48_000.0, 4_800);
        let mut out = vec![0.0f32; input.len()];
        ola_stretch(&input, input.len(), &mut out);
        // Interior matches; edges may be tapered. Compare RMS in a
        // central window.
        let mid_in = rms(&input[1024..3776]);
        let mid_out = rms(&out[1024..3776]);
        assert!(
            (mid_in - mid_out).abs() < 0.05,
            "interior RMS mismatch: in {}, out {}",
            mid_in,
            mid_out
        );
    }

    #[test]
    fn ratio_one_two_preserves_frequency_content() {
        // 1 s of 1 kHz sine → stretch to 1.2 s. Zero-crossing density
        // should remain ≈ 2000 / sec (so total ≈ 2400 over 1.2 s).
        let input = sine(1_000.0, 48_000.0, 48_000);
        let target = 57_600usize; // 1.2× input length
        let out = ola_stretch_to_vec(&input, target);
        let zcs = zero_crossings(&out[1024..target - 1024]);
        let duration_secs = (target - 2 * 1024) as f32 / 48_000.0;
        let zcs_per_sec = zcs as f32 / duration_secs;
        // Naive resample-down would give ~1666 zc/sec at the same
        // 1 kHz pitch perception (would be 833 Hz peak); time-stretch
        // keeps 2000 zc/sec ± OLA artifacts.
        assert!(
            (zcs_per_sec - 2_000.0).abs() < 200.0,
            "expected ~2000 zc/s (1 kHz), got {} ({} crossings over {} s)",
            zcs_per_sec,
            zcs,
            duration_secs
        );
    }

    #[test]
    fn ratio_zero_eight_compresses_signal() {
        // Stretch 1 s down to 0.8 s.
        let input = sine(500.0, 48_000.0, 48_000);
        let target = 38_400usize;
        let out = ola_stretch_to_vec(&input, target);
        // Zero-crossings still ≈ 1000/sec → ~800 over the new span.
        let zcs = zero_crossings(&out[1024..target - 1024]);
        let duration_secs = (target - 2 * 1024) as f32 / 48_000.0;
        let zcs_per_sec = zcs as f32 / duration_secs;
        assert!(
            (zcs_per_sec - 1_000.0).abs() < 150.0,
            "expected ~1000 zc/s (500 Hz), got {} ({} crossings over {} s)",
            zcs_per_sec,
            zcs,
            duration_secs
        );
    }

    #[test]
    fn empty_input_writes_nothing() {
        let mut out = vec![0.5f32; 64];
        ola_stretch(&[], 64, &mut out);
        // out is zeroed up to output_frames before any windowing, so
        // an empty input leaves silence.
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn output_buffer_smaller_than_target_clamps() {
        let input = sine(440.0, 48_000.0, 4_800);
        let mut out = vec![0.0f32; 1_000];
        ola_stretch(&input, 4_800, &mut out);
        // No panic; out has been written within its bounds.
        assert!(out.iter().all(|s| s.is_finite()));
    }
}
