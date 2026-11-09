# Sitepins on Cloudflare Workers — 2-Worker deployment

> Status: implemented locally, **not yet deployed live**. Every check that
> can run without a Cloudflare account or an Atlas cluster has been run
> (see "Verification" below). The live smoke test in §6 still has to happen.

## 1. Architecture

Two Workers, one Atlas cluster, one R2 bucket. Nothing here touches the
Docker / Vercel / local-Node paths — `docker-compose.yml`, both
`Dockerfile`s, `vercel.json` and `api/src/server.ts` are untouched and
still work.

| Piece | Worker | Domain | Entry |
| --- | --- | --- | --- |
| App (Next.js 16) | `sitepins-app` | https://csofts.tech | `app/wrangler.jsonc` → `.open-next/worker.js` (via `@opennextjs/cloudflare` 1.20.16) |
| API (Express 5 + Mongoose 9) | `sitepins-api` | https://api.csofts.tech | `api/wrangler.jsonc` → `api/src/worker.ts` |

```
browser ──► csofts.tech ──────► sitepins-app (OpenNext Worker)
   │                              │  NEXT_PUBLIC_BACKEND_URL
   │                              ▼
   └────► api.csofts.tech ──► sitepins-api Worker
                                  │  fetch() routes:
                                  │  • /healthz → answered in the Worker
                                  │  • /api/v1/editor/collab, /socket.io/* → Realtime DO (stub, §5)
                                  │  • everything else → Api DO (singleton)
                                  ▼
                             ApiDurableObject ("sitepins-api")
                               • holds ONE Mongoose connection (maxPoolSize 1)
                               • runs the existing Express app via
                                 httpServerHandler() from `cloudflare:node`
                               • better-auth, incl. its second (lazy)
                                 Mongoose connection, runs inside the DO
                                  │
                                  ├─► MongoDB Atlas (mongodb.net, replica set)
                                  └─► Cloudflare R2 (S3-compatible uploads)
```

### Why the API runs inside a Durable Object

Workers are stateless isolates and cannot pool a MongoDB connection across
requests. Cloudflare's MongoDB docs give two options: a fresh connection
per request (~300 ms overhead) or a Durable Object holding one connection
(~35 ms warm). We use the DO, and route **all** REST traffic through one
named instance, so the existing Express + Mongoose + better-auth code runs
unchanged inside it: the default Mongoose connection, the auth connection,
and `mongoose.startSession()` transactions (only used in
`api/src/modules/user/user.service.ts`) all live in the same process.

Trade-offs, stated plainly:

- One DO is single-threaded (Cloudflare documents a soft ~1,000 req/s
  per DO instance). Fine for a self-hosted CMS; not a multi-region HA
  design.
- The DO evicts after ~70–140 s idle; the next request pays a cold
  Mongo connect again, and TCP does not survive hibernation.
- `MongoClient` / `Db` objects cannot be passed back from a DO via RPC —
  all DB logic runs *inside* the DO, which is why the Express app itself
  runs there instead of in the front Worker.
- **Hyperdrive is NOT used** — it does not support MongoDB.

### What changed in the code (summary)

**App Worker**

- `app/open-next.config.ts` + `app/wrangler.jsonc` (name `sitepins-app`,
  route `csofts.tech`, `compatibility_date` 2026-11-09,
  `nodejs_compat`).
- `app/src/app/api/sandbox/*` (create / heartbeat / stop) are now 503
  stubs. Live preview ran on Vercel Sandbox, a Vercel-only service that
  cannot run on Workers. The originals are in git history. The editor
  degrades gracefully (`use-sandbox-preview` treats a missing preview
  as "no preview available").
- `app/src/proxy.ts` needed **no shim**: `@opennextjs/cloudflare`
  1.20.16 bundles Next 16's `proxy.ts` as the Node middleware
  (verified — `.open-next/middleware/` contains the built auth +
  next-intl gate). OpenNext issue #1277 is fixed in this version.
- `@opennextjs/cloudflare` 1.20.16 + `wrangler` 4.158.0 added as
  devDependencies.

**API Worker**

- `api/src/worker.ts` — Worker entry: `/healthz` here, realtime paths
  to the Realtime DO, everything else to the Api DO.
- `api/src/lib/workerRuntime.ts` — `ApiDurableObject` (Express via
  `httpServerHandler` from `cloudflare:node` — note: the correct import
  is `cloudflare:node`, not `cloudflare:workers`) and
  `RealtimeDurableObject` (gated stub, §5).
- `api/src/lib/workerEnv.ts` — Worker `env` bindings feed config
  (`resolveEnv()`); local Node still uses `process.env` / `.env`.
  `api/src/config/variables.ts` and `cors-options.ts` use it. `dotenv`
  loading is guarded so a missing filesystem on Workers cannot crash
  the import.
