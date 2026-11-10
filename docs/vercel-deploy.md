# Sitepins on Vercel — 2-service deployment

> Status: config is in the repo and verified locally; **no Vercel project
> exists yet and nothing is deployed**. The Vercel dashboard side
> (import project, env vars, first deploy) still has to happen — see §4.
> Companion doc for the Cloudflare setup: `docs/cloudflare-deploy.md`.

## 1. Architecture

One Vercel project, two services, one domain. The root `vercel.json`
already declares this (shipped upstream, untouched by the Cloudflare
work):

| Piece | Service | Root | Framework | Entry |
| --- | --- | --- | --- | --- |
| App (Next.js 16) | `app` | `app/` | `nextjs` | `next build` / `next start` |
| API (Express 5 + Mongoose 9) | `api` | `api/` | `express` | `tsc` build / `node ./dist/server.js` |

```json
{
  "services": {
    "api": { "root": "api", "framework": "express" },
    "app": { "root": "app", "framework": "nextjs" }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "api" } },
    { "source": "/(.*)", "destination": { "service": "app" } }
  ]
}
```

```
browser ──► https://<project>.vercel.app ──► app service (Next.js)
                │  /api/* rewrite
                └────► api service (Express, real Node server)
                           ├─► MongoDB Atlas
                           └─► Cloudflare R2 (S3-compatible uploads)
```

The API service is **internal by default** — it is only reachable
through the main domain's `/api/*` rewrite, not on its own public URL.
That is why `NEXT_PUBLIC_BACKEND_URL` below is the same origin plus
`/api/v1`, not a separate `api.` subdomain (unlike Cloudflare, where
the API lives at `api.csofts.tech`).

## 2. How Vercel differs from the Cloudflare deployment

- **Realtime is expected to work here.** The API is a real long-running
  Node `http.Server`, and Vercel documents Express + `ws` WebSocket
  servers as a supported pattern — so Socket.io presence and Hocuspocus
  co-editing should function. This still needs a live two-browser
  check after the first deploy; on Cloudflare both are explicit 503
  stubs (`docs/cloudflare-deploy.md` §5).
- **No Durable Object, no single-threaded bottleneck.** The API holds
  its own Mongoose connection pool directly; there is no ~70–140 s
  eviction / cold Mongo reconnect like the Worker DO.
- **Native `bcrypt` and SMTP both work** (real Node). The Cloudflare
  swaps (`bcryptjs`, Resend HTTP mail) still work fine on Vercel too —
  no code change needed — but SMTP becomes an option again.
- **Live preview is currently STUBBED — known gap.** The Cloudflare
  build replaced `app/src/app/api/sandbox/*` (create / heartbeat /
  stop) with 503 `sandbox-unavailable` stubs, because the originals
  import `@vercel/sandbox` and sandbox helper modules that cannot run
  on Workers. On Vercel those originals would work natively. Until the
  routes are made runtime-gated (Vercel = original, Worker = stub),
  a Vercel deploy has no live preview — the editor degrades gracefully
  instead of hanging. To restore the originals for a Vercel-only
  deploy (this breaks the Cloudflare Worker build — do not do it if
  you still deploy to Cloudflare):
  `git checkout 12655c6 -- app/src/app/api/sandbox/`

## 3. Prerequisites (same as Cloudflare, except the domain)

- [ ] **MongoDB Atlas cluster** + DB user + Network Access `0.0.0.0/0`
  (same cluster as Cloudflare can be reused — a second deployment
  talking to the same Atlas database is fine; they share data).
- [ ] **R2 bucket `sitepins-media`** + API token + public URL
  `https://media.csofts.tech` (already done).
- [ ] **GitHub App** (slug, App ID, Client ID, Client Secret, `.pem`)
  + optional GitLab OAuth app (same as Cloudflare).
- [ ] **Resend API key** (optional for first launch — see mail note
  in §5) + a verified sending domain.
- [ ] Vercel account with access to team `zaheer-ahmads-projects`.

Secrets: generate with `openssl rand -base64 32` for
`BETTER_AUTH_SECRET`, `JWT_SECRET`, `INTERNAL_API_SECRET`;
`openssl rand -hex 32` for `SANDBOX_ENCRYPTION_KEY`.
`INTERNAL_API_SECRET` must be **identical** on both services (and,
if you keep both deployments, identical to the Cloudflare one too).

## 4. Create the project (dashboard — the agent cannot do this yet)

The Vercel connection available to the agent returns 403 on project
reads for team `zaheer-ahmads-projects` (team scope not authorized),
so the project must be created from the dashboard for now:

