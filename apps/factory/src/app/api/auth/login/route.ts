/**
 * F1 — login: verify credentials, progressive lockout (5 fails → 15 min,
 * persisted), create a server-side session, set the HttpOnly cookie. Audited.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, sessionCookieHeader } from "@/lib/auth/session";

export const permission = PUBLIC;

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export const POST = guarded(PUBLIC, async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and password required", code: "bad_request" }, { status: 400 });
  }
  const { email, password } = parsed.data;
  const invalid = NextResponse.json(
    { error: "Invalid email or password", code: "invalid_credentials" },
    { status: 401 },
  );

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.status !== "active") return invalid;
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return NextResponse.json(
      { error: "Account temporarily locked. Try again later.", code: "locked" },
      { status: 429 },
    );
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const fails = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: fails,
        lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null,
      },
    });
    return invalid;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  const token = await createSession(user.id, {
    userAgent: req.headers.get("user-agent") ?? undefined,
    ip: req.headers.get("x-forwarded-for") ?? undefined,
  });
  void audit({ actorId: user.id, entityType: "auth", entityId: user.id, action: "login" });

  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookieHeader(token));
  return res;
});
