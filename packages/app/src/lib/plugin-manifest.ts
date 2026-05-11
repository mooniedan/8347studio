/**
 * Phase 8 M1 — plugin manifest schema + validator.
 *
 * Third-party plugins publish a manifest JSON the host fetches first.
 * The host validates the shape here before fetching the WASM + UI
 * bundles named inside. Validation is *structural*, not behavioural —
 * integrity hash format is checked but the bytes haven't been fetched
 * yet at this point in the pipeline.
 *
 * Manifest stays minimal on purpose: anything that isn't required to
 * find + verify + present the plugin to the user belongs in the
 * plugin's own UI bundle, not the manifest. Adding fields later is
 * safe — `parseManifest` already tolerates unknown extra keys for
 * forward-compatibility.
 */

export type PluginKind = 'effect' | 'instrument' | 'container';
export const PLUGIN_KINDS: readonly PluginKind[] = ['effect', 'instrument', 'container'];

export type ParamCurve = 'linear' | 'log' | 'exponential';
export const PARAM_CURVES: readonly ParamCurve[] = ['linear', 'log', 'exponential'];

export interface ParamDescriptor {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  curve: ParamCurve;
  /** Display unit ("Hz", "dB", "%", etc.). Optional — UIs fall back
   *  to no suffix if absent. */
  unit?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  wasm: string;
  wasmIntegrity: string;
  ui?: string;
  uiIntegrity?: string;
  params: ParamDescriptor[];
  license?: string;
  homepage?: string;
  icon?: string;
}

export interface ValidationIssue {
  /** Dot-path to the offending value, e.g. `params[0].curve`. */
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: ValidationIssue[] };

// Reverse-domain notation: at least one dot, lowercase + digits + dashes.
const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
// Semver "major.minor.patch", with optional `-prerelease`.
const VERSION_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;
// SRI hash: `sha256-` then base64 (44 chars including = padding).
const SRI_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;

function isUrlLike(s: string): boolean {
  // Allow `https://`, `http://`, or relative paths (`/`, `./`, `../`).
  // Plugins served from the same origin as the host can use relative
  // URLs; CDN-hosted plugins use absolute ones.
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true;
  try { new URL(s); return true; } catch { return false; }
}

function pushReq<T>(
  issues: ValidationIssue[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  check: (v: unknown) => v is T,
  hint: string,
): T | undefined {
  if (!(key in obj)) {
    issues.push({ path: `${path}${key}`, message: `missing required field` });
    return undefined;
  }
  const v = obj[key];
  if (!check(v)) {
    issues.push({ path: `${path}${key}`, message: hint });
    return undefined;
  }
  return v;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function validateParam(
  raw: unknown,
  idx: number,
  issues: ValidationIssue[],
): ParamDescriptor | null {
  const path = `params[${idx}].`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: `params[${idx}]`, message: 'must be an object' });
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id   = pushReq(issues, obj, 'id',   path, isString, 'must be a string');
  const name = pushReq(issues, obj, 'name', path, isString, 'must be a string');
  const min  = pushReq(issues, obj, 'min',  path, isFiniteNumber, 'must be a finite number');
  const max  = pushReq(issues, obj, 'max',  path, isFiniteNumber, 'must be a finite number');
  const def  = pushReq(issues, obj, 'default', path, isFiniteNumber, 'must be a finite number');
  const curveRaw = pushReq(issues, obj, 'curve', path, isString, 'must be a string');

  let curve: ParamCurve | undefined;
  if (curveRaw !== undefined) {
    if (!(PARAM_CURVES as readonly string[]).includes(curveRaw)) {
      issues.push({
        path: `${path}curve`,
        message: `must be one of ${PARAM_CURVES.join(' | ')}`,
      });
    } else {
      curve = curveRaw as ParamCurve;
    }
  }

  if (min !== undefined && max !== undefined && min >= max) {
    issues.push({ path: `${path}min`, message: 'must be strictly less than max' });
  }
  if (def !== undefined && min !== undefined && max !== undefined && (def < min || def > max)) {
    issues.push({ path: `${path}default`, message: 'must lie within [min, max]' });
  }

  const unitRaw = obj.unit;
  if (unitRaw !== undefined && !isString(unitRaw)) {
    issues.push({ path: `${path}unit`, message: 'must be a string when present' });
  }

  if (
    id === undefined || name === undefined || min === undefined ||
    max === undefined || def === undefined || curve === undefined
  ) return null;

  return {
    id, name, min, max, default: def, curve,
    ...(typeof unitRaw === 'string' ? { unit: unitRaw } : {}),
  };
}

/** Validate a parsed-JSON value as a `PluginManifest`. Unknown extra
 *  keys are tolerated so the schema can grow without breaking older
 *  consumers. */
