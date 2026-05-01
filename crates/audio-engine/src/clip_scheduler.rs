// Track-level clip scheduler. The engine advances `current_tick` per
// audio block; for every note whose start or end falls inside the
// block's tick window the scheduler fires a PluginEvent into the
// track's instrument.
//
// Phase-1's Sequencer plugin owns its own scheduling inside `process`.
// Phase-2 introduces this track-level scheduler so PianoRoll clips can
// drive any plugin (subtractive synth in M2, third-party plugins in
// Phase 7) by emitting NoteOn / NoteOff events. StepSeq clips continue
// to flow through the Sequencer plugin until a later phase migrates
// step patterns to events too.

use alloc::vec::Vec;

use crate::plugin::{Plugin, PluginEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduledNote {
    pub pitch: u8,
    pub velocity: u8,
    pub start_tick: u64,
    pub end_tick: u64,
}

#[derive(Default)]
pub struct ClipScheduler {
    notes: Vec<ScheduledNote>,
}

impl ClipScheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn replace_notes(&mut self, notes: Vec<ScheduledNote>) {
        self.notes = notes;
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }

    pub fn note_count(&self) -> usize {
        self.notes.len()
    }

    /// Fire NoteOn / NoteOff into `plugin` for any note whose start or
    /// end tick falls in `[prev_tick, next_tick)`. Block-quantized — a
    /// future polish pass can fire with sample-accurate offsets.
    pub fn fire_for_block(&self, prev_tick: u64, next_tick: u64, plugin: &mut dyn Plugin) {
        if next_tick <= prev_tick {
            return;
        }
        for n in &self.notes {
            if n.start_tick >= prev_tick && n.start_tick < next_tick {
                plugin.handle_event(PluginEvent::NoteOn {
                    pitch: n.pitch,
                    velocity: n.velocity,
                });
            }
            if n.end_tick >= prev_tick && n.end_tick < next_tick {
                plugin.handle_event(PluginEvent::NoteOff { pitch: n.pitch });
            }
        }
    }

    /// Release every active note. Used when transport stops — prevents
    /// notes that started before the stop point from hanging.
    pub fn release_all(&self, plugin: &mut dyn Plugin) {
        plugin.handle_event(PluginEvent::AllNotesOff);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{ParamId, Plugin, PluginEvent};
    use alloc::vec;
    use core::any::Any;

    #[derive(Default)]
    struct Sink {
        events: Vec<PluginEvent>,
    }

    impl Plugin for Sink {
        fn process(&mut self, _i: &[&[f32]], _o: &mut [&mut [f32]], _f: usize) {}
        fn set_param(&mut self, _: ParamId, _: f32) {}
        fn handle_event(&mut self, ev: PluginEvent) {
            self.events.push(ev);
        }
        fn as_any_mut(&mut self) -> &mut dyn Any {
            self
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    #[test]
    fn fires_note_on_when_start_in_window() {
        let mut sched = ClipScheduler::new();
        sched.replace_notes(vec![ScheduledNote {
            pitch: 60,
            velocity: 100,
            start_tick: 50,
            end_tick: 100,
        }]);
        let mut sink = Sink::default();
        sched.fire_for_block(0, 60, &mut sink);
        assert_eq!(sink.events.len(), 1);
        assert!(matches!(
            sink.events[0],
            PluginEvent::NoteOn {
                pitch: 60,
                velocity: 100
            }
        ));
    }

    #[test]
    fn fires_note_off_when_end_in_window() {
        let mut sched = ClipScheduler::new();
        sched.replace_notes(vec![ScheduledNote {
            pitch: 64,
            velocity: 90,
            start_tick: 0,
            end_tick: 200,
        }]);
        let mut sink = Sink::default();
        // Block straddles the note end.
        sched.fire_for_block(180, 220, &mut sink);
        assert_eq!(sink.events.len(), 1);
        assert!(matches!(sink.events[0], PluginEvent::NoteOff { pitch: 64 }));
    }

    #[test]
    fn skips_notes_outside_window() {
        let mut sched = ClipScheduler::new();
        sched.replace_notes(vec![ScheduledNote {
            pitch: 60,
            velocity: 100,
            start_tick: 1000,
            end_tick: 1100,
        }]);
        let mut sink = Sink::default();
        sched.fire_for_block(0, 100, &mut sink);
        assert!(sink.events.is_empty());
    }

    #[test]
    fn empty_window_fires_nothing() {
        let mut sched = ClipScheduler::new();
        sched.replace_notes(vec![ScheduledNote {
            pitch: 60,
            velocity: 100,
            start_tick: 0,
            end_tick: 100,
        }]);
        let mut sink = Sink::default();
        sched.fire_for_block(50, 50, &mut sink);
        assert!(sink.events.is_empty());
    }

    #[test]
    fn release_all_fires_all_notes_off() {
        let sched = ClipScheduler::new();
        let mut sink = Sink::default();
        sched.release_all(&mut sink);
        assert_eq!(sink.events.len(), 1);
        assert_eq!(sink.events[0], PluginEvent::AllNotesOff);
    }
}
