// Wire format for `RebuildProject` — postcard-encoded.
//
// Carries the structural subset of the Y.Doc that the audio engine needs:
// per-track mixer state, instrument identity, and master gain. Per-step
// patterns and tempo segments will join this struct in M4 and M5.
//
// The struct is *not* the same shape as the Y.Doc — it's the minimum the
// engine consumes. The Y→snapshot transform lives in engine-bridge.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectSnapshot {
    pub master_gain: f32,
    pub tracks: Vec<TrackSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackSnapshot {
    pub kind: TrackKind,
    pub name: String,
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub voices: u32,
    pub instrument: InstrumentSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrackKind {
    Midi,
    Audio,
    Bus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InstrumentSnapshot {
    /// Phase-1 first-party "builtin:oscillator" wrapped behind the
    /// step-sequencer plugin. Phase 2 expands this to general plugins.
    BuiltinSequencer { waveform: u32 },
    /// Audio/Bus tracks, or MIDI tracks with no instrument loaded.
    None,
}

pub fn encode(snap: &ProjectSnapshot) -> Vec<u8> {
    postcard::to_allocvec(snap).expect("snapshot postcard encode")
}

pub fn decode(bytes: &[u8]) -> Result<ProjectSnapshot, postcard::Error> {
    postcard::from_bytes(bytes)
}
