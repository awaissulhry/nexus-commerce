/**
 * FP11.1 — PUBLIC: an invitee accepts. The token is the auth. GET validates it
 * (email + role) so the join page can render; POST creates the User + UserRole
 * for the invited role, logs them in (session cookie), and burns the invite.
 * The team service runs the guardrails + the account creation.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { validateInvite, acceptInvite } from "@/lib/auth/team-service";
import { GuardrailError } from "@/lib/auth/guardrails";
import { createSession, sessionCookieHeader, csrfCookieHeader, newCsrfToken } from "@/lib/auth/session";

export const permission = PUBLIC;

export const GET = guarded(PUBLIC, async (_req, { params }) => {
  const { token } = await params;
  const view = await validateInvite(token);
  if (!view) return NextResponse.json({ error: "This invitation is invalid, expired, or already used." }, { status: 410 });
  return NextResponse.json(view);
});

const Body = z.object({ displayName: z.string().trim().min(1).max(80), password: z.string().min(8).max(200) });

export const POST = guarded(PUBLIC, async (req, { params }) => {
  const { token } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A display name and a password (8+ characters) are required" }, { status: 400 });
  try {
    const { userId } = await acceptInvite(token, parsed.data.displayName, parsed.data.password);
    const sessionToken = await createSession(userId, { userAgent: req.headers.get("user-agent") ?? undefined });
    void audit({ actorId: userId, entityType: "user", entityId: userId, action: "invite-accepted" });
    const res = NextResponse.json({ ok: true });
    res.headers.append("Set-Cookie", sessionCookieHeader(sessionToken));
    res.headers.append("Set-Cookie", csrfCookieHeader(newCsrfToken()));
    return res;
  } catch (e) {
    if (e instanceof GuardrailError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
});
