import { test, expect } from '@playwright/test';

/**
 * Phase 7 M1 — visual baseline spec. Locks the P0 token surface and
 * the base UI component set so later phases can't quietly drift the
 * design system. Loads the `/?styleguide=1` route (see main.ts).
 */
test.describe('phase-7 M1 — styleguide & visual system', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?styleguide=1');
    await expect(page.getByTestId('styleguide')).toBeVisible();
  });

  test('all primary sections render', async ({ page }) => {
    await expect(page.getByTestId('section-colors')).toBeVisible();
    await expect(page.getByTestId('section-type')).toBeVisible();
    await expect(page.getByTestId('section-spacing')).toBeVisible();
    await expect(page.getByTestId('section-track-palette')).toBeVisible();
    await expect(page.getByTestId('section-components')).toBeVisible();
  });

  test('P0 tokens are bound on :root', async ({ page }) => {
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bg0:       cs.getPropertyValue('--bg-0').trim(),
        bg3:       cs.getPropertyValue('--bg-3').trim(),
        fg0:       cs.getPropertyValue('--fg-0').trim(),
        accent:    cs.getPropertyValue('--accent').trim(),
        meterOk:   cs.getPropertyValue('--meter-ok').trim(),
        meterClip: cs.getPropertyValue('--meter-clip').trim(),
        sp3:       cs.getPropertyValue('--sp-3').trim(),
        sp6:       cs.getPropertyValue('--sp-6').trim(),
        text12:    cs.getPropertyValue('--text-12').trim(),
        sans:      cs.getPropertyValue('--font-sans').trim(),
        mono:      cs.getPropertyValue('--font-mono').trim(),
        track1:    cs.getPropertyValue('--track-1').trim(),
        track8:    cs.getPropertyValue('--track-8').trim(),
      };
    });
    expect(tokens.bg0).toBe('#07070a');
    expect(tokens.bg3).toBe('#20232a');
    expect(tokens.fg0).toBe('#f4f5f7');
    expect(tokens.accent).toBe('#e2342d');
    expect(tokens.meterOk).toBe('#5fc36b');
    expect(tokens.meterClip).toBe('#e2342d');
    expect(tokens.sp3).toBe('8px');
    expect(tokens.sp6).toBe('24px');
    expect(tokens.text12).toBe('12px');
    expect(tokens.sans).toContain('IBM Plex Sans');
    expect(tokens.mono).toContain('IBM Plex Mono');
    expect(tokens.track1).toBe('#e2342d');
    expect(tokens.track8).toBe('#ff5fa8');
  });

  test('IBM Plex fonts are loaded', async ({ page }) => {
    // Wait for fonts before asking — @fontsource is async.
    await page.evaluate(() => (document as any).fonts.ready);
    const families = await page.evaluate(() => {
      // @ts-expect-error iter
      return Array.from(document.fonts).map((f: FontFace) => f.family);
    });
    expect(families).toContain('IBM Plex Sans');
    expect(families).toContain('IBM Plex Mono');
  });

  test('every base component renders', async ({ page }) => {
    for (const id of [
      'cmp-buttons',
      'cmp-pills',
      'cmp-seg',
      'cmp-numeric',
      'cmp-slider',
      'cmp-knob',
      'cmp-fader',
      'cmp-h-meter',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test('buttons are interactive', async ({ page }) => {
    const btn = page.getByTestId('btn-primary');
    await expect(btn).toBeEnabled();
    await btn.click(); // no-op handler, just verifies hit-testability
  });

  test('SegmentedControl switches selection', async ({ page }) => {
    const lp = page.getByTestId('seg-filter-lp');
    const hp = page.getByTestId('seg-filter-hp');
    await expect(lp).toHaveAttribute('aria-checked', 'true');
    await hp.click();
    await expect(hp).toHaveAttribute('aria-checked', 'true');
    await expect(lp).toHaveAttribute('aria-checked', 'false');
  });

  test('Numeric wheel-up increments by one step', async ({ page }) => {
    const bpm = page.getByTestId('num-bpm');
    await expect(bpm).toHaveText(/128/);
    await bpm.hover();
    await page.mouse.wheel(0, -1);
    await expect(bpm).toHaveText(/129/);
    await page.mouse.wheel(0, -1);
    await expect(bpm).toHaveText(/130/);
    await page.mouse.wheel(0, 1);
    await expect(bpm).toHaveText(/129/);
  });

  test('Numeric click-drag updates the value (vertical pointer drag)', async ({ page }) => {
    // Use synthetic pointer events to sidestep Playwright's mouse→pointer
    // synthesis quirks around setPointerCapture; this is the path the
    // component actually exposes to the DOM.
    await page.getByTestId('num-bpm').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const fire = (type: string, y: number) => el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
          clientX: cx, clientY: y, bubbles: true,
        }),
      );
      fire('pointerdown', cy);
      fire('pointermove', cy - 10);
      fire('pointerup', cy - 10);
    });
    await expect(page.getByTestId('num-bpm')).toHaveText(/138|139|140/);
  });

  test('Pill toggle exposes aria-pressed', async ({ page }) => {
    const solo = page.getByTestId('pill-solo');
    await expect(solo).toHaveAttribute('aria-pressed', 'true');
  });

  test('Meter is reachable by aria role', async ({ page }) => {
    await expect(page.getByTestId('meter-master')).toBeVisible();
    await expect(page.getByTestId('hmeter-95')).toBeVisible();
  });

  test('visual snapshot of the styleguide', async ({ page }) => {
    // Wait for fonts so the snapshot is deterministic.
    await page.evaluate(() => (document as any).fonts.ready);
    await expect(page.getByTestId('styleguide')).toHaveScreenshot('styleguide.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
    });
  });
});
