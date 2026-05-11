<script lang="ts">
  /**
   * Phase 7 M1 styleguide — visual reference for the P0 design system
   * and base components in `lib/ui/`. Mounted via `?styleguide=1`.
   * Doubles as the snapshot target for the Playwright regression
   * test in `tests/phase-7/styleguide.spec.ts`.
   */
  import {
    Button,
    IconButton,
    Pill,
    SegmentedControl,
    Numeric,
    Slider,
    Knob,
    Fader,
    Meter,
  } from './lib/ui';

  let segValue = $state<'lp' | 'hp' | 'bp'>('lp');
  let numValue = $state(120);
  let bpmValue = $state(128);
  let sliderValue = $state(0.5);
  let knobCutoff = $state(0.66);
  let knobReso = $state(0.3);
  let faderTrack = $state(0.72);
  let faderMaster = $state(0.6);

  const swatches = [
    { name: '--bg-0', hex: '#07070a' },
    { name: '--bg-1', hex: '#0e0f12' },
    { name: '--bg-2', hex: '#16181c' },
    { name: '--bg-3', hex: '#20232a' },
    { name: '--fg-0', hex: '#f4f5f7' },
    { name: '--fg-1', hex: '#c8ccd4' },
    { name: '--fg-2', hex: '#7c8290' },
    { name: '--fg-3', hex: '#4a4f5a' },
  ];
  const semantic = [
    { name: '--accent', hex: '#e2342d', glyph: 'AC' },
    { name: '--rec',    hex: '#e2342d', glyph: 'REC' },
    { name: '--arm',    hex: '#ff8a3d', glyph: 'ARM' },
    { name: '--solo',   hex: '#ffd23d', glyph: 'SOLO' },
    { name: '--mute',   hex: '#6a6f7c', glyph: 'MUTE' },
    { name: '--meter-ok',   hex: '#5fc36b', glyph: 'OK' },
    { name: '--meter-warn', hex: '#ffb13d', glyph: 'WARN' },
    { name: '--meter-clip', hex: '#e2342d', glyph: 'CLIP' },
  ];
  const tracks = [1, 2, 3, 4, 5, 6, 7, 8];
  const typeSizes = [
    { name: '--text-10', size: '10px' },
    { name: '--text-11', size: '11px' },
    { name: '--text-12', size: '12px' },
    { name: '--text-14', size: '14px' },
    { name: '--text-16', size: '16px' },
  ];
  const spaces = [
    { n: '1', v: '2px' },
    { n: '2', v: '4px' },
    { n: '3', v: '8px' },
    { n: '4', v: '12px' },
    { n: '5', v: '16px' },
    { n: '6', v: '24px' },
  ];
</script>

