// First-party plugins. Each module here implements `Plugin` directly —
// no JIT loader, no plugin manifest, statically linked into the engine.
// Phase 7 will introduce a public SDK on the same trait.

pub mod compressor;
pub mod delay;
pub mod eq;
pub mod gain;
pub mod reverb;
pub mod subtractive;