export function parseManifest(raw: unknown): ParseResult {
  const issues: ValidationIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '', message: 'manifest must be a JSON object' }] };
  }
  const obj = raw as Record<string, unknown>;

  const id      = pushReq(issues, obj, 'id', '', isString, 'must be a string');
  const name    = pushReq(issues, obj, 'name', '', isString, 'must be a string');
  const version = pushReq(issues, obj, 'version', '', isString, 'must be a string');
  const kindRaw = pushReq(issues, obj, 'kind', '', isString, 'must be a string');
  const wasm    = pushReq(issues, obj, 'wasm', '', isString, 'must be a string');
  const wasmInt = pushReq(issues, obj, 'wasmIntegrity', '', isString, 'must be a string');

  if (id !== undefined && !ID_RE.test(id)) {
    issues.push({ path: 'id', message: 'must be reverse-domain notation, e.g. com.example.acme-reverb' });
  }
  if (version !== undefined && !VERSION_RE.test(version)) {
    issues.push({ path: 'version', message: 'must be semver (major.minor.patch[-prerelease])' });
  }
  let kind: PluginKind | undefined;
  if (kindRaw !== undefined) {
    if (!(PLUGIN_KINDS as readonly string[]).includes(kindRaw)) {
      issues.push({ path: 'kind', message: `must be one of ${PLUGIN_KINDS.join(' | ')}` });
    } else {
      kind = kindRaw as PluginKind;
    }
  }
  if (wasm !== undefined && !isUrlLike(wasm)) {
    issues.push({ path: 'wasm', message: 'must be a URL or path' });
  }
  if (wasmInt !== undefined && !SRI_RE.test(wasmInt)) {
    issues.push({ path: 'wasmIntegrity', message: 'must be a sha256 SRI hash, e.g. sha256-…44 base64 chars…=' });
  }

  // Optional UI bundle — when one is present, integrity hash is
  // required too. When absent, the host renders the default UI from
  // descriptors.
  const ui = obj.ui;
  const uiInt = obj.uiIntegrity;
  if (ui !== undefined) {
    if (!isString(ui) || !isUrlLike(ui)) {
      issues.push({ path: 'ui', message: 'must be a URL or path' });
    }
    if (uiInt === undefined) {
      issues.push({ path: 'uiIntegrity', message: 'required when `ui` is present' });
    } else if (!isString(uiInt) || !SRI_RE.test(uiInt)) {
      issues.push({ path: 'uiIntegrity', message: 'must be a sha256 SRI hash' });
    }
  } else if (uiInt !== undefined) {
    issues.push({ path: 'uiIntegrity', message: '`ui` must be present when `uiIntegrity` is set' });
  }

  // params: required but can be empty for plugins whose UI is purely
  // event-driven (rare but allowed).
  let params: ParamDescriptor[] = [];
  if (!('params' in obj)) {
    issues.push({ path: 'params', message: 'missing required field' });
  } else if (!Array.isArray(obj.params)) {
    issues.push({ path: 'params', message: 'must be an array' });
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < obj.params.length; i++) {
      const p = validateParam(obj.params[i], i, issues);
      if (p) {
        if (seen.has(p.id)) {
          issues.push({ path: `params[${i}].id`, message: `duplicate id "${p.id}"` });
        }
        seen.add(p.id);
        params.push(p);
      }
    }
  }

  // Optional metadata.
  for (const key of ['license', 'homepage', 'icon'] as const) {
    const v = obj[key];
    if (v !== undefined && !isString(v)) {
      issues.push({ path: key, message: 'must be a string when present' });
    }
  }
  if (typeof obj.homepage === 'string' && !isUrlLike(obj.homepage)) {
    issues.push({ path: 'homepage', message: 'must be a URL or path' });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    manifest: {
      id: id!, name: name!, version: version!, kind: kind!,
      wasm: wasm!, wasmIntegrity: wasmInt!,
      params,
      ...(typeof ui === 'string' ? { ui } : {}),
      ...(typeof uiInt === 'string' ? { uiIntegrity: uiInt } : {}),
      ...(typeof obj.license === 'string' ? { license: obj.license } : {}),
      ...(typeof obj.homepage === 'string' ? { homepage: obj.homepage } : {}),
      ...(typeof obj.icon === 'string' ? { icon: obj.icon } : {}),
    },
  };
}

/** Convenience for the load path — fetched bytes will arrive as a
 *  string. Parses then validates; JSON parse errors are reported the
 *  same way as schema errors. */
export function parseManifestJson(text: string): ParseResult {
  try {
    return parseManifest(JSON.parse(text));
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '', message: `invalid JSON: ${(err as Error).message}` }],
    };
  }
}