- `api/src/auth.ts` — the second Mongoose connection is now lazy
  (`getAuthConnection()` / `getAuthClient()` / `getAuthDb()`); the
  import-time `process.exit(1)` is gone. `api/src/auth-demo.ts` uses
  the same getters.
- `bcrypt` (native addon — cannot run on Workers) → `bcryptjs`
  (pure JS, same `$2b$` hash format, so existing password hashes still
  verify). `bcrypt` removed from `api/package.json`.
- `api/src/lib/mailer.ts` — new `resend` provider (plain `fetch` to
  `https://api.resend.com/emails`). SMTP is kept for Node but throws a
  clear error on a Worker. Auto-detect order: `RESEND_API_KEY` →
  `SMTP_HOST` → console.
- `api/src/modules/common/bucket.route.ts` — on a Worker, multer uses
  memory storage and the handler uploads with the AWS SDK v3
  `PutObjectCommand` (fetch-based, works against R2). Node keeps
  multer-s3 streaming. The response still returns `{ key, ... }`,
  which is what the app reads (`use-image-upload.ts` uses
  `response.data.key`). R2 ignores S3 ACLs, so `permission` is
  validated but not applied — the bucket must be public (r2.dev or a
  custom domain) for `NEXT_PUBLIC_BUCKET_URL` to serve objects.
- `api/src/server.ts` — one pre-existing type error fixed so `tsc`
  passes (`RawData` → `Uint8Array` conversion in the Hocuspocus
  message handler; bytes unchanged). The Node server itself is
  unchanged and still used for local dev.
- `api/wrangler.jsonc` (name `sitepins-api`, route `api.csofts.tech`,
  `compatibility_date` 2026-11-09, `nodejs_compat_v2` only —
  `nodejs_compat` + `nodejs_compat_v2` together are rejected by
  Wrangler), DO bindings + `v1` migration, R2 binding
  `SITEPINS_BUCKET` → bucket `sitepins-media`.
- `.dev.vars.example` files for both Workers (placeholders only).

## 2. Prerequisites — the user must do these (agent cannot)

- [ ] **Cloudflare account + `csofts.tech` zone** in Cloudflare DNS.
  Workers **Paid plan ($5/mo)** — Durable Objects require it, and the
  app bundle is over the free 3 MiB gzip script limit in total upload
  terms (see §7).
- [ ] **`wrangler login`** in a terminal (browser OAuth).
- [ ] **MongoDB Atlas cluster** (any M0/Flex or higher — all Atlas
  clusters are replica sets, which transactions need). Create a DB user
  with read/write on the `sitepins` database, and set **Network Access
  to `0.0.0.0/0`** — Worker IPs are dynamic, so Atlas cannot allowlist
  them. Copy the `mongodb+srv://…` connection string.
- [ ] **R2 bucket `sitepins-media`** + an API token with
  Object Read/Write. Enable public access: either the `r2.dev`
  subdomain or a custom domain (e.g. `media.csofts.tech`) — that URL
  becomes `NEXT_PUBLIC_BUCKET_URL`. Note the **account ID** for
  `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`.
- [ ] **GitHub App** (see `app/README.md` "Setting up a GitHub App"):
  slug, App ID, Client ID, Client Secret, private key (`.pem`).
  Optional: GitLab OAuth app.
- [ ] **Resend account + API key** (https://resend.com) and a verified
  sending domain, for OTP / password-reset email. First launch without
  mail is possible with `MAIL_PROVIDER=console` +
  `REQUIRE_EMAIL_VERIFICATION=false` (OTP is then logged, not emailed
  — only for a private first launch).
- [ ] Generate secrets (never paste real values into chat or files):
  `openssl rand -base64 32` for `BETTER_AUTH_SECRET`, `JWT_SECRET`,
  `INTERNAL_API_SECRET`; `openssl rand -hex 32` for
  `SANDBOX_ENCRYPTION_KEY`. `INTERNAL_API_SECRET` must be **identical**
  on both Workers.

## 3. Secrets & variables

### API Worker — secrets (`wrangler secret put <NAME>` from `api/`)

| Secret | Value |
| --- | --- |
| `MONGO_URI` | Atlas `mongodb+srv://…` string |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `INTERNAL_API_SECRET` | same value as the app Worker |
| `SANDBOX_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | R2 API token |
| `S3_BUCKET_NAME` | `sitepins-media` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app |
| `RESEND_API_KEY` | Resend API key |
| `REOON_API_KEY` | optional, may be empty |

Non-secret vars are already in `api/wrangler.jsonc` `[vars]`
(`BASE_URL=https://api.csofts.tech`, `CORS_ORIGINS=https://csofts.tech`,
`APP_URL=https://csofts.tech`, `COOKIE_DOMAIN=.csofts.tech`,
`TRUST_PROXY=1`, `S3_ENDPOINT`, `S3_REGION=auto`,
`MAIL_PROVIDER=resend`).

