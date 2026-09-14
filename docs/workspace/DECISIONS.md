# Self-hosted multi-document workspace — design decisions

Status: **settled, pre-implementation**. Date: 2026-09-14.

Goal: turn this Excalidraw fork into a personal canvas workspace — many documents, continuous autosave, server-backed storage, reachable over the internet.

Each entry records the choice AND the rejected alternatives, so a later reversal starts from the reasoning rather than from scratch.

---

## Baseline findings (what already exists)

| Thing | Status | Where |
| --- | --- | --- |
| Autosave | **Already exists**, 300ms debounce | `excalidraw-app/App.tsx:727`, `SAVE_TO_LOCAL_STORAGE_TIMEOUT` |
| Multi-document | **Does not exist**, single hardcoded key `"excalidraw"` | `app_constants.ts:40` |
| Custom sidebar tabs | **Already exists** (two Excalidraw+ promo tabs to displace) | `excalidraw-app/components/AppSidebar.tsx` |
| Local-file save (Ctrl+S) | Exists via File System Access API | `actions/actionExport.tsx:253` |
| Router | **None.** Hand-rolled hash parsing only | — |
| Per-document appState fields | Upstream already marks 5 as document-level | `packages/excalidraw/appState.ts:150` (`APP_STATE_STORAGE_CONF`) |
| Library persistence adapter | First-class `load`/`save` interface | `packages/excalidraw/data/library.ts:78` |

### Known landmines (must be handled, not discovered later)

1. **Image GC deletes other documents' images.** `clearObsoleteFiles({currentFileIds})` (`LocalData.ts:54`) deletes any image not on the _current_ canvas older than 24h. The files store is global and keyed by `FileId`. Fix: server-side refcount via `document_files`.
2. **tabSync version keys are global.** `version-dataState` / `version-files` must become per-document or two tabs on different documents fight.
3. **Undo crosses documents.** History entries are inverse _deltas_, not snapshots. Swapping elements records a delta whose undo resurrects the previous document. Even with `captureUpdate: NEVER`, pre-existing stack entries reference old ids and `HistoryDelta.applyTo` falls back to `snapshot.elements`. Fix: `updateScene(..., NEVER)` **then** `history.clear()` — that order.
4. **No host API to clear the files map.** `addFiles` is additive-only; `replace` is reachable only from inside a registered Action, which can't be invoked programmatically. `store.clear()` is private. In-place swapping therefore leaks `App.files` / `imageCache` monotonically across every document opened.
5. **URL is wiped to bare origin** by `history.replaceState(..., window.location.origin)` at `App.tsx:285,302,305` and `Collab.tsx:392` — kills path, query and hash together. There is **no `popstate` listener** anywhere.
6. **Service worker masks the SPA 404.** `navigateFallback: "index.html"` is the vite-plugin-pwa default and is unset here, so path routes work after SW install and 404 on a cold load. No `navigateFallbackDenylist`, so top-level navigations to `/api/*` are served `index.html`.
7. **Collab lock leak.** `pauseSave("collaboration")` is taken at `Collab.tsx:516` _before_ the socket opens, released only in `destroySocketClient`. A failed connect freezes persistence for the whole tab, silently.
8. **Collab stop-path clobbers.** `stopCollaboration(true)` (the "Stop session" button) keeps room content in the editor, which then persists over the open document. Today that overwrites "the local scene"; with multi-doc it overwrites a _server_ document.
9. `isCollabDisabled` is only an `isRunningInIframe()` check — unrelated to whether collab env vars are configured. Unconfigured collab half-works rather than disabling.

---

## Decisions

### Product scope

- **D1. Storage model: server-backed, self-hosted.** Rejected: browser-only IndexedDB multi-doc (data trapped in one browser profile); File System Access API directory (Chrome/Edge only, permission re-grant per reload). Driver: must survive a cache clear and be reachable from phone and laptop.

- **D2. Single user, hardcoded credential.** No users table, no signup, no sharing. `owner_id` columns omitted entirely; adding a second user later is a small migration, not a redesign. _(Note: an earlier round chose multi-user with accounts; reversed deliberately — this is a personal instance.)_

- **D3. Sidebar inside the canvas** for the document list, as a new tab in `AppSidebar.tsx` replacing a promo tab. No changes needed inside `packages/excalidraw`. Rejected: separate file-browser route (full page load per switch, second UI surface); top-bar dropdown (unusable past ~20 documents).

- **D4. Sidebar v1 scope:** flat list, name search, sort by recently-updated, client-generated thumbnails. **No folders** — search + recency beats folders until ~50 documents, and tags beat folders after. Thumbnails included now specifically because the save path is being written once.

