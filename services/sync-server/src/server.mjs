// Phase-9 M1 — y-websocket sync server.
//
// One WebSocket connection per client, routed to a room by the URL
// path (`wss://host/room/<roomId>`). Each room owns a Y.Doc that the
// server holds in memory; clients reconcile via the Yjs sync protocol
// (`y-protocols/sync`) and exchange ephemeral state via the awareness
// protocol (`y-protocols/awareness`).
//
// Auth: optional bearer token in the URL query string (`?token=…`).
// When `SYNC_TOKEN` is unset, the server runs unauthenticated — useful
// for local dev and the M1 integration test. Production deployments
// must set the env var.
//
// Persistence is intentionally absent in M1. When the last client
// leaves a room the doc is discarded. Phase-10 polish can swap in
// a leveldb or filesystem persistence layer; the room registry is
// the only seam that needs to change.
//
// Wire protocol (per https://github.com/yjs/y-protocols):
//   - First byte = message type.
//     0 = sync   (encodeSyncStep1/2, encodeUpdate routed via y-protocols/sync)
//     1 = awareness (encodeAwarenessUpdate from y-protocols/awareness)
//
// On any sync/awareness change the server broadcasts the encoded
// message to every *other* connection in the same room. The sender
// never receives its own echo.

import http from 'node:http';
import { parse } from 'node:url';

import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const PORT = Number(process.env.PORT ?? 1234);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * @typedef {{
 *   doc: Y.Doc,
 *   awareness: awarenessProtocol.Awareness,
 *   connections: Set<import('ws').WebSocket>,
 *   updateHandler: (update: Uint8Array, origin: unknown) => void,
 *   awarenessHandler: (
 *     changes: { added: number[], updated: number[], removed: number[] },
 *     origin: unknown,
 *   ) => void,
 * }} Room
 */

function makeRoomRegistry() {
  /** @type {Map<string, Room>} */
  const rooms = new Map();

  function getOrCreate(roomId) {
    let room = rooms.get(roomId);
    if (room) return room;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // server has no awareness identity

    /** @type {Room} */
    const newRoom = {
      doc,
      awareness,
      connections: new Set(),
      updateHandler: () => {},
      awarenessHandler: () => {},
    };

    newRoom.updateHandler = (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const buf = encoding.toUint8Array(enc);
      for (const conn of newRoom.connections) {
        if (conn !== origin && conn.readyState === conn.OPEN) {
          conn.send(buf);
        }
      }
    };
    doc.on('update', newRoom.updateHandler);

    newRoom.awarenessHandler = ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      const buf = encoding.toUint8Array(enc);
      for (const conn of newRoom.connections) {
        if (conn !== origin && conn.readyState === conn.OPEN) {
          conn.send(buf);
        }
      }
    };
    awareness.on('update', newRoom.awarenessHandler);

    rooms.set(roomId, newRoom);
    return newRoom;
  }

  function tearDown(room, roomId) {
    room.doc.off('update', room.updateHandler);
    room.awareness.off('update', room.awarenessHandler);
    // Awareness.destroy starts an internal cleanup interval — its
    // own destroy method clears it. Without this the event loop
    // stays alive after the WS server shuts down.
    room.awareness.destroy();
    room.doc.destroy();
    if (roomId) rooms.delete(roomId);
  }

  function disposeIfEmpty(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.connections.size > 0) return;
    tearDown(room, roomId);
  }

  function disposeAll() {
    for (const [id, room] of rooms) {
      for (const c of room.connections) c.terminate();
      room.connections.clear();
      tearDown(room, id);
    }
    rooms.clear();
  }

  return { getOrCreate, disposeIfEmpty, disposeAll };
}

/**
 * Send the sync handshake (step 1) to a freshly-connected client.
 * Phase-1 of the Yjs sync protocol: server announces its state
 * vector; client replies with the missing updates.
 */
function sendSyncStep1(conn, doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  conn.send(encoding.toUint8Array(enc));
}

/**
 * Send the current awareness state to a freshly-connected client so
 * they see everybody else's cursors / colors right away.
 */
function sendAwarenessSnapshot(conn, awareness) {
  const clients = Array.from(awareness.getStates().keys());
  if (clients.length === 0) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    enc,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  );
  conn.send(encoding.toUint8Array(enc));
}

function handleMessage(conn, room, data) {
  const dec = decoding.createDecoder(data);
  const enc = encoding.createEncoder();
  const messageType = decoding.readVarUint(dec);
  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      // y-protocols/sync handles step1/step2/update internally and
      // writes any reply messages back into `enc`. The third arg is
      // the transaction origin — we pass `conn` so the room's
      // doc-update handler can skip echoing this update back.
      syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
      // Only send if the protocol actually wrote a reply
      // (sync step 2 / update acks). Empty replies = single byte of
      // message type, skip.
      if (encoding.length(enc) > 1) {
        conn.send(encoding.toUint8Array(enc));
      }
      break;
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(dec),
        conn,
      );
      break;
    }
    default:
      // Unknown message type — ignore. Forward-compat with future
      // protocol extensions (file transfer, RTC negotiation, etc.).
      break;
  }
}

function authorized(req, token) {
  if (!token) return true;
  const { query } = parse(req.url, true);
  return query?.token === token;
}

function parseRoomId(req) {
  // Expected path: /room/<roomId>. Reject anything else.
  const { pathname } = parse(req.url, true);
  if (!pathname?.startsWith('/room/')) return null;
  const roomId = pathname.slice('/room/'.length);
  if (!roomId || roomId.includes('/')) return null;
  // Bound the id length so a malicious client can't blow memory.
  if (roomId.length > 128) return null;
  return decodeURIComponent(roomId);
}

export function createServer({
  port = PORT,
  host = HOST,
  // Read SYNC_TOKEN at call time, not module-load time, so tests
  // that mutate the env before constructing the server see the
  // current value.
  token = process.env.SYNC_TOKEN ?? null,
} = {}) {
  const registry = makeRoomRegistry();
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!authorized(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const roomId = parseRoomId(req);
    if (!roomId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachConnection(ws, roomId);
    });
  });

  function attachConnection(ws, roomId) {
    const room = registry.getOrCreate(roomId);
    room.connections.add(ws);

    ws.on('message', (data) => {
      try {
        // ws gives us Node Buffer; convert to Uint8Array for lib0.
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        handleMessage(ws, room, bytes);
      } catch (err) {
        console.error('sync-server: message handler threw', err);
      }
    });

    ws.on('close', () => {
      room.connections.delete(ws);
      // Remove this connection's awareness presence so peers' avatar
      // lists update immediately on disconnect.
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        [room.doc.clientID],
        ws,
      );
      // Reap empty rooms so memory doesn't grow unbounded.
      queueMicrotask(() => registry.disposeIfEmpty(roomId));
    });

    ws.on('error', (err) => {
      console.warn('sync-server: ws error', err.message);
    });

    sendSyncStep1(ws, room.doc);
    sendAwarenessSnapshot(ws, room.awareness);
  }

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      resolve({
        httpServer,
        wss,
        port: typeof addr === 'object' && addr ? addr.port : port,
        close() {
          return new Promise((resolveClose) => {
            registry.disposeAll();
            wss.close();
            httpServer.close(() => resolveClose());
          });
        },
      });
    });
  });
}

// `node src/server.mjs` boots a long-running server. Importing the
// module (the test path) does not.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  createServer().then((srv) => {
    const auth = process.env.SYNC_TOKEN ? 'token-required' : 'open';
    console.log(
      `sync-server listening on ws://${HOST}:${srv.port}/room/<id> (${auth})`,
    );
  });
}
