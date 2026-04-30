use audio_engine::engine::Engine;
use audio_engine::oscillator::Waveform;
use audio_engine::sequencer::Sequencer;
use audio_engine::track::TrackEngine;
use core::slice;

static mut ENGINE: Option<Engine> = None;

#[allow(static_mut_refs)]
unsafe fn engine() -> &'static mut Engine {
    ENGINE.as_mut().expect("init not called")
}

/// M2 ships a single MIDI track at index 0 wrapping the existing step
/// sequencer. M3+ will let the host add/remove tracks through the
/// structural channel; for now the legacy single-track UI keeps working
/// because every export below routes to track 0.
unsafe fn seq0() -> &'static mut Sequencer {
    let track = engine()
        .track_mut(0)
        .expect("track 0 missing — init not called");
    track
        .instrument
        .as_any_mut()
        .downcast_mut::<Sequencer>()
        .expect("track 0 instrument is not a Sequencer")
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let mut engine = Engine::new();
    let seq = Sequencer::new(sample_rate);
    engine.add_track(TrackEngine::new(Box::new(seq)));
    unsafe {
        ENGINE = Some(engine);
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut f32 {
    let mut v = Vec::<f32>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

#[no_mangle]
pub extern "C" fn process(ptr: *mut f32, len: usize) {
    unsafe {
        let buf = slice::from_raw_parts_mut(ptr, len);
        engine().process_mono(buf);
    }
}

#[no_mangle]
pub extern "C" fn set_step_mask(i: u32, mask: u32) {
    unsafe { seq0().set_step_mask(i, mask) }
}

#[no_mangle]
pub extern "C" fn set_bpm(bpm: f32) {
    unsafe { seq0().set_bpm(bpm) }
}

#[no_mangle]
pub extern "C" fn set_playing(on: u32) {
    // Route through Engine so transport state propagates to every track
    // (only one in M2, but the wiring is right for M3+).
    unsafe { engine().set_playing(on != 0) }
}

#[no_mangle]
pub extern "C" fn get_current_step() -> i32 {
    unsafe { seq0().current_step() }
}

#[no_mangle]
pub extern "C" fn set_waveform(w: u32) {
    let waveform = match w {
        1 => Waveform::Saw,
        2 => Waveform::Square,
        _ => Waveform::Sine,
    };
    unsafe { seq0().set_waveform(waveform) }
}
