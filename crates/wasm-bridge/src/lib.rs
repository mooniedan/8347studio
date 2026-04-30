use audio_engine::oscillator::Waveform;
use audio_engine::sequencer::Sequencer;
use core::slice;

static mut SEQ: Option<Sequencer> = None;

#[allow(static_mut_refs)]
unsafe fn seq() -> &'static mut Sequencer {
    SEQ.as_mut().expect("init not called")
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe {
        SEQ = Some(Sequencer::new(sample_rate));
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
        seq().process(buf);
    }
}

#[no_mangle]
pub extern "C" fn set_step_mask(i: u32, mask: u32) {
    unsafe { seq().set_step_mask(i, mask) }
}

#[no_mangle]
pub extern "C" fn set_bpm(bpm: f32) {
    unsafe { seq().set_bpm(bpm) }
}

#[no_mangle]
pub extern "C" fn set_playing(on: u32) {
    unsafe { seq().set_playing(on != 0) }
}

#[no_mangle]
pub extern "C" fn get_current_step() -> i32 {
    unsafe { seq().current_step() }
}

#[no_mangle]
pub extern "C" fn set_waveform(w: u32) {
    let waveform = match w {
        1 => Waveform::Saw,
        2 => Waveform::Square,
        _ => Waveform::Sine,
    };
    unsafe { seq().set_waveform(waveform) }
}
