# Trying the workspace locally

Everything through phase 3 works: sign in, multiple canvases, autosave to the server, switching, offline queueing, conflict resolution.

`yarn` is not on PATH on this machine — every command below uses `corepack yarn`, which works without installing anything.

## One-time setup

```bash
cd ~/Projects/pocs/scalidraw
cp server/.env.example server/.env
corepack yarn workspace @scalidraw/server hash-password
```

Type a password (12+ characters; input is hidden). Paste the printed `AUTH_PASSWORD_HASH=...` line into `server/.env`, replacing the empty one, then set this in the same file — the cookie is `Secure` by default and a `Secure` cookie is silently dropped over plain http:

```
COOKIE_SECURE=false
```

## Running it

### Option A — closest to production (recommended first)

One process serving both the app and the API, exactly as it will on the MacBook.

```bash
corepack yarn build:app
corepack yarn build:server
cd server && env $(grep -v '^#' .env | xargs) \
  STATIC_DIR=../excalidraw-app/build node dist/index.js
```

Open **http://localhost:3010**.

### Option B — hot reload, for poking at the UI

Two terminals:

```bash
# terminal 1 — API only
corepack yarn start:server

# terminal 2 — Vite, proxying /api to the server above
corepack yarn start
```

Open **http://localhost:3000**. Editing anything under `excalidraw-app/workspace/` reloads instantly.

## What is worth testing

Ordered by how likely it is to be broken. The UI has not been clicked through in a browser yet — only the API and the unit tests have been exercised — so treat the first section as genuinely unverified.

### The basics

- [ ] The sign-in screen appears, and a wrong password is rejected.
- [ ] After signing in you land on a canvas and the URL becomes `/d/<id>`.
- [ ] Draw something, wait a second, reload — it is still there.
- [ ] Open the sidebar's canvases tab (the stacked-sheets icon, top of the sidebar). Create a second canvas with **+**.

### Switching canvases — the riskiest part

Switching remounts the editor deliberately (D15), which is the call most likely to feel wrong or leak state.

- [ ] Draw different shapes in two canvases and switch between them a few times. Each keeps its own contents.
- [ ] **Undo does not cross documents.** Draw in canvas A, switch to B, press Ctrl+Z repeatedly. Nothing from A should appear in B, and B's own elements should not be deleted by an undo that "belongs" to A. This was a guaranteed bug with the alternative approach, so it is the single most valuable thing to check.
- [ ] Scroll and zoom differ per canvas and are restored on switch.
- [ ] Your pen colour and stroke width do **not** reset when switching — those are device preferences, not document state.
- [ ] Paste an image into canvas A, switch to B and back. The image is still there. Reload. Still there.
- [ ] Browser Back and Forward move between canvases.
- [ ] Hard-refresh while on `/d/<id>` — it loads that canvas, not a 404.

### Offline behaviour

Open DevTools → Network → set throttling to **Offline**.

- [ ] Keep drawing. It should not error or freeze.
- [ ] A pill appears near the footer: "1 change not uploaded".
- [ ] Go back online. It should upload on its own within a second or two; the pill disappears. Clicking the pill forces a retry immediately.
- [ ] Harder version: go offline, draw, **close the tab**, reopen, go online. The queue lives in IndexedDB, so the drawing should still upload.

### Conflicts

Needs two browser windows on the same canvas.

- [ ] Open `/d/<id>` in two windows. Draw in window A and let it save. Now draw in window B.
- [ ] B should show a modal: "This canvas changed somewhere else", offering to keep your version or take the other one.
- [ ] "Keep what is on this screen" wins and uploads. "Use the other device's version" replaces the canvas.
- [ ] Either way, nothing is lost silently.

### Sidebar actions

- [ ] Rename by double-clicking a canvas name. Enter commits, Escape cancels.
- [ ] Search filters the list.
- [ ] Duplicate creates "<name> (copy)" and opens it; editing the copy does not change the original.
- [ ] Delete asks for confirmation, and deleting the open canvas moves you to another one.

## Poking at the data

Everything lives in one SQLite file — `server/data/workspace.db`.

```bash
sqlite3 server/data/workspace.db \
  "SELECT id, name, version, datetime(updated_at/1000,'unixepoch') FROM documents;"

# snapshots kept for recovery (D5)
sqlite3 server/data/workspace.db \
  "SELECT document_id, version, datetime(created_at/1000,'unixepoch') FROM snapshots;"
```

A deleted canvas is only soft-deleted, so it can be brought back by hand:

```bash
sqlite3 server/data/workspace.db \
  "UPDATE documents SET deleted_at = NULL WHERE name = 'the one you deleted';"
```

## Not built yet

Do not test for these — they are phase 4 and 5:

- Your **existing excalidraw.com scene in this browser is not migrated** into a document yet. It is untouched in localStorage, not lost.
- **Collab rooms** still use the original localStorage path, and the two known collab hazards (a failed connect freezing local saves, and "Stop session" overwriting the open document) are not fixed yet.
- Two tabs on the **same** canvas still share the old global tab-sync keys.
- No thumbnails in the sidebar yet.
- Nothing is deployed: no LaunchDaemon, tunnel, Access, or backups.
