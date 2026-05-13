use crate::oscillator::{Oscillator, Waveform};
use crate::plugin::Plugin;

const STEPS: u32 = 16;
const NOTES: u32 = 25;
const LOW_MIDI: u32 = 48; // C3; bit k of a step mask = MIDI note LOW_MIDI + k
const MAX_VOICES: usize = 8;
const VOICE_GAIN: f32 = 0.25;

enum EnvPhase {
    Idle,
    Attack,
    Hold,
    Release,
}

struct Envelope {
    attack: f32,
    release: f32,
    phase: EnvPhase,
    pos: f32,
    release_from: f32,
}

impl Envelope {
    fn new(sample_rate: f32) -> Self {
        Self {
            attack: sample_rate * 0.005,
            release: sample_rate * 0.08,
            phase: EnvPhase::Idle,
            pos: 0.0,
            release_from: 0.0,
        }
    }

    fn trigger(&mut self) {
        self.phase = EnvPhase::Attack;
        self.pos = 0.0;
    }

    fn release(&mut self) {
        self.release_from = self.level();
        self.phase = EnvPhase::Release;
        self.pos = 0.0;
    }

    fn is_idle(&self) -> bool {
        matches!(self.phase, EnvPhase::Idle)
    }

    fn is_held(&self) -> bool {
        matches!(self.phase, EnvPhase::Attack | EnvPhase::Hold)
    }

    fn level(&self) -> f32 {
        match self.phase {
            EnvPhase::Idle => 0.0,
            EnvPhase::Attack => self.pos / self.attack,
            EnvPhase::Hold => 1.0,
            EnvPhase::Release => {
                let r = (1.0 - self.pos / self.release).max(0.0);
                self.release_from * r
            }
        }
    }

    fn next(&mut self) -> f32 {
        let v = self.level();
        match self.phase {
            EnvPhase::Idle | EnvPhase::Hold => {}
            EnvPhase::Attack => {
                self.pos += 1.0;
                if self.pos >= self.attack {
                    self.phase = EnvPhase::Hold;
                    self.pos = 0.0;
                }
            }
            EnvPhase::Release => {
                self.pos += 1.0;
                if self.pos >= self.release {
                    self.phase = EnvPhase::Idle;
                    self.pos = 0.0;
                }
            }
        }
        v
    }
}

struct Voice {
    osc: Oscillator,
    env: Envelope,
    /// MIDI note this voice is playing, or -1 if never triggered.
    midi: i32,
    /// Monotonic trigger tick. Lower value = older voice (steal first).
    last_triggered: u64,
}

impl Voice {
    fn new(sample_rate: f32) -> Self {
        let mut osc = Oscillator::new(sample_rate);
        osc.set_gain(VOICE_GAIN);
        Self {
            osc,
            env: Envelope::new(sample_rate),
            midi: -1,
            last_triggered: 0,
        }
    }
}

/// Default ticks per 1/16 step at PPQ=960. The engine drives the
/// step pointer from its tick clock, so this matches the StepSeq
/// clip's `stepTicks` field in project.ts.
pub const DEFAULT_TICKS_PER_STEP: u32 = 240;

pub struct Sequencer {
    voices: [Voice; MAX_VOICES],
    next_trigger_tick: u64,
    /// Per-step bitmask of active notes; bit k = MIDI note LOW_MIDI + k.
    steps: [u32; STEPS as usize],
    current_step: u32,
    /// Ticks per step (PPQ-relative). Settable; default 240 (1/16 at PPQ=960).
    ticks_per_step: u32,
    playing: bool,
    /// Force a reconcile on the next `advance_to_tick`. Set when
    /// transport starts so step-0 fires even when tick is already 0.
    needs_initial_reconcile: bool,
}

fn midi_to_hz(m: f32) -> f32 {
    440.0 * libm::exp2f((m - 69.0) / 12.0)
}

impl Sequencer {
    pub fn new(sample_rate: f32) -> Self {
        let voices = core::array::from_fn(|_| Voice::new(sample_rate));
        Self {
            voices,
            next_trigger_tick: 1,
            steps: [0; STEPS as usize],
            current_step: 0,
            ticks_per_step: DEFAULT_TICKS_PER_STEP,
            playing: false,
            needs_initial_reconcile: false,
        }
    }

