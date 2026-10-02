/**
 * P11 (MCP full control, decision P-1 = A) — the pure rules of Claude's connection to the factory: the token format and
 * its hash, how long one may live, what makes one unusable, what the server refuses to start without, the per-minute
 * rate and the daily cap of drafts. No database, no clock of its own: every function takes `now`, so the tests pin
 * them exactly (src/lib/__tests__/p11-claude-core.test.ts).
 *
 * The connection is local: a small stdio MCP server (apps/factory/mcp/server.ts) that Claude Code or Claude Desktop
 * starts on the factory machine. It has no network surface. Its token is created by the OWNER in Settings ›
 * Integrations › Claude, shown once, and kept as a sha256 only — as sessions are (src/lib/auth/session.ts).
 */
import { createHash, randomBytes } from "node:crypto";

/** Every factory token starts with this, so one pasted in the wrong place is recognisable. */
export const TOKEN_PREFIX = "fct_";
export const MAX_TOKEN_DAYS = 90;
export const DEFAULT_TOKEN_DAYS = 30;
/** At most this many drafts (quotes, purchase orders, comments, stage moves) per token per day. */
export const DAILY_DRAFT_CAP = 100;
/** The draft tools (P12): their successful calls are what the daily cap counts. */
export const DRAFT_TOOLS = ["factory-draft-quote", "factory-draft-purchase-order", "factory-add-comment", "factory-advance-work-order"] as const;
/** The audit action of a successful call of a tool; a refused one adds `.refused`. */
export const auditAction = (tool: string): string => `claude.${tool}`;
export const DRAFT_ACTIONS: string[] = DRAFT_TOOLS.map(auditAction);

/** At most this many calls per token per minute. */
export const CALLS_PER_MINUTE = 60;

export type ClaudeScope = "read" | "draft";
/** The two scope sets a token can carry, as stored. */
export const SCOPE_SETS = ["read", "read,draft"] as const;
export type ScopeSet = (typeof SCOPE_SETS)[number];

const DAY_MS = 86_400_000;

/** A new raw token: the prefix and 32 random bytes. Shown to the OWNER once, never stored. */
export function newRawToken(bytes: Buffer = randomBytes(32)): string {
  return `${TOKEN_PREFIX}${bytes.toString("base64url")}`;
}

/** What is stored and looked up: the sha256 of the raw token. */
export const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

/** The shape of a raw token: the prefix and 43 base64url characters. Anything else is refused before a lookup. */
export const looksLikeToken = (raw: string | null | undefined): raw is string =>
  typeof raw === "string" && /^fct_[A-Za-z0-9_-]{43}$/.test(raw);

/** When a token made now for `days` days expires: at least 1 day, at most 90. */
export function expiryFor(days: number | undefined, now: Date): Date {
  const wanted = Number.isFinite(days) ? Math.trunc(days as number) : DEFAULT_TOKEN_DAYS;
  const clamped = Math.min(Math.max(wanted, 1), MAX_TOKEN_DAYS);
  return new Date(now.getTime() + clamped * DAY_MS);
}

/** The scopes a stored scope set grants. Unknown words grant nothing; drafting always implies reading. */
export function parseScopes(stored: string | null | undefined): Set<ClaudeScope> {
  const words = new Set((stored ?? "").split(",").map((w) => w.trim()));
  const out = new Set<ClaudeScope>();
  if (words.has("read")) out.add("read");
  if (words.has("draft") && words.has("read")) out.add("draft");
  return out;
}

/** Why a token cannot be used now, in a sentence; null when it can. */
export function tokenRefusal(
  row: { revokedAt: Date | null; expiresAt: Date } | null,
  user: { status: string } | null,
  now: Date,
): string | null {
  if (!row) return "This Claude connection is unknown to the factory. Create a new one in Settings › Integrations › Claude.";
  if (row.revokedAt) return "This Claude connection was revoked in Settings › Integrations › Claude.";
  if (row.expiresAt.getTime() <= now.getTime()) return "This Claude connection has expired. Create a new one in Settings › Integrations › Claude.";
  if (!user || user.status !== "active") return "The person this Claude connection runs as is no longer active in the factory.";
  return null;
}

/**
 * Why the server must not start, or null. RBAC in `shadow` mode allows every action (denials are only logged), so a
 * token would reach everything; a database not in WAL mode risks corruption with a third process on the file.
 */
export function startRefusal(input: { rbacMode: string | undefined; journalMode: string | null; token: string | undefined }): string | null {
  if (input.rbacMode !== "enforce") {
    return "Refusing to start: FACTORY_RBAC_MODE is not \"enforce\". In shadow mode every permission check allows, so Claude would read and draft everything. Set FACTORY_RBAC_MODE=enforce for the factory.";
  }
  if (input.journalMode !== "wal") {
    return `Refusing to start: the factory database is not in WAL mode (journal_mode=${input.journalMode ?? "unknown"}). A third process on a non-WAL file risks corrupting it.`;
  }
  if (!looksLikeToken(input.token)) {
    return "Refusing to start: FACTORY_MCP_TOKEN is missing or not a factory token. Create one in Settings › Integrations › Claude and put it in the Claude configuration on this machine.";
  }
  return null;
}

/** Why another draft is refused today, or null. */
export function draftCapRefusal(usedToday: number, cap = DAILY_DRAFT_CAP): string | null {
  return usedToday >= cap
    ? `This Claude connection has made ${usedToday} drafts today, the most it may make in a day (${cap}). It can draft again tomorrow; the factory app is not limited.`
    : null;
}

/** The start of the server's local day: the daily cap counts from here. */
export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** A sliding one-minute window per token. */
export class MinuteRate {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly limit = CALLS_PER_MINUTE) {}

  /** True when the call may go ahead (and is counted); false when the token is over its minute. */
  take(key: string, now: number): boolean {
    const recent = (this.calls.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.limit) {
      this.calls.set(key, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(key, recent);
    return true;
  }
}
