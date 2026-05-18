// Integration test for the Phase-9 M1 sync server.
//
// Boots the server on an ephemeral port, opens two raw WebSocket
// connections speaking the y-protocols wire format, and asserts:
//   1. A client A's update lands at client B within RTT (≤500 ms).
//   2. Awareness updates flow A → B.
//   3. A disconnects → reconnects → still sees state.
//   4. Authorized + unauthorized requests are gated by SYNC_TOKEN.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { createServer } from '../src/server.mjs';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * Minimal Yjs sync client: opens a WS to the server, drives the
 * y-protocols handshake, and surfaces the Y.Doc + Awareness so tests
 * can poke at them. Strips out everything the real client doesn't
 * need (IndexedDB persistence, retry/backoff, telemetry).
 */
function makeClient({ url, doc = new Y.Doc(), awareness }) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  awareness = awareness ?? new awarenessProtocol.Awareness(doc);

  function sendBytes(bytes) {
    if (ws.readyState === ws.OPEN) ws.send(bytes);
  }

  // y-protocols handshake is symmetric — both sides need to send
  // step 1 so each gets the other's missing updates. The server
  // sends step 1 on connect; the client mirrors that here.
  const opened = new Promise((resolve, reject) => {
    ws.once('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      sendBytes(encoding.toUint8Array(enc));
      resolve();
    });
    ws.once('error', reject);
  });

  // Broadcast our doc updates to the server.
  doc.on('update', (update, origin) => {
    if (origin === ws) return; // came from the server already
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    sendBytes(encoding.toUint8Array(enc));
  });

  // Broadcast our awareness changes.
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === 'server') return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    sendBytes(encoding.toUint8Array(enc));
  });

  ws.on('message', (data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dec = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(dec);
    switch (messageType) {
      case MESSAGE_SYNC: {
        // Reply enc — server may want a follow-up.
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        // Setting origin=ws prevents our own update handler from
        // re-broadcasting what we just absorbed from the server.
        syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) {
          sendBytes(encoding.toUint8Array(enc));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(dec),
          'server',
        );
        break;
      }
      default:
        break;
    }
  });

  return {
    ws,
    doc,
    awareness,
    async ready() { await opened; },
    close() {
      return new Promise((resolve) => {
        const finish = () => {
          // Awareness owns an internal cleanup interval; destroying
          // it lets the test runner's event loop drain after the
          // assertions complete.
          awareness.destroy();
          doc.destroy();
          resolve();
        };
        if (ws.readyState === ws.CLOSED) return finish();
        ws.once('close', finish);
        ws.close();
      });
    },
  };
}

async function withServer(env, fn) {
  // Pass-through env vars. Currently only SYNC_TOKEN matters.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const srv = await createServer({ port: 0 });
  try {
    await fn(srv);
  } finally {
    await srv.close();
    process.env = saved;
  }
}

test('two clients sync edits through the server', async () => {
  await withServer({}, async (srv) => {
    const url = `ws://127.0.0.1:${srv.port}/room/test`;
    const a = makeClient({ url });
    const b = makeClient({ url });
    await a.ready();
    await b.ready();

    // Give both clients a tick to complete the initial sync handshake.
    await delay(50);

    a.doc.getMap('meta').set('name', 'Hello');

    // Poll B for the change.
    let bName;
    for (let i = 0; i < 50; i++) {
      bName = b.doc.getMap('meta').get('name');
      if (bName === 'Hello') break;
      await delay(10);
    }
    assert.equal(bName, 'Hello', 'expected B to see A\'s edit');

    await a.close();
    await b.close();
  });
});

test('awareness updates propagate A → B', async () => {
  await withServer({}, async (srv) => {
    const url = `ws://127.0.0.1:${srv.port}/room/awareness-test`;
    const a = makeClient({ url });
    const b = makeClient({ url });
    await a.ready();
    await b.ready();
    await delay(50);

    a.awareness.setLocalStateField('user', { name: 'Alice', color: '#f00' });

    let seen;
    for (let i = 0; i < 50; i++) {
      const states = Array.from(b.awareness.getStates().values());
      seen = states.find((s) => s.user?.name === 'Alice');
      if (seen) break;
      await delay(10);
    }
    assert.ok(seen, 'expected B to see A\'s awareness state');
    assert.equal(seen.user.color, '#f00');

    await a.close();
    await b.close();
  });
});

test('reconnect catches up with missed edits', async () => {
  await withServer({}, async (srv) => {
    const url = `ws://127.0.0.1:${srv.port}/room/reconnect-test`;
    const a = makeClient({ url });
    const b = makeClient({ url });
    await a.ready();
    await b.ready();
    await delay(50);

    a.doc.getArray('xs').push(['one']);
    await delay(50);
    assert.deepEqual(b.doc.getArray('xs').toArray(), ['one']);

    // B drops out; A keeps editing.
    await b.close();
    a.doc.getArray('xs').push(['two', 'three']);
    await delay(50);

    // B reconnects with a fresh doc and should pull the missing edits.
    const b2 = makeClient({ url });
    await b2.ready();
    let xs;
    for (let i = 0; i < 50; i++) {
      xs = b2.doc.getArray('xs').toArray();
      if (xs.length === 3) break;
      await delay(10);
    }
    assert.deepEqual(xs, ['one', 'two', 'three']);

    await a.close();
    await b2.close();
  });
});

test('SYNC_TOKEN gate rejects unauthorized clients and admits authorized ones', async () => {
  await withServer({ SYNC_TOKEN: 'secret-123' }, async (srv) => {
    const denied = new WebSocket(`ws://127.0.0.1:${srv.port}/room/x`);
    const rejection = new Promise((resolve) => {
      denied.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      denied.on('error', () => resolve(0));
    });
    const code = await rejection;
    assert.equal(code, 401, `expected 401, got ${code}`);

    const allowed = new WebSocket(
      `ws://127.0.0.1:${srv.port}/room/x?token=secret-123`,
    );
    await new Promise((resolve, reject) => {
      allowed.once('open', resolve);
      allowed.once('error', reject);
    });
    await new Promise((resolve) => {
      allowed.once('close', () => resolve());
      allowed.close();
    });
  });
});

test('bad room path returns 400', async () => {
  await withServer({}, async (srv) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/not-a-room`);
    const code = await new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve(0));
    });
    assert.equal(code, 400);
  });
});