    /// Replace active notes at step `i` with `mask`.
    /// Only the lower `NOTES` bits are honored.
    pub fn set_step_mask(&mut self, i: u32, mask: u32) {
        if (i as usize) < self.steps.len() {
            self.steps[i as usize] = mask & ((1 << NOTES) - 1);
        }
    }

    pub fn set_ticks_per_step(&mut self, t: u32) {
        if t > 0 {
            self.ticks_per_step = t;
        }
    }

    pub fn set_playing(&mut self, on: bool) {
        self.playing = on;
        if !on {
            self.current_step = 0;
            // Release any sustained voices so they fade instead of holding forever.
            for v in self.voices.iter_mut() {
                if v.env.is_held() {
                    v.env.release();
                }
            }
        } else {
            // Re-arm initial reconcile so step-0 (or whatever step
            // the engine's tick maps to on first block) fires.
            self.needs_initial_reconcile = true;
        }
    }

    /// Engine drives the step pointer from its tick clock. Called every
    /// audio block with the tick range covered by the block. Fires
    /// `reconcile_step` for every step boundary `k * ticks_per_step`
    /// that falls in the half-open interval `[prev_tick, next_tick)`.
    /// Eliminates the truncation drift that the old self-clocking
    /// `samples_per_step` counter accumulated relative to piano-roll
    /// tracks (~7 samples/bar at 48 kHz / 110 BPM).
    pub fn advance_for_window(&mut self, prev_tick: u64, next_tick: u64) {
        if !self.playing {
            return;
        }
        let s = self.ticks_per_step as u64;
        // Force-fire the floor-step at prev_tick on the first call after
        // set_playing(true), even if no boundary falls inside the window
        // (covers the transport-resume-mid-step case).
        let mut t = if self.needs_initial_reconcile {
            let step = ((prev_tick / s) % STEPS as u64) as u32;
            self.current_step = step;
            let mask = self.steps[step as usize];
            self.reconcile_step(mask);
            self.needs_initial_reconcile = false;
            // Next regular boundary to consider is strictly after prev_tick.
            (prev_tick / s + 1) * s
        } else {
            // First boundary at or after prev_tick.
            ((prev_tick + s - 1) / s) * s
        };
        // Safety cap: one full lap should be more than any realistic
        // audio block. Prevents pathological runaway on huge windows.
        let mut count = 0usize;
        while t < next_tick && count <= STEPS as usize {
            let step = ((t / s) % STEPS as u64) as u32;
            let mask = self.steps[step as usize];
            self.reconcile_step(mask);
            self.current_step = step;
            t = t.saturating_add(s);
            count += 1;
        }
    }

    pub fn set_waveform(&mut self, w: Waveform) {
        for v in self.voices.iter_mut() {
            v.osc.set_waveform(w);
        }
    }

    /// Current playhead step, or -1 when stopped.
    pub fn current_step(&self) -> i32 {
        if self.playing {
            self.current_step as i32
        } else {
            -1
        }
    }

    fn trigger_voice(&mut self, midi: u32) {
        let tick = self.next_trigger_tick;
        self.next_trigger_tick = tick.wrapping_add(1);
        // Prefer idle voices; then fading (released) voices; then oldest held voice.
        let idx = self
            .voices
            .iter()
            .position(|v| v.env.is_idle())
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| (v.env.is_held(), v.last_triggered))
                    .map(|(i, _)| i)
                    .unwrap()
            });
        let v = &mut self.voices[idx];
        v.osc.set_frequency(midi_to_hz(midi as f32));
        v.env.trigger();
        v.midi = midi as i32;
        v.last_triggered = tick;
    }

    /// Reconcile held voices with the mask of the step we're about to enter:
    /// release any held note that's no longer in the mask, and trigger only
    /// new notes. Notes present in consecutive steps sustain without re-attack.
    fn reconcile_step(&mut self, mask: u32) {
        for idx in 0..MAX_VOICES {
            let v = &self.voices[idx];
            if !v.env.is_held() || v.midi < LOW_MIDI as i32 {
                continue;
            }
            let k = v.midi as u32 - LOW_MIDI;
            if k >= NOTES || (mask & (1 << k)) == 0 {
                self.voices[idx].env.release();
            }
        }
        for k in 0..NOTES {
            if mask & (1 << k) == 0 {
                continue;
            }
            let midi = (LOW_MIDI + k) as i32;
            let already_held = self
                .voices
                .iter()
                .any(|v| v.env.is_held() && v.midi == midi);
            if !already_held {
                self.trigger_voice(LOW_MIDI + k);
            }
        }
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        // Audio-only: step transitions are driven by `advance_to_tick`
        // from the engine. This loop just renders voices.
        for s in buf.iter_mut() {
            let mut mix = 0.0;
            for v in self.voices.iter_mut() {
                mix += v.osc.next_sample() * v.env.next();
            }
            *s = mix;
        }
    }
}

