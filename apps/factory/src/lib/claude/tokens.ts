/**
 * P11 — Claude's factory connections (FactoryAccessToken): created by the OWNER in Settings › Integrations › Claude,
 * listed without their secret, revoked at once; and, on every MCP call, resolved from the raw token to the person it
 * runs as. The raw token is returned once at creation and never stored (its sha256 is), as sessions are.
 * Every create and revoke is audited; the rules themselves are pure (core.ts).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";
import {
  DRAFT_ACTIONS,
  SCOPE_SETS,
  expiryFor,
  hashToken,
  looksLikeToken,
  newRawToken,
  parseScopes,
  startOfLocalDay,
  tokenRefusal,
  type ClaudeScope,
  type ScopeSet,
} from "./core";

export type AccessTokenView = {
  id: string;
  label: string;
  scopes: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  runsAs: { id: string; displayName: string };
};

const VIEW_SELECT = {
  id: true,
  label: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  user: { select: { id: true, displayName: true } },
} as const;

type ViewRow = {
  id: string;
  label: string;
  scopes: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  user: { id: string; displayName: string };
};

const view = (row: ViewRow): AccessTokenView => ({
  id: row.id,
  label: row.label,
  scopes: row.scopes,
  expiresAt: row.expiresAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  runsAs: row.user,
});

/** Every connection, newest first, without its secret. */
export async function listAccessTokens(): Promise<AccessTokenView[]> {
  const rows = await prisma.factoryAccessToken.findMany({ select: VIEW_SELECT, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map(view);
}

export class AccessTokenInputError extends Error {}

/** A new connection for an active person; the raw token is in the answer once. */
export async function createAccessToken(input: {
  ownerId: string;
  userId: string;
  label: string;
  scopes: string;
  days?: number;
  now?: Date;
}): Promise<{ token: AccessTokenView; raw: string }> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 80) throw new AccessTokenInputError("Name the connection (1–80 characters).");
  if (!(SCOPE_SETS as readonly string[]).includes(input.scopes)) throw new AccessTokenInputError("Choose what Claude may do: read, or read and draft.");
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
  if (!user || user.status !== "active") throw new AccessTokenInputError("Choose an active person for Claude to act as.");
  const now = input.now ?? new Date();
  const raw = newRawToken();
  const row = await prisma.factoryAccessToken.create({
    data: {
      userId: user.id,
      label,
      tokenHash: hashToken(raw),
      scopes: input.scopes as ScopeSet,
      expiresAt: expiryFor(input.days, now),
      createdById: input.ownerId,
    },
    select: VIEW_SELECT,
  });
  await audit({
    actorId: input.ownerId,
    entityType: "claude",
    entityId: row.id,
    action: "claude.token.created",
    after: { label, scopes: row.scopes, runsAs: row.user.id, expiresAt: row.expiresAt.toISOString() },
  });
  return { token: view(row), raw };
}

/** Revoke a connection: the very next call with it is refused. False when there is none, or it is already revoked. */
export async function revokeAccessToken(id: string, actorId: string, now = new Date()): Promise<boolean> {
  const result = await prisma.factoryAccessToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
  if (result.count !== 1) return false;
  await audit({ actorId, entityType: "claude", entityId: id, action: "claude.token.revoked" });
  return true;
}

export type ResolvedAccess =
  | { ok: true; tokenId: string; label: string; scopes: Set<ClaudeScope>; user: SessionUser }
  | { ok: false; error: string };

/** A raw token to the person it runs as, checked now: unknown, revoked, expired and inactive are refused. */
export async function resolveAccessToken(raw: string | undefined, now = new Date()): Promise<ResolvedAccess> {
  if (!looksLikeToken(raw)) return { ok: false, error: tokenRefusal(null, null, now)! };
  const row = await prisma.factoryAccessToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: { include: { roleAssignments: { include: { role: { select: { key: true } } } } } } },
  });
  const refusal = tokenRefusal(row, row?.user ?? null, now);
  if (refusal || !row) return { ok: false, error: refusal ?? "unknown" };
  // At most one write a minute per connection: "last used" is for a person, not an audit.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    void prisma.factoryAccessToken.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => {});
  }
  const u = row.user;
  return {
    ok: true,
    tokenId: row.id,
    label: row.label,
    scopes: parseScopes(row.scopes),
    user: {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      status: u.status,
      permissionsVersion: u.permissionsVersion,
      roleKeys: u.roleAssignments.map((a) => a.role.key),
    },
  };
}

/** How many drafts this connection made today (the audit rows of its draft tools). */
export async function draftsToday(tokenId: string, now = new Date()): Promise<number> {
  return prisma.auditLog.count({
    where: { entityType: "claude", entityId: tokenId, action: { in: DRAFT_ACTIONS }, createdAt: { gte: startOfLocalDay(now) } },
  });
}
