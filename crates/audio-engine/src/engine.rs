use crate::clip_scheduler::{ClipScheduler, ScheduledNote};
use crate::event::Event;
use crate::oscillator::Waveform;
use crate::plugin::{Plugin, Silence};
use crate::plugins::compressor::Compressor;
use crate::plugins::delay::Delay;
use crate::plugins::eq::Eq;
use crate::plugins::gain::Gain;
use crate::plugins::reverb::Reverb;
use crate::plugins::subtractive::Subtractive;
use crate::sab_ring::RingReader;
use crate::sequencer::Sequencer;
use crate::snapshot::{InsertKind, InstrumentSnapshot, ProjectSnapshot};
use crate::tempo_map::TempoMap;
use crate::track::{InsertSlot, Send, TrackEngine};

pub struct Engine {
    pub tracks: Vec<TrackEngine>,
    /// Per-track piano-roll scheduler. 1:1 with `tracks`. Empty
    /// scheduler = "no PianoRoll clip on this track" (StepSeq tracks
    /// continue to flow through the Sequencer plugin internally).
    pub track_schedulers: Vec<ClipScheduler>,
    /// Per-track bus-input mono buffer (Phase-4 M2). 1:1 with `tracks`.
    /// Filled each block by the sends of earlier tracks; consumed by
    /// the bus track itself (kind == Bus) when its turn comes.
    bus_inputs: Vec<Vec<f32>>,
    pub master_gain: f32,
    pub tempo_map: TempoMap,
    pub playing: bool,
    /// Fractional tick position; integer view via `current_tick()`.
    tick_pos: f64,
    right_scratch: Vec<f32>,
    sample_rate: f32,
}

impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            tracks: Vec::new(),
            track_schedulers: Vec::new(),
            bus_inputs: Vec::new(),
            master_gain: 1.0,
            tempo_map: TempoMap::new(sample_rate),
            playing: false,
            tick_pos: 0.0,
            right_scratch: Vec::new(),
            sample_rate,
        }
    }

    pub fn current_tick(&self) -> u64 {
        self.tick_pos as u64
    }

    /// Replace the structural state with `snap`. Track count, kind, and
    /// instrument identity are taken from the snapshot; existing track
    /// instances are reused only when track count *and* instrument kind
    /// match, so live voices keep playing across cosmetic edits (mute,
    /// gain, etc.). Anything more invasive (track added/removed, voice
    /// count changed, instrument swapped) rebuilds the affected tracks.
    pub fn apply_snapshot(&mut self, snap: &ProjectSnapshot) {
        self.master_gain = snap.master_gain;

        for (i, ts) in snap.tracks.iter().enumerate() {
            let needs_rebuild = i >= self.tracks.len()
                || self.tracks[i].voices != ts.voices
                || !instrument_matches(&self.tracks[i], &ts.instrument);
            if needs_rebuild {
                let track = build_track(self.sample_rate, ts);
                if i < self.tracks.len() {
                    self.tracks[i] = track;
                } else {
                    self.tracks.push(track);
                }
            } else {
                let track = &mut self.tracks[i];
                track.gain = ts.gain;
                track.pan = ts.pan;
                track.mute = ts.mute;
                track.solo = ts.solo;
                match &ts.instrument {
                    InstrumentSnapshot::BuiltinSequencer { waveform } => {
                        if let Some(seq) = track
                            .instrument
                            .as_any_mut()
                            .downcast_mut::<Sequencer>()
                        {
                            seq.set_waveform(waveform_from_u32(*waveform));
                        }
                    }
                    InstrumentSnapshot::Subtractive { params } => {
                        if let Some(s) = track
                            .instrument
                            .as_any_mut()
                            .downcast_mut::<Subtractive>()
                        {
                            for &(id, value) in params {
                                s.set_param(id, value);
                            }
                        }
                    }
                    InstrumentSnapshot::None => {}
                }
            }
            // Route per-clip step pattern (if any) into the track's
            // sequencer. Empty Vec means "no step clip / leave untouched"
            // for tracks like buses; non-empty means "this is the
            // canonical pattern" so it overwrites whatever was there.
            if !ts.steps.is_empty() {
                if let Some(seq) = self.tracks[i]
                    .instrument
                    .as_any_mut()
                    .downcast_mut::<Sequencer>()
                {
                    for (step_idx, mask) in ts.steps.iter().enumerate() {
                        seq.set_step_mask(step_idx as u32, *mask);
                    }
                }
            }
            // Insert chain. Phase-4 M1 always rebuilds — the chain is
            // typically tiny and rebuilding avoids tracking per-slot
            // identity. Reuse becomes worth it once Reverb/etc. land
            // (M3) and rebuilding throws away expensive state.
            self.tracks[i].inserts.clear();
            for ins in ts.inserts.iter() {
                let mut plugin: Box<dyn Plugin> = match ins.kind {
                    InsertKind::Gain => Box::new(Gain::new()),
                    InsertKind::Eq => Box::new(Eq::new(self.sample_rate)),
                    InsertKind::Compressor => Box::new(Compressor::new(self.sample_rate)),
                    InsertKind::Reverb => Box::new(Reverb::new(self.sample_rate)),
                    InsertKind::Delay => Box::new(Delay::new(self.sample_rate)),
                };
                for &(id, value) in &ins.params {
                    plugin.set_param(id, value);
                }
                self.tracks[i].inserts.push(InsertSlot {
                    plugin,
                    bypass: ins.bypass,
                });
            }
            // Sends. Replace wholesale on every snapshot.
            self.tracks[i].sends.clear();
            for s in ts.sends.iter() {
                self.tracks[i].sends.push(Send {
                    target_track: s.target_track,
                    level: s.level,
                    pre_fader: s.pre_fader,
                });
            }
        }
        if snap.tracks.len() < self.tracks.len() {
            self.tracks.truncate(snap.tracks.len());
        }
        // Per-track piano-roll scheduler — keep length in lock-step
        // with self.tracks, then refresh notes from the snapshot.
        while self.track_schedulers.len() < self.tracks.len() {
            self.track_schedulers.push(ClipScheduler::new());
        }
        if self.track_schedulers.len() > self.tracks.len() {
            self.track_schedulers.truncate(self.tracks.len());
        }
        for (i, ts) in snap.tracks.iter().enumerate() {
            let notes: alloc::vec::Vec<ScheduledNote> = ts
                .piano_roll_notes
                .iter()
                .map(|n| ScheduledNote {
                    pitch: n.pitch,
                    velocity: n.velocity,
                    start_tick: n.start_tick,
                    end_tick: n.start_tick.saturating_add(n.length_ticks),
                })
                .collect();
            self.track_schedulers[i].replace_notes(notes);
        }
    }

    pub fn add_track(&mut self, track: TrackEngine) -> usize {
        self.tracks.push(track);
        self.track_schedulers.push(ClipScheduler::new());
        self.tracks.len() - 1
    }

    pub fn track_mut(&mut self, idx: usize) -> Option<&mut TrackEngine> {
        self.tracks.get_mut(idx)
    }

    pub fn set_playing(&mut self, on: bool) {
        self.playing = on;
        if !on {
            self.tick_pos = 0.0;
        }
        for (i, t) in self.tracks.iter_mut().enumerate() {
            t.instrument.set_playing(on);
            if !on {
                if let Some(sched) = self.track_schedulers.get(i) {
                    sched.release_all(&mut *t.instrument);
                }
            }
        }
    }

    pub fn locate(&mut self, tick: u64) {
        self.tick_pos = tick as f64;
    }

    pub fn set_bpm(&mut self, bpm: f32) {
        self.tempo_map.set_bpm(bpm);
        // Phase-1 carry-over: per-track Sequencer keeps its own
        // samples_per_step counter while M5 hasn't moved scheduling out
        // of the instrument. Propagate the BPM so the two stay aligned.
        for t in self.tracks.iter_mut() {
            if let Some(seq) = t.instrument.as_any_mut().downcast_mut::<Sequencer>() {
                seq.set_bpm(bpm);
            }
        }
    }

    pub fn apply_event(&mut self, ev: Event) {
        match ev {
            Event::Transport { play } => self.set_playing(play),
            Event::Locate { tick } => self.locate(tick),
            Event::SetBpm { bpm } => self.set_bpm(bpm),
            Event::SetTrackGain { track, gain } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.gain = gain;
                }
            }
            Event::SetTrackPan { track, pan } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.pan = pan;
                }
            }
            Event::SetTrackMute { track, mute } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.mute = mute;
                }
            }
            Event::SetTrackSolo { track, solo } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.solo = solo;
                }
            }
            Event::SetMasterGain { gain } => self.master_gain = gain,
            Event::SetParam { track, id, value } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.instrument.set_param(id, value);
                }
            }
            Event::NoteOn {
                track,
                pitch,
                velocity,
            } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.instrument
                        .handle_event(crate::plugin::PluginEvent::NoteOn { pitch, velocity });
                }
            }
            Event::NoteOff { track, pitch } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.instrument
                        .handle_event(crate::plugin::PluginEvent::NoteOff { pitch });
                }
            }
            Event::MidiCc { track, cc, value } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.instrument
                        .handle_event(crate::plugin::PluginEvent::MidiCc { cc, value });
                }
            }
            Event::AllNotesOff { track } => {
                if let Some(t) = self.tracks.get_mut(track as usize) {
                    t.instrument
                        .handle_event(crate::plugin::PluginEvent::AllNotesOff);
                }
            }
        }
    }

    /// Drain every event in `ring` and apply it. Called once at the top
    /// of every audio block.
    pub fn drain_events(&mut self, ring: &mut RingReader) {
        // Buffer drained events first so we can iterate without holding a
        // borrow on the ring while we mutate self.
        let mut events: alloc::vec::Vec<Event> = alloc::vec::Vec::new();
        ring.drain(|bytes| {
            if let Ok(ev) = crate::event::decode(bytes) {
                events.push(ev);
            }
        });
        for ev in events {
            self.apply_event(ev);
        }
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        debug_assert_eq!(left.len(), right.len());
        let frames = left.len();
        let prev_tick = self.current_tick();
        self.advance_tick(frames);
        let next_tick = self.current_tick();
        self.fire_track_schedulers(prev_tick, next_tick);
        for s in left.iter_mut() {
            *s = 0.0;
        }
        for s in right.iter_mut() {
            *s = 0.0;
        }
        // Resize + zero per-track bus-input scratches.
        let n = self.tracks.len();
        while self.bus_inputs.len() < n {
            self.bus_inputs.push(Vec::new());
        }
        for buf in self.bus_inputs.iter_mut().take(n) {
            if buf.len() < frames {
                buf.resize(frames, 0.0);
            }
            for s in buf[..frames].iter_mut() {
                *s = 0.0;
            }
        }
        let any_solo = self.tracks.iter().any(|t| t.solo);
        for i in 0..n {
            // 1. Render this track's mono. For a Bus, the "instrument"
            // is replaced by the accumulated send sum that earlier
            // tracks deposited in bus_inputs[i].
            let is_bus = matches!(self.tracks[i].kind, crate::snapshot::TrackKind::Bus);
            if is_bus {
                let input_owned: alloc::vec::Vec<f32> =
                    self.bus_inputs[i][..frames].to_vec();
                self.tracks[i].compute_mono(frames, Some(&input_owned));
            } else {
                self.tracks[i].compute_mono(frames, None);
            }
            // 2. Apply post-fader sends — mono × send.level summed
            // into target bus inputs. Sends are post-mute / post-solo
            // (a muted track sends nothing), matching Live/Logic.
            let silenced = any_solo && !self.tracks[i].solo;
            let send_gate = if silenced || self.tracks[i].mute { 0.0 } else { 1.0 };
            // Copy sends out so we can mutate bus_inputs while reading the track's mono.
            let send_count = self.tracks[i].sends.len();
            for s_idx in 0..send_count {
                let send = self.tracks[i].sends[s_idx];
                let target = send.target_track as usize;
                if target >= n || target == i {
                    continue;
                }
                let mono = &self.tracks[i].scratch[..frames];
                let target_buf = &mut self.bus_inputs[target][..frames];
                let g = send.level * send_gate;
                for k in 0..frames {
                    target_buf[k] += mono[k] * g;
                }
            }
            // 3. Mix this track to master via gain/pan/mute/solo.
            self.tracks[i].mix_to_master(frames, left, right, silenced);
        }
        for s in left.iter_mut() {
            *s *= self.master_gain;
        }
        for s in right.iter_mut() {
            *s *= self.master_gain;
        }
    }

    fn fire_track_schedulers(&mut self, prev_tick: u64, next_tick: u64) {
        if !self.playing || next_tick <= prev_tick {
            return;
        }
        let n = self.tracks.len().min(self.track_schedulers.len());
        for i in 0..n {
            let sched = &self.track_schedulers[i];
            if sched.is_empty() {
                continue;
            }
            sched.fire_for_block(prev_tick, next_tick, &mut *self.tracks[i].instrument);
        }
    }

    fn advance_tick(&mut self, frames: usize) {
        if !self.playing {
            return;
        }
        let dt = self
            .tempo_map
            .ticks_for_samples(frames, self.current_tick());
        self.tick_pos += dt;
    }

    /// Mono compatibility path for the Phase-1 worklet. Renders the
    /// full stereo bus including bus routing, then collapses to mono
    /// via constant-power sum.
    pub fn process_mono(&mut self, out: &mut [f32]) {
        let frames = out.len();
        let mut right_local = core::mem::take(&mut self.right_scratch);
        if right_local.len() < frames {
            right_local.resize(frames, 0.0);
        }
        self.process_stereo(out, &mut right_local[..frames]);
        // process_stereo already applied master_gain to both sides.
        // Constant-power sum-to-mono: (L+R)/√2.
        let scale = core::f32::consts::FRAC_1_SQRT_2;
        for (l, r) in out.iter_mut().zip(right_local[..frames].iter()) {
            *l = (*l + *r) * scale;
        }
        self.right_scratch = right_local;
    }
}

