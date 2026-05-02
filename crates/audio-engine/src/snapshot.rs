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
    /// Automation lanes (Phase-4 M4). Each lane targets one parameter
    /// on one track's instrument or insert slot and carries a set of
    /// (tick, value) points evaluated each audio block via linear
    /// interpolation.
    pub automation: Vec<AutomationLane>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutomationLane {
    pub track_idx: u32,
    pub target: AutoTarget,
    pub param_id: u32,
    /// Points sorted by tick. Linear interpolation between adjacent
    /// points; constant before the first and after the last.
    pub points: Vec<AutoPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum AutoTarget {
    /// The track's instrument plugin. `slot_idx` is unused.
    Instrument,
    /// One of the track's insert slots.
    Insert { slot_idx: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AutoPoint {
    pub tick: u64,
    pub value: f32,
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
    /// Sends to bus tracks. Phase-4 M2 introduced.
    pub sends: Vec<SendSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SendSnapshot {
    pub target_track: u32,
    pub level: f32,
    pub pre_fader: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InsertSnapshot {
    pub kind: InsertKind,
    pub params: Vec<(u32, f32)>,
    pub bypass: bool,
    /// For Container inserts (Phase-4 M5), the parallel branches.
    /// Empty for non-Container kinds.
    pub branches: Vec<BranchSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BranchSnapshot {
    pub gain: f32,
    /// Each branch is its own plugin chain; outputs sum back at the
    /// container's mix node. Recursive — a Container inside a branch
    /// is allowed but rare.
    pub inserts: Vec<InsertSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InsertKind {
    /// First-party Gain — clean amplitude scaler. Phase-4 M1 fixture.
    Gain,
    /// 4-band parametric. Phase-4 M3.
    Eq,
    /// Feedforward peak compressor. Phase-4 M3.
    Compressor,
    /// Schroeder algorithmic reverb. Phase-4 M3.
    Reverb,
    /// Mono delay with shaped feedback. Phase-4 M3.
    Delay,
    /// Container — parallel branches summed back at the mix node.
    /// Phase-4 M5 escape hatch for parallel processing without a
    /// node-graph editor.
    Container,
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
