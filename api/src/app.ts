import brand from "./config/brand";
import config from "./config/variables";
import { globalErrorhandler } from "./middlewares/globalErrorHandler";
import { apiLimiter } from "./middlewares/rateLimiters";
import { sanitizeInput } from "./middlewares/sanitizeInput";
import router from "./routes";
import cors from "cors";
import express, { Application, NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { getAuth } from "./auth";
import { getAuthDemo } from "./auth-demo";
import { dbConnect } from "./lib/dbConnect";
import { logger } from "./lib/logger";
import {
  corsProtectedOptions,
  corsUnprotectedOptions,
} from "./config/cors-options";
import { agentUploadRouter } from "./modules/agent/agent.upload";
import { gitProxyRouter } from "./modules/agent/git-proxy";
import { mcpRoute } from "./modules/agent/mcp.route";

const app: Application = express();

// Behind a proxy (Vercel, DO App Platform, nginx) so req.ip / req.protocol
// and rate limiting read the real client from X-Forwarded-* rather than the
// proxy. Configurable via TRUST_PROXY; defaults to 1 hop in production.
const tp = config.trust_proxy;
const trustProxyValue =
  tp === "false" || tp === "0"
    ? false
    : /^\d+$/.test(tp ?? "")
      ? Number(tp)
      : tp;
app.set("trust proxy", trustProxyValue);

// Express 5's default. Pinned explicitly because it is a security property,
// not a preference: "simple" yields string | string[] values only, so a query
// string can never carry a Mongo operator object (`?id[$ne]=`) into a filter.
// Switching this to "extended" would reopen that door.
app.set("query parser", "simple");

// Security headers. This is a JSON API behind CORS, so cross-origin resource
// policy is relaxed to allow the separate web origin to read responses.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

const conditionalCors = (req: Request, res: Response, next: NextFunction) => {
  const isUnprotectedRoute = req.path.startsWith("/api/v1/token");
  const options = isUnprotectedRoute
    ? corsUnprotectedOptions
    : corsProtectedOptions;

  cors(options)(req, res, next);
};

app.use(conditionalCors);

// Vercel's Express preset serves this app directly without startServer(),
// so the default Mongoose connection would never open and every model query
// (User.findOne, ...) buffers 10s then times out ("buffering timed out").
// Kick the connection off on each request; dbConnect() is idempotent and
// returns immediately once connected, and model operations buffer briefly
// until the first connect finishes. Never block the request on it —
// /healthz must stay fast, and a down database must not hang every request
// for the 30s server-selection timeout.
app.use((_req, _res, next) => {
  void dbConnect().catch((err) => {
    logger.warn("Background MongoDB connect failed", err);
  });
  next();
});

// must place better auth handlers before express.json()
type AuthRequestHandler = (req: Request, res: Response) => unknown;
let authHandler: AuthRequestHandler | null = null;
app.all("/api/v1/auth/*splat", async (req, res) => {
  if (!authHandler) {
    // better-auth is ESM-only — dynamic import (see auth.ts).
    const { toNodeHandler } = await import("better-auth/node");
    authHandler = toNodeHandler(await getAuth());
  }
  return authHandler(req, res);
});
// Demo auth is an anonymous-signup surface — only mount it when DEMO_MODE is on.
if (config.demo_mode) {
  let authDemoHandler: AuthRequestHandler | null = null;
  app.all("/api/v1/demo/auth/*splat", async (req, res) => {
    if (!authDemoHandler) {
      const { toNodeHandler } = await import("better-auth/node");
      authDemoHandler = toNodeHandler(await getAuthDemo());
    }
    return authDemoHandler(req, res);
  });
}

// MCP, the git proxy and agent uploads read raw request bodies, so they sit before the JSON parser.
app.all("/mcp", mcpRoute);
app.use("/git", gitProxyRouter);
app.use("/agent-upload", agentUploadRouter);

// Cap request body size to prevent trivial memory-exhaustion DoS. Override
// with JSON_BODY_LIMIT if your content payloads are larger.
const bodyLimit = process.env.JSON_BODY_LIMIT || "5mb";
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

app.get("/", async (req, res) => {
  res.send(`Welcome to ${brand.name} API`);
});

// Liveness/readiness probe for orchestrators (Docker, DO App Platform, k8s).
app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// Strip Mongo operator keys before anything can reach a query filter, then
// apply a broad request ceiling. better-auth runs its own rate limiter on
// /api/v1/auth/*, which is mounted above this.
app.use("/api/v1", sanitizeInput, apiLimiter, router);

app.use(globalErrorhandler);

export default app;
