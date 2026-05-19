// Phase-9 M2 asset-bucket integration tests.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

import { createServer } from '../src/server.mjs';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function withServer(env, fn) {
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

test('PUT /asset/<hash> stores bytes; GET returns them', async () => {
  await withServer({}, async (srv) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = sha256Hex(bytes);

    const put = await fetch(`http://127.0.0.1:${srv.port}/asset/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav' },
      body: bytes,
    });
    assert.equal(put.status, 204);

    const get = await fetch(`http://127.0.0.1:${srv.port}/asset/${hash}`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'audio/wav');
    const got = new Uint8Array(await get.arrayBuffer());
    assert.deepEqual(Array.from(got), Array.from(bytes));
  });
});

test('GET /asset/<unknown-hash> returns 404', async () => {
  await withServer({}, async (srv) => {
    const fakeHash = 'a'.repeat(64);
    const res = await fetch(`http://127.0.0.1:${srv.port}/asset/${fakeHash}`);
    assert.equal(res.status, 404);
  });
});

test('bad-hash routes return 400 (length / charset)', async () => {
  await withServer({}, async (srv) => {
    const bad = await fetch(`http://127.0.0.1:${srv.port}/asset/not-hex`);
    assert.equal(bad.status, 400);
    const shortHex = await fetch(`http://127.0.0.1:${srv.port}/asset/deadbeef`);
    assert.equal(shortHex.status, 400);
  });
});

test('SYNC_TOKEN guards asset PUT', async () => {
  await withServer({ SYNC_TOKEN: 'shh' }, async (srv) => {
    const bytes = new Uint8Array([9, 9, 9]);
    const hash = sha256Hex(bytes);

    const denied = await fetch(`http://127.0.0.1:${srv.port}/asset/${hash}`, {
      method: 'PUT',
      body: bytes,
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(
      `http://127.0.0.1:${srv.port}/asset/${hash}?token=shh`,
      { method: 'PUT', body: bytes },
    );
    assert.equal(allowed.status, 204);

    // GET stays open — clients fetching assets they already
    // reference don't need the room secret to read bytes.
    const get = await fetch(`http://127.0.0.1:${srv.port}/asset/${hash}`);
    assert.equal(get.status, 200);
  });
});

test('OPTIONS preflight on /asset/ returns CORS headers', async () => {
  await withServer({}, async (srv) => {
    const hash = 'a'.repeat(64);
    const res = await fetch(`http://127.0.0.1:${srv.port}/asset/${hash}`, {
      method: 'OPTIONS',
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert(res.headers.get('access-control-allow-methods').includes('PUT'));
  });
});
