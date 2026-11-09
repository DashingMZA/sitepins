// Cloudflare Worker stub.
//
// Live preview used to run the user's site inside a Vercel Sandbox
// (@vercel/sandbox) — a Vercel-only service that cannot run on Cloudflare
// Workers. The original implementation is preserved in git history
// (see `git log -- app/src/app/api/sandbox/create/route.ts`); on this
// deployment the endpoint answers 503 so the editor degrades gracefully
// instead of failing at build time or hanging at runtime
// (`use-sandbox-preview` treats a missing sandboxName/previewUrl as
// "no preview available"). Re-enabling live preview on Cloudflare needs
// a different sandbox backend (e.g. Cloudflare Containers) — see
// docs/cloudflare-deploy.md, section "Realtime follow-up".
import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "sandbox-unavailable",
      message:
        "Live preview (Vercel Sandbox) is disabled on the Cloudflare deployment. Editing, commits and deploys are unaffected.",
    },
    { status: 503 },
  );
}
