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
    /// Per-step bitmask for the track's first StepSeq clip (Phase 1
    /// only ever has one). Empty when the track has no step clip.
    pub steps: Vec<u32>,
    /// Notes for the track's first PianoRoll clip. Empty when the
    /// track has no piano-roll clip. Phase-2 M4 introduced.
    pub piano_roll_notes: Vec<NoteSnapshot>,
    /// Insert FX chain. Phase-4 M1 introduced. Empty = dry signal.
    pub inserts: Vec<InsertSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InsertSnapshot {
    pub kind: InsertKind,
    pub params: Vec<(u32, f32)>,
    pub bypass: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InsertKind {
    /// First-party Gain — clean amplitude scaler. Phase-4 M1 fixture.
    Gain,
    // Phase-4 M3 will append EQ, Compressor, Reverb, Delay.
    // Phase-4 M5 appends Container.
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NoteSnapshot {
    pub pitch: u8,
    pub velocity: u8,
    pub start_tick: u64,
    pub length_ticks: u64,
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
    /// Phase-2 first-party subtractive synth. `params` carries any
    /// non-default parameter values as (id, value) pairs so the engine
    /// rebuilds the patch deterministically from the snapshot. Empty
    /// vec = "use defaults".
    Subtractive { params: Vec<(u32, f32)> },
}

pub fn encode(snap: &ProjectSnapshot) -> Vec<u8> {
    postcard::to_allocvec(snap).expect("snapshot postcard encode")
}

pub fn decode(bytes: &[u8]) -> Result<ProjectSnapshot, postcard::Error> {
    postcard::from_bytes(bytes)
}