impl Plugin for Sequencer {
    fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        if let Some(ch) = outputs.get_mut(0) {
            Sequencer::process(self, &mut ch[..frames]);
        }
    }

    fn set_playing(&mut self, on: bool) {
        Sequencer::set_playing(self, on);
    }

    fn voice_count_hint(&self) -> Option<u32> {
        Some(MAX_VOICES as u32)
    }

    fn reset(&mut self) {
        for v in self.voices.iter_mut() {
            if v.env.is_held() {
                v.env.release();
            }
        }
    }

    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }

    fn as_any(&self) -> &dyn core::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note_bit(midi: u32) -> u32 {
        1 << (midi - LOW_MIDI)
    }

    // Helper: cover the window leading into `step` so the boundary fires,
    // then render audio. Caller treats each call as "step `step` just
    // started".
    fn render_at_step(seq: &mut Sequencer, step: u32, frames: usize) -> alloc::vec::Vec<f32> {
        let s = DEFAULT_TICKS_PER_STEP as u64;
        let prev = step.saturating_sub(if step == 0 { 0 } else { 1 }) as u64 * s;
        let next = step as u64 * s + 1;
        seq.advance_for_window(prev, next);
        let mut buf = alloc::vec![0.0f32; frames];
        seq.process(&mut buf);
        buf
    }

    #[test]
    fn silent_when_stopped() {
        let mut seq = Sequencer::new(48_000.0);
        for i in 0..16 {
            seq.set_step_mask(i, note_bit(60));
        }
        let mut buf = [0.0f32; 1024];
        seq.process(&mut buf);
        assert!(buf.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn emits_audio_when_playing_with_active_steps() {
        let mut seq = Sequencer::new(48_000.0);
        seq.set_step_mask(0, note_bit(69));
        seq.set_playing(true);
        let buf = render_at_step(&mut seq, 0, 4800);
        let peak = buf.iter().cloned().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.05, "peak was {peak}");
        assert!(buf.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn chord_is_louder_than_single_note() {
        let mut single = Sequencer::new(48_000.0);
        single.set_step_mask(0, note_bit(60));
        single.set_playing(true);
        let a = render_at_step(&mut single, 0, 4800);
        let peak_single = a.iter().cloned().fold(0.0f32, |x, y| x.max(y.abs()));

        let mut chord = Sequencer::new(48_000.0);
        chord.set_step_mask(0, note_bit(60) | note_bit(64) | note_bit(67));
        chord.set_playing(true);
        let b = render_at_step(&mut chord, 0, 4800);
        let peak_chord = b.iter().cloned().fold(0.0f32, |x, y| x.max(y.abs()));

        assert!(b.iter().all(|s| s.is_finite()));
        assert!(
            peak_chord > peak_single * 1.5,
            "chord peak {peak_chord} not substantially louder than single {peak_single}"
        );
    }

    #[test]
    fn voice_stealing_never_clips_or_nans_with_many_notes() {
        let mut seq = Sequencer::new(48_000.0);
        // All 25 notes on step 0 — exceeds MAX_VOICES, forces stealing.
        seq.set_step_mask(0, (1 << NOTES) - 1);
        seq.set_playing(true);
        let buf = render_at_step(&mut seq, 0, 9600);
        assert!(buf.iter().all(|s| s.is_finite()));
        let held: usize = seq.voices.iter().filter(|v| v.env.is_held()).count();
        assert!(held <= MAX_VOICES);
    }

    #[test]
    fn adjacent_same_note_sustains_without_retrigger() {
        let mut seq = Sequencer::new(48_000.0);
        let mask = note_bit(60);
        seq.set_step_mask(0, mask);
        seq.set_step_mask(1, mask);
        seq.set_step_mask(2, mask);
        seq.set_playing(true);
        // Advance through three step boundaries.
        let _ = render_at_step(&mut seq, 0, 100);
        let _ = render_at_step(&mut seq, 1, 100);
        let _ = render_at_step(&mut seq, 2, 100);
        // next_trigger_tick starts at 1 and increments on each trigger.
        // Three sustained steps should cause exactly one trigger.
        assert_eq!(seq.next_trigger_tick, 2);
    }

    #[test]
    fn adjacent_different_notes_still_retrigger() {
        let mut seq = Sequencer::new(48_000.0);
        seq.set_step_mask(0, note_bit(60));
        seq.set_step_mask(1, note_bit(62));
        seq.set_playing(true);
        let _ = render_at_step(&mut seq, 0, 100);
        let _ = render_at_step(&mut seq, 1, 100);
        assert_eq!(seq.next_trigger_tick, 3);
    }

    #[test]
    fn note_releases_when_next_step_is_empty() {
        let mut seq = Sequencer::new(48_000.0);
        seq.set_step_mask(0, note_bit(60));
        // step 1 is empty
        seq.set_playing(true);
        let _ = render_at_step(&mut seq, 0, 1000);
        // Step into an empty mask: held voice should release.
        let _ = render_at_step(&mut seq, 1, 4000);
        assert!(
            seq.voices.iter().all(|v| v.env.is_idle()),
            "expected all voices idle after release tail"
        );
    }

    #[test]
    fn held_chord_partial_change_only_retriggers_new_note() {
        let mut seq = Sequencer::new(48_000.0);
        // Step 0: C major. Step 1: keep C and G, swap E for F.
        seq.set_step_mask(0, note_bit(60) | note_bit(64) | note_bit(67));
        seq.set_step_mask(1, note_bit(60) | note_bit(65) | note_bit(67));
        seq.set_playing(true);
        let _ = render_at_step(&mut seq, 0, 100);
        let _ = render_at_step(&mut seq, 1, 100);
        // Initial triggers: 3 notes → tick goes 1→4. At step 1 boundary,
        // only F is new, one more trigger → tick should be 5.
        assert_eq!(seq.next_trigger_tick, 5);
    }

    #[test]
    fn current_step_is_minus_one_when_stopped() {
        let seq = Sequencer::new(48_000.0);
        assert_eq!(seq.current_step(), -1);
    }

    #[test]
    fn current_step_follows_engine_tick() {
        let s = DEFAULT_TICKS_PER_STEP as u64;
        let mut seq = Sequencer::new(48_000.0);
        seq.set_playing(true);
        // First block from 0 covering one step's worth: fires step 0.
        seq.advance_for_window(0, s);
        assert_eq!(seq.current_step(), 0);
        // Next block covers [s, 2s): fires step 1.
        seq.advance_for_window(s, 2 * s);
        assert_eq!(seq.current_step(), 1);
        // Skip forward — STEPS boundaries crossed; we wrap back to step 0.
        seq.advance_for_window(2 * s, STEPS as u64 * s + 1);
        assert_eq!(seq.current_step(), 0);
        seq.set_playing(false);
        assert_eq!(seq.current_step(), -1);
    }

    #[test]
    fn advance_when_stopped_is_a_noop() {
        let mut seq = Sequencer::new(48_000.0);
        seq.set_step_mask(0, note_bit(60));
        seq.advance_for_window(0, DEFAULT_TICKS_PER_STEP as u64);
        // No reconcile because not playing — no triggers should have fired.
        assert_eq!(seq.next_trigger_tick, 1);
    }

    #[test]
    fn empty_pattern_stays_silent() {
        let mut seq = Sequencer::new(48_000.0);
        seq.set_playing(true);
        let buf = render_at_step(&mut seq, 0, 4800);
        assert!(buf.iter().all(|s| *s == 0.0));
    }
}
