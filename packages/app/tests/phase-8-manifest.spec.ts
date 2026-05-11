import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M1 — plugin manifest schema. Positive + negative fixtures
 * locked in here; the manifest shape is the public SDK contract, so
 * any change here is a knowing change.
 */

type Issue = { path: string; message: string };
type Ok = { ok: true; manifest: Record<string, unknown> };
type Err = { ok: false; issues: Issue[] };
type Result = Ok | Err;

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function parse(page: Page, raw: unknown): Promise<Result> {
  return page.evaluate((m) => {
    const w = window as any;
    return w.__bridge.parsePluginManifest(m) as Result;
  }, raw);
}

const VALID_WASM_SRI = 'sha256-' + 'A'.repeat(43) + '=';
const VALID_UI_SRI   = 'sha256-' + 'B'.repeat(43) + '=';

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'com.example.acme-reverb',
    name: 'Acme Reverb',
    version: '1.2.3',
    kind: 'effect',
    wasm: 'https://cdn.example.com/acme-reverb-1.2.3.wasm',
    wasmIntegrity: VALID_WASM_SRI,
    ui: 'https://cdn.example.com/acme-reverb-1.2.3-ui.js',
    uiIntegrity: VALID_UI_SRI,
    params: [
      { id: 'mix',     name: 'Mix',     min: 0, max: 1,     default: 0.3, curve: 'linear' },
      { id: 'time',    name: 'Time',    min: 1, max: 2000,  default: 250, curve: 'log',    unit: 'ms' },
    ],
    license: 'MIT',
    homepage: 'https://example.com/acme-reverb',
    icon: 'data:image/svg+xml,…',
    ...overrides,
  };
}

test.describe('phase-8 M1 — plugin manifest schema', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
  });

  test('accepts a full valid manifest', async ({ page }) => {
    const r = await parse(page, validManifest());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.id).toBe('com.example.acme-reverb');
      expect((r.manifest as any).params).toHaveLength(2);
    }
  });

  test('accepts a minimal manifest (no UI, no params, no metadata)', async ({ page }) => {
    const r = await parse(page, {
      id: 'com.example.zero',
      name: 'Zero',
      version: '0.1.0',
      kind: 'effect',
      wasm: '/plugins/zero.wasm',
      wasmIntegrity: VALID_WASM_SRI,
      params: [],
    });
    expect(r.ok).toBe(true);
  });

  test('tolerates unknown extra fields (forward-compat)', async ({ page }) => {
    const r = await parse(page, validManifest({ futureField: 42, anotherOne: 'yes' }));
    expect(r.ok).toBe(true);
  });

  test('rejects non-object input', async ({ page }) => {
    for (const bad of [null, 'string', 42, [], true]) {
      const r = await parse(page, bad);
      expect(r.ok).toBe(false);
    }
  });

  test('rejects missing required fields', async ({ page }) => {
    const required = ['id', 'name', 'version', 'kind', 'wasm', 'wasmIntegrity', 'params'];
    for (const field of required) {
      const m = validManifest();
      delete (m as any)[field];
      const r = await parse(page, m);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.issues.some((i) => i.path === field)).toBe(true);
      }
    }
  });

  test('rejects invalid id (must be reverse-domain notation)', async ({ page }) => {
    for (const bad of ['noDots', 'UpperCase.io', '.leadingDot', 'trailing.', '']) {
      const r = await parse(page, validManifest({ id: bad }));
      expect(r.ok).toBe(false);
    }
  });

  test('accepts semver prerelease, rejects non-semver versions', async ({ page }) => {
    expect((await parse(page, validManifest({ version: '1.0.0-beta.1' }))).ok).toBe(true);
    for (const bad of ['1.0', '1', '1.0.0.0', 'v1.0.0', 'one.two.three']) {
      const r = await parse(page, validManifest({ version: bad }));
      expect(r.ok).toBe(false);
    }
  });

  test('rejects unknown kind', async ({ page }) => {
    const r = await parse(page, validManifest({ kind: 'midi' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toBe('kind');
  });

  test('rejects malformed wasmIntegrity', async ({ page }) => {
    for (const bad of ['notahash', 'md5-abc', 'sha256-tooShort', 'sha256-' + 'A'.repeat(44)]) {
      const r = await parse(page, validManifest({ wasmIntegrity: bad }));
      expect(r.ok).toBe(false);
    }
  });

  test('rejects wasm with bad URL', async ({ page }) => {
    const r = await parse(page, validManifest({ wasm: 'not a url' }));
    expect(r.ok).toBe(false);
  });

  test('requires uiIntegrity when ui present', async ({ page }) => {
    const m = validManifest();
    delete (m as any).uiIntegrity;
    const r = await parse(page, m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'uiIntegrity')).toBe(true);
  });

  test('rejects uiIntegrity without ui', async ({ page }) => {
    const m = validManifest();
    delete (m as any).ui;
    const r = await parse(page, m);
    expect(r.ok).toBe(false);
  });

  test('rejects param with unknown curve', async ({ page }) => {
    const r = await parse(page, validManifest({
      params: [{ id: 'x', name: 'X', min: 0, max: 1, default: 0.5, curve: 'sigmoid' }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toBe('params[0].curve');
  });

  test('rejects param with min >= max', async ({ page }) => {
    const r = await parse(page, validManifest({
      params: [{ id: 'x', name: 'X', min: 1, max: 0, default: 0, curve: 'linear' }],
    }));
    expect(r.ok).toBe(false);
  });

  test('rejects param with default outside [min, max]', async ({ page }) => {
    const r = await parse(page, validManifest({
      params: [{ id: 'x', name: 'X', min: 0, max: 1, default: 5, curve: 'linear' }],
    }));
    expect(r.ok).toBe(false);
  });

  test('rejects duplicate param ids', async ({ page }) => {
    const r = await parse(page, validManifest({
      params: [
        { id: 'mix', name: 'Mix A', min: 0, max: 1, default: 0, curve: 'linear' },
        { id: 'mix', name: 'Mix B', min: 0, max: 1, default: 1, curve: 'linear' },
      ],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => /duplicate/.test(i.message))).toBe(true);
  });

  test('relative URLs are accepted for wasm/ui (same-origin hosting)', async ({ page }) => {
    const r = await parse(page, validManifest({
      wasm: '/plugins/acme.wasm',
      ui:   './ui/acme.js',
    }));
    expect(r.ok).toBe(true);
  });
});
