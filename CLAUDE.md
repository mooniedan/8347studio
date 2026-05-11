# 8347 Studio — agent guide

Read these before doing non-trivial work:

- `.claude/overview-plan.md` — phase map, current phase, cross-cutting
  commitments. Always check the phase map before starting work.
- `.claude/plans/phase-N-*.md` — the active phase plan. Mirror the
  shape of recent commits (`phase-N MX: …`).
- `.claude/plans/designs/` — HTML/CSS/JSX mockups the UI is converging
  toward; the design-prompts index lives at
  `.claude/plans/design-prompts.md` and tells you which mockup each
  phase milestone owns.
- `.claude/dream.md` — long-form intent.

## Non-negotiables

1. **Yjs is the source of truth.** All project state through the
   Y.Doc; engine consumes immutable snapshots.
2. **Audio thread never blocks, allocates, or touches JS objects.**
3. **Plugin trait stays stable** once a phase has shipped against it.
4. **Tests land with the feature.** Cargo for DSP, Playwright for UI,
   audio-snapshot for end-to-end. TDD-style — failing test first.
5. **The Demo Song is the cumulative audible regression.** Every new
   user-facing feature that *can* live in a project must:
   - Add a block to `seedDemoSong` in
     `packages/app/src/lib/project.ts`.
   - Add a matching assertion in
     `packages/app/tests/demo-song.spec.ts`.
   - Be audibly exercised when the user clicks `★ Demo Song` from a
     clean slate. If you ship a feature without doing this, the demo
     drifts away from "what the DAW can do today" — the canary the
     user relies on.

   Exempt: transport chrome, settings, satellite windows, and
   anything that can't be expressed as project content. Those stay
   covered by their own phase specs.

## Conventions

- Commit messages: `phase-N MX: short summary` for milestone work;
  `chore:` / `fix:` / `feat:` otherwise. Match the style of recent
  commits in `git log`.
- Never `git push` unless the most recent user message explicitly
  authorizes it for the specific commit at hand.
- After every milestone, run the full Playwright suite
  (`pnpm --filter app exec playwright test`) — it must stay green.
  The `m4-tempo "BPM doubles tick rate"` test is timing-flaky under
  parallel load; passing in isolation is the bar.

## Where features live

- Rust audio engine: `crates/audio-engine/` (DSP, plugins, scheduler).
- WASM bridge: `crates/wasm-bridge/` (exports the engine to JS).
- Svelte app: `packages/app/src/`.
  - Design tokens + base components: `src/styles/`, `src/lib/ui/`.
  - Project state + helpers: `src/lib/project.ts`.
  - Engine bridge: `src/lib/engine-bridge.ts`.
- Tests: `packages/app/tests/*.spec.ts` (Playwright);
  `crates/*/src/**` (cargo).
