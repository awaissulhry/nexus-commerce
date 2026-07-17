/**
 * F1 — login: verify credentials, create a server-side session, set the
 * HttpOnly cookie. Audited.
 * FS4 — the dormant lockout columns are real: 5 consecutive failures → a
 * 15-minute lock (423 with the remaining minutes; `login.locked` audited),
 * success resets the counter (`login.unlocked-on-success` audited when a lock
 * had been riding the account). The machine itself is pure —
 * src/lib/auth/lockout.ts — rate-limited by USER, not IP (single-site reality).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { isLocked, onLoginFailure, onLoginSuccess, remainingLockMinutes } from "@/lib/auth/lockout";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, sessionCookieHeader } from "@/lib/auth/session";

export const permission = PUBLIC;

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

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

  const now = Date.now();
  if (isLocked(user.lockedUntil, now)) {
    const minutes = remainingLockMinutes(user.lockedUntil!, now);
    return NextResponse.json(
      {
        error: `Account locked after too many failed attempts — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        code: "locked",
        lockedUntil: user.lockedUntil,
      },
      { status: 423 },
    );
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const next = onLoginFailure({ failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil }, now);
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil },
    });
    if (next.justLocked) {
      void audit({
        actorId: null,
        entityType: "auth",
        entityId: user.id,
        action: "login.locked",
        after: { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil },
      });
    }
    return invalid;
  }

  if (user.lockedUntil) {
    // an (expired) lock was riding the account — its clean release is on the record
    void audit({ actorId: user.id, entityType: "auth", entityId: user.id, action: "login.unlocked-on-success" });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { ...onLoginSuccess(), lastLoginAt: new Date() },
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
