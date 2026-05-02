// Automation evaluation. The engine holds a flat list of lanes pulled
// from the project snapshot; each audio block, before rendering, the
// engine evaluates every lane at the current tick and writes the
// resulting value into the addressed plugin via set_param.
//
// Phase-4 M4 ships linear interpolation only. Hold and Exponential
// curves are listed in the spec's design but deferred to Phase-9
// polish — the lane storage is shape-compatible (see AutoPoint).

use crate::snapshot::{AutoPoint, AutoTarget, AutomationLane};

pub fn evaluate_lane(points: &[AutoPoint], tick: u64) -> Option<f32> {
    if points.is_empty() {
        return None;
    }
    if tick <= points[0].tick {
        return Some(points[0].value);
    }
    let last = points.last().unwrap();
    if tick >= last.tick {
        return Some(last.value);
    }
    for w in points.windows(2) {
        let p0 = w[0];
        let p1 = w[1];
        if tick >= p0.tick && tick < p1.tick {
            let span = (p1.tick - p0.tick) as f32;
            let frac = (tick - p0.tick) as f32 / span;
            return Some(p0.value + (p1.value - p0.value) * frac);
        }
    }
    Some(last.value)
}

pub fn lane_target(lane: &AutomationLane) -> (u32, AutoTarget, u32) {
    (lane.track_idx, lane.target, lane.param_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts(pairs: &[(u64, f32)]) -> alloc::vec::Vec<AutoPoint> {
        pairs
            .iter()
            .map(|&(tick, value)| AutoPoint { tick, value })
            .collect()
    }

    #[test]
    fn empty_lane_yields_none() {
        assert!(evaluate_lane(&[], 100).is_none());
    }

    #[test]
    fn single_point_lane_holds_constant() {
        let p = pts(&[(0, 0.5)]);
        assert_eq!(evaluate_lane(&p, 0), Some(0.5));
        assert_eq!(evaluate_lane(&p, 1000), Some(0.5));
    }

    #[test]
    fn before_first_point_returns_first_value() {
        let p = pts(&[(100, 1.0), (200, 2.0)]);
        assert_eq!(evaluate_lane(&p, 0), Some(1.0));
        assert_eq!(evaluate_lane(&p, 50), Some(1.0));
    }

    #[test]
    fn after_last_point_returns_last_value() {
        let p = pts(&[(100, 1.0), (200, 2.0)]);
        assert_eq!(evaluate_lane(&p, 200), Some(2.0));
        assert_eq!(evaluate_lane(&p, 1000), Some(2.0));
    }

    #[test]
    fn linear_interpolates_midpoint() {
        let p = pts(&[(0, 0.0), (1000, 1.0)]);
        assert_eq!(evaluate_lane(&p, 500), Some(0.5));
        assert_eq!(evaluate_lane(&p, 250), Some(0.25));
    }

    #[test]
    fn three_point_lane_routes_to_correct_segment() {
        let p = pts(&[(0, 0.0), (100, 1.0), (200, 0.0)]);
        // Segment 1: 0..100 → ramp up.
        assert_eq!(evaluate_lane(&p, 50), Some(0.5));
        // Segment 2: 100..200 → ramp down.
        assert_eq!(evaluate_lane(&p, 150), Some(0.5));
    }
}
