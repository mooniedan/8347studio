// Phase-8 M3b — third-party WASM plugin runtime.
//
// Plugin instances live in their own WebAssembly.Memory in JS land
// (loaded by packages/app/src/lib/plugin-loader.ts). The engine
// reaches them via four host-provided imports the audio worklet
// supplies at engine-instantiation time:
//
//   host_plugin_set_param   (handle, id, value)
//   host_plugin_get_param   (handle, id)            -> value
//   host_plugin_handle_event(handle, kind, p1, p2)
//   host_plugin_process     (handle, in_ptr, in_chs,
//                            out_ptr, out_chs, frames)
//
// The worklet's JS receives the engine-memory pointers in process,
// copies audio into the right plugin's memory, calls the plugin's
// process(), and copies output back into engine memory. The engine
// itself never touches plugin memory.
//
// Native (host arch) builds replace the imports with no-op stubs so
// the audio-engine crate still compiles + unit-tests run.

use alloc::vec::Vec;
use core::any::Any;

use crate::plugin::{Plugin, PluginEvent, PluginKind};

/// Identifier assigned by the worklet when a plugin is registered.
/// Tracks carry this in their snapshot; the engine passes it back
/// across the FFI on every call so the worklet can route.
pub type WasmPluginHandle = u32;

/// Plugin shape advertised in the snapshot — keeps WasmPlugin's
/// `kind()` honest so the mixer + UI behave correctly (effects sit
/// in insert chains; instruments occupy the instrument slot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmPluginKind {
    Instrument,
    Effect,
}

impl WasmPluginKind {
    fn to_plugin_kind(self) -> PluginKind {
        match self {
            WasmPluginKind::Instrument => PluginKind::Instrument,
            WasmPluginKind::Effect => PluginKind::Effect,
        }
    }
}

pub struct WasmPlugin {
    handle: WasmPluginHandle,
    kind: WasmPluginKind,
    /// Re-usable scratch for the f32 output if the engine ever needs
    /// to stage a buffer between host calls. M3b uses outputs in
    /// place; the field is reserved for future fan-in cases.
    #[allow(dead_code)]
    scratch: Vec<f32>,
}

impl WasmPlugin {
    pub fn new(handle: WasmPluginHandle, kind: WasmPluginKind) -> Self {
        Self { handle, kind, scratch: Vec::new() }
    }

    pub fn handle(&self) -> WasmPluginHandle {
        self.handle
    }
}

impl Plugin for WasmPlugin {
    fn kind(&self) -> PluginKind {
        self.kind.to_plugin_kind()
    }

    fn set_param(&mut self, id: u32, value: f32) {
        unsafe { host_plugin_set_param(self.handle, id, value) };
    }

    fn get_param(&self, id: u32) -> Option<f32> {
        Some(unsafe { host_plugin_get_param(self.handle, id) })
    }

    fn handle_event(&mut self, ev: PluginEvent) {
        let (kind, p1, p2) = match ev {
            PluginEvent::NoteOn { pitch, velocity } => (0u32, pitch as u32, velocity as u32),
            PluginEvent::NoteOff { pitch } => (1u32, pitch as u32, 0u32),
            PluginEvent::MidiCc { cc, value } => (2u32, cc as u32, value as u32),
            PluginEvent::AllNotesOff => (3u32, 0u32, 0u32),
        };
        unsafe { host_plugin_handle_event(self.handle, kind, p1, p2) };
    }

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        // The host expects interleaved frames. Effects: take input;
        // instruments: in_channels = 0. We pass channel counts +
        // pointers; the worklet handles interleaving + memory copies.
        let in_channels = inputs.len() as u32;
        let out_channels = outputs.len() as u32;
        let in_ptr: *const f32 = if inputs.is_empty() {
            core::ptr::null()
        } else {
            inputs[0].as_ptr()
        };
        let out_ptr: *mut f32 = if outputs.is_empty() {
            core::ptr::null_mut()
        } else {
            outputs[0].as_mut_ptr()
        };
        unsafe {
            host_plugin_process(
                self.handle,
                in_ptr,
                in_channels,
                out_ptr,
                out_channels,
                frames as u32,
            )
        };
    }

    fn reset(&mut self) {
        // Send AllNotesOff so the plugin clears any held state.
        unsafe { host_plugin_handle_event(self.handle, 3, 0, 0) };
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
    fn as_any(&self) -> &dyn Any { self }
}

// ---------- Host imports / stubs ------------------------------------

#[cfg(target_arch = "wasm32")]
extern "C" {
    fn host_plugin_set_param(handle: WasmPluginHandle, id: u32, value: f32);
    fn host_plugin_get_param(handle: WasmPluginHandle, id: u32) -> f32;
    fn host_plugin_handle_event(handle: WasmPluginHandle, kind: u32, p1: u32, p2: u32);
    fn host_plugin_process(
        handle: WasmPluginHandle,
        in_ptr: *const f32,
        in_channels: u32,
        out_ptr: *mut f32,
        out_channels: u32,
        frames: u32,
    );
}

// Native test stubs — let the crate compile on the host. The real
// runtime path is exercised in Playwright (the worklet supplies the
// imports). Native cargo tests can verify WasmPlugin obeys the trait
// surface, just not the audio output.

#[cfg(not(target_arch = "wasm32"))]
unsafe fn host_plugin_set_param(_h: WasmPluginHandle, _id: u32, _v: f32) {}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn host_plugin_get_param(_h: WasmPluginHandle, _id: u32) -> f32 { 0.0 }

#[cfg(not(target_arch = "wasm32"))]
unsafe fn host_plugin_handle_event(_h: WasmPluginHandle, _k: u32, _p1: u32, _p2: u32) {}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn host_plugin_process(
    _h: WasmPluginHandle,
    _in_ptr: *const f32,
    _in_channels: u32,
    out_ptr: *mut f32,
    out_channels: u32,
    frames: u32,
) {
    // On native, "process" zeroes the output so static tests have
    // deterministic, silent behaviour.
    if out_ptr.is_null() { return; }
    let total = (out_channels as usize) * (frames as usize);
    unsafe {
        for i in 0..total {
            *out_ptr.add(i) = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasm_plugin_carries_handle_and_kind() {
        let p = WasmPlugin::new(42, WasmPluginKind::Effect);
        assert_eq!(p.handle(), 42);
        assert_eq!(p.kind(), PluginKind::Effect);
    }

    #[test]
    fn wasm_plugin_passes_trait_object_safety() {
        let p: alloc::boxed::Box<dyn Plugin> =
            alloc::boxed::Box::new(WasmPlugin::new(1, WasmPluginKind::Instrument));
        // Method calls don't panic with stub host imports.
        let mut boxed = p;
        boxed.set_param(0, 0.5);
        assert_eq!(boxed.get_param(0), Some(0.0)); // native stub returns 0
        boxed.handle_event(PluginEvent::NoteOn { pitch: 60, velocity: 100 });
        boxed.reset();
    }

    #[test]
    fn wasm_plugin_process_writes_silence_on_native() {
        let mut p = WasmPlugin::new(1, WasmPluginKind::Effect);
        let mut buf = alloc::vec![1.0f32; 64];
        let mut outs: [&mut [f32]; 1] = [&mut buf[..]];
        p.process(&[], &mut outs, 64);
        // Native stub zeros the output.
        for s in &buf {
            assert_eq!(*s, 0.0);
        }
    }
}
