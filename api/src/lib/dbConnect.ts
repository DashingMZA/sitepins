import mongoose from "mongoose";
import { logger } from "./logger";
import { resolveEnv } from "./workerEnv";

// Idempotent: safe to call on every Worker/Durable Object request. A
// Durable Object holds one long-lived Mongoose connection (maxPoolSize 1 in
// the Worker path — see `src/lib/workerRuntime.ts`); a plain Worker
// invocation that calls this directly pays a fresh connect (~300 ms, per
// Cloudflare's MongoDB docs) because Workers cannot pool across requests.
let connecting: Promise<void> | null = null;

export async function dbConnect(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  if (mongoose.connection.readyState === 2 && connecting) {
    await connecting;
    return;
  }

  const MONGO_URI = resolveEnv("MONGO_URI");

  if (!MONGO_URI) {
    throw new Error(
      "Please define the MONGO_URI environment variable (api/.env locally, " +
        "or a `wrangler secret put MONGO_URI` on Cloudflare Workers)",
    );
  }

  connecting = (async () => {
    try {
      // Single connection per isolate/DO. Atlas counts every Worker isolate
      // as a client; a pool here would exhaust the Atlas connection limit.
      await mongoose.connect(MONGO_URI, { maxPoolSize: 1 });
      logger.info("[+] Database is connected successfully");
    } catch (error) {
      logger.error("[-] Database is failed to connect", error);
      throw error;
    } finally {
      connecting = null;
    }
  })();
  await connecting;
}
