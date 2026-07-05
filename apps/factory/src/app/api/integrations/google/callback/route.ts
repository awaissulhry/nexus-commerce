/**
 * F1 — the loopback OAuth redirect target. Top-level GET navigation, so the
 * SameSite=Lax session cookie rides and the guard authenticates the Owner.
 * On success → back to Settings › Integrations.
 */
import { NextRequest, NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { publishEvent } from "@/lib/events";
import { handleCallback } from "@/lib/google/oauth";

export const permission = FEATURES.integrationsManage;

export const GET = guarded(FEATURES.integrationsManage, async (req: NextRequest, { actor }) => {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const to = (q: string) => NextResponse.redirect(`${req.nextUrl.origin}/settings/integrations?${q}`);
  if (!code || !state) return to("google_error=" + encodeURIComponent("Google returned no code"));
  try {
    const { email } = await handleCallback(code, state);
    void audit({ actorId: actor!.id, entityType: "integration", entityId: "google", action: "connected", after: { email } });
    publishEvent("integration.changed", { provider: "google" });
    return to("connected=google");
  } catch (err) {
    return to("google_error=" + encodeURIComponent((err as Error).message.slice(0, 180)));
  }
});