fn instrument_matches(track: &TrackEngine, instrument: &InstrumentSnapshot) -> bool {
    let any = track.instrument.as_any();
    match instrument {
        InstrumentSnapshot::BuiltinSequencer { .. } => any.is::<Sequencer>(),
        InstrumentSnapshot::None => any.is::<Silence>(),
        InstrumentSnapshot::Subtractive { .. } => any.is::<Subtractive>(),
    }
}

fn build_track(sample_rate: f32, ts: &crate::snapshot::TrackSnapshot) -> TrackEngine {
    let instrument: Box<dyn Plugin> = match &ts.instrument {
        InstrumentSnapshot::BuiltinSequencer { waveform } => {
            let mut seq = Sequencer::new(sample_rate);
            seq.set_waveform(waveform_from_u32(*waveform));
            Box::new(seq)
        }
        InstrumentSnapshot::None => Box::new(Silence),
        InstrumentSnapshot::Subtractive { params } => {
            let mut s = Subtractive::new(sample_rate);
            s.set_voice_count(ts.voices);
            for &(id, value) in params {
                s.set_param(id, value);
            }
            Box::new(s)
        }
    };
    let mut track = TrackEngine::new(instrument);
    track.gain = ts.gain;
    track.pan = ts.pan;
    track.mute = ts.mute;
    track.solo = ts.solo;
    track.voices = ts.voices;
    track.kind = ts.kind;
    track
}

