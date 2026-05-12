#!/usr/bin/env node
// Phase 8 M5 — emit plugin manifest JSONs next to each example
// plugin's compiled WASM. Run after `just build-example-plugins` has
// produced the .wasm files; this script hashes them and writes a
// minimal manifest the picker can fetch and install end-to-end.
//
// Kept in plain Node so there's no toolchain to add — the only thing
// it needs is `crypto.createHash` which is part of `node:crypto`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'packages', 'app', 'public', 'example-plugins');

function sri(wasmFile) {
  const path = resolve(out, wasmFile);
  if (!existsSync(path)) {
    throw new Error(`missing plugin wasm: ${path} (did you run \`just build-example-plugins\` first?)`);
  }
  return 'sha256-' + createHash('sha256').update(readFileSync(path)).digest('base64');
}

function emit(manifest, file) {
  const path = resolve(out, file);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${path}`);
}

emit(
  {
    id: 'com.example.gain',
    name: 'Gain',
    version: '0.1.0',
    kind: 'effect',
    wasm: './wasm_gain_plugin.wasm',
    wasmIntegrity: sri('wasm_gain_plugin.wasm'),
    params: [
      { id: 'gain', name: 'Gain', min: 0, max: 1, default: 1, curve: 'linear' },
    ],
    license: 'MIT',
  },
  'wasm_gain_plugin.json',
);

emit(
  {
    id: 'com.example.bitcrusher',
    name: 'Bitcrusher',
    version: '0.1.0',
    kind: 'effect',
    wasm: './wasm_bitcrusher.wasm',
    wasmIntegrity: sri('wasm_bitcrusher.wasm'),
    params: [
      { id: 'bit_depth', name: 'Bit Depth', min: 1, max: 16, default: 8, curve: 'linear', unit: 'none' },
      { id: 'srr', name: 'Sample Rate', min: 1, max: 32, default: 1, curve: 'linear' },
      { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, curve: 'linear' },
    ],
    license: 'MIT',
  },
  'wasm_bitcrusher.json',
);
