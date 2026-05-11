//! Example third-party plugin — a classic bitcrusher effect. Pairs
//! two cheap DSP tricks that make a clean signal sound digitally
//! dirty:
//!
//!   1. Bit-depth reduction. Quantize each sample to one of `2^N`
//!      discrete levels. Low N (3–6 bits) is the audibly crunchy
//!      regime; 16 bits is essentially transparent.
//!   2. Sample-rate reduction (sample-and-hold). Repeat every Nth
//!      input sample for the next N-1 samples. High N introduces
//!      aliasing artifacts characteristic of low-rate digital audio.
//!
//! Wet / dry mix lets the user dial in the amount. Together the
//! three params cover the bitcrusher's whole expressive range.
//!
//! Implements the public Phase-8 plugin ABI (see `examples/README.md`).
//! Built into `packages/app/public/example-plugins/` by
//! `just build-example-plugins`.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;
use alloc::boxed::Box;
use core::slice;

/// Per-instance state. Allocated on the bump heap by `init`.
pub struct Instance {
    pub sample_rate: f32,
    pub max_block_size: u32,
    /// Bit depth — 1.0..16.0. Fractional values are valid for smooth
    /// automation; the quantizer rounds the level count at runtime.
    pub bit_depth: f32,
    /// Sample-rate reduction factor — 1.0..32.0. Higher = more
    /// aliasing.
    pub srr: f32,
    /// Wet/dry mix — 0.0 (fully dry) .. 1.0 (fully wet).
    pub mix: f32,
    /// Sample-and-hold counter + last-held value per channel. We
    /// support up to 4 channels which is plenty for stereo+expansion;
    /// extra channels fall back to a per-frame hold.
    sah_counter: u32,
    sah_held: [f32; 4],
}

impl Instance {
    fn new(sample_rate: f32, max_block_size: u32) -> Self {
        Self {
            sample_rate,
            max_block_size,
            bit_depth: 8.0,
            srr: 1.0,
            mix: 1.0,
            sah_counter: 0,
            sah_held: [0.0; 4],
        }
    }
}

/// Quantize an amplitude in `[-1, 1]` to one of `levels` discrete
/// steps. Used both for the DSP and as a unit-testable helper.
pub fn quantize(sample: f32, bit_depth: f32) -> f32 {
    let bits = bit_depth.clamp(1.0, 16.0);
    let levels = libm::powf(2.0, bits) as f32;
    let half = levels * 0.5;
    let clamped = sample.clamp(-1.0, 1.0);
    libm::floorf(clamped * half) / half
}

// ---------- ABI ------------------------------------------------------

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> *mut u8 {
    let mut v: alloc::vec::Vec<u8> = alloc::vec::Vec::with_capacity(size as usize);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32, max_block_size: u32) -> usize {
    let inst = Box::new(Instance::new(sample_rate, max_block_size));
    Box::into_raw(inst) as usize
}

#[no_mangle]
pub extern "C" fn destroy(handle: usize) {
    if handle == 0 {
        return;
    }
    unsafe { drop(Box::from_raw(handle as *mut Instance)) };
}

#[no_mangle]
pub extern "C" fn set_param(handle: usize, id: u32, value: f32) {
    let Some(inst) = (unsafe { (handle as *mut Instance).as_mut() }) else {
        return;
    };
    match id {
        0 => inst.bit_depth = value.clamp(1.0, 16.0),
        1 => inst.srr = value.clamp(1.0, 32.0),
        2 => inst.mix = value.clamp(0.0, 1.0),
        _ => {}
    }
}

#[no_mangle]
pub extern "C" fn get_param(handle: usize, id: u32) -> f32 {
    let Some(inst) = (unsafe { (handle as *const Instance).as_ref() }) else {
        return 0.0;
    };
    match id {
        0 => inst.bit_depth,
        1 => inst.srr,
        2 => inst.mix,
        _ => 0.0,
    }
}

