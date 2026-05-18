# sync-server — Phase-9 M1

`y-websocket`-compatible sync server for 8347 Studio collab. Holds
one in-memory Y.Doc per room, brokers the Yjs sync + awareness
protocols between connected clients.

## Run locally

```sh
pnpm --filter sync-server install
pnpm --filter sync-server start
```

Server listens on `ws://0.0.0.0:1234/room/<roomId>`. Health check at
`http://0.0.0.0:1234/healthz`.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `1234` | TCP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `SYNC_TOKEN` | _(unset)_ | When set, clients must include `?token=<value>` in the WS URL. |

## Tests

```sh
pnpm --filter sync-server test
```

Runs `node --test` against the server with two-client integration
scenarios: edit propagation, awareness, reconnect catch-up, and the
`SYNC_TOKEN` gate.

## Wire protocol

Standard `y-protocols` framing — first varuint is the message type:

- `0` → sync (`writeSyncStep1`, `writeSyncStep2`, `writeUpdate`)
- `1` → awareness (`encodeAwarenessUpdate`)

Unknown message types are ignored so forward-compatible extensions
don't break older servers.

## Persistence

**None in M1** — rooms live only as long as at least one client is
connected. Phase-10 polish can layer LevelDB or filesystem
persistence on top; the room registry in `src/server.mjs` is the
seam.
