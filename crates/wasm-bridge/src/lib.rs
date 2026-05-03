use audio_engine::engine::Engine;
use audio_engine::event;
use audio_engine::oscillator::Waveform;
use audio_engine::sequencer::Sequencer;
use audio_engine::snapshot;
use audio_engine::track::TrackEngine;
use core::slice;

static mut ENGINE: Option<Engine> = None;
/// Reusable scratch for incoming `RebuildProject` payloads — one
/// allocation that grows on demand, no per-rebuild leak.
static mut SNAP_BUF: Option<Vec<u8>> = None;
/// Reusable scratch for inbound SAB events (one event at a time).
static mut EVENT_BUF: Option<Vec<u8>> = None;
/// Reusable scratch for incoming asset-PCM uploads (Phase-5 M2).
/// Holds f32 frames; sized in samples not bytes.
static mut ASSET_BUF: Option<Vec<f32>> = None;

#[allow(static_mut_refs)]
unsafe fn engine() -> &'static mut Engine {
    ENGINE.as_mut().expect("init not called")
}

fn seq_at(track_idx: u32) -> Option<&'static mut Sequencer> {
    unsafe {
        engine()
            .track_mut(track_idx as usize)
            .and_then(|t| t.instrument.as_any_mut().downcast_mut::<Sequencer>())
    }
}

/// First Sequencer-backed track in the project, if any. Used by the
/// playhead-readback path so the step-grid animation works regardless
/// of where the StepSeq track sits in the track list (it isn't always
/// at index 0 — e.g., the demo song has the Subtractive lead first).
fn first_seq() -> Option<&'static mut Sequencer> {
    unsafe {
        for t in engine().tracks.iter_mut() {
            if let Some(s) = t.instrument.as_any_mut().downcast_mut::<Sequencer>() {
                return Some(s);
            }
        }
        None
    }
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let mut engine = Engine::new(sample_rate);
    let seq = Sequencer::new(sample_rate);
    engine.add_track(TrackEngine::new(Box::new(seq)));
    unsafe {
        ENGINE = Some(engine);
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Reserve `len` bytes in the snapshot scratch buffer and return a
/// pointer the JS side can write into. Followed by `rebuild_project(len)`.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn snapshot_buffer_reserve(len: usize) -> *mut u8 {
    unsafe {
        let buf = SNAP_BUF.get_or_insert_with(Vec::new);
        if buf.capacity() < len {
            buf.reserve(len - buf.capacity());
        }
        buf.clear();
        buf.resize(len, 0);
        buf.as_mut_ptr()
    }
}

/// Reserve `len` bytes in the event scratch buffer and return a pointer
/// the JS worklet can write a single SAB event into. Followed by
/// `apply_event(len)`. The worklet drains its SAB ring and calls this
/// once per event — kept simple to avoid teaching wasm to own SAB views.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn event_buffer_reserve(len: usize) -> *mut u8 {
    unsafe {
        let buf = EVENT_BUF.get_or_insert_with(Vec::new);
        if buf.capacity() < len {
            buf.reserve(len - buf.capacity());
        }
        buf.clear();
        buf.resize(len, 0);
        buf.as_mut_ptr()
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn apply_event(len: usize) {
    unsafe {
        if let Some(buf) = EVENT_BUF.as_ref() {
            let bytes = &buf[..len.min(buf.len())];
            if let Ok(ev) = event::decode(bytes) {
                engine().apply_event(ev);
            }
        }
    }
}

/// Reserve `frames` f32 slots in the asset scratch and return a
/// pointer the host can write decoded PCM into. Followed by
/// `register_asset(asset_id, frames)`.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn asset_buffer_reserve(frames: usize) -> *mut f32 {
    unsafe {
        let buf = ASSET_BUF.get_or_insert_with(Vec::new);
        if buf.capacity() < frames {
            buf.reserve(frames - buf.capacity());
        }
        buf.clear();
        buf.resize(frames, 0.0);
        buf.as_mut_ptr()
    }
}