1. Go to [vercel.com/new](https://vercel.com/new) → **Import Git
   Repository** → pick `DashingMZA/sitepins`.
2. Framework Preset should resolve to **Services** from the root
   `vercel.json`. If it does not, set the project framework to
   Services manually before deploying.
3. Add the environment variables from §5 (Production; Preview can
   share the same values except secrets you want separate).
4. **Deploy.** The first build builds both services.
5. Note the assigned domain, e.g. `https://sitepins.vercel.app`
   (name depends on the project name you pick) — then replace
   `<project>` in §5 with it. `NEXT_PUBLIC_*` are inlined at build
   time, so if the domain differs from what you exported, set the
   vars and **redeploy** (a rebuild is required).
6. Optional: add a custom domain in the project settings
   (e.g. `sitepins.csofts.tech` — needs a DNS record; the apex
   `csofts.tech` is on Cloudflare, so use a subdomain, not the apex).

Auto-deploy note: importing enables automatic deploys on every push
to `main` by default. If you want deploys to stay manual (as on the
other project), turn off Git auto-deploy in the project settings
(Settings → Git) after import.

## 5. Environment variables

`<project>` = your Vercel project domain, e.g.
`https://sitepins.vercel.app`. All `NEXT_PUBLIC_*` must be set
**before** the build (they are inlined at build time).

### App service

| Var | Value |
| --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | `https://<project>/api/v1` |
| `NEXT_PUBLIC_HP_WS_URL` | `wss://<project>/api/v1/editor/collab` |
| `NEXT_PUBLIC_BRAND_URL` | `https://<project>` |
| `NEXT_PUBLIC_BRAND_NAME` / `NEXT_PUBLIC_BRAND_SLUG` | `Sitepins` / `sitepins` |
| `NEXT_PUBLIC_BUCKET_URL` | `https://media.csofts.tech` |
| `NEXT_PUBLIC_GIT_APP_NAME` | GitHub App slug (**required, non-empty** — the build throws without it) |
| `NEXT_PUBLIC_GITLAB_CLIENT_ID` | optional |
| other `NEXT_PUBLIC_*` brand/link vars | see `app/.env.example` / `app/wrangler.jsonc` (same values as Cloudflare, except the three URLs above) |

App secrets (same values as Cloudflare where applicable):
`INTERNAL_API_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (full `.pem`),
`GITLAB_CLIENT_SECRET` (optional), `AI_PROVIDER` / `AI_MODEL` /
`AI_API_KEY` (optional).

### API service

| Secret / var | Value |
| --- | --- |
| `MONGO_URI` | Atlas `mongodb+srv://…` string |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `INTERNAL_API_SECRET` | same value as the app service |
| `SANDBOX_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | R2 API token |
| `S3_BUCKET_NAME` | `sitepins-media` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app |
| `RESEND_API_KEY` | Resend API key |
| `REOON_API_KEY` | optional |
| `BASE_URL` | `https://<project>` |
| `CORS_ORIGINS` | `https://<project>` |
| `APP_URL` | `https://<project>` |
| `COOKIE_DOMAIN` | *(leave unset — single-host deploy, cookies scope to the exact host)* |
| `TRUST_PROXY` | `1` |
| `MAIL_PROVIDER` | `resend` (or `console` + `REQUIRE_EMAIL_VERIFICATION=false` for a first launch with no mail — OTP is then logged, not emailed) |
| `REQUIRE_EMAIL_VERIFICATION` | `true` (or `false` with the console-mail first launch) |

## 6. Local verification (done 2026-11-09)

| Check | Result |
| --- | --- |
| Root `vercel.json` services + rewrites | Present, matches Vercel services format (upstream config) |
| App `next build` with Vercel-style env (`NEXT_PUBLIC_BACKEND_URL=https://sitepins.vercel.app/api/v1`, bucket `https://media.csofts.tech`) | PASS — exit 0, all routes emitted (incl. the 503 sandbox stubs) |
| API `pnpm build` (`tsc`) | PASS (already verified for the Cloudflare build; same code) |
| API `pnpm test` | PASS — 44 files, 418 tests |
| Vercel project / live deploy | **NOT DONE** — needs §4 (dashboard import) |

## 7. Smoke-test checklist (after first deploy)

- [ ] `/login` renders, login with a test user works, `/dashboard` loads.
- [ ] Create a project, connect a GitHub repo, edit a file, save → a
      real commit lands in the repo.
- [ ] Upload an image → object appears in the R2 bucket and renders
      at `https://media.csofts.tech/<key>`.
- [ ] Open the same file in two browsers → live cursors / presence
      appear and edits sync (realtime check — the main thing Vercel
      should do better than Cloudflare).
- [ ] Live preview button → currently shows "sandbox unavailable"
      (expected until §2's restore/gating work is done).
- [ ] Check the built app calls `https://<project>/api/v1`
      (browser devtools Network tab). A wrong value means the build
      env was wrong — fix the vars and redeploy.

## 8. Rollback

- The Cloudflare deployment (if live) is unaffected — different
  platform, same Atlas + R2 + GitHub. Both can run side by side;
  they share one database, so a user/project created on one shows
  up on the other.
- To take Vercel down: delete the project (or remove the domain) in
  the Vercel dashboard. Data stays in Atlas + R2 + GitHub.