- **D5. Version history: cheap insurance.** Snapshot at most every ~10 min while a document changes, keep ~50 per document, **no browse UI in v1** (recoverable by hand via SQLite). The write path is trivial now and impossible to reconstruct retroactively.

- **D6. Delete: soft-delete, no trash UI.** `deleted_at` set, recoverable via SQLite or backup. A trash view is real UI for a few-times-a-year event. **"Reset canvas" keeps meaning "clear this document's elements"** — it stays undoable and must not silently become a document-level destructive operation.

- **D7. Ctrl+S is repointed to "force flush to server now"** with visible confirmation. "Export to file" stays in the menu as an escape hatch; the _active file handle_ concept is dropped — two competing autosave targets is the confusion being escaped.

### Sync and data

- **D8. Full-snapshot sync, not deltas.** `PUT /api/documents/:id/scene` with the whole scene. Excalidraw's `store.ts` delta machinery is built for collab, not persistence.

- **D9. Conflict: last-write-wins with a warning.** `version` column, `If-Match`, 409 on stale, client shows "changed elsewhere — reload or overwrite?". Rejected: silent LWW (eats work); element-level three-way merge (research project — Excalidraw's own answer to concurrency is the collab feature, not merged persistence).

- **D10. IndexedDB stays as a write-through cache**, not a replacement. Canvas renders from local instantly, server write happens behind it, queued writes flush on reconnect. Without this, every network hiccup blocks drawing.

- **D11. Offline queue never expires.** Always offer to push on reconnect. Cold start with no server and no cached documents shows an error rather than creating a local scratch document — a second class of unsynced document would need reconciling later.

- **D12. Images: BLOBs in SQLite**, not files on disk. One file is the entire backup, atomic with the scene, and it eliminates the "row exists, file vanished" failure mode. Revisit only at hundreds of large images.

- **D13. Global prefs stay in localStorage** (per-device), following the `useHandleAppTheme.ts` precedent. Only documents sync. Per-document appState = the 5 upstream document-level fields (`gridSize`, `gridStep`, `gridModeEnabled`, `viewBackgroundColor`, `lockedMultiSelections`) plus `scrollX`, `scrollY`, `zoom`, `name`, and selection state. Everything else (~45 keys incl. all 17 `currentItem*` defaults, export settings, snapping prefs, sidebar state) is global. Rationale: device-local defaults are arguably _correct_ — a stylus tablet wants different defaults than a laptop. Caution: `updateScene`'s `appState` is a **shallow merge, not a replace** — unpassed fields carry over from the previous document.

- **D14. Shape library syncs to the server** via `LibraryPersistenceAdapter` (~25 lines, modelled on `LibraryIndexedDBAdapter` at `LocalData.ts:229`), with `migrationAdapter: LibraryIndexedDBAdapter` to pull the existing local library up on first run. Caveat: `persistLibraryUpdate` re-reads and **unions** on save to preserve items other clients hold, so server-side deletes need separate enforcement.

### Client architecture

- **D15. Document switching: remount `<Excalidraw>` via `key`.** Buys the codebase's own correct `initializeScene()` load path — files, imageCache, store, history and fonts all reset in the right order. `componentWillUnmount` is unusually thorough and the API object is poisoned on unmount so stale refs fail loudly. Costs: a mount flash, and the module-level `editorJotaiStore` singleton survives remount so sidebar/library/search UI state leaks between documents (upstream has a standing TODO on exactly this). Rejected: in-place swap — unbounded `App.files`/`imageCache` growth plus a hand-maintained reimplementation of a sequence upstream changes freely. Mitigation: keep the sidebar mounted **outside** the remounted subtree. **Never render two `<Excalidraw>` instances simultaneously** (`ShapeCache.destroy()` is static and the jotai store is shared).

- **D16. Path routes `/d/:id`.** Requires: SPA fallback in Fastify, a `popstate` listener, patching the four `replaceState`-to-origin call sites to preserve the path, and `navigateFallbackDenylist: [/^\/api\//]` in the PWA config. Rejected: hash routes (collide with the anchored `#room=`/`#json=` regexes and get wiped by the same `replaceState` calls); no-URL sidebar-only (loses bookmarking).

- **D17. Fix both collab hazards** (~30 lines): release `pauseSave` in a `catch` so a failed connect can't freeze persistence; make the stop path write room content to a **new** document rather than the open one. Collab transport itself stays untouched. Rejected: hard-disabling collab; leaving as-is (two silent data-loss paths, one of which now overwrites server data).

### Infrastructure

- **D18. Fastify serves both API and static assets** — one process, one port, one container-or-daemon. nginx is a second moving part earning nothing for a single user, and the SPA fallback then lives beside the API routes. _(Consequence: the existing nginx Dockerfile is not reusable for this.)_

- **D19. Host: home MacBook (Apple Silicon, M-series).** Rejected: Oracle Cloud Free Tier — genuinely strong (4 OCPU / 24GB, static IP, 10TB egress) and the ARM/firewall concerns were overstated; the real risk is A1 capacity availability. Chosen against for physical control of the data. Dev machine stays this Linux box — dev and prod are separate hardware.

- **D20. Uptime: intermittent and accepted.** Powered on when needed. LaunchDaemon with `KeepAlive` starts the service at boot. FileVault stays on (an unattended reboot will wait at the unlock prompt — accepted). `pmset -a sleep 0 disablesleep 1` while serving. Sync state must be visible in the UI so the machine is never closed with work still queued.

- **D21. Native Node + launchd, no Docker on the Mac.** Docker Desktop / Colima / OrbStack are Linux VMs that start at _login_, not boot — directly contradicting D20. With D18 there is exactly one process to run.

- **D22. Exposure: Cloudflare Tunnel.** Outbound-only, so no port forwarding, no static IP, immune to CGNAT, free TLS. Requires moving nameservers from Hostinger to Cloudflare (free); Hostinger stays the registrar. Nothing listens on the home IP. Rejected: Tailscale Funnel (`*.ts.net` hostname, or a client on every device); port-forward + DDNS + Let's Encrypt (ISP-dependent, breaks on IP rotation). `cloudflared service install` sets up its own daemon.

- **D23. Cloudflare Access in front, app login kept.** Unauthenticated traffic never reaches the Mac; the app login remains as a second layer and as the thing that still works if the host moves. Rejected: dropping the app login (welds the app to Cloudflare).

- **D24. Access session expiry must be detected client-side.** An expired Access session turns an XHR into a **302 to Cloudflare's login page**, not a 401 — autosave would see a "successful" response containing HTML. One fetch wrapper detects non-JSON/redirected responses, surfaces "session expired — reload to sign in", and holds the write in the queue. Pair with a long (up to 1 month) Access session. Rejected: exempting `/api/*` from Access — the API is where all the data is.

- **D25. Auth hardening:** argon2 hash in env (never plaintext), httpOnly + secure + sameSite cookie, 30-day sliding sessions, exponential per-IP backoff on login, **no lockout** (self-DoS on a single-user system), no app-level 2FA (Access covers it).

- **D26. Deploy: git pull + build on the Mac**, driven by a small `deploy.sh` that also restarts the daemon. Sidesteps cross-arch entirely. Rejected: rsync prebuilt artifacts (breaks on arm64 native modules); GHCR images (moot without Docker).

- **D27. SQLite driver: `better-sqlite3`.** Ships darwin-arm64 prebuilds. Maturity matters more than avoiding one native dep when it holds the only copy of the work. Keep the data-access layer thin enough to swap for Node's built-in `node:sqlite`.

- **D28. Backup: nightly `sqlite3 .backup` → `age`-encrypted → Cloudflare R2.** Must use `.backup`, never a file copy, or it captures a torn DB mid-write. The `age` private key is backed up somewhere that is **not only the MacBook**. Keep the DB where Time Machine covers it — complements R2, does not replace it (same room, same machine). A documented one-command **restore** is part of this; untested backups aren't backups.

- **D29. Testing:** integration tests over real HTTP routes against a temp DB, plus client-side tests for the storage adapter and offline queue. Those two are exactly where bugs silently eat drawings and won't surface in manual testing.

---

## Schema

```
sessions         token, expires_at
documents        id, name, version, updated_at, deleted_at, thumbnail
scenes           document_id, blob (gzipped elements + per-doc appState)
snapshots        document_id, blob, created_at        -- D5, ~50 per doc
files            file_id, bytes (BLOB)                -- D12
document_files   document_id, file_id                 -- refcount, fixes landmine 1
library          singleton row, items blob            -- D14
```

## Phases

1. `server/` workspace — Fastify + better-sqlite3, auth, documents CRUD. Curl-testable standalone before any UI exists.
2. Client storage adapter — `LocalData` stops being a static singleton, becomes document-scoped; IndexedDB write-through cache with flush queue. **The hard part.**
3. Login gate + documents sidebar tab + `/d/:id` routing + remount-on-switch.
4. Migration (existing localStorage scene becomes document #1), per-doc tabSync keys, server-side image refcount, collab fixes (D17).
5. Deploy — LaunchDaemon, cloudflared, Access, backup cron.

Branch off `master`; this fork has no local commits and upstream pulls should stay clean fast-forwards.

## Left as implementation defaults (not separately decided)

Thumbnail format and generation timing; request size caps; snapshot retention tuning; exact shape of the localStorage → document #1 migration; argon2 cost parameters.
