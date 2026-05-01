// WebMIDI input plumbing.
//
// Phase-3 M1: enumerate inputs, subscribe to messages, decode into the
// engine bridge's note/CC entry points. The "where do these events go"
// (armed track) is wired in M2 via a route() callback the caller
// supplies on creation.
//
// Failure modes that must NOT crash the app:
//   - WebMIDI not available (Safari < 18, Firefox before recent
//     stable). midi.supported() returns false.
//   - User denies permission. status flips to 'denied'; no devices.
//   - Browser SysEx prompt rejected. We don't request sysex.

export type MidiStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported';

export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiInputController {
  /// Snapshot of currently enumerated inputs.
  readonly devices: MidiDevice[];
  /// Current permission / availability state.
  readonly status: MidiStatus;
  /// Currently selected device id; null = "all enumerated devices".
  selectedDeviceId: string | null;
  /// Subscribe to status / device-list changes. Returns unsubscribe.
  subscribe(cb: () => void): () => void;
  /// Force-request access (called on first user gesture). Safe to
  /// call multiple times.
  request(): Promise<void>;
  /// Test affordance: feed a raw MIDI message through the same decode
  /// path a real device would. Bypasses requestMIDIAccess entirely.
  simulate(data: ArrayLike<number>): void;
  destroy(): void;
}

export interface MidiSink {
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
  cc(cc: number, value: number): void;
}

// WebMIDI types come from lib.dom — Navigator.requestMIDIAccess /
// MIDIAccess / MIDIInput / MIDIMessageEvent are all built-in in modern
// TS. We only need the dispatch event shape because input events use
// MIDIMessageEvent.

export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.requestMIDIAccess === 'function'
  );
}

export function createMidiInput(sink: MidiSink): MidiInputController {
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const cb of subscribers) cb();
  };

  const state: {
    status: MidiStatus;
    devices: MidiDevice[];
    selectedDeviceId: string | null;
    access: MIDIAccess | null;
    boundInputs: Map<string, MIDIInput>;
  } = {
    status: 'idle',
    devices: [],
    selectedDeviceId: null,
    access: null,
    boundInputs: new Map(),
  };

  if (!isSupported()) {
    state.status = 'unsupported';
  }

  const dispatch = (data: Uint8Array) => {
    if (data.length < 1) return;
    const status = data[0];
    const cmd = status & 0xf0;
    if (cmd === 0x90 && data.length >= 3) {
      const pitch = data[1] & 0x7f;
      const velocity = data[2] & 0x7f;
      // Status 0x90 with velocity 0 is a note-off in canonical MIDI.
      if (velocity === 0) sink.noteOff(pitch);
      else sink.noteOn(pitch, velocity);
    } else if (cmd === 0x80 && data.length >= 3) {
      sink.noteOff(data[1] & 0x7f);
    } else if (cmd === 0xb0 && data.length >= 3) {
      sink.cc(data[1] & 0x7f, data[2] & 0x7f);
    }
    // Ignore everything else for Phase 3 (program change, pitch bend,
    // aftertouch, sysex). Phase 9 polish lifts what's needed.
  };

  const onMessage = (deviceId: string) => (event: Event) => {
    if (state.selectedDeviceId !== null && state.selectedDeviceId !== deviceId) return;
    const data = (event as MIDIMessageEvent).data;
    if (data) dispatch(data);
  };

  const refreshDevices = () => {
    if (!state.access) return;
    const devices: MidiDevice[] = [];
    // Drop bindings to inputs that vanished; rebind to current set.
    const seen = new Set<string>();
    state.access.inputs.forEach((input, id) => {
      seen.add(id);
      devices.push({
        id,
        name: input.name ?? '(unknown)',
        manufacturer: input.manufacturer ?? '',
      });
      if (!state.boundInputs.has(id)) {
        input.onmidimessage = onMessage(id);
        state.boundInputs.set(id, input);
      }
    });
    for (const [id, input] of state.boundInputs) {
      if (!seen.has(id)) {
        input.onmidimessage = null;
        state.boundInputs.delete(id);
      }
    }
    state.devices = devices;
    notify();
  };

  const request = async (): Promise<void> => {
    if (state.status === 'unsupported' || state.status === 'granted' || state.status === 'requesting') {
      return;
    }
    state.status = 'requesting';
    notify();
    try {
      const access = await navigator.requestMIDIAccess();
      state.access = access;
      access.onstatechange = () => refreshDevices();
      state.status = 'granted';
      refreshDevices();
    } catch {
      state.status = 'denied';
      state.devices = [];
      notify();
    }
  };

  return {
    get devices() {
      return state.devices;
    },
    get status() {
      return state.status;
    },
    get selectedDeviceId() {
      return state.selectedDeviceId;
    },
    set selectedDeviceId(id) {
      state.selectedDeviceId = id;
      notify();
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    request,
    simulate(data) {
      const arr = data instanceof Uint8Array ? data : new Uint8Array(Array.from(data));
      dispatch(arr);
    },
    destroy() {
      for (const input of state.boundInputs.values()) {
        input.onmidimessage = null;
      }
      state.boundInputs.clear();
      if (state.access) state.access.onstatechange = null;
      subscribers.clear();
    },
  };
}
