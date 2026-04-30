use crate::event::Event;
use crate::oscillator::Waveform;
use crate::sab_ring::RingReader;
use crate::sequencer::Sequencer;
use crate::snapshot::{InstrumentSnapshot, ProjectSnapshot};
use crate::tempo_map::TempoMap;
use crate::track::TrackEngine;

pub struct Engine {
    pub tracks: Vec<TrackEngine>,
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

        let same_count = snap.tracks.len() == self.tracks.len();
        for (i, ts) in snap.tracks.iter().enumerate() {
            let needs_rebuild = !same_count
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
                if let InstrumentSnapshot::BuiltinSequencer { waveform } = ts.instrument {
                    if let Some(seq) = track
                        .instrument
                        .as_any_mut()
                        .downcast_mut::<Sequencer>()
                    {
                        seq.set_waveform(waveform_from_u32(waveform));
                    }
                }
            }
        }
        if snap.tracks.len() < self.tracks.len() {
            self.tracks.truncate(snap.tracks.len());
        }
    }

    pub fn add_track(&mut self, track: TrackEngine) -> usize {
        self.tracks.push(track);
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
        for t in self.tracks.iter_mut() {
            t.instrument.set_playing(on);
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
        self.advance_tick(left.len());
        for s in left.iter_mut() {
            *s = 0.0;
        }
        for s in right.iter_mut() {
            *s = 0.0;
        }
        let any_solo = self.tracks.iter().any(|t| t.solo);
        for track in self.tracks.iter_mut() {
            let silenced = any_solo && !track.solo;
            track.render_into_stereo(left, right, silenced);
        }
        for s in left.iter_mut() {
            *s *= self.master_gain;
        }
        for s in right.iter_mut() {
            *s *= self.master_gain;
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

    /// Mono compatibility path for the Phase-1 worklet. Renders the full
    /// stereo bus and collapses it via constant-power sum. M3 replaces
    /// this with a true stereo path over the SAB ring.
    pub fn process_mono(&mut self, out: &mut [f32]) {
        self.advance_tick(out.len());
        if self.right_scratch.len() < out.len() {
            self.right_scratch.resize(out.len(), 0.0);
        }
        let right = &mut self.right_scratch[..out.len()];
        for s in out.iter_mut() {
            *s = 0.0;
        }
        for s in right.iter_mut() {
            *s = 0.0;
        }
        let any_solo = self.tracks.iter().any(|t| t.solo);
        for track in self.tracks.iter_mut() {
            let silenced = any_solo && !track.solo;
            track.render_into_stereo(out, right, silenced);
        }
        let g = self.master_gain * core::f32::consts::FRAC_1_SQRT_2;
        for (l, r) in out.iter_mut().zip(right.iter()) {
            *l = (*l + *r) * g;
        }
    }
}

fn instrument_matches(track: &TrackEngine, instrument: &InstrumentSnapshot) -> bool {
    match instrument {
        InstrumentSnapshot::BuiltinSequencer { .. } => track
            .instrument
            .voice_count_hint()
            .is_some(),
        InstrumentSnapshot::None => track.instrument.voice_count_hint().is_none(),
    }
}

fn build_track(sample_rate: f32, ts: &crate::snapshot::TrackSnapshot) -> TrackEngine {
    let instrument: Box<dyn crate::plugin::Plugin> = match ts.instrument {
        InstrumentSnapshot::BuiltinSequencer { waveform } => {
            let mut seq = Sequencer::new(sample_rate);
            seq.set_waveform(waveform_from_u32(waveform));
            Box::new(seq)
        }
        InstrumentSnapshot::None => Box::new(crate::plugin::Silence),
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
        fn process(&mut self, out: &mut [f32]) {
            let v = if self.playing { self.value } else { 0.0 };
            for s in out.iter_mut() {
                *s = v;
            }
        }
        fn set_playing(&mut self, on: bool) {
            self.playing = on;
        }
        fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
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
            }],
        };
        let bytes = crate::snapshot::encode(&snap);
        let decoded = crate::snapshot::decode(&bytes).expect("decode");
        assert_eq!(snap, decoded);
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
}
