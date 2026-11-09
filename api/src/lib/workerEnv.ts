// ---------------------------------------------------------------------------
// Cloudflare Worker environment plumbing.
//
// On a Worker (or inside a Durable Object) there is no `.env` file and no
// ambient `process.env` you can rely on: configuration arrives as bindings
// on the `env` object passed to `fetch()` / the Durable Object constructor.
// Local Node dev keeps working exactly as before — when no Worker env has
// been set, everything falls back to `process.env` (dotenv `.env`).
//
// Rule: the Worker entry point (`src/worker.ts`) and the Durable Objects
// (`src/lib/workerRuntime.ts`) call `setWorkerEnv(env)` at the start of
// every `fetch()`, before any request-scoped config is read. Config modules
// evaluated at import time read `process.env`, which workerd populates from
// vars/secrets (nodejs_compat_populate_process_env) for compatibility dates
// >= 2025-04-01; the explicit binding wins when both are present.
// ---------------------------------------------------------------------------

export type WorkerEnv = Record<string, unknown>;

let workerEnv: WorkerEnv | null = null;

export function setWorkerEnv(env: WorkerEnv | null | undefined): void {
  if (env && typeof env === "object") workerEnv = env;
}

export function getWorkerEnv(): WorkerEnv | null {
  return workerEnv;
}

export function isWorkerRuntime(): boolean {
  return workerEnv !== null;
}

/** String env value: Worker binding first, then `process.env`. */
export function resolveEnv(name: string): string | undefined {
  const bound = workerEnv?.[name];
  if (typeof bound === "string" && bound !== "") return bound;
  const fromProcess =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  return fromProcess === "" ? undefined : fromProcess;
}

/** Non-string binding (e.g. an R2Bucket): only available on a Worker. */
export function getWorkerBinding<T = unknown>(name: string): T | undefined {
  const bound = workerEnv?.[name];
  return bound === undefined || bound === null ? undefined : (bound as T);
}