<div class="spec" data-testid="styleguide">

  <header class="spec-head">
    <div class="wordmark">
      <h1>
        <span class="leet">8</span>3<span class="leet">4</span><span class="leet">7</span>
        Studio
      </h1>
      <span class="tag">P0 — visual system</span>
    </div>
    <div class="meta">
      <div><span class="k">phase</span> <span class="v">7 / M1</span></div>
      <div><span class="k">tokens</span> <span class="v">tokens.css</span></div>
    </div>
  </header>

  <!-- Colors -->
  <section class="section" data-testid="section-colors">
    <div class="label">
      <span class="num">01</span>
      Colors
      <span class="desc">--bg-0..3 surfaces, --fg-0..3 text, semantic state.</span>
    </div>
    <div class="body">
      <div class="swatch-grid">
        {#each swatches as s (s.name)}
          <div class="swatch">
            <div class="chip" style:background={s.hex}></div>
            <div class="info">
              <span class="name">{s.name}</span>
              <span class="hex">{s.hex}</span>
            </div>
          </div>
        {/each}
      </div>
      <div class="swatch-grid">
        {#each semantic as s (s.name)}
          <div class="swatch semantic">
            <div class="chip" style:background={s.hex}>
              <span class="glyph">{s.glyph}</span>
            </div>
            <div class="info">
              <span class="name">{s.name}</span>
              <span class="hex">{s.hex}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Type -->
  <section class="section" data-testid="section-type">
    <div class="label">
      <span class="num">02</span>
      Type scale
      <span class="desc">IBM Plex Sans + IBM Plex Mono, 5 sizes 10–16px.</span>
    </div>
    <div class="body">
      <div class="type-scale">
        {#each typeSizes as t (t.name)}
          <div class="size">{t.name}</div>
          <div class="sample-sans" style:font-size={t.size}>The quick brown fox 0123</div>
          <div class="sample-mono" style:font-size={t.size}>120.00 BPM · 1.4.3.000 · -6.0 dB</div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Spacing -->
  <section class="section" data-testid="section-spacing">
    <div class="label">
      <span class="num">03</span>
      Spacing
      <span class="desc">--sp-1..6 → 2 / 4 / 8 / 12 / 16 / 24.</span>
    </div>
    <div class="body">
      <div class="spacing-row">
        {#each spaces as s (s.n)}
          <div class="step">
            <div class="bar" style:width={s.v}></div>
            <div class="lbl">--sp-<b>{s.n}</b> {s.v}</div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Track palette -->
  <section class="section" data-testid="section-track-palette">
    <div class="label">
      <span class="num">04</span>
      Track palette
      <span class="desc">Per-track color stripes; 8-entry saturated default.</span>
    </div>
    <div class="body">
      <div class="track-palette">
        {#each tracks as n (n)}
          <div class="track-chip" style:background="var(--track-{n})">T{n}</div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Components -->
  <section class="section" data-testid="section-components">
    <div class="label">
      <span class="num">05</span>
      Components
      <span class="desc">Buttons, segmented, numeric, slider, knob, fader, meter.</span>
    </div>
    <div class="body">
      <div class="cmp-grid">

        <div class="cmp" data-testid="cmp-buttons">
          <div class="cmp-title">
            <span class="name">Buttons</span>
            <span class="id">btn / btn--primary / btn--ghost / btn--icon</span>
          </div>
          <div class="cmp-stage">
            <Button testId="btn-default">Default</Button>
            <Button variant="primary" testId="btn-primary">Primary</Button>
            <Button variant="ghost" testId="btn-ghost">Ghost</Button>
            <IconButton ariaLabel="Settings" testId="btn-icon">⚙</IconButton>
          </div>
        </div>

        <div class="cmp" data-testid="cmp-pills">
          <div class="cmp-title">
            <span class="name">Pills</span>
            <span class="id">S / M / A / R — track-strip pills</span>
          </div>
          <div class="cmp-stage">
            <Pill kind="solo" active ariaLabel="Solo" testId="pill-solo">S</Pill>
            <Pill kind="mute" active ariaLabel="Mute" testId="pill-mute">M</Pill>
            <Pill kind="arm"  active ariaLabel="Arm"  testId="pill-arm">A</Pill>
            <Pill kind="rec"  active ariaLabel="Record" testId="pill-rec">R</Pill>
            <Pill kind="neutral"     ariaLabel="Inactive" testId="pill-off">·</Pill>
          </div>
        </div>

        <div class="cmp" data-testid="cmp-seg">
          <div class="cmp-title">
            <span class="name">Segmented</span>
            <span class="id">seg / seg.on</span>
          </div>
          <div class="cmp-stage">
            <SegmentedControl
              bind:value={segValue}
              ariaLabel="Filter type"
              testId="seg-filter"
              options={[
                { value: 'lp', label: 'LP' },
                { value: 'hp', label: 'HP' },
                { value: 'bp', label: 'BP' },
              ]}
            />
          </div>
        </div>

        <div class="cmp" data-testid="cmp-numeric">
          <div class="cmp-title">
            <span class="name">Numeric</span>
            <span class="id">click-drag · dbl-click to type · wheel</span>
          </div>
          <div class="cmp-stage">
            <Numeric
              bind:value={bpmValue}
              min={20} max={300} step={1}
              suffix=" BPM"
              width={80}
              ariaLabel="BPM"
              testId="num-bpm"
            />
            <Numeric
              bind:value={numValue}
              min={0} max={127} step={1}
              ariaLabel="Note"
              testId="num-note"
            />
          </div>
        </div>

        <div class="cmp" data-testid="cmp-slider">
          <div class="cmp-title">
            <span class="name">Slider</span>
            <span class="id">horizontal · 0..1</span>
          </div>
          <div class="cmp-stage">
            <Slider bind:value={sliderValue} ariaLabel="Mix" testId="slider-mix" />
          </div>
        </div>

        <div class="cmp" data-testid="cmp-knob">
          <div class="cmp-title">
            <span class="name">Knob</span>
            <span class="id">drag · dbl-click resets</span>
          </div>
          <div class="cmp-stage">
            <Knob
              bind:value={knobCutoff}
              label="Cutoff" suffix="" precision={2}
              ariaLabel="Cutoff"
              testId="knob-cutoff"
            />
            <Knob
              bind:value={knobReso}
              label="Reso" suffix="" precision={2}
              ariaLabel="Resonance"
              testId="knob-reso"
            />
          </div>
        </div>

        <div class="cmp" data-testid="cmp-fader">
          <div class="cmp-title">
            <span class="name">Faders + Meters</span>
            <span class="id">channel strip primitives</span>
          </div>
          <div class="cmp-stage" style:gap="32px">
            <div class="strip">
              <Fader bind:value={faderTrack} ariaLabel="Track 1 fader" testId="fader-track" />
              <Meter level={0.55} peak={0.75} ariaLabel="Track 1 meter" testId="meter-track" />
            </div>
            <div class="strip">
              <Fader bind:value={faderMaster} ariaLabel="Master fader" testId="fader-master" />
              <Meter level={0.82} peak={0.95} ariaLabel="Master meter" testId="meter-master" />
            </div>
          </div>
        </div>

        <div class="cmp" data-testid="cmp-h-meter">
          <div class="cmp-title">
            <span class="name">Horizontal meter</span>
            <span class="id">track-rail meter, slim</span>
          </div>
          <div class="cmp-stage" style:flex-direction="column" style:align-items="stretch">
            <Meter level={0.3} orientation="horizontal" ariaLabel="Track-rail meter, 30%" testId="hmeter-30" />
            <Meter level={0.7} orientation="horizontal" ariaLabel="Track-rail meter, 70%" testId="hmeter-70" />
            <Meter level={0.95} orientation="horizontal" ariaLabel="Track-rail meter, 95%" testId="hmeter-95" />
          </div>
        </div>

      </div>
    </div>
  </section>

</div>

<style>
  .spec {
    max-width: 1440px;
    margin: 0 auto;
    padding: var(--sp-6);
    display: flex;
    flex-direction: column;
    gap: var(--sp-6);
    color: var(--fg-0);
  }
  .spec-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding-bottom: var(--sp-5);
    border-bottom: 1px solid var(--line-1);
  }
  .spec-head .wordmark {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
  }
  .spec-head h1 {
    font-family: var(--font-mono);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
    color: var(--fg-0);
  }
  .spec-head h1 .leet { color: var(--accent); }
  .spec-head .tag {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-2);
    letter-spacing: 0.02em;
  }
  .spec-head .meta {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-2);
    text-align: right;
    line-height: 1.5;
  }
  .spec-head .meta .k { color: var(--fg-3); }
  .spec-head .meta .v { color: var(--fg-1); }

  .section {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: var(--sp-6);
    padding: var(--sp-5) 0;
  }
  .section > .label {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding-top: 6px;
  }
  .section > .label .num {
    display: block;
    color: var(--accent);
    font-size: var(--text-10);
    margin-bottom: 4px;
  }
  .section > .label .desc {
    display: block;
    text-transform: none;
    letter-spacing: 0;
    color: var(--fg-3);
    font-size: var(--text-11);
    margin-top: var(--sp-3);
    line-height: 1.5;
  }
  .section > .body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }

  .swatch-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--sp-3);
  }
  .swatch {
    background: var(--bg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--r-md);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .swatch .chip {
    height: 64px;
    border-bottom: 1px solid var(--line-1);
    position: relative;
  }
  .swatch .info {
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .swatch .info .name {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-0);
  }
  .swatch .info .hex {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
  }
  .swatch.semantic .chip {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .swatch.semantic .chip .glyph {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: rgba(0, 0, 0, 0.6);
    font-weight: 700;
    letter-spacing: 0.1em;
  }

  .type-scale {
    display: grid;
    grid-template-columns: 80px 1fr 1fr;
    gap: 0;
    border: 1px solid var(--line-1);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .type-scale > div {
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-2);
    display: flex;
    align-items: center;
  }
  .type-scale > div:nth-last-child(-n+3) { border-bottom: none; }
  .type-scale .size {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--accent);
    background: var(--bg-1);
    border-right: 1px solid var(--line-1);
  }
  .type-scale .sample-sans { color: var(--fg-0); }
  .type-scale .sample-mono {
    font-family: var(--font-mono);
    color: var(--fg-1);
    border-left: 1px solid var(--line-0);
  }

  .spacing-row {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-5);
    padding: var(--sp-5);
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-md);
  }
  .spacing-row .step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
  }
  .spacing-row .bar {
    background: var(--accent);
    border-radius: 1px;
    height: 24px;
  }
  .spacing-row .lbl {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
  }
  .spacing-row .lbl b { color: var(--fg-0); font-weight: 500; }

  .track-palette {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .track-chip {
    width: 56px;
    height: 32px;
    border-radius: var(--r-sm);
    border: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: flex-end;
    padding: 4px 6px;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: rgba(0, 0, 0, 0.65);
    font-weight: 600;
    position: relative;
    overflow: hidden;
  }
  .track-chip::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.18), transparent 50%);
    pointer-events: none;
  }

  .cmp-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-5);
  }
  .cmp {
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-md);
    padding: var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .cmp-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cmp-title .name {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-1);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .cmp-title .id {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-3);
  }
  .cmp-stage {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--sp-4);
    background:
      radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.02), transparent 60%),
      var(--bg-0);
    border: 1px solid var(--line-0);
    border-radius: var(--r-sm);
    padding: var(--sp-5);
    min-height: 120px;
  }

  .strip {
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }
</style>
