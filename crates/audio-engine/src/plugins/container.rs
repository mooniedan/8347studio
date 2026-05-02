// Container plugin — N parallel branches, each with its own insert
// chain. Outputs sum at the mix node. The escape hatch for graph-y
// use cases (parallel compression, mid/side, multi-band split) without
// turning the host into a node-graph editor.
//
// Each branch:
//   * has its own ordered Vec<InsertSlot> chain
//   * applies a post-chain gain
//   * sums into the container's output buffer
//
// Container's own descriptors expose per-branch gains (paramIds 0..N-1).
// Branch *structure* — count, per-branch chain — is reshaped via the
// snapshot path, not via set_param.

use alloc::boxed::Box;
use alloc::vec::Vec;
use core::any::Any;

use crate::plugin::{
    ParamCurve, ParamDescriptor, ParamId, ParamUnit, Plugin, PluginEvent, PluginKind,
};
use crate::snapshot::BranchSnapshot;
use crate::track::InsertSlot;

pub const MAX_BRANCHES: usize = 8;

struct Branch {
    plugins: Vec<InsertSlot>,
    gain: f32,
    /// Mono scratch the branch processes through. Sized lazily.
    scratch: Vec<f32>,
    /// Ping-pong target for the branch's own insert chain.
    scratch2: Vec<f32>,
}

pub struct Container {
    sample_rate: f32,
    branches: Vec<Branch>,
    /// Per-branch gain descriptors, generated lazily so the Vec lives
    /// as long as the Container.
    descs: Vec<ParamDescriptor>,
    /// Sum buffer — accumulates each branch's output before the host
    /// reads from it.
    sum: Vec<f32>,
}

impl Container {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            branches: Vec::new(),
            descs: Vec::new(),
            sum: Vec::new(),
        }
    }

    pub fn from_branches(sample_rate: f32, branches_snap: &[BranchSnapshot]) -> Self {
        let mut c = Self::new(sample_rate);
        c.set_branches(branches_snap);
        c
    }

    pub fn set_branches(&mut self, branches_snap: &[BranchSnapshot]) {
        self.branches.clear();
        let take = branches_snap.len().min(MAX_BRANCHES);
        for snap in branches_snap.iter().take(take) {
            let plugins: Vec<InsertSlot> = snap
                .inserts
                .iter()
                .map(|ins| InsertSlot {
                    plugin: super::build_insert_plugin(self.sample_rate, ins),
                    bypass: ins.bypass,
                })
                .collect();
            self.branches.push(Branch {
                plugins,
                gain: snap.gain,
                scratch: Vec::new(),
                scratch2: Vec::new(),
            });
        }
        // Rebuild descriptor table.
        // Names live in a static array because ParamDescriptor.name is &'static str.
        const NAMES: [&str; MAX_BRANCHES] = [
            "Branch 1 Gain",
            "Branch 2 Gain",
            "Branch 3 Gain",
            "Branch 4 Gain",
            "Branch 5 Gain",
            "Branch 6 Gain",
            "Branch 7 Gain",
            "Branch 8 Gain",
        ];
        self.descs = (0..self.branches.len())
            .map(|i| ParamDescriptor {
                id: i as u32,
                name: NAMES[i],
                min: 0.0,
                max: 2.0,
                default: 1.0,
                unit: ParamUnit::None,
                curve: ParamCurve::Linear,
                group: "container",
            })
            .collect();
    }

    pub fn branch_count(&self) -> usize {
        self.branches.len()
    }
}

impl Plugin for Container {
    fn descriptors(&self) -> &[ParamDescriptor] {
        &self.descs
    }

    fn set_param(&mut self, id: ParamId, value: f32) {
        if let Some(b) = self.branches.get_mut(id as usize) {
            b.gain = value.clamp(0.0, 4.0);
        }
    }

    fn get_param(&self, id: ParamId) -> Option<f32> {
        self.branches.get(id as usize).map(|b| b.gain)
    }