#[no_mangle]
pub extern "C" fn handle_event(_handle: usize, _kind: u32, _p1: u32, _p2: u32) {
    // Bitcrusher is an effect — no events to handle.
}

#[no_mangle]
pub extern "C" fn process(
    handle: usize,
    in_ptr: *const f32,
    in_channels: u32,
    out_ptr: *mut f32,
    out_channels: u32,
    frames: u32,
) {
    let Some(inst) = (unsafe { (handle as *mut Instance).as_mut() }) else {
        return;
    };
    let frames_us = frames as usize;
    let inc = in_channels as usize;
    let outc = out_channels as usize;

    if outc == 0 {
        return;
    }
    let dst = unsafe { slice::from_raw_parts_mut(out_ptr, outc * frames_us) };
    if inc == 0 {
        // No input — emit silence. Bitcrusher needs something to
        // crush, so this is the safe default rather than synthesising
        // (an effect plugin called as if it were an instrument).
        for s in dst.iter_mut() {
            *s = 0.0;
        }
        return;
    }
    let src = unsafe { slice::from_raw_parts(in_ptr, inc * frames_us) };

    let srr_int = libm::roundf(inst.srr.max(1.0)) as u32;
    let common = inc.min(outc).min(inst.sah_held.len());
    let dry_gain = 1.0 - inst.mix;
    let wet_gain = inst.mix;

    for f in 0..frames_us {
        // Sample-and-hold step: update held values once every srr_int
        // frames, otherwise re-use the last-held set.
        if inst.sah_counter == 0 {
            for c in 0..common {
                inst.sah_held[c] = src[f * inc + c];
            }
        }
        inst.sah_counter = (inst.sah_counter + 1) % srr_int;

        for c in 0..outc {
            let dry = if c < inc { src[f * inc + c] } else { 0.0 };
            let held = if c < common { inst.sah_held[c] } else { dry };
            let wet = quantize(held, inst.bit_depth);
            dst[f * outc + c] = dry * dry_gain + wet * wet_gain;
        }
    }
}

// ---------- no_std plumbing -----------------------------------------

#[cfg(target_arch = "wasm32")]
mod wasm_alloc {
    use core::alloc::{GlobalAlloc, Layout};

    struct Bump;

    static mut HEAP: [u8; 64 * 1024] = [0; 64 * 1024];
    static mut NEXT: usize = 0;

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align();
            let size = layout.size();
            #[allow(static_mut_refs)]
            let next = NEXT;
            let start = (next + align - 1) & !(align - 1);
            let end = start + size;
            #[allow(static_mut_refs)]
            let heap_len = HEAP.len();
            if end > heap_len {
                return core::ptr::null_mut();
            }
            NEXT = end;
            #[allow(static_mut_refs)]
            let base = HEAP.as_mut_ptr();
            base.add(start)
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    #[global_allocator]
    static A: Bump = Bump;

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        loop {}
    }
}

