// OpenNext Cloudflare adapter config for the Sitepins app Worker
// (https://csofts.tech).
//
// Default overrides (in-memory / KV-backed incremental cache as shipped by
// the adapter). No R2 cache bucket is required for the first deploy; if
// fetch-cache revalidation needs to persist across isolates, switch to
// `r2IncrementalCache` from
// "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache"
// and add the bucket binding to app/wrangler.jsonc (see
// docs/cloudflare-deploy.md).
//
// proxy.ts: @opennextjs/cloudflare 1.20.x bundles Next 16's `proxy.ts`
// (auth + next-intl gate in app/src/proxy.ts) as the Node middleware — no
// middleware.ts shim is needed. Verified by `pnpm cf:build` producing
// `.open-next/` with the middleware bundled (see docs/cloudflare-deploy.md).
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