### App Worker — build-time vars + secrets

`NEXT_PUBLIC_*` values are **inlined at build time**. They must be in
the environment *before* `pnpm cf:build` runs — setting them in
`wrangler.jsonc [vars]` alone does **not** rebuild the app. For
`wrangler deploy` from a terminal, export them in the shell (or put them
in `app/.env` locally — gitignored — for `next dev`); for Workers Builds
(Connect to Git), set them as build variables in the dashboard. Changing
one later requires a rebuild + redeploy.

| Var | Value |
| --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | `https://api.csofts.tech/api/v1` |
| `NEXT_PUBLIC_HP_WS_URL` | `wss://api.csofts.tech/api/v1/editor/collab` |
| `NEXT_PUBLIC_BRAND_URL` | `https://csofts.tech` |
| `NEXT_PUBLIC_BRAND_NAME` / `NEXT_PUBLIC_BRAND_SLUG` | `Sitepins` / `sitepins` |
| `NEXT_PUBLIC_BUCKET_URL` | R2 public URL, e.g. `https://sitepins-media.r2.dev` |
| `NEXT_PUBLIC_GIT_APP_NAME` | GitHub App slug (**required, non-empty** — the build throws without it) |
| `NEXT_PUBLIC_GITLAB_CLIENT_ID` | optional |
| other `NEXT_PUBLIC_*` brand/link vars | see `app/.env.example` / `app/wrangler.jsonc` |

App secrets (`wrangler secret put` from `app/`):
`INTERNAL_API_SECRET` (same as API), `GITHUB_APP_ID`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_PRIVATE_KEY` (full `.pem`, newlines preserved),
`GITLAB_CLIENT_SECRET`, `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY`.

## 4. Deploy commands

```bash
# from the repo root
pnpm install

# --- API first (the app points at it) ---
cd api
wrangler secret put MONGO_URI
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put JWT_SECRET
wrangler secret put INTERNAL_API_SECRET
wrangler secret put SANDBOX_ENCRYPTION_KEY
wrangler secret put S3_ACCESS_KEY
wrangler secret put S3_SECRET_KEY
wrangler secret put S3_BUCKET_NAME
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put RESEND_API_KEY
# wrangler secret put REOON_API_KEY   # optional
pnpm cf:dry-run    # typecheck + build already verified; dry-run only
pnpm cf:deploy     # → https://api.csofts.tech

