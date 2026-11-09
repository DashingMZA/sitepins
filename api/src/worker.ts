/// <reference types="@cloudflare/workers-types" />
// ---------------------------------------------------------------------------
// Cloudflare Worker entry point for the Sitepins API (api.csofts.tech).
//
// Routing:
// - /healthz                         -> answered here (no DB needed)
// - /api/v1/editor/collab, /socket.io/*
//                                   -> RealtimeDurableObject (gated stub, see
//                                      src/lib/workerRuntime.ts — realtime is
//                                      NOT yet ported; it returns a clear 503)
// - everything else                  -> ApiDurableObject (singleton, holds
//                                      the Mongoose connection and runs the
//                                      existing Express app via
//                                      httpServerHandler from `cloudflare:node`)
//
// Local Node dev is unchanged: run `pnpm dev:api` / `src/server.ts` as
// before. This file is only used by Wrangler (`wrangler.jsonc` main).
// ---------------------------------------------------------------------------

import { setWorkerEnv } from "./lib/workerEnv";
import {
  ApiDurableObject,
  RealtimeDurableObject,
  type SitepinsApiEnv,
} from "./lib/workerRuntime";

export { ApiDurableObject, RealtimeDurableObject };

function isRealtimeRequest(url: URL): boolean {
  return (
    url.pathname === "/api/v1/editor/collab" ||
    url.pathname.startsWith("/socket.io/")
  );
}

export default {
  async fetch(
    request: Request,
    env: SitepinsApiEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    setWorkerEnv(env);

    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", worker: "sitepins-api" });
    }

    const realtime = isRealtimeRequest(url);
    const namespace = realtime ? env.REALTIME_DO : env.API_DO;
    const id = namespace.idFromName(
      realtime ? "sitepins-realtime" : "sitepins-api",
    );
    const stub = namespace.get(id);
    // ctx is forwarded implicitly by the DO stub; the DO owns its own ctx.
    void ctx;
    return stub.fetch(request);
  },
} satisfies ExportedHandler<SitepinsApiEnv>;
