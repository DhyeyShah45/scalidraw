# @scalidraw/server

Backend for the self-hosted multi-document workspace. Fastify + SQLite, one process, serving both the API and (optionally) the built frontend.

Design decisions and their rejected alternatives live in [`docs/workspace/DECISIONS.md`](../docs/workspace/DECISIONS.md). Read that before changing anything structural here.

## Running it

```bash
cp server/.env.example server/.env
yarn workspace @scalidraw/server hash-password   # paste the output into .env
yarn start:server                                # dev, with watch
```

For production the entry point is `dist/index.js`:

```bash
yarn build:server
node server/dist/index.js
```

It exits with code 78 (`EX_CONFIG`) and a readable message when configuration is wrong, rather than starting up half-working.

## Data

Everything lives in one file, `$DATA_DIR/workspace.db` — scenes, snapshots, image bytes and the shape library included. That is deliberate (D12): the backup is a single file.

Back it up with `sqlite3 .backup`, never `cp` — WAL mode means a raw copy can capture a torn database.

## API

All routes except `/api/health` and `/api/auth/login` require the session cookie.

| Method | Route | Notes |
| --- | --- | --- |
| POST | `/api/auth/login` | `{password}`; per-IP exponential backoff |
| POST | `/api/auth/logout` |  |
| GET | `/api/auth/session` | 401 with `code: "NO_SESSION"` when dead |
| GET | `/api/documents` | most-recently-updated first |
| POST | `/api/documents` | `{name?, scene?}` |
| GET | `/api/documents/:id` | metadata only |
| PATCH | `/api/documents/:id` | `{name}` |
| DELETE | `/api/documents/:id` | soft delete |
| POST | `/api/documents/:id/duplicate` |  |
| GET | `/api/documents/:id/scene` | `ETag: "<version>"` |
| PUT | `/api/documents/:id/scene` | **requires `If-Match`**; 409 on conflict, 428 without |
| GET/PUT | `/api/documents/:id/thumbnail` | raw `image/png` |
| POST | `/api/documents/:id/files` | `{files: [{id, dataURL}]}` |
| POST | `/api/files/batch` | `{ids}` → `{files, missing}` |
| GET/PUT | `/api/library` | shared shape library |

`If-Match` carries the version the client last saw. A mismatch is a 409 with the current version attached, which the client turns into "changed elsewhere — reload or overwrite?" (D9). It is never resolved silently.

## Tests

```bash
yarn test:server
```

Integration tests over the real HTTP routes via `app.inject()` against an in-memory database. The root vitest config excludes `server/**` — this workspace is plain Node and must not inherit the repo's jsdom setup.
