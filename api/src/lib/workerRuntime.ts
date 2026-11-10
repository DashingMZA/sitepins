/// <reference types="@cloudflare/workers-types" />
// ---------------------------------------------------------------------------
// Cloudflare Durable Objects for the Sitepins API Worker.
//
// Why a Durable Object holds the API at all
// -----------------------------------------
// Workers are stateless isolates: they cannot pool a MongoDB connection
// across requests, and the MongoDB driver needs a persistent TCP/TLS
// connection. Cloudflare's own MongoDB docs give two options — a fresh
// connection per request (~300 ms overhead) or a Durable Object that holds
// one connection (~35 ms warm). We use the DO, and we route *all* REST
// traffic through a single named instance (`sitepins-api`), so the whole
// existing Express + Mongoose + better-auth codebase runs unchanged inside
// it: one Mongoose default connection (via `dbConnect()`), one auth
// connection (via `getAuthConnection()`), and transactions created by
// `mongoose.startSession()` all live in the same process, which is what
// makes them work. Hyperdrive is NOT used — it does not support MongoDB.
//
// Trade-offs, stated plainly:
// - A single DO is a single-threaded bottleneck (Cloudflare documents a
//   soft ~1,000 req/s per DO instance) and a single point of failure for
//   the API. For a self-hosted CMS this is acceptable; it is not a
//   multi-region HA design. Sharding by org/project is a follow-up.
// - The DO evicts after ~70–140 s idle; the next request pays a cold
//   connect again, and TCP does not survive hibernation.
// - The Express app runs via `httpServerHandler` from `cloudflare:node`
//   (NOT `cloudflare:workers` — that import path is wrong) with
//   `nodejs_compat`. This path is verified by typecheck + `wrangler deploy
//   --dry-run` only; a live smoke test against Atlas still has to happen
//   (see docs/cloudflare-deploy.md) because this sandbox has no Atlas
//   cluster and no Cloudflare account.
// ---------------------------------------------------------------------------

import { DurableObject } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import app from "../app";
import { dbConnect } from "./dbConnect";
import { logger } from "./logger";
import { setWorkerEnv } from "./workerEnv";

export interface SitepinsApiEnv {
  MONGO_URI: string;
  API_DO: DurableObjectNamespace<ApiDurableObject>;
  REALTIME_DO: DurableObjectNamespace<RealtimeDurableObject>;
  /** R2 bucket binding (declared for future direct-R2 use; uploads today go
   * through the S3-compatible endpoint — see bucket.route.ts). */
  SITEPINS_BUCKET?: unknown;
  [key: string]: unknown;
}

const API_PORT = 4000;

export class ApiDurableObject extends DurableObject<SitepinsApiEnv> {
  private handler: ReturnType<typeof httpServerHandler> | null = null;

  async fetch(request: Request): Promise<Response> {
    setWorkerEnv(this.env);

    // The DO owns the Mongo connection; connect once, reuse afterwards.
    // A failed connect is a 503, never a process exit (there is no process).
    try {
      await dbConnect();
    } catch (error) {
      logger.error("[worker] MongoDB connect failed", error);
      return Response.json(
        {
          success: false,
          message:
            "Database unavailable. Check MONGO_URI (Atlas) and network access (0.0.0.0/0).",
        },
        { status: 503 },
      );
    }

    if (!this.handler) {
      // `app` is imported statically (same as server.ts). Config modules
      // evaluated at import time read `process.env`, which workerd populates from Worker bindings for
      // compatibility dates >= 2025-04-01; `setWorkerEnv(this.env)` above
      // additionally makes the explicit DO env win for anything resolved
      // after this point. The Node entry point (`src/server.ts`, with
      // socket.io + Hocuspocus) is deliberately NOT used here — see
      // RealtimeDurableObject below.
      // `listen()` registers the server with workerd's node:http layer on
      // this port; httpServerHandler({ port }) dispatches Worker requests
      // into it. (The server-object overload does not typecheck against
      // Node's http.Server because of its `address()` return type.)
      app.listen(API_PORT);
      this.handler = httpServerHandler({ port: API_PORT });
    }

    const fetchHandler = this.handler.fetch;
    if (!fetchHandler) {
      throw new Error("[worker] httpServerHandler returned no fetch handler");
    }
    // DurableObjectState is not an ExecutionContext; the handler only uses
    // it for waitUntil(), which both provide. The DO request type also
    // differs from the Worker's IncomingRequest type — same wire request.
    type WorkerFetchRequest = Parameters<
      NonNullable<ExportedHandler["fetch"]>
    >[0];
    return fetchHandler.call(
      this.handler,
      request as unknown as WorkerFetchRequest,
      this.env,
      this.ctx as unknown as ExecutionContext,
    );
  }
}

// ---------------------------------------------------------------------------
// Realtime — GATED STUB, not a working implementation. Read this before
// assuming the editor's live features work on Cloudflare.
//
// What the Node server does today (api/src/server.ts):
// - socket.io presence gateway (`presence-update`, join-file/leave-file)
//   and editor gateway (`join-editor`, `commit`, `commit:external`)
// - Hocuspocus (Yjs) collaborative editing on /api/v1/editor/collab
//
// Why it cannot run as-is on a Worker:
// - socket.io speaks the engine.io protocol (long-polling + WebSocket
//   upgrade over a Node http.Server). A Worker has no Node http.Server to
//   attach it to, and the app's `socket.io-client` cannot talk to a plain
//   WebSocket endpoint. Porting presence needs a native-WebSocket DO *and*
//   a client-side switch away from socket.io-client.
// - Hocuspocus v4 *does* claim Cloudflare Workers support via crossws
//   (the `Hocuspocus` class + `handleConnection(ws, request, context)`),
//   and the installed @hocuspocus/server is ^4.7.1 — but `server.ts`
//   builds it around Node `ws` + `requestHeaders`, and its auth hook
//   needs a live better-auth session + `isOrgMember()` DB check inside
//   the DO. That port is real work, not a config change.
//
// What this stub does instead: it answers both realtime surfaces with an
// explicit, machine-readable 503 (`realtime-unavailable`) instead of
// hanging or silently dropping edits. REST editing, auth, projects and
// uploads all work without it; only live cursors/presence and simultaneous
// co-editing are unavailable until the follow-up in
// docs/cloudflare-deploy.md ("Realtime follow-up") is implemented.
// ---------------------------------------------------------------------------

export const REALTIME_UNAVAILABLE = {
  error: "realtime-unavailable",
  message:
    "Realtime collaboration (presence + Hocuspocus co-editing) is not yet deployed on Cloudflare Workers. " +
    "REST editing, auth and uploads are unaffected. See docs/cloudflare-deploy.md, section 'Realtime follow-up'.",
} as const;

export class RealtimeDurableObject extends DurableObject<SitepinsApiEnv> {
  async fetch(request: Request): Promise<Response> {
    setWorkerEnv(this.env);
    const upgrade = request.headers.get("upgrade")?.toLowerCase();

    if (upgrade === "websocket") {
      // Accept the upgrade so the client gets a clean close with a reason
      // instead of a hanging handshake, then close it immediately.
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      server.send(JSON.stringify(REALTIME_UNAVAILABLE));
      server.close(
        1011,
        "Realtime collaboration is not yet deployed on Cloudflare Workers",
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // socket.io long-polling and any plain HTTP hit on the realtime paths.
    return Response.json(REALTIME_UNAVAILABLE, { status: 503 });
  }
}
