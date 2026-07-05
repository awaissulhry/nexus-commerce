/** F1 — start the OAuth flow: returns the Google consent URL to open. */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { buildAuthUrl } from "@/lib/google/oauth";

export const permission = FEATURES.integrationsManage;

export const POST = guarded(FEATURES.integrationsManage, async (req) => {
  const redirectUri = `${req.nextUrl.origin}/api/integrations/google/callback`;
  const url = await buildAuthUrl(redirectUri);
  if (!url) return NextResponse.json({ error: "Save the OAuth client id/secret first" }, { status: 400 });
  return NextResponse.json({ url });
});