    fn handle_event(&mut self, _ev: PluginEvent) {}

    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize) {
        let Some(out) = outputs.get_mut(0) else { return };
        let input = inputs.first().copied().unwrap_or(&[]);
        // Resize sum.
        if self.sum.len() < frames {
            self.sum.resize(frames, 0.0);
        }
        for s in self.sum[..frames].iter_mut() {
            *s = 0.0;
        }
        // Run each branch and accumulate.
        for branch in self.branches.iter_mut() {
            if branch.scratch.len() < frames {
                branch.scratch.resize(frames, 0.0);
            }
            if branch.scratch2.len() < frames {
                branch.scratch2.resize(frames, 0.0);
            }
            // Seed the chain with the container's input.
            for i in 0..frames {
                branch.scratch[i] = if i < input.len() { input[i] } else { 0.0 };
            }
            // Run inserts inside this branch (copy-back pattern).
            for slot in branch.plugins.iter_mut() {
                if slot.bypass {
                    continue;
                }
                branch.scratch2[..frames].copy_from_slice(&branch.scratch[..frames]);
                let in_arr: [&[f32]; 1] = [&branch.scratch2[..frames]];
                let mut out_arr: [&mut [f32]; 1] = [&mut branch.scratch[..frames]];
                slot.plugin.process(&in_arr, &mut out_arr, frames);
            }
            // Accumulate into the sum, scaled by branch gain.
            let g = branch.gain;
            for i in 0..frames {
                self.sum[i] += branch.scratch[i] * g;
            }
        }
        // Write summed output.
        out[..frames].copy_from_slice(&self.sum[..frames]);
    }

    fn reset(&mut self) {
        for branch in self.branches.iter_mut() {
            for slot in branch.plugins.iter_mut() {
                slot.plugin.reset();
            }
            for s in branch.scratch.iter_mut() {
                *s = 0.0;
            }
            for s in branch.scratch2.iter_mut() {
                *s = 0.0;
            }
        }
        for s in self.sum.iter_mut() {
            *s = 0.0;
        }
    }

    fn kind(&self) -> PluginKind {
        PluginKind::Container
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
    use crate::snapshot::{InsertKind, InsertSnapshot};
    use alloc::vec;

    fn render(c: &mut Container, input: &[f32]) -> alloc::vec::Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];
        let in_arr: [&[f32]; 1] = [input];
        let mut out_arr: [&mut [f32]; 1] = [&mut out[..]];
        c.process(&in_arr, &mut out_arr, n);
        out
    }

    fn gain_insert(g: f32) -> InsertSnapshot {
        InsertSnapshot {
            kind: InsertKind::Gain,
            params: vec![(0, g)],
            bypass: false,
            branches: vec![],
        }
    }

    #[test]
    fn no_branches_outputs_silence() {
        let mut c = Container::new(48_000.0);
        let input = vec![0.5f32; 8];
        let out = render(&mut c, &input);
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn two_branches_identity_and_half_sum_to_1_5x_input() {
        // Branch 0: empty chain (passthrough), gain 1.0.
        // Branch 1: single Gain ×0.5 insert, gain 1.0.
        // Sum: input × 1.0 + input × 0.5 = input × 1.5.
        let mut c = Container::from_branches(
            48_000.0,
            &[
                BranchSnapshot { gain: 1.0, inserts: vec![] },
                BranchSnapshot { gain: 1.0, inserts: vec![gain_insert(0.5)] },
            ],
        );
        let input = [1.0f32, -1.0, 0.5, -0.5];
        let out = render(&mut c, &input);
        for (a, b) in out.iter().zip(&input) {
            assert!((a - b * 1.5).abs() < 1e-6, "got {}, expected {}", a, b * 1.5);
        }
    }

    #[test]
    fn branch_gain_scales_branch_output() {
        // Single branch with no inserts and gain 0.25.
        let mut c = Container::from_branches(
            48_000.0,
            &[BranchSnapshot { gain: 0.25, inserts: vec![] }],
        );
        let input = [1.0f32; 4];
        let out = render(&mut c, &input);
        for s in out.iter() {
            assert!((s - 0.25).abs() < 1e-6);
        }
    }

    #[test]
    fn set_param_overrides_branch_gain() {
        let mut c = Container::from_branches(
            48_000.0,
            &[BranchSnapshot { gain: 1.0, inserts: vec![] }],
        );
        c.set_param(0, 0.5);
        let input = [1.0f32; 4];
        let out = render(&mut c, &input);
        for s in out.iter() {
            assert!((s - 0.5).abs() < 1e-6);
        }
    }

    #[test]
    fn bypassed_insert_inside_branch_passes_signal() {
        // Branch with a Gain ×0 insert, but the slot is bypassed →
        // signal should pass through at the branch's input level.
        let mut c = Container::from_branches(
            48_000.0,
            &[BranchSnapshot {
                gain: 1.0,
                inserts: vec![InsertSnapshot {
                    kind: InsertKind::Gain,
                    params: vec![(0, 0.0)],
                    bypass: true,
                    branches: vec![],
                }],
            }],
        );
        let input = [0.6f32; 4];
        let out = render(&mut c, &input);
        for s in out.iter() {
            assert!((s - 0.6).abs() < 1e-6);
        }
    }

    #[test]
    fn branch_count_capped_at_max() {
        let many = (0..16)
            .map(|_| BranchSnapshot { gain: 0.1, inserts: vec![] })
            .collect::<alloc::vec::Vec<_>>();
        let c = Container::from_branches(48_000.0, &many);
        assert_eq!(c.branch_count(), MAX_BRANCHES);
    }

    #[test]
    fn descriptors_match_branch_count() {
        let c = Container::from_branches(
            48_000.0,
            &[
                BranchSnapshot { gain: 1.0, inserts: vec![] },
                BranchSnapshot { gain: 1.0, inserts: vec![] },
                BranchSnapshot { gain: 1.0, inserts: vec![] },
            ],
        );
        assert_eq!(c.descriptors().len(), 3);
    }
}