// ---------- Native tests --------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_round_trip() {
        let h = init(48_000.0, 256);
        set_param(h, 0, 4.0);
        set_param(h, 1, 8.0);
        set_param(h, 2, 0.75);
        assert!((get_param(h, 0) - 4.0).abs() < 1e-6);
        assert!((get_param(h, 1) - 8.0).abs() < 1e-6);
        assert!((get_param(h, 2) - 0.75).abs() < 1e-6);
        destroy(h);
    }

    #[test]
    fn params_clamp_to_range() {
        let h = init(48_000.0, 256);
        set_param(h, 0, 99.0);
        assert!((get_param(h, 0) - 16.0).abs() < 1e-6);
        set_param(h, 1, -5.0);
        assert!((get_param(h, 1) - 1.0).abs() < 1e-6);
        set_param(h, 2, 5.0);
        assert!((get_param(h, 2) - 1.0).abs() < 1e-6);
        destroy(h);
    }

    #[test]
    fn quantize_produces_a_limited_value_set() {
        // 3 bits = 8 discrete levels. A pure ramp through [-1, 1]
        // should produce no more than 8 unique output values.
        let mut seen: alloc::vec::Vec<f32> = alloc::vec::Vec::new();
        for i in 0..1000 {
            let s = -1.0 + (i as f32 / 500.0);
            let q = quantize(s, 3.0);
            if !seen.iter().any(|&v| (v - q).abs() < 1e-6) {
                seen.push(q);
            }
        }
        assert!(seen.len() <= 8, "expected ≤ 8 levels, got {}", seen.len());
    }

    #[test]
    fn process_at_mix_zero_passes_input_through() {
        let h = init(48_000.0, 64);
        set_param(h, 2, 0.0); // mix = 0 → dry only
        let inp: [f32; 8] = [0.1, -0.2, 0.5, -0.7, 0.95, -0.95, 0.0, 0.3];
        let mut out: [f32; 8] = [0.0; 8];
        process(h, inp.as_ptr(), 1, out.as_mut_ptr(), 1, 8);
        for i in 0..8 {
            assert!(
                (out[i] - inp[i]).abs() < 1e-6,
                "mix=0 should pass dry, got out[{}]={}",
                i,
                out[i]
            );
        }
        destroy(h);
    }

    #[test]
    fn process_at_low_bit_depth_quantizes_output() {
        let h = init(48_000.0, 64);
        set_param(h, 0, 2.0); // 2 bits = 4 levels
        set_param(h, 1, 1.0); // no SRR
        set_param(h, 2, 1.0); // fully wet
        // Smooth ramp; quantized output should have at most 4
        // unique values in [-1, 1].
        let inp: alloc::vec::Vec<f32> = (0..32)
            .map(|i| -1.0 + (i as f32 / 16.0))
            .collect();
        let mut out = alloc::vec![0.0f32; 32];
        process(h, inp.as_ptr(), 1, out.as_mut_ptr(), 1, 32);
        let mut uniq: alloc::vec::Vec<f32> = alloc::vec::Vec::new();
        for &s in &out {
            if !uniq.iter().any(|&v| (v - s).abs() < 1e-6) {
                uniq.push(s);
            }
        }
        assert!(uniq.len() <= 4, "expected ≤ 4 levels at 2-bit, got {}", uniq.len());
        destroy(h);
    }

    #[test]
    fn sample_rate_reduction_repeats_held_values() {
        let h = init(48_000.0, 64);
        set_param(h, 0, 16.0); // no quantization
        set_param(h, 1, 4.0);  // sample-and-hold every 4 frames
        set_param(h, 2, 1.0);  // fully wet
        let inp: [f32; 8] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
        let mut out: [f32; 8] = [0.0; 8];
        process(h, inp.as_ptr(), 1, out.as_mut_ptr(), 1, 8);
        // First 4 frames hold inp[0]; next 4 hold inp[4].
        for i in 0..4 {
            assert!(
                (out[i] - inp[0]).abs() < 0.01,
                "frame {} held wrong value: got {}, expected ≈ {}",
                i, out[i], inp[0],
            );
        }
        for i in 4..8 {
            assert!(
                (out[i] - inp[4]).abs() < 0.01,
                "frame {} held wrong value: got {}, expected ≈ {}",
                i, out[i], inp[4],
            );
        }
        destroy(h);
    }

    #[test]
    fn instrument_call_shape_emits_silence() {
        // Effects expect input; if the engine accidentally calls a
        // bitcrusher in instrument-style (inputs=0), output is
        // silent — safer than producing noise.
        let h = init(48_000.0, 64);
        let mut out: [f32; 8] = [9.0; 8];
        process(h, core::ptr::null(), 0, out.as_mut_ptr(), 1, 8);
        for &s in &out {
            assert_eq!(s, 0.0);
        }
        destroy(h);
    }
}
