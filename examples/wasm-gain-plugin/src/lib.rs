//! Reference third-party plugin for the Phase-8 SDK — a 1-param gain
//! effect. The DSP is intentionally trivial: `output = input * gain`.
//! The point of this crate is to lock in the ABI plugin authors must
//! satisfy and prove that the JS loader + (eventually) the audio
//! engine can drive it.
//!
//! The crate is `no_std` so the WASM blob stays tiny. State is held
//! in a single `Instance` heap-allocated on `init` and freed on
//! `destroy`. The handle returned to the host is the raw pointer.
//!
//! See `examples/README.md` for the ABI spec.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;
use alloc::boxed::Box;
use core::slice;

/// Plugin instance. One per `init` call.
pub struct Instance {
    pub gain: f32,
    pub max_block_size: u32,
    pub sample_rate: f32,
}

impl Instance {
    fn new(sample_rate: f32, max_block_size: u32) -> Self {
        Self { gain: 1.0, max_block_size, sample_rate }
    }
}

// ---------- ABI ------------------------------------------------------
//
// All exports are `#[no_mangle] extern "C"` so the WASM module
// exposes them as named exports the JS loader can grab by name.

/// Allocate `size` bytes inside the plugin's memory and hand the host
/// a pointer. Used by the loader to set up the I/O buffers it'll
/// later pass into `process`. The pointer is owned by the plugin —
/// `destroy` would free it, but the loader's I/O buffers are
/// long-lived so we just leak them (intentional; a single allocation
/// is fine for the plugin's lifetime).
///
/// Returns a raw pointer; in the WASM ABI this compiles to an `i32`
/// memory offset, which is what the JS loader expects. On native
/// (used by these crate's own unit tests) it's a 64-bit pointer.
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
    unsafe {
        drop(Box::from_raw(handle as *mut Instance));
    }
}

#[no_mangle]
pub extern "C" fn set_param(handle: usize, id: u32, value: f32) {
    let Some(inst) = (unsafe { (handle as *mut Instance).as_mut() }) else {
        return;
    };
    if id == 0 {
        inst.gain = value.clamp(0.0, 1.0);
    }
}

#[no_mangle]
pub extern "C" fn get_param(handle: usize, id: u32) -> f32 {
    let Some(inst) = (unsafe { (handle as *const Instance).as_ref() }) else {
        return 0.0;
    };
    match id {
        0 => inst.gain,
        _ => 0.0,
    }
}

#[no_mangle]
pub extern "C" fn handle_event(_handle: usize, _kind: u32, _p1: u32, _p2: u32) {
    // Gain is an effect — no events to handle.
}

/// Render `frames` samples per channel. Interleaved layout.
#[no_mangle]
pub extern "C" fn process(
    handle: usize,
    in_ptr: *const f32,
    in_channels: u32,
    out_ptr: *mut f32,
    out_channels: u32,
    frames: u32,
) {
    let Some(inst) = (unsafe { (handle as *const Instance).as_ref() }) else {
        return;
    };
    let gain = inst.gain;
    let total_in = (frames * in_channels) as usize;
    let total_out = (frames * out_channels) as usize;
    let src = if total_in == 0 {
        &[][..]
    } else {
        unsafe { slice::from_raw_parts(in_ptr, total_in) }
    };
    let dst = unsafe { slice::from_raw_parts_mut(out_ptr, total_out) };

    if in_channels == out_channels && in_channels > 0 {
        for i in 0..total_out {
            dst[i] = src[i] * gain;
        }
    } else if in_channels == 0 {
        // Instrument-style call (no input). Gain produces silence.
        for s in dst.iter_mut() {
            *s = 0.0;
        }
    } else {
        // Channel-count mismatch: write min(in, out) channels of
        // gain-scaled audio, zero the rest. Keeps the plugin safe
        // against ABI misuse without panicking.
        let frames_us = frames as usize;
        let common = in_channels.min(out_channels) as usize;
        for f in 0..frames_us {
            for c in 0..common {
                dst[f * out_channels as usize + c] =
                    src[f * in_channels as usize + c] * gain;
            }
            for c in common..(out_channels as usize) {
                dst[f * out_channels as usize + c] = 0.0;
            }
        }
    }
}

// ---------- no_std plumbing -----------------------------------------

#[cfg(target_arch = "wasm32")]
mod wasm_alloc {
    use core::alloc::{GlobalAlloc, Layout};

    /// Bump allocator — tiny + sufficient for a plugin that only
    /// allocates an `Instance` + two I/O buffers. Real plugins
    /// should ship their own (e.g. `dlmalloc-rs`) if they allocate
    /// often.
    struct Bump;

    static mut HEAP: [u8; 64 * 1024] = [0; 64 * 1024];
    static mut NEXT: usize = 0;

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align();
            let size = layout.size();
            // Mutable-static reads are flagged by 2024 edition; this
            // allocator is single-threaded inside the audio worklet's
            // WASM instance so the access pattern is safe.
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
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
            // Bump allocator — no per-block free. Good enough for
            // this reference plugin.
        }
    }

    #[global_allocator]
    static A: Bump = Bump;

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        loop {}
    }
}

// ---------- Native tests --------------------------------------------
//
// These run on the host architecture (the crate's `lib` target) so
// the DSP can be unit-tested without a WASM runtime. The wasm32
// build is exercised by the JS loader's Playwright spec.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_param_round_trips() {
        let h = init(48_000.0, 256);
        set_param(h, 0, 0.25);
        assert!((get_param(h, 0) - 0.25).abs() < 1e-6);
        destroy(h);
    }

    #[test]
    fn process_scales_input_by_gain() {
        let h = init(48_000.0, 256);
        set_param(h, 0, 0.5);
        let inp: [f32; 8] = [1.0; 8];
        let mut out: [f32; 8] = [0.0; 8];
        process(h, inp.as_ptr(), 1, out.as_mut_ptr(), 1, 8);
        for s in out.iter() {
            assert!((s - 0.5).abs() < 1e-6);
        }
        destroy(h);
    }

    #[test]
    fn gain_clamps_to_unit_range() {
        let h = init(48_000.0, 256);
        set_param(h, 0, 5.0);
        assert!((get_param(h, 0) - 1.0).abs() < 1e-6);
        set_param(h, 0, -1.0);
        assert!((get_param(h, 0) - 0.0).abs() < 1e-6);
        destroy(h);
    }

    #[test]
    fn unknown_param_id_is_silent() {
        let h = init(48_000.0, 256);
        set_param(h, 99, 0.5); // should not panic
        assert_eq!(get_param(h, 99), 0.0);
        destroy(h);
    }
}
