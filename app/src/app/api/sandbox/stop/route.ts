// Cloudflare Worker stub — see create/route.ts for why the Vercel
// Sandbox stop endpoint is disabled on this deployment.
import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "sandbox-unavailable",
      message:
        "Live preview (Vercel Sandbox) is disabled on the Cloudflare deployment.",
    },
    { status: 503 },
  );
}
