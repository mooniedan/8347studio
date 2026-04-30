// Engine events carried over the SPSC SAB ring (sab_ring.rs).
//
// postcard-encoded; the JS writer must produce identical wire bytes.
// Phase-1 covers transport + per-track mixer params. M4 adds note +
// tempo events; M6 adds master meter feedback.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Event {
    Transport { play: bool },
    SetTrackGain { track: u32, gain: f32 },
    SetTrackPan { track: u32, pan: f32 },
    SetTrackMute { track: u32, mute: bool },
    SetTrackSolo { track: u32, solo: bool },
    SetMasterGain { gain: f32 },
}

pub fn encode(ev: &Event) -> postcard::Result<alloc::vec::Vec<u8>> {
    postcard::to_allocvec(ev)
}

pub fn decode(bytes: &[u8]) -> postcard::Result<Event> {
    postcard::from_bytes(bytes)
}
