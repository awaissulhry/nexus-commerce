/**
 * FS5 — FTS5 query layer (S-13): escaped MATCH building + bounded id lookups
 * over the FTS5 substrate (migration `fs5_fts`; tables are declared
 * externally-managed in prisma.config.ts). Every helper returns entity IDS
 * only — callers hydrate through Prisma so RBAC filtering, archived checks
 * and response shapes stay where they already live (api/search, and the
 * Inbox `?q=` once EPI adopts `searchMessageConversationIds`).
 *
 * Safety model: user text NEVER reaches SQL — it is folded into a quoted
 * FTS5 phrase-prefix string (`"tok"* "tok2"*`, implicit AND) and BOUND as a
 * parameter; the SQL text itself is the fixed grammar in FTS_SQL (exported
 * so the unit suite executes the exact same strings against a real FTS5
 * database). Quoting neutralizes every FTS5 operator (AND/OR/NOT/NEAR,
 * parens, ^, :, *, -); embedded double quotes are doubled per FTS5 escaping.
 *
 * Availability: helpers are only called after `ftsAvailable()` — a cached
 * sqlite_master probe — so the ⌘K route keeps its LIKE path as a working
 * fallback until the Owner applies the migration (playbook 6b: authored,
 * not applied). Once seen available it stays available for the process.
 */
import { prisma } from "@/lib/db";

const MAX_TOKENS = 8; // bounds MATCH cost; nobody types 9 meaningful ⌘K terms
const MAX_TOKEN_LEN = 64;
const MAX_LIMIT = 50;

/**
 * Fold free text into a safe FTS5 MATCH expression: whitespace-split tokens,
 * each double-quote-escaped and wrapped as a phrase-prefix (`"tok"*`), joined
 * by implicit AND. Tokens with no letter/number content are dropped (they
 * cannot match anything — unicode61 treats them as separators — and an empty
 * phrase is an FTS5 syntax error). Returns null when nothing searchable
 * remains; callers must then return [] instead of querying.
 */
export function buildMatchQuery(q: string): string | null {
  const tokens = q
    .replace(/\u0000/g, " ")
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, MAX_TOKENS)
    .map((t) => `"${t.slice(0, MAX_TOKEN_LEN).replace(/"/g, '""')}"*`);
  return tokens.length ? tokens.join(" ") : null;
}

/**
 * The fixed SQL grammar, one string per entity — `?` params are always
 * (match, limit) except messageConversationIds (match, innerLimit, limit).
 * External-content tables are joined back to their source rows via rowid
 * inside a LIMIT-ed subquery (MATCH runs once, bounded, before the join);
 * party_fts carries its own party_id column (self-contained table).
 */
export const FTS_SQL = {
  conversationIds:
    'SELECT c."id" AS id FROM "Conversation" c JOIN (SELECT rowid, rank FROM conversation_fts WHERE conversation_fts MATCH ? ORDER BY rank LIMIT ?) f ON c.rowid = f.rowid ORDER BY f.rank',
  messageConversationIds:
    'SELECT DISTINCT m."conversationId" AS id FROM "Message" m JOIN (SELECT rowid, rank FROM message_fts WHERE message_fts MATCH ? ORDER BY rank LIMIT ?) f ON m.rowid = f.rowid LIMIT ?',
  partyIds: "SELECT party_id AS id FROM party_fts WHERE party_fts MATCH ? ORDER BY rank LIMIT ?",
  quoteIds:
    'SELECT q."id" AS id FROM "Quote" q JOIN (SELECT rowid, rank FROM quote_fts WHERE quote_fts MATCH ? ORDER BY rank LIMIT ?) f ON q.rowid = f.rowid ORDER BY f.rank',
  orderIds:
    'SELECT o."id" AS id FROM "Order" o JOIN (SELECT rowid, rank FROM order_fts WHERE order_fts MATCH ? ORDER BY rank LIMIT ?) f ON o.rowid = f.rowid ORDER BY f.rank',
} as const;

const FTS_TABLES = ["conversation_fts", "message_fts", "party_fts", "quote_fts", "order_fts"] as const;

const clampLimit = (n: number): number => Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number.isFinite(n) ? n : 1)));

let ftsKnownAvailable = false;
let lastProbeAt = 0;
const PROBE_TTL_MS = 60_000;

/**
 * True once all five FTS tables exist. Availability is sticky (tables are
 * never dropped in normal operation); a negative answer is re-probed at most
 * once a minute so the LIKE fallback costs one tiny sqlite_master read until
 * the migration lands, not one per keystroke.
 */
export async function ftsAvailable(): Promise<boolean> {
  if (ftsKnownAvailable) return true;
  const now = Date.now();
  if (now - lastProbeAt < PROBE_TTL_MS) return false;
  lastProbeAt = now;
  try {
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('conversation_fts', 'message_fts', 'party_fts', 'quote_fts', 'order_fts')`;
    ftsKnownAvailable = rows.length === FTS_TABLES.length;
  } catch {
    ftsKnownAvailable = false;
  }
  return ftsKnownAvailable;
}

async function idsFor(sql: string, q: string, limits: number[]): Promise<string[]> {
  const match = buildMatchQuery(q);
  if (!match) return [];
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(sql, match, ...limits);
  return rows.map((r) => r.id);
}

/** Conversations whose SUBJECT matches (bounded, rank-ordered). */
export function searchConversationIds(q: string, limit = 6): Promise<string[]> {
  return idsFor(FTS_SQL.conversationIds, q, [clampLimit(limit)]);
}

/**
 * Conversations whose MESSAGES (snippet/bodyText) match — distinct
 * conversation ids. The inner MATCH is oversampled 4× so several hits inside
 * one thread still leave `limit` distinct conversations. This is the helper
 * the Inbox `?q=` should adopt (EPI handoff — recorded, not wired here).
 */
export function searchMessageConversationIds(q: string, limit = 6): Promise<string[]> {
  const l = clampLimit(limit);
  return idsFor(FTS_SQL.messageConversationIds, q, [clampLimit(l * 4), l]);
}

/** Parties matching by name OR any of their emails (bounded, rank-ordered). */
export function searchPartyIds(q: string, limit = 6): Promise<string[]> {
  return idsFor(FTS_SQL.partyIds, q, [clampLimit(limit)]);
}

/** Quotes matching by number (bounded, rank-ordered). */
export function searchQuoteIds(q: string, limit = 6): Promise<string[]> {
  return idsFor(FTS_SQL.quoteIds, q, [clampLimit(limit)]);
}

/** Orders matching by number (bounded, rank-ordered). */
export function searchOrderIds(q: string, limit = 6): Promise<string[]> {
  return idsFor(FTS_SQL.orderIds, q, [clampLimit(limit)]);
}

/** Re-sort hydrated rows into FTS rank order (Prisma `IN` loses ordering). */
export function sortByIdOrder<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const rankOf = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (rankOf.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rankOf.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}
