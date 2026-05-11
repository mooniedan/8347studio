use crate::asset_cache::{AssetCache, AssetId};
use crate::audio_region::AudioRegion;
use crate::automation::evaluate_lane;
use crate::clip_scheduler::{ClipScheduler, ScheduledNote};
use crate::event::Event;
use crate::snapshot::{AutoTarget, AutomationLane};
use crate::oscillator::Waveform;
use crate::plugin::{Plugin, Silence};
use crate::plugins::build_insert_plugin;
use crate::plugins::drumkit::Drumkit;
use crate::plugins::subtractive::Subtractive;
use crate::plugins::wasm::{WasmPlugin, WasmPluginKind};
use crate::sab_ring::RingReader;
use crate::sequencer::Sequencer;
use crate::snapshot::{InstrumentSnapshot, LoopRegion, ProjectSnapshot};
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
    /// Automation lanes. Phase-4 M4. Mirrored from the snapshot;
    /// evaluated each audio block at current_tick and written into
    /// the addressed plugin's set_param.
    automation: Vec<AutomationLane>,
    /// Per-asset PCM cache. Phase-5 M1. Audio-track region rendering
    /// reads from here; the host populates it via register_asset.
    pub asset_cache: AssetCache,
    /// Absolute sample position on the timeline. Resets to 0 on
    /// transport stop / locate(0). Used for sample-accurate Audio-
    /// track region scheduling, parallel to tick_pos.
    sample_pos: u64,
    pub master_gain: f32,
    pub tempo_map: TempoMap,
    pub playing: bool,
    /// Fractional tick position; integer view via `current_tick()`.
    tick_pos: f64,
    /// Optional transport loop. When `Some`, `process_stereo` wraps
    /// `tick_pos` from `end_tick` back to `start_tick` so piano-roll
    /// clips, automation, and audio regions cycle.
    pub loop_region: Option<LoopRegion>,
    right_scratch: Vec<f32>,
    sample_rate: f32,
}

impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            tracks: Vec::new(),
            track_schedulers: Vec::new(),
            bus_inputs: Vec::new(),
            automation: Vec::new(),
            asset_cache: AssetCache::new(),
            sample_pos: 0,
            master_gain: 1.0,
            tempo_map: TempoMap::new(sample_rate),
            playing: false,
            tick_pos: 0.0,
            loop_region: None,
            right_scratch: Vec::new(),
            sample_rate,
        }
    }

    pub fn current_sample(&self) -> u64 {
        self.sample_pos
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
                    InstrumentSnapshot::Drumkit { params } => {
                        if let Some(d) = track
                            .instrument
                            .as_any_mut()
                            .downcast_mut::<Drumkit>()
                        {
                            for &(id, value) in params {
                                d.set_param(id, value);
                            }
                        }
                    }
                    InstrumentSnapshot::Wasm { params, .. } => {
                        if let Some(w) = track
                            .instrument
                            .as_any_mut()
                            .downcast_mut::<WasmPlugin>()
                        {
                            for &(id, value) in params {
                                w.set_param(id, value);
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
                let plugin = build_insert_plugin(self.sample_rate, ins);
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
            // Audio regions. Phase-5 M1.
            self.tracks[i].audio_regions.clear();
            for r in ts.audio_regions.iter() {
                self.tracks[i].audio_regions.push(AudioRegion {
                    asset_id: r.asset_id,
                    start_sample: r.start_sample,
                    length_samples: r.length_samples,
                    asset_offset_samples: r.asset_offset_samples,
                    gain: r.gain,
                    fade_in_samples: r.fade_in_samples,
                    fade_out_samples: r.fade_out_samples,
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
        // Replace automation wholesale. Phase-9 polish can keep stable
        // identity to avoid throwing away a mid-edit smoothing state.
        self.automation = snap.automation.clone();
        // Transport loop region — `None` disables looping.
        self.loop_region = snap.loop_region;
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
            self.sample_pos = 0;
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
        // Convert ticks to absolute samples using the current tempo
        // map. With a constant-BPM Phase-1 tempo map this is exact;
        // tempo-map polish will refine as tempo changes land.
        let bpm = self.tempo_map.bpm_at(tick);
        let ppq = 960.0_f64;
        let ticks_per_sec = bpm as f64 * ppq / 60.0;
        let secs = tick as f64 / ticks_per_sec.max(1e-6);
        self.sample_pos = (secs * self.sample_rate as f64) as u64;
    }

    /// Phase-5 M1: register or replace the PCM frames for an asset id.
    /// Frames are mono at the engine's sample rate.
    pub fn register_asset(&mut self, asset_id: AssetId, frames: alloc::vec::Vec<f32>) {
        self.asset_cache.put(asset_id, frames);
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
        let mut next_tick = self.current_tick();
        // Transport loop wrap — when `tick_pos` crosses `end_tick`,
        // fire pending notes up to the boundary, release any held
        // notes (so chord sustains don't bleed across the wrap), then
        // jump back to `start_tick` and fire the post-wrap window.
        // Automation evaluates at the wrapped tick so lanes cycle.
        if self.playing {
            if let Some(lr) = self.loop_region {
                if lr.end_tick > lr.start_tick
                    && prev_tick < lr.end_tick
                    && next_tick >= lr.end_tick
                {
                    self.fire_track_schedulers(prev_tick, lr.end_tick);
                    for t in self.tracks.iter_mut() {
                        t.instrument
                            .handle_event(crate::plugin::PluginEvent::AllNotesOff);
                    }
                    let loop_len = lr.end_tick - lr.start_tick;
                    let overshoot = next_tick - lr.end_tick;
                    let wrapped = lr.start_tick + (overshoot % loop_len);
                    self.tick_pos = wrapped as f64;
                    let bpm = self.tempo_map.bpm_at(wrapped);
                    let ppq = 960.0_f64;
                    let ticks_per_sec = bpm as f64 * ppq / 60.0;
                    let secs = wrapped as f64 / ticks_per_sec.max(1e-6);
                    self.sample_pos = (secs * self.sample_rate as f64) as u64;
                    self.fire_track_schedulers(lr.start_tick, wrapped);
                    next_tick = wrapped;
                } else {
                    self.fire_track_schedulers(prev_tick, next_tick);
                }
            } else {
                self.fire_track_schedulers(prev_tick, next_tick);
            }
        } else {
            self.fire_track_schedulers(prev_tick, next_tick);
        }
        // Apply automation BEFORE rendering so this block sees the
        // automated value. Block-quantized resolution; sub-block
        // ramps are a future polish item.
        self.apply_automation(next_tick);
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
        let block_start_sample = self.sample_pos;
        for i in 0..n {
            // 1. Render this track's mono. For a Bus, the "instrument"
            // is replaced by the accumulated send sum. For Audio
            // tracks, the engine fills scratch from regions before
            // running inserts.
            let kind = self.tracks[i].kind;
            match kind {
                crate::snapshot::TrackKind::Bus => {
                    let input_owned: alloc::vec::Vec<f32> =
                        self.bus_inputs[i][..frames].to_vec();
                    self.tracks[i].compute_mono(frames, Some(&input_owned));
                }
                crate::snapshot::TrackKind::Audio => {
                    // Reset scratch + buffers via fill_source (writes
                    // silence for Audio tracks).
                    self.tracks[i].fill_source(frames, None);
                    if self.playing {
                        // Sum each region into the track's scratch.
                        // Split borrow on disjoint engine fields.
                        let track = &mut self.tracks[i];
                        for region in &track.audio_regions {
                            region.render_into(
                                &mut track.scratch[..frames],
                                block_start_sample,
                                &self.asset_cache,
                            );
                        }
                    }
                    self.tracks[i].run_inserts(frames);
                }
                _ => {
                    self.tracks[i].compute_mono(frames, None);
                }
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
        // Advance the absolute sample position for the next block.
        if self.playing {
            self.sample_pos = self.sample_pos.saturating_add(frames as u64);
        }
    }

    fn apply_automation(&mut self, tick: u64) {
        // Iterate through lanes; for each evaluate at the current tick
        // and write into the addressed plugin. We can't borrow
        // self.automation while mutating self.tracks via a normal
        // iterator (split borrow on different fields makes this OK).
        for lane_idx in 0..self.automation.len() {
            let (track_idx, target, param_id) = {
                let l = &self.automation[lane_idx];
                (l.track_idx as usize, l.target, l.param_id)
            };
            let value = match evaluate_lane(&self.automation[lane_idx].points, tick) {
                Some(v) => v,
                None => continue,
            };
            let Some(track) = self.tracks.get_mut(track_idx) else {
                continue;
            };
            match target {
                AutoTarget::Instrument => track.instrument.set_param(param_id, value),
                AutoTarget::Insert { slot_idx } => {
                    if let Some(slot) = track.inserts.get_mut(slot_idx as usize) {
                        slot.plugin.set_param(param_id, value);
                    }
                }
            }
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
        InstrumentSnapshot::Drumkit { .. } => any.is::<Drumkit>(),
        InstrumentSnapshot::Wasm { handle, .. } => {
            // Match only if it's a WasmPlugin AND the handle is the
            // same — swapping plugins on a track has to rebuild.
            if let Some(w) = any.downcast_ref::<WasmPlugin>() {
                w.handle() == *handle
            } else {
                false
            }
        }
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
        InstrumentSnapshot::Drumkit { params } => {
            let mut d = Drumkit::new(sample_rate);
            for &(id, value) in params {
                d.set_param(id, value);
            }
            Box::new(d)
        }
        InstrumentSnapshot::Wasm { handle, is_instrument, params } => {
            let kind = if *is_instrument {
                WasmPluginKind::Instrument
            } else {
                WasmPluginKind::Effect
            };
            let mut w = WasmPlugin::new(*handle, kind);
            for &(id, value) in params {
                w.set_param(id, value);
            }
            Box::new(w)
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
    use crate::snapshot::{NoteSnapshot, TrackKind, TrackSnapshot};
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                        branches: alloc::vec![],
                    },
                    InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 0.5)],
                        bypass: false,
                        branches: alloc::vec![],
                    },
                ],
                sends: alloc::vec![],
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                        branches: alloc::vec![],
                    },
                    InsertSnapshot {
                        kind: InsertKind::Gain,
                        params: alloc::vec![(0, 0.5)],
                        bypass: false,
                        branches: alloc::vec![],
                    },
                ],
                sends: alloc::vec![],
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                    audio_regions: alloc::vec![],
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
                        branches: alloc::vec![],
                    }],
                    sends: alloc::vec![],
                audio_regions: alloc::vec![],
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
    fn automation_lane_drives_subtractive_cutoff_sweep() {
        use crate::plugins::subtractive::{Subtractive, PID_FILTER_CUTOFF};
        use crate::snapshot::{AutoPoint, AutoTarget, AutomationLane};

        let mut e = Engine::new(48_000.0);
        // One subtractive track, cutoff automated 100→8000 Hz over
        // ticks 0..3840 (one bar at 120 BPM, ppq=960).
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            automation: alloc::vec![AutomationLane {
                track_idx: 0,
                target: AutoTarget::Instrument,
                param_id: PID_FILTER_CUTOFF,
                points: alloc::vec![
                    AutoPoint { tick: 0, value: 100.0 },
                    AutoPoint { tick: 3840, value: 8000.0 },
                ],
            }],
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
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
                audio_regions: alloc::vec![],
            }],
            loop_region: None,
        };
        e.apply_snapshot(&snap);
        e.set_playing(true);

        // Render a small block. Engine evaluates automation at the
        // post-advance tick; with frames=128 at 48k and 120 BPM,
        // next_tick after one block is ~5 ticks → cutoff still ≈ 100.
        let mut buf = alloc::vec![0.0f32; 128];
        e.process_mono(&mut buf);
        let synth = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .unwrap();
        let cutoff_early = synth.get_param(PID_FILTER_CUTOFF).unwrap();
        assert!(
            (cutoff_early - 100.0).abs() < 50.0,
            "early cutoff should be near 100, got {}",
            cutoff_early
        );

        // Locate to the midpoint of the lane and render again.
        e.locate(1920);
        let mut buf2 = alloc::vec![0.0f32; 128];
        e.process_mono(&mut buf2);
        let synth = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .unwrap();
        let cutoff_mid = synth.get_param(PID_FILTER_CUTOFF).unwrap();
        // Half-way through 100..8000 ≈ 4050.
        assert!(
            (cutoff_mid - 4050.0).abs() < 200.0,
            "mid cutoff should be ≈4050, got {}",
            cutoff_mid
        );

        // Locate past the end → cutoff clamps to last value.
        e.locate(8000);
        let mut buf3 = alloc::vec![0.0f32; 128];
        e.process_mono(&mut buf3);
        let synth = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<Subtractive>()
            .unwrap();
        let cutoff_end = synth.get_param(PID_FILTER_CUTOFF).unwrap();
        assert!(
            (cutoff_end - 8000.0).abs() < 50.0,
            "end cutoff should clamp to 8000, got {}",
            cutoff_end
        );
    }

    #[test]
    fn audio_track_renders_registered_asset_at_region_position() {
        use crate::snapshot::AudioRegionSnapshot;
        let mut e = Engine::new(48_000.0);
        // Synthesize a 1 kHz sine asset at 48k for 0.1 s.
        let mut sine = alloc::vec![0.0f32; 4_800];
        for (i, s) in sine.iter_mut().enumerate() {
            *s = libm::sinf(2.0 * core::f32::consts::PI * 1_000.0 * i as f32 / 48_000.0);
        }
        e.register_asset(7, sine.clone());

        let snap = ProjectSnapshot {
            master_gain: 1.0,
            automation: alloc::vec![],
            loop_region: None,
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Audio,
                name: "Loop".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 16,
                instrument: InstrumentSnapshot::None,
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
                audio_regions: alloc::vec![AudioRegionSnapshot {
                    asset_id: 7,
                    start_sample: 256,
                    length_samples: 4_800,
                    asset_offset_samples: 0,
                    gain: 1.0,
                    fade_in_samples: 0,
                    fade_out_samples: 0,
                }],
            }],
        };
        e.apply_snapshot(&snap);
        e.set_playing(true);

        // Render two 256-sample blocks. Block 0 covers samples 0..256
        // (region hasn't started); block 1 covers 256..512 (region's
        // first 256 samples).
        let mut block0_l = alloc::vec![0.0f32; 256];
        let mut block0_r = alloc::vec![0.0f32; 256];
        e.process_stereo(&mut block0_l, &mut block0_r);
        // Region hasn't started; output silent.
        assert!(
            block0_l.iter().all(|s| s.abs() < 1e-5),
            "expected silence in block 0, peak {}",
            block0_l.iter().fold(0.0f32, |a, b| a.max(b.abs()))
        );

        let mut block1_l = alloc::vec![0.0f32; 256];
        let mut block1_r = alloc::vec![0.0f32; 256];
        e.process_stereo(&mut block1_l, &mut block1_r);
        // Block 1 contains the asset's first 256 samples — applied to
        // both channels via constant-power pan (×1/√2).
        let scale = core::f32::consts::FRAC_1_SQRT_2;
        for (i, &expected_raw) in sine[..256].iter().enumerate() {
            let expected = expected_raw * scale;
            let got = block1_l[i];
            assert!(
                (got - expected).abs() < 1e-4,
                "block 1 sample {} mismatch: got {}, expected {}",
                i,
                got,
                expected
            );
        }
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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
            automation: alloc::vec![],
            loop_region: None,
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
                audio_regions: alloc::vec![],
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

    #[test]
    fn loop_region_wraps_tick_pos_at_end_back_to_start() {
        let mut e = Engine::new(48_000.0);
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            automation: alloc::vec![],
            loop_region: Some(LoopRegion { start_tick: 0, end_tick: 1000 }),
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
                piano_roll_notes: alloc::vec![],
                inserts: alloc::vec![],
                sends: alloc::vec![],
                audio_regions: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        e.set_playing(true);
        // Locate just before the loop end and render a block big enough
        // to cross the boundary. The post-block tick must wrap back
        // into [start_tick, end_tick).
        e.locate(950);
        let mut buf = alloc::vec![0.0f32; 4_096];
        e.process_mono(&mut buf);
        let t = e.current_tick();
        assert!(
            t < 1000,
            "tick {t} should have wrapped back below loop_end=1000"
        );
    }

    #[test]
    fn loop_region_fires_piano_roll_notes_each_iteration() {
        // A single PianoRoll note at tick 100 inside a [0, 500) loop
        // should fire NoteOn twice across two loop iterations.
        use crate::plugin::PluginEvent;
        use core::any::Any;

        #[derive(Default)]
        struct CountingSynth {
            on: u32,
        }
        impl Plugin for CountingSynth {
            fn process(&mut self, _i: &[&[f32]], _o: &mut [&mut [f32]], _f: usize) {}
            fn set_param(&mut self, _: u32, _: f32) {}
            fn handle_event(&mut self, ev: PluginEvent) {
                if let PluginEvent::NoteOn { .. } = ev {
                    self.on += 1;
                }
            }
            fn as_any_mut(&mut self) -> &mut dyn Any { self }
            fn as_any(&self) -> &dyn Any { self }
        }

        let mut e = Engine::new(48_000.0);
        // Replace the default Silence on track 0 with a counting plugin.
        // The simplest path: build via snapshot, then swap.
        let snap = ProjectSnapshot {
            master_gain: 1.0,
            automation: alloc::vec![],
            loop_region: Some(LoopRegion { start_tick: 0, end_tick: 500 }),
            tracks: alloc::vec![TrackSnapshot {
                kind: TrackKind::Midi,
                name: "T".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                voices: 1,
                instrument: InstrumentSnapshot::None,
                steps: alloc::vec![],
                piano_roll_notes: alloc::vec![NoteSnapshot {
                    pitch: 60,
                    velocity: 100,
                    start_tick: 100,
                    length_ticks: 50,
                }],
                inserts: alloc::vec![],
                sends: alloc::vec![],
                audio_regions: alloc::vec![],
            }],
        };
        e.apply_snapshot(&snap);
        e.tracks[0].instrument = alloc::boxed::Box::new(CountingSynth::default());
        e.set_playing(true);

        // Render enough samples to cross the loop boundary at least
        // twice: 2× 500 ticks at 120 BPM ppq=960 → ~625 ms → ~30k
        // frames @ 48 kHz. Render in blocks to mimic real audio.
        for _ in 0..16 {
            let mut buf = alloc::vec![0.0f32; 2048];
            e.process_mono(&mut buf);
        }
        let cs = e.tracks[0]
            .instrument
            .as_any()
            .downcast_ref::<CountingSynth>()
            .unwrap();
        assert!(cs.on >= 2, "expected ≥2 NoteOn fires across loop iterations, got {}", cs.on);
    }
}
