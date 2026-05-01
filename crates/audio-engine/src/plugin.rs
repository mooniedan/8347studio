// Phase-2 canonical Plugin trait. Same shape the public SDK will publish
// in Phase 7 — first-party plugins exercise it from day one so the seam
// stays honest.
//
// Audio-thread contract: `process`, `set_param`, and `handle_event` must
// be lock-free and allocation-free. `descriptors` is called off the
// audio thread (instantiation + UI bind only).

use core::any::Any;

/// Stable per-plugin parameter id. Matches the Y.Doc parameter map keys
/// so SetParam events on the SAB ring carry just `(id, f32)` and never
/// touch strings on the audio thread.
pub type ParamId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginKind {
    Instrument,
    Effect,
    Container,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamCurve {
    /// Slider position maps linearly to value.
    Linear,
    /// Slider position maps exponentially — used for frequency-like
    /// params so 1 kHz sits in the middle of a 20 Hz–20 kHz range.
    Exp,
    /// Value is in dB; UI clamps and labels accordingly.
    Db,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamUnit {
    None,
    Hz,
    Db,
    Seconds,
    Ms,
    Percent,
    Semitones,
    Cents,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamDescriptor {
    pub id: ParamId,
    pub name: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: ParamUnit,
    pub curve: ParamCurve,
    pub group: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginEvent {
    NoteOn { pitch: u8, velocity: u8 },
    NoteOff { pitch: u8 },
    MidiCc { cc: u8, value: u8 },
    AllNotesOff,
}

pub trait Plugin: Send + Any {
    fn descriptors(&self) -> &[ParamDescriptor] {
        &[]
    }

    fn set_param(&mut self, _id: ParamId, _value: f32) {}

    /// Read back the current value of a parameter. Default returns
    /// `None`; instruments that hold per-param state override.
    fn get_param(&self, _id: ParamId) -> Option<f32> {
        None
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    /// Render `frames` samples. `outputs[ch][..frames]` is overwritten
    /// (replace, not accumulate). `inputs` is empty for instruments;
    /// effects in Phase 4 will read from it.
    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize);

    /// Drop all internal state — release voices, zero filter memory —
    /// so the next process starts from silence.
    fn reset(&mut self) {}

    fn kind(&self) -> PluginKind {
        PluginKind::Instrument
    }

    // ---- Phase-1 carry-overs ----------------------------------------
    //
    // Default impls so new plugins ignore. M4 moves clip scheduling out
    // of the instrument so `set_playing` goes away; M5 routes everything
    // host-side through descriptors so `as_any_mut` / `voice_count_hint`
    // go away. Until then these keep the existing Sequencer wiring
    // compiling without a forklift rewrite.
    fn set_playing(&mut self, _on: bool) {}
    fn voice_count_hint(&self) -> Option<u32> {
        None
    }
    fn as_any_mut(&mut self) -> &mut dyn Any;
    /// Immutable downcast escape hatch — used by the engine to decide
    /// whether a snapshot's instrument shape matches the live one
    /// (avoids rebuilding voices on cosmetic edits).
    fn as_any(&self) -> &dyn Any;
}

/// No-op plugin for tracks without a loaded instrument.
pub struct Silence;

impl Plugin for Silence {
    fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        for ch in outputs.iter_mut() {
            for s in ch[..frames].iter_mut() {
                *s = 0.0;
            }
        }
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::boxed::Box;

    #[test]
    fn trait_is_object_safe() {
        let _: Box<dyn Plugin> = Box::new(Silence);
    }

    #[test]
    fn silence_zeros_outputs_up_to_frames() {
        let mut p = Silence;
        let mut buf = [1.0f32; 8];
        let mut outs: [&mut [f32]; 1] = [&mut buf[..]];
        p.process(&[], &mut outs, 8);
        assert!(buf.iter().all(|s| *s == 0.0));
    }

    /// Stub instrument that exercises every overridable method. Used as
    /// the canonical "did the trait survive a refactor?" probe.
    struct Stub {
        last_event: Option<PluginEvent>,
        gain: f32,
        descs: [ParamDescriptor; 1],
    }

    impl Stub {
        fn new() -> Self {
            Self {
                last_event: None,
                gain: 0.5,
                descs: [ParamDescriptor {
                    id: 0,
                    name: "gain",
                    min: 0.0,
                    max: 1.0,
                    default: 0.5,
                    unit: ParamUnit::None,
                    curve: ParamCurve::Linear,
                    group: "amp",
                }],
            }
        }
    }

    impl Plugin for Stub {
        fn descriptors(&self) -> &[ParamDescriptor] {
            &self.descs
        }
        fn set_param(&mut self, id: ParamId, v: f32) {
            if id == 0 {
                self.gain = v;
            }
        }
        fn handle_event(&mut self, ev: PluginEvent) {
            self.last_event = Some(ev);
        }
        fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
            for ch in outputs.iter_mut() {
                for s in ch[..frames].iter_mut() {
                    *s = self.gain;
                }
            }
        }
        fn reset(&mut self) {
            self.last_event = None;
            self.gain = 0.0;
        }
        fn as_any_mut(&mut self) -> &mut dyn Any {
            self
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    #[test]
    fn descriptors_advertise_param_metadata() {
        let s = Stub::new();
        let d = &s.descriptors()[0];
        assert_eq!(d.id, 0);
        assert_eq!(d.name, "gain");
        assert_eq!(d.unit, ParamUnit::None);
        assert_eq!(d.curve, ParamCurve::Linear);
    }

    #[test]
    fn set_param_changes_output() {
        let mut s = Stub::new();
        let mut buf = [0.0f32; 4];
        {
            let mut outs: [&mut [f32]; 1] = [&mut buf[..]];
            s.process(&[], &mut outs, 4);
        }
        assert!((buf[0] - 0.5).abs() < 1e-6);
        s.set_param(0, 0.25);
        {
            let mut outs: [&mut [f32]; 1] = [&mut buf[..]];
            s.process(&[], &mut outs, 4);
        }
        assert!((buf[0] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn handle_event_delivers_note_on() {
        let mut s = Stub::new();
        s.handle_event(PluginEvent::NoteOn {
            pitch: 60,
            velocity: 100,
        });
        assert_eq!(
            s.last_event,
            Some(PluginEvent::NoteOn {
                pitch: 60,
                velocity: 100
            })
        );
    }

    #[test]
    fn reset_clears_state() {
        let mut s = Stub::new();
        s.handle_event(PluginEvent::AllNotesOff);
        s.set_param(0, 0.9);
        s.reset();
        assert_eq!(s.last_event, None);
        assert_eq!(s.gain, 0.0);
    }

    #[test]
    fn kind_defaults_to_instrument() {
        let s = Stub::new();
        assert_eq!(s.kind(), PluginKind::Instrument);
    }
}
