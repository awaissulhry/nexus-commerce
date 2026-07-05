/** F1 — save the Google OAuth Desktop client id/secret (encrypted at rest). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { saveOauthClientConfig } from "@/lib/google/oauth";

export const permission = FEATURES.integrationsManage;

const Body = z.object({ clientId: z.string().min(10), clientSecret: z.string().min(5) });

export const POST = guarded(FEATURES.integrationsManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "clientId and clientSecret required" }, { status: 400 });
  await saveOauthClientConfig(parsed.data.clientId.trim(), parsed.data.clientSecret.trim());
  void audit({ actorId: actor!.id, entityType: "integration", entityId: "google", action: "config.saved" });
  return NextResponse.json({ ok: true });
});
