/** F1 — save the Google OAuth Desktop client id/secret (encrypted at rest). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { saveOauthClientConfig } from "@/lib/google/oauth";

export const permission = FEATURES.integrationsManage;

// Gate-finding fix (2026-07-05): the field accepted ANY string — the Owner's
// email was silently stored as a "client id". Enforce the real shapes.
const Body = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/\.apps\.googleusercontent\.com$/, {
      message:
        "That is not a Google OAuth Client ID — it must end in .apps.googleusercontent.com (Google Cloud console → Credentials → your Desktop app client)",
    }),
  clientSecret: z
    .string()
    .trim()
    .min(10, { message: "Client secret looks too short — copy it from the same Credentials screen" })
    .refine((s) => !s.includes("@"), {
      message: "That looks like an email address, not a client secret",
    }),
});

export const POST = guarded(FEATURES.integrationsManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "clientId and clientSecret required";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  await saveOauthClientConfig(parsed.data.clientId.trim(), parsed.data.clientSecret.trim());
  void audit({ actorId: actor!.id, entityType: "integration", entityId: "google", action: "config.saved" });
  return NextResponse.json({ ok: true });
});
