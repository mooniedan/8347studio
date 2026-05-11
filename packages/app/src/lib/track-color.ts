/**
 * Phase 7 M3 — per-track color palette. 8-entry saturated palette
 * matching the design tokens (`--track-1` … `--track-8` in
 * `styles/tokens.css`). The palette here mirrors the CSS values so
 * Y.Doc track meta can store concrete hex strings (independent of
 * the runtime token, allowing future per-track custom colors).
 *
 * `defaultColorForIndex` round-robins through the palette by track
 * order — the dream principle: tracks should be visually
 * distinguishable at a glance.
 */

export const TRACK_PALETTE: readonly string[] = [
  '#e2342d', // 1 — accent red
  '#ff8a3d', // 2 — orange
  '#ffd23d', // 3 — yellow
  '#5fc36b', // 4 — green
  '#3dc8c0', // 5 — teal
  '#4a9eff', // 6 — blue
  '#a06bff', // 7 — purple
  '#ff5fa8', // 8 — pink
] as const;

export function defaultColorForIndex(idx: number): string {
  return TRACK_PALETTE[((idx % TRACK_PALETTE.length) + TRACK_PALETTE.length) %
    TRACK_PALETTE.length];
}

/** Returns the design-token CSS reference (`var(--track-N)`) for a
 *  track index — handy if a consumer wants to live-switch palettes
 *  via the root `data-track-palette` attribute. */
export function tokenColorForIndex(idx: number): string {
  return `var(--track-${(idx % TRACK_PALETTE.length) + 1})`;
}
