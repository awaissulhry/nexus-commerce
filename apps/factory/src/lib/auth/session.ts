/**
 * F1 — server-side sessions (S1 pattern): opaque 256-bit token in an HttpOnly
 * cookie, sha256 hash in the DB (raw never stored), 7-day idle / 30-day
 * absolute expiry, slide throttled to ≥60s between writes. Single origin →
 * SameSite=Lax, no CHIPS apparatus (F0-ARCHITECTURE §RBAC).
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

export const SESSION_COOKIE = "factory_session";
export const CSRF_COOKIE = "factory_csrf";
export const CSRF_HEADER = "x-factory-csrf";

const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const SLIDE_THROTTLE_MS = 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  status: string;
  permissionsVersion: number;
  roleKeys: string[];
};

export async function createSession(userId: string, meta?: { userAgent?: string; ip?: string }) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      idleExpiry: new Date(now + IDLE_MS),
      absoluteExpiry: new Date(now + ABSOLUTE_MS),
      userAgent: meta?.userAgent?.slice(0, 255),
      ip: meta?.ip?.slice(0, 64),
    },
  });
  return token;
}

export async function validateSessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { roleAssignments: { include: { role: { select: { key: true } } } } } } },
  });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  if (session.idleExpiry.getTime() < now || session.absoluteExpiry.getTime() < now) return null;
  if (session.user.status !== "active") return null;
  // sliding idle expiry, throttled
  const target = now + IDLE_MS;
  if (target - session.idleExpiry.getTime() > SLIDE_THROTTLE_MS) {
    void prisma.session
      .update({ where: { id: session.id }, data: { idleExpiry: new Date(target) } })
      .catch(() => {});
  }
  const u = session.user;
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    status: u.status,
    permissionsVersion: u.permissionsVersion,
    roleKeys: u.roleAssignments.map((a) => a.role.key),
  };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash: sha256(token) },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export function sessionCookieHeader(token: string, maxAgeSec = ABSOLUTE_MS / 1000): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function csrfCookieHeader(token: string): string {
  // NOT HttpOnly — double-submit: the client reads it and mirrors it in the header
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}`;
}

export const newCsrfToken = () => randomBytes(16).toString("hex");
