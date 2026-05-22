#!/usr/bin/env node
// Phase-9 LAN-testing helper.
//
// Boots the sync-server + Vite dev server in one go, in a config that
// other machines on the same LAN can reach:
//
//   - Sync server listens on 0.0.0.0:1234 (plain ws, local only).
//   - Vite serves HTTPS on 0.0.0.0:8347 (self-signed cert via
//     SHARE_MODE=1 in packages/app/vite.config.ts). HTTPS is required
//     so the LAN-IP origin is a secure context — otherwise current
//     Chromium ignores COOP/COEP (no SharedArrayBuffer) and
//     AudioContext.audioWorklet is undefined, breaking the engine.
//   - VITE_SYNC_URL points the client at wss://<LAN IP>:8347/sync,
//     a SAME-ORIGIN path Vite proxies to the local sync server. This
//     dodges the mixed-content trap (an https page can't open ws://)
//     without putting TLS on the sync server.
//
// Each device hits a self-signed-cert warning once ("proceed"); after
// that audio + collab both work. Ctrl-C tears down both processes.

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

/// Pick the first non-internal IPv4 address. Most laptops surface
/// one obvious LAN interface (en0 on macOS, eth0/wlan0 on Linux);
/// when multiple exist we go with the first as a sensible default.
function detectLanIp() {
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

const lanIp = detectLanIp();
if (!lanIp) {
  console.warn(
    '[dev:share] No non-loopback IPv4 interface found — falling back to localhost.\n' +
    '            Other machines on your LAN won\'t be able to reach this server.',
  );
}
const host = lanIp ?? 'localhost';
const syncPort = process.env.SYNC_PORT ? Number(process.env.SYNC_PORT) : 1234;
const vitePort = 8347;

console.log('───────────────────────────────────────────────────────');
console.log('  8347 Studio — share mode (Phase-9 LAN testing)');
console.log('───────────────────────────────────────────────────────');
console.log(`  App:        https://${host}:${vitePort}/`);
console.log(`  Sync:       wss://${host}:${vitePort}/sync/room/<id> (proxied)`);
console.log(`  Loopback:   https://localhost:${vitePort}/`);
console.log('───────────────────────────────────────────────────────');
console.log('  Tip: visit https://<host>:8347/?room=<id> on each device');
console.log('       to join the same project. Accept the self-signed');
console.log('       cert warning once per device. Ctrl-C to stop.');
console.log('───────────────────────────────────────────────────────');

const children = [];

function spawnChild(label, command, args, env) {
  const proc = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${label}] `;
  const tag = (chunk) => chunk.toString().split('\n').map((l) => l ? prefix + l : l).join('\n');
  proc.stdout.on('data', (c) => process.stdout.write(tag(c)));
  proc.stderr.on('data', (c) => process.stderr.write(tag(c)));
  proc.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 1);
  });
  children.push(proc);
  return proc;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* may already be dead */ }
  }
  // Hard-exit if children don't drop within a second.
  setTimeout(() => process.exit(code), 1000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

spawnChild('sync ', 'pnpm', ['--filter', 'sync-server', 'start'], {
  HOST: '0.0.0.0',
  PORT: String(syncPort),
});

spawnChild('vite ', 'pnpm', ['--filter', 'app', 'dev'], {
  SHARE_MODE: '1',
  SYNC_PORT: String(syncPort),
  // Same-origin wss path; Vite proxies /sync → the local ws sync server.
  VITE_SYNC_URL: `wss://${host}:${vitePort}/sync`,
});