/// Copy the asset scratch into the engine's PCM cache under
/// `asset_id`. After this returns the buffer can be reused for the
/// next asset.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn register_asset(asset_id: u32, frames: usize) {
    unsafe {
        if let Some(buf) = ASSET_BUF.as_ref() {
            let take = frames.min(buf.len());
            let pcm: Vec<f32> = buf[..take].to_vec();
            engine().register_asset(asset_id, pcm);
        }
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn rebuild_project(len: usize) {
    unsafe {
        if let Some(buf) = SNAP_BUF.as_ref() {
            let bytes = &buf[..len.min(buf.len())];
            match snapshot::decode(bytes) {
                Ok(snap) => engine().apply_snapshot(&snap),
                Err(_) => {
                    // Snapshot decode failures are swallowed on the audio
                    // thread to avoid panics; the JS side validates before
                    // posting. M9 will add telemetry.
                }
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn process(ptr: *mut f32, len: usize) {
    unsafe {
        let buf = slice::from_raw_parts_mut(ptr, len);
        engine().process_mono(buf);
    }
}

// ---- Legacy single-track exports (Phase-0/1 UI back-compat) -----------
//
// M5 deletes these in favour of structural rebuilds. Until then, they
// route to track 0 so the existing Svelte UI keeps working.

#[no_mangle]
pub extern "C" fn set_step_mask(track: u32, i: u32, mask: u32) {
    if let Some(seq) = seq_at(track) {
        seq.set_step_mask(i, mask);
    }
}

#[no_mangle]
pub extern "C" fn set_playing(on: u32) {
    unsafe { engine().set_playing(on != 0) }
}

#[no_mangle]
pub extern "C" fn get_current_step() -> i32 {
    first_seq().map(|s| s.current_step()).unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn set_waveform(track: u32, w: u32) {
    let waveform = match w {
        1 => Waveform::Saw,
        2 => Waveform::Square,
        _ => Waveform::Sine,
    };
    if let Some(seq) = seq_at(track) {
        seq.set_waveform(waveform);
    }
}

// ---- Debug exports for e2e tests --------------------------------------

#[no_mangle]
pub extern "C" fn debug_track_gain(idx: u32) -> f32 {
    unsafe {
        engine()
            .tracks
            .get(idx as usize)
            .map(|t| t.gain)
            .unwrap_or(f32::NAN)
    }
}

#[no_mangle]
pub extern "C" fn debug_master_gain() -> f32 {
    unsafe { engine().master_gain }
}

#[no_mangle]
pub extern "C" fn debug_track_count() -> u32 {
    unsafe { engine().tracks.len() as u32 }
}

#[no_mangle]
pub extern "C" fn debug_track_peak(idx: u32) -> f32 {
    unsafe {
        engine()
            .tracks
            .get(idx as usize)
            .map(|t| t.peak)
            .unwrap_or(0.0)
    }
}

#[no_mangle]
pub extern "C" fn debug_current_tick() -> f64 {
    // u64 doesn't survive the f64 return path used by the worklet's
    // debug RPC, but Phase-1 ticks fit comfortably in 53 bits, so f64
    // is exact for any practical playhead position.
    unsafe { engine().current_tick() as f64 }
}

#[no_mangle]
pub extern "C" fn debug_bpm() -> f32 {
    unsafe { engine().tempo_map.bpm_at(engine().current_tick()) }
}

/// How many assets the engine's PCM cache currently holds. Used by
/// Phase-5 tests to confirm register_asset uploaded.
#[no_mangle]
pub extern "C" fn debug_asset_count() -> u32 {
    unsafe { engine().asset_cache.len() as u32 }
}

/// Engine-side loop region readback. Returns end_tick when set, 0
/// when no loop is active. Used to verify the snapshot wire format
/// preserves the loop region across the JS → engine boundary.
#[no_mangle]
pub extern "C" fn debug_loop_end() -> f64 {
    unsafe {
        engine()
            .loop_region
            .map(|lr| lr.end_tick as f64)
            .unwrap_or(0.0)
    }
}

/// Read back a plugin parameter from the addressed track. Returns NaN
/// if the track or parameter doesn't exist on the track's instrument.
/// Used by Phase-2 tests to verify the Y.Doc → SAB → engine round-trip.
#[no_mangle]
pub extern "C" fn debug_track_param(track: u32, id: u32) -> f32 {
    unsafe {
        engine()
            .tracks
            .get(track as usize)
            .and_then(|t| t.instrument.get_param(id))
            .unwrap_or(f32::NAN)
    }
}