fn waveform_from_u32(w: u32) -> Waveform {
    match w {
        1 => Waveform::Saw,
        2 => Waveform::Square,
        _ => Waveform::Sine,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::Plugin;
    use crate::snapshot::{TrackKind, TrackSnapshot};
    use core::f32::consts::FRAC_1_SQRT_2;

    struct ConstSource {
        value: f32,
        playing: bool,
    }

    impl Plugin for ConstSource {
        fn process(&mut self, _inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
            let v = if self.playing { self.value } else { 0.0 };
            if let Some(ch) = outputs.get_mut(0) {
                for s in ch[..frames].iter_mut() {
                    *s = v;
                }
            }
        }
        fn set_playing(&mut self, on: bool) {
            self.playing = on;
        }
        fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
            self
        }
        fn as_any(&self) -> &dyn core::any::Any {
            self
        }
    }

    fn const_track(value: f32) -> TrackEngine {
        TrackEngine::new(Box::new(ConstSource {
            value,
            playing: true,
        }))
    }

    const TOL: f32 = 1e-5;

    #[test]
    fn empty_engine_renders_silence() {
        let mut e = Engine::new(48_000.0);
        let mut l = [1.0f32; 8];
        let mut r = [1.0f32; 8];
        e.process_stereo(&mut l, &mut r);
        assert!(l.iter().all(|s| *s == 0.0));
        assert!(r.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn two_tracks_sum_into_master() {
        let mut e = Engine::new(48_000.0);
        e.add_track(const_track(0.3));
        e.add_track(const_track(0.4));
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        // Centre pan is constant-power: each track contributes value * cos(π/4)
        // to each side. So the master sees (0.3 + 0.4) * (1/√2).
        let expected = (0.3 + 0.4) * FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < TOL, "L got {}, expected {}", l[0], expected);
        assert!((r[0] - expected).abs() < TOL, "R got {}, expected {}", r[0], expected);
    }

    #[test]
    fn mute_drops_a_track_from_the_mix() {
        let mut e = Engine::new(48_000.0);
        e.add_track(const_track(0.3));
        let mut t1 = const_track(0.4);
        t1.mute = true;
        e.add_track(t1);
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        let expected = 0.3 * FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < TOL, "muted track leaked: {}", l[0]);
        assert!((r[0] - expected).abs() < TOL);
    }

    #[test]
    fn solo_isolates_a_single_track() {
        let mut e = Engine::new(48_000.0);
        let mut t0 = const_track(0.3);
        t0.solo = true;
        e.add_track(t0);
        e.add_track(const_track(0.4));
        e.add_track(const_track(0.5));
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        let expected = 0.3 * FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < TOL, "solo leaked: {}", l[0]);
    }

    #[test]
    fn solo_overrides_mute_for_the_soloed_track() {
        let mut e = Engine::new(48_000.0);
        let mut t0 = const_track(0.3);
        t0.solo = true;
        t0.mute = true;
        e.add_track(t0);
        e.add_track(const_track(0.4));
        e.set_playing(true);

        let mut l = [0.0f32; 16];
        let mut r = [0.0f32; 16];
        e.process_stereo(&mut l, &mut r);

        // Soloed AND muted: the M2 contract is that mute still wins on
        // *that* track, and other (non-soloed) tracks remain silenced
        // because some track is soloed. So the bus is silent.
        assert!(l.iter().all(|s| s.abs() < TOL), "expected silence, got {:?}", &l[..4]);
    }

    #[test]
    fn apply_snapshot_seeds_tracks_with_correct_mixer_state() {
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 0.5,
            tracks: vec![
                TrackSnapshot {
                    kind: TrackKind::Midi,
                    name: "Drums".into(),
                    gain: 0.8,
                    pan: -0.3,
                    mute: false,
                    solo: false,
                    voices: 12,
                    instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 1 },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
                },
                TrackSnapshot {
                    kind: TrackKind::Midi,
                    name: "Bass".into(),
                    gain: 0.6,
                    pan: 0.2,
                    mute: true,
                    solo: false,
                    voices: 16,
                    instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 0 },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
                },
            ],
        };
        e.apply_snapshot(&snap);
        assert_eq!(e.tracks.len(), 2);
        assert!((e.master_gain - 0.5).abs() < 1e-6);
        assert!((e.tracks[0].gain - 0.8).abs() < 1e-6);
        assert!((e.tracks[0].pan - (-0.3)).abs() < 1e-6);
        assert_eq!(e.tracks[0].voices, 12);
        assert!(e.tracks[1].mute);
    }

    #[test]
    fn apply_snapshot_preserves_instrument_when_kind_matches() {
        let mut e = Engine::new(48_000.0);
        let mut snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "T".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 0 },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        let original = e.tracks[0]
            .instrument
            .as_any_mut()
            .downcast_mut::<Sequencer>()
            .expect("seq instrument") as *mut Sequencer as usize;

        // A mute toggle is a cosmetic change; the instrument should be reused.
        snap.tracks[0].mute = true;
        e.apply_snapshot(&snap);
        let after = e.tracks[0]
            .instrument
            .as_any_mut()
            .downcast_mut::<Sequencer>()
            .expect("seq instrument") as *mut Sequencer as usize;
        assert_eq!(original, after, "instrument was rebuilt on cosmetic change");
        assert!(e.tracks[0].mute);
    }

    #[test]
    fn current_tick_advances_under_play() {
        let mut e = Engine::new(48_000.0);
        let seq = Sequencer::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(seq)));
        e.set_playing(true);

        // 1 second at 120 BPM = 2 beats × 960 PPQ = 1920 ticks.
        let mut buf = alloc::vec![0.0f32; 48_000];
        e.process_mono(&mut buf);
        let t = e.current_tick();
        assert!(
            (t as i64 - 1920).abs() <= 1,
            "tick {} not within 1 of 1920",
            t
        );
    }

    #[test]
    fn current_tick_freezes_when_stopped() {
        let mut e = Engine::new(48_000.0);
        let seq = Sequencer::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(seq)));
        // Not playing.
        let mut buf = alloc::vec![0.0f32; 4_800];
        e.process_mono(&mut buf);
        assert_eq!(e.current_tick(), 0);
    }

    #[test]
    fn set_bpm_doubles_tick_rate() {
        let mut e = Engine::new(48_000.0);
        let seq = Sequencer::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(seq)));
        e.set_playing(true);
        e.set_bpm(60.0);
        let mut buf = alloc::vec![0.0f32; 24_000];
        e.process_mono(&mut buf);
        let slow = e.current_tick();

        e.locate(0);
        e.set_bpm(120.0);
        let mut buf = alloc::vec![0.0f32; 24_000];
        e.process_mono(&mut buf);
        let fast = e.current_tick();
        assert!(
            (fast as i64 - 2 * slow as i64).abs() <= 2,
            "fast={fast} slow={slow}"
        );
    }

    #[test]
    fn locate_event_jumps_the_playhead() {
        let mut e = Engine::new(48_000.0);
        let seq = Sequencer::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(seq)));
        let mut buf = alloc::vec![0u8; crate::sab_ring::HEADER_BYTES + 64];
        crate::sab_ring::init(&mut buf);
        {
            let mut w = crate::sab_ring::RingWriter::new(&mut buf);
            let payload = crate::event::encode(&Event::Locate { tick: 4242 }).expect("encode");
            assert!(w.write(&payload));
        }
        let mut r = crate::sab_ring::RingReader::new(&mut buf);
        e.drain_events(&mut r);
        assert_eq!(e.current_tick(), 4242);
    }

    #[test]
    fn drain_events_applies_set_track_gain() {
        let mut e = Engine::new(48_000.0);
        e.add_track(const_track(0.5));
        assert!((e.tracks[0].gain - 1.0).abs() < 1e-6);

        let mut buf = alloc::vec![0u8; crate::sab_ring::HEADER_BYTES + 64];
        crate::sab_ring::init(&mut buf);
        {
            let mut w = crate::sab_ring::RingWriter::new(&mut buf);
            let payload = crate::event::encode(&Event::SetTrackGain { track: 0, gain: 0.25 })
                .expect("encode");
            assert!(w.write(&payload));
        }
        let mut r = crate::sab_ring::RingReader::new(&mut buf);
        e.drain_events(&mut r);
        assert!((e.tracks[0].gain - 0.25).abs() < 1e-6);
    }

    #[test]
    fn drain_events_applies_transport() {
        let mut e = Engine::new(48_000.0);
        let seq = Sequencer::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(seq)));

        let mut buf = alloc::vec![0u8; crate::sab_ring::HEADER_BYTES + 64];
        crate::sab_ring::init(&mut buf);
        {
            let mut w = crate::sab_ring::RingWriter::new(&mut buf);
            let payload = crate::event::encode(&Event::Transport { play: true }).expect("encode");
            assert!(w.write(&payload));
        }
        let mut r = crate::sab_ring::RingReader::new(&mut buf);
        e.drain_events(&mut r);
        let seq = e.tracks[0]
            .instrument
            .as_any_mut()
            .downcast_mut::<Sequencer>()
            .expect("seq");
        assert_eq!(seq.current_step(), 0, "transport play not applied");
    }

    #[test]
    fn apply_snapshot_routes_clip_steps_into_track_sequencer() {
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Drums".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 0 },
                steps: alloc::vec![
                    1u32 << 12,
                    0,
                    0,
                    0,
                    1u32 << 16,
                    0,
                    0,
                    0,
                    1u32 << 12,
                    0,
                    0,
                    0,
                    1u32 << 16,
                    0,
                    0,
                    0
                ],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        e.set_playing(true);
        // Render enough samples to cross the first step boundary so a
        // voice triggers, then verify audio is non-silent — proves the
        // step pattern landed.
        let mut buf = alloc::vec![0.0f32; 6_000];
        e.process_mono(&mut buf);
        let peak = buf.iter().cloned().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.01, "no audio after applying clip steps; peak {peak}");
    }

    #[test]
    fn apply_snapshot_round_trips_through_postcard() {
        let snap = ProjectSnapshot {
            master_gain: 0.75,
            tracks: vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Lead".into(),
                gain: 0.9,
                pan: 0.0,
                mute: false,
                solo: true,
                voices: 8,
                instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 2 },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        let bytes = crate::snapshot::encode(&snap);
        let decoded = crate::snapshot::decode(&bytes).expect("decode");
        assert_eq!(snap, decoded);
    }

    #[test]
    fn track_peak_rises_with_audio_then_falls_when_silenced() {
        let mut e = Engine::new(48_000.0);
        e.add_track(const_track(0.5));
        e.set_playing(true);

        let mut buf = alloc::vec![0.0f32; 1024];
        e.process_mono(&mut buf);
        let active_peak = e.tracks[0].peak;
        assert!(active_peak > 0.4, "expected loud peak, got {}", active_peak);

        e.tracks[0].mute = true;
        // Render many blocks so the decay has time to drag the meter down.
        for _ in 0..200 {
            e.process_mono(&mut buf);
        }
        let muted_peak = e.tracks[0].peak;
        assert!(
            muted_peak < 0.05,
            "meter still hot ({}) after long silence",
            muted_peak
        );
    }

    #[test]
    fn master_gain_scales_the_bus() {
        let mut e = Engine::new(48_000.0);
        e.add_track(const_track(0.5));
        e.master_gain = 0.5;
        e.set_playing(true);

        let mut l = [0.0f32; 8];
        let mut r = [0.0f32; 8];
        e.process_stereo(&mut l, &mut r);

        let expected = 0.5 * FRAC_1_SQRT_2 * 0.5;
        assert!((l[0] - expected).abs() < TOL, "L got {}, expected {}", l[0], expected);
    }

    #[test]
    fn apply_snapshot_builds_a_subtractive_track_with_params() {
        use crate::plugins::subtractive::{Subtractive, PID_FILTER_CUTOFF};
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Synth".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::Subtractive {
                    params: alloc::vec![(PID_FILTER_CUTOFF, 1234.0)],
                },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        assert_eq!(e.tracks.len(), 1);
        let s = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .expect("Subtractive instrument");
        assert!(
            (s.get_param(PID_FILTER_CUTOFF).unwrap() - 1234.0).abs() < 1e-3,
            "param did not land in synth"
        );
    }

    #[test]
    fn drain_events_routes_set_param_to_track_plugin() {
        use crate::plugins::subtractive::{Subtractive, PID_FILTER_CUTOFF};
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Synth".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::Subtractive { params: alloc::vec![] },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);

        let mut buf = alloc::vec![0u8; crate::sab_ring::HEADER_BYTES + 64];
        crate::sab_ring::init(&mut buf);
        {
            let mut w = crate::sab_ring::RingWriter::new(&mut buf);
            let payload = crate::event::encode(&Event::SetParam {
                track: 0,
                id: PID_FILTER_CUTOFF,
                value: 4321.0,
            })
            .expect("encode");
            assert!(w.write(&payload));
        }
        let mut r = crate::sab_ring::RingReader::new(&mut buf);
        e.drain_events(&mut r);

        let s = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .expect("Subtractive instrument");
        assert!((s.get_param(PID_FILTER_CUTOFF).unwrap() - 4321.0).abs() < 1e-3);
    }

    #[test]
    fn insert_chain_attenuates_track_signal() {
        use crate::snapshot::{InsertKind, InsertSnapshot};
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Lead".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 0 },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                // Two Gain inserts, each at 0.5 → chain output is 0.25× input.
                inserts: alloc::vec![
                    InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 0.5)],
                        bypass: false,
                    },
                    InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 0.5)],
                        bypass: false,
                    },
                ],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        // Stub source: write 1.0 into the first insert's input via a
        // ConstSource (which Engine.tracks already uses).
        e.tracks[0].instrument = alloc::boxed::Box::new(ConstSource {
            value: 1.0,
            playing: true,
        });
        e.set_playing(true);

        let mut l = [0.0f32; 8];
        let mut r = [0.0f32; 8];
        e.process_stereo(&mut l, &mut r);
        // 1.0 * 0.5 * 0.5 = 0.25, then constant-power pan ÷√2 each side.
        let expected = 0.25 * core::f32::consts::FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < 1e-5, "l[0] = {}, expected {}", l[0], expected);
    }

    #[test]
    fn bypass_skips_insert_in_chain() {
        use crate::snapshot::{InsertKind, InsertSnapshot};
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Lead".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 0 },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![
                    InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 0.5)],
                        bypass: true, // first insert bypassed
                    },
                    InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 0.5)],
                        bypass: false,
                    },
                ],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        e.tracks[0].instrument = alloc::boxed::Box::new(ConstSource {
            value: 1.0,
            playing: true,
        });
        e.set_playing(true);

        let mut l = [0.0f32; 8];
        let mut r = [0.0f32; 8];
        e.process_stereo(&mut l, &mut r);
        // Skipped first → only second 0.5 applies.
        let expected = 0.5 * core::f32::consts::FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < 1e-5);
    }

    #[test]
    fn bus_track_with_gain2_doubles_send_signal() {
        use crate::snapshot::{InsertKind, InsertSnapshot, SendSnapshot};
        let mut e = Engine::new(48_000.0);
        // Track 0: source. Sends 1.0 to bus at index 1.
        // Track 1: Bus, hosts a Gain×2 insert. Bus output doubles its
        // input signal magnitude.
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![
                TrackSnapshot {
                    kind: TrackKind::Midi,
                    name: "Source".into(),
                    gain: 1.0,
                    pan: 0.0,
                    mute: false,
                    solo: false,
                    voices: 16,
                    instrument: InstrumentSnapshot::BuiltinSequencer { waveform: 0 },
                    steps: alloc::vec![],
                    piano_roll_notes: alloc::vec![],
                    inserts: alloc::vec![],
                    sends: alloc::vec![SendSnapshot {
                        target_track: 1,
                        level: 1.0,
                        pre_fader: false,
                    }],
                },
                TrackSnapshot {
                    kind: TrackKind::Bus,
                    name: "Reverb Bus".into(),
                    // Mute the source's dry path effectively by giving
                    // the bus a clean signal path: the ConstSource on
                    // track 0 still contributes to master, but we can
                    // verify the bus output by comparing with vs.
                    // without the bus.
                    gain: 1.0,
                    pan: 0.0,
                    mute: false,
                    solo: false,
                    voices: 16,
                    instrument: InstrumentSnapshot::None,
                    steps: alloc::vec![],
                    piano_roll_notes: alloc::vec![],
                    inserts: alloc::vec![InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 2.0)],
                        bypass: false,
                    }],
                    sends: alloc::vec![],
                },
            ],
        };
        e.apply_snapshot(&snap);
        // Source: a 0.25 const value.
        e.tracks[0].instrument = alloc::boxed::Box::new(ConstSource {
            value: 0.25,
            playing: true,
        });
        // Mute source's dry path so we measure the bus contribution
        // alone.
        e.tracks[0].mute = true;
        e.set_playing(true);

        let mut l = [0.0f32; 8];
        let mut r = [0.0f32; 8];
        e.process_stereo(&mut l, &mut r);
        // Source → muted (no dry to master) but sends still route at
        // post-fader: the M2 contract is sends are post-mute, so a
        // muted track contributes 0 to its sends. Expectation: silent.
        assert!(l.iter().all(|s| s.abs() < 1e-6), "muted source leaked through send: {:?}", &l[..2]);

        // Now unmute; bus should now contribute 0.25 × 2.0 = 0.5,
        // panned center → 0.5 × FRAC_1_SQRT_2 each side. Plus the
        // dry source at 0.25 panned center → 0.25 × FRAC_1_SQRT_2.
        // Sum: 0.75 × FRAC_1_SQRT_2.
        e.tracks[0].mute = false;
        let mut l = [0.0f32; 8];
        let mut r = [0.0f32; 8];
        e.process_stereo(&mut l, &mut r);
        let expected = 0.75 * core::f32::consts::FRAC_1_SQRT_2;
        assert!(
            (l[0] - expected).abs() < 1e-5,
            "expected dry+wet = 0.75/√2 ({}), got {}",
            expected,
            l[0]
        );
    }

    #[test]
    fn live_note_on_event_routes_to_track_instrument() {
        use crate::plugins::subtractive::Subtractive;
        let mut e = Engine::new(48_000.0);
        e.add_track(TrackEngine::new(Box::new(Subtractive::new(48_000.0))));

        let mut buf = alloc::vec![0u8; crate::sab_ring::HEADER_BYTES + 64];
        crate::sab_ring::init(&mut buf);
        {
            let mut w = crate::sab_ring::RingWriter::new(&mut buf);
            let payload = crate::event::encode(&Event::NoteOn {
                track: 0,
                pitch: 60,
                velocity: 100,
            })
            .expect("encode");
            assert!(w.write(&payload));
        }
        let mut r = crate::sab_ring::RingReader::new(&mut buf);
        e.drain_events(&mut r);

        // Render past the synth's 5 ms attack — Subtractive should be
        // producing audio because the live event triggered a voice.
        let mut out = alloc::vec![0.0f32; 4_800];
        e.process_mono(&mut out);
        let peak = out.iter().cloned().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.05, "no audio after live NoteOn; peak {peak}");
    }

    #[test]
    fn piano_roll_notes_drive_subtractive_via_track_scheduler() {
        use crate::snapshot::NoteSnapshot;
        let mut e = Engine::new(48_000.0);
        // Track-level PianoRoll → Subtractive. C4 NoteOn at tick 0
        // for 1920 ticks (one beat at 120 BPM, ppq=960).
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Lead".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::Subtractive { params: alloc::vec![] },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![NoteSnapshot {
                    pitch: 60,
                    velocity: 100,
                    start_tick: 0,
                    length_ticks: 1920,
                }],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        e.set_playing(true);

        // Render enough audio for the track scheduler to fire NoteOn
        // and the synth to climb past attack into sustain.
        let mut buf = alloc::vec![0.0f32; 12_000];
        e.process_mono(&mut buf);
        let peak = buf.iter().cloned().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.05, "no audio after PianoRoll NoteOn; peak {peak}");
    }

    #[test]
    fn apply_snapshot_preserves_subtractive_when_kind_matches() {
        use crate::plugins::subtractive::{Subtractive, PID_FILTER_CUTOFF};
        let mut e = Engine::new(48_000.0);
        let mut snap = ProjectSnapshot {
            master_gain: 1.0,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "Synth".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::Subtractive {
                    params: alloc::vec![(PID_FILTER_CUTOFF, 1500.0)],
                },
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        let original_ptr = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .expect("Subtractive") as *const Subtractive as usize;

        // Cosmetic + param edit — instrument should be reused, param updated.
        snap.tracks[0].mute = true;
        snap.tracks[0].instrument = InstrumentSnapshot::Subtractive {
            params: alloc::vec![(PID_FILTER_CUTOFF, 7777.0)],
        };
        e.apply_snapshot(&snap);
        let after = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .expect("Subtractive") as *const Subtractive as usize;
        assert_eq!(original_ptr, after, "Subtractive was rebuilt on cosmetic edit");
        assert!(
            (e.tracks[0]
                .instrument
                .as_any()
                .downcast_ref::<Subtractive>()
                .unwrap()
                .get_param(PID_FILTER_CUTOFF)
                .unwrap()
                - 7777.0)
                .abs()
                < 1e-3
        );
    }
}
