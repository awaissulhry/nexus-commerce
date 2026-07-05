/** F1 — logout: revoke the session server-side and clear the cookie. */
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { SESSION_COOKIE, clearSessionCookieHeader, revokeSession } from "@/lib/auth/session";

export const permission = PUBLIC;

export const POST = guarded(PUBLIC, async (req, { actor }) => {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  if (actor) void audit({ actorId: actor.id, entityType: "auth", entityId: actor.id, action: "logout" });
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  return res;
});