# --- App ---
cd ../app
# export all NEXT_PUBLIC_* vars first (see §3 table), then:
wrangler secret put INTERNAL_API_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_CLIENT_ID
wrangler secret put GITHUB_APP_CLIENT_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
# wrangler secret put GITLAB_CLIENT_SECRET   # optional
# wrangler secret put AI_API_KEY             # optional
pnpm cf:dry-run
pnpm cf:deploy     # → https://csofts.tech
```

Local dev is unchanged: `pnpm dev` (or `pnpm dev:api` / `pnpm dev:app`)
with `api/.env` + `app/.env`; `wrangler dev` also works from each
folder with a local `.dev.vars` (copy from `.dev.vars.example`).

## 5. What is NOT working yet — realtime follow-up

Realtime is **gated off, not faked**. Both surfaces answer with an
explicit machine-readable 503 so nothing hangs or silently drops edits:

- `GET /api/v1/editor/collab` (WebSocket upgrade) and
  `GET /socket.io/*` → `{"error":"realtime-unavailable", …}` (HTTP) or
  a WebSocket close `1011` with the same JSON as the first frame.
- The app's live preview (`/api/sandbox/*`) → `503 sandbox-unavailable`.

What that means in the product: login, orgs, projects, file editing,
commits, media upload and SEO tools work; **live cursors/presence,
simultaneous co-editing, and live preview do not**.

Why it is a follow-up, not a config change:

- **Presence / editor events** use socket.io (engine.io protocol over a
  Node http.Server). A Worker has no Node http.Server to attach it to,
  and the app's `socket.io-client` cannot talk to a plain WebSocket
  endpoint. Porting needs a native-WebSocket Durable Object *and* a
  client-side switch away from `socket.io-client` (`app/src/contexts/
  socket-context.tsx`, `use-presence.ts`, `file-editor.tsx`).
- **Hocuspocus co-editing** is closer: v4 runs on Workers via crossws
  (`Hocuspocus` class + `handleConnection(ws, request, context)`, and
  the repo already uses `@hocuspocus/server` ^4.7.1). But `server.ts`
  builds it around Node `ws` + `requestHeaders`, and its `onAuthenticate`
  hook needs a live better-auth session + `isOrgMember()` DB check
  inside the DO, plus Yjs document persistence (DO storage or Mongo).
  That port is a separate work item: move the `new Hocuspocus({...})`
  setup from `server.ts` into a `CollabDurableObject`, route
  `/api/v1/editor/collab` upgrades to it, and smoke-test two browsers
  editing the same file.
- **Live preview** needs a sandbox backend that runs on Cloudflare
  (e.g. Cloudflare Containers); Vercel Sandbox cannot be used here.

## 6. Smoke-test checklist (after first deploy)

API — `https://api.csofts.tech`:

- [ ] `GET /healthz` → `{"status":"ok","worker":"sitepins-api"}`
- [ ] `GET /` → `Welcome to Sitepins API`
- [ ] `POST /api/v1/auth/sign-up/email` with a test user → 200 and a
      Resend email arrives (or, with verification off, the account is
      created directly); then sign-in sets the session cookie for
      `.csofts.tech`.
- [ ] `GET /api/v1/user/...` (or any authed route) with that cookie → 200.
- [ ] Upload an image in the editor → object appears in the R2 bucket
      and renders at `<NEXT_PUBLIC_BUCKET_URL>/<key>`.
- [ ] `GET /api/v1/editor/collab` (plain HTTP) → 503
      `realtime-unavailable` (expected — §5).
- [ ] Cold start: first request after ~3 min idle is slow (DO eviction
      + Mongo reconnect); the second is fast. If the first *fails*,
      check `MONGO_URI` and Atlas Network Access (`0.0.0.0/0`).

App — `https://csofts.tech`:

- [ ] `/login` renders, login with the test user works, `/dashboard`
      loads (proxy auth gate runs — no redirect loop).
- [ ] Create a project, connect a GitHub repo, edit a file, save →
      a real commit lands in the repo.
- [ ] Live preview button shows the "sandbox unavailable" state
      instead of hanging (expected — §5).
- [ ] No `NEXT_PUBLIC_*` value is wrong: check the built app calls
      `https://api.csofts.tech/api/v1` (browser devtools Network tab).
      A wrong value here means the build env was wrong — rebuild.

## 7. Verification (done in this sandbox, 2026-11-09)

| Check | Result |
| --- | --- |
| `pnpm install` (pnpm 12.15.0, Node 24.22.1) | PASS |
| API `pnpm typecheck` | PASS (after fixing one pre-existing `server.ts:138` type error — `RawData` → `Uint8Array` conversion; bytes unchanged) |
| API `pnpm build` (`tsc` + `tsc-alias`) | PASS — `dist/worker.js` emitted |
| API `pnpm test` | PASS — 44 files, 418 tests |
| API `wrangler deploy --dry-run` | PASS — total upload 11,063 KiB / gzip 2,006 KiB; bindings `API_DO`, `REALTIME_DO`, `SITEPINS_BUCKET` + all `[vars]` resolved. One esbuild warning only (`unenv` whatwg-url default import) |
| App `pnpm typecheck` (with `NEXT_PUBLIC_*` set) | PASS |
| App `opennextjs-cloudflare build` | PASS — "Worker saved in `.open-next/worker.js`"; `.open-next/middleware/` contains the built `proxy.ts` gate; only esbuild warnings (duplicate `case` in a vendored chunk, `-0` comparison) |
| App `wrangler deploy --dry-run` | PASS — 679 asset files read; bindings `ASSETS` + all `NEXT_PUBLIC_*` vars resolved |
| Live deploy / Atlas / R2 / DNS | **NOT DONE** — no push, no deploy (per task); needs §2 + §6 |

Notes:

- The API dry-run initially failed twice for fixable config reasons,
  both fixed in the committed config: (1) `dist/worker.js` is CommonJS,
  so Wrangler treated it as a service worker — `main` is now
  `src/worker.ts` and Wrangler bundles it; (2) `nodejs_compat` +
  `nodejs_compat_v2` together are rejected — only `nodejs_compat_v2`
  is set.
- The app dry-run total upload is 65,022 KiB / gzip 13,212 KiB — that
  is mostly the 679 static-asset files; the Worker script itself is
  the small `.open-next/worker.js` entry. No size error was raised.
- `/tmp` in this sandbox is a 512 MiB tmpfs and filled up during the
  builds (pnpm store + OpenNext temp files). Builds were run with
  `TMPDIR=~/workspace/.tmp`. On a normal machine this is a non-issue.
- `pnpm store prune` was run once to free space; it only removed
  unreferenced packages.

## 8. Rollback

- Re-deploying the previous Docker/Vercel setup is unaffected — no
  Docker, Vercel or local-Node file was deleted or changed.
- To take the Workers down: `wrangler delete` in `api/` and `app/`
  (or remove the `csofts.tech` / `api.csofts.tech` routes in the
  Cloudflare dashboard). Data stays in Atlas + R2 + GitHub.
