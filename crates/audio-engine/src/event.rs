// Engine events carried over the SPSC SAB ring (sab_ring.rs).
//
// postcard-encoded; the JS writer must produce identical wire bytes.
// Phase-1 covers transport + per-track mixer params. M4 adds note +
// tempo events; M6 adds master meter feedback.

use serde::{Deserialize, Serialize};

// Order is the postcard wire format — JS bridge must match this. Append
// new variants to the end so existing discriminants keep their value.

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Event {
    Transport { play: bool },
    SetTrackGain { track: u32, gain: f32 },
    SetTrackPan { track: u32, pan: f32 },
    SetTrackMute { track: u32, mute: bool },
    SetTrackSolo { track: u32, solo: bool },
    SetMasterGain { gain: f32 },
    SetBpm { bpm: f32 },
    Locate { tick: u64 },
    /// Per-plugin parameter write. `id` matches the plugin's own
    /// ParamDescriptor table; the audio thread routes to the
    /// instrument on the addressed track.
    SetParam { track: u32, id: u32, value: f32 },
}

pub fn encode(ev: &Event) -> postcard::Result<alloc::vec::Vec<u8>> {
    postcard::to_allocvec(ev)
}

pub fn decode(bytes: &[u8]) -> postcard::Result<Event> {
    postcard::from_bytes(bytes)
}
