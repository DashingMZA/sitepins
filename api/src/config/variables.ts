import { resolveEnv } from "../lib/workerEnv";
import dotenv from "dotenv";
import path from "path";

// On Cloudflare Workers there is no `.env` file: configuration arrives as
// bindings on the Worker `env` object (see `src/lib/workerEnv.ts`), and
// `resolveEnv()` reads those first. Local Node dev still loads `.env` here.
// The try/catch keeps the Worker path alive if the filesystem read is
// unavailable in workerd; on Node it behaves exactly as before.
try {
  dotenv.config({ path: path.join(process.cwd(), ".env") });
} catch {
  // Worker runtime or read-only filesystem — bindings are the source.
}

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
};

export default {
  env: resolveEnv("NODE_ENV"),
  database_uri: resolveEnv("MONGO_URI"),
  port: resolveEnv("PORT"),
  better_auth_secret: resolveEnv("BETTER_AUTH_SECRET"),
  // bcrypt cost factor. Falls back to 10 when SALT is unset/invalid so a
  // missing env var never silently produces NaN rounds.
  salt: Number(resolveEnv("SALT")) || 10,
  jwt_secret: resolveEnv("JWT_SECRET"),
  jwt_expire: resolveEnv("JWT_TOKEN_EXPIRE"),

  // Session cookie domain. Leave unset for single-host deploys (the browser
  // then scopes the cookie to the exact host). Only set this to a leading-dot
  // domain (e.g. ".example.com") when the app and API live on different
  // subdomains of the same site and must share the session cookie.
  cookie_domain: resolveEnv("COOKIE_DOMAIN"),

  // Number of proxies in front of the app (Vercel, DO App Platform, nginx…).
  // Needed so Express reads the real client IP and protocol from the
  // X-Forwarded-* headers. Default 1 in production.
  trust_proxy:
    resolveEnv("TRUST_PROXY") ??
    (resolveEnv("NODE_ENV") === "production" ? "1" : "false"),

  // Require a verified email before a credentials account can sign in. Turn
  // off (REQUIRE_EMAIL_VERIFICATION=false) for instances with no mail provider.
  require_email_verification: bool(
    resolveEnv("REQUIRE_EMAIL_VERIFICATION"),
    true,
  ),

  // Public demo mode. When off (default) the unauthenticated demo-auth
  // endpoints (/api/v1/demo/auth/*) are not mounted, so a self-hosted instance
  // exposes no anonymous-signup surface. The hosted demo turns this on.
  demo_mode: bool(resolveEnv("DEMO_MODE"), false),

  // ---- Media storage (S3-compatible: AWS S3, Cloudflare R2, MinIO,
  // Backblaze B2, DigitalOcean Spaces) ----
  s3_endpoint: resolveEnv("S3_ENDPOINT"),
  s3_region: resolveEnv("S3_REGION"),
  s3_access_key: resolveEnv("S3_ACCESS_KEY"),
  s3_secret_key: resolveEnv("S3_SECRET_KEY"),
  s3_bucket_name: resolveEnv("S3_BUCKET_NAME"),
  s3_force_path_style: bool(resolveEnv("S3_FORCE_PATH_STYLE"), false),

  // Optional anti-abuse email validation at signup (https://reoon.com).
  // Unset = skipped. Fails open if the service is unreachable.
  reoon_api_key: resolveEnv("REOON_API_KEY"),

  // ---- Transactional email ----
  // Provider: "smtp" | "resend" | "console". Unset = auto-detect: "resend"
  // when RESEND_API_KEY is set, "smtp" when SMTP_HOST is set, else "console"
  // (logs the message + OTP/link to stdout). "resend" is the Cloudflare
  // Worker provider — Workers cannot open raw SMTP TCP connections, so SMTP
  // is Node-only. Extensions can register a custom sender via setMailSender.
  mail_provider: resolveEnv("MAIL_PROVIDER"),
  mail_from_name: resolveEnv("MAIL_FROM_NAME"),
  mail_from_email: resolveEnv("MAIL_FROM_EMAIL"),
  // Resend HTTP API key (https://resend.com). Used only when
  // MAIL_PROVIDER=resend or auto-detected. Never commit a real key.
  resend_api_key: resolveEnv("RESEND_API_KEY"),

  // SMTP (used when MAIL_PROVIDER=smtp or auto-detected; Node only)
  smtp_host: resolveEnv("SMTP_HOST"),
  smtp_port: Number(resolveEnv("SMTP_PORT")) || 587,
  smtp_secure: bool(resolveEnv("SMTP_SECURE"), false),
  smtp_user: resolveEnv("SMTP_USER"),
  smtp_pass: resolveEnv("SMTP_PASS"),

  // Internal server-to-server secret (used by the web app's API routes)
  internal_secret: resolveEnv("INTERNAL_API_SECRET"),

  // Public origin of this API (also better-auth's baseURL), e.g. https://api.example.com
  base_url: resolveEnv("BASE_URL")?.replace(/\/+$/, ""),

  // AES-256-GCM key for encrypting sandbox tokens at rest (64-char hex)
  sandbox_encryption_key: resolveEnv("SANDBOX_ENCRYPTION_KEY"),
};
