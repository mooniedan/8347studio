// First-party plugins. Each module here implements `Plugin` directly —
// no JIT loader, no plugin manifest, statically linked into the engine.
// Phase 7 will introduce a public SDK on the same trait.

pub mod compressor;
pub mod container;
pub mod delay;
pub mod drumkit;
pub mod eq;
pub mod gain;
pub mod reverb;
pub mod subtractive;

use alloc::boxed::Box;

use crate::plugin::Plugin;
use crate::snapshot::{InsertKind, InsertSnapshot};

/// Build a freshly-instantiated plugin for the given insert snapshot
/// and seed its params. Container delegates back into this function
/// to construct each branch's chain — the recursion is bounded by
/// snapshot depth.
pub fn build_insert_plugin(sample_rate: f32, ins: &InsertSnapshot) -> Box<dyn Plugin> {
    let mut plugin: Box<dyn Plugin> = match ins.kind {
        InsertKind::Gain => Box::new(gain::Gain::new()),
        InsertKind::Eq => Box::new(eq::Eq::new(sample_rate)),
        InsertKind::Compressor => Box::new(compressor::Compressor::new(sample_rate)),
        InsertKind::Reverb => Box::new(reverb::Reverb::new(sample_rate)),
        InsertKind::Delay => Box::new(delay::Delay::new(sample_rate)),
        InsertKind::Container => Box::new(container::Container::from_branches(
            sample_rate,
            &ins.branches,
        )),
    };
    for &(id, value) in &ins.params {
        plugin.set_param(id, value);
    }
    plugin
}
