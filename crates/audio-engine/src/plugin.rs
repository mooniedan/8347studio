// Forward-compatible plugin trait stub.
//
// Phase 2 will expand this with descriptors / set_param / handle_event, and
// split clip scheduling out of the instrument. For now Plugin is the bare
// minimum the multi-track Engine needs to host first-party instruments.

use core::any::Any;

pub trait Plugin: Send + Any {
    /// Render samples into `out` (mono, replacing — the implementation is
    /// expected to overwrite each sample, not accumulate).
    fn process(&mut self, out: &mut [f32]);

    /// Transport state. Plugins that schedule events internally (e.g. the
    /// Phase-0/1 step sequencer) react here; pure effect plugins ignore.
    fn set_playing(&mut self, _on: bool) {}

    /// Suggested voice-pool size. Phase 2 wires this to instrumentSlot
    /// .voices in the Y.Doc; for the M2 stub it's purely advisory.
    fn voice_count_hint(&self) -> Option<u32> {
        None
    }

    /// Bridge escape hatch — lets the host downcast to a concrete instrument
    /// and reach methods that aren't yet covered by the trait (BPM, step
    /// masks, etc.). Phase 2 replaces these calls with set_param / events
    /// over the SAB ring.
    fn as_any_mut(&mut self) -> &mut dyn Any;
}
