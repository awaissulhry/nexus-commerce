/**
 * MAP.3 — the connection resolver.
 *
 * One function decides which marketplace account a piece of work belongs to, and
 * it is **fail-closed**: when more than one account is active for a channel and
 * the caller has not said which one it means, it throws. It never picks.
 *
 * That rule is the whole point of the phase. The 60 sites this replaces all did
 * some variant of:
 *
 *     prisma.channelConnection.findFirst({
 *       where: { channelType: 'EBAY', isActive: true },
 *       orderBy: { updatedAt: 'desc' },
 *     })
 *
 * `orderBy: updatedAt desc` silently selects **the most recently touched account**.
 * With one account that is correct by accident. With two it is a coin flip that
 * lands a push in the wrong store, and — because `AdTarget.updatedAt`-style sync
 * heartbeats bump rows constantly (`reference_updatedat_is_a_sync_heartbeat`) —
 * the coin is not even weighted the way the author imagined. Ambiguity has to be a
 * loud, early failure instead of a quiet mis-push.
 *
 * While exactly one account is active per channel — today's state, and every state
 * until MAP.4 — every scope form returns that one row, so converting a call site
 * is behaviour-preserving and can be verified on prod before a second account
 * exists for anything to go wrong on.
 *
 * ── Channel-agnostic by requirement ───────────────────────────────────────────
 * Per the operator's decision 1 (2026-08-19), nothing here hard-codes a channel.
 * `channel` is always a parameter. Adding Amazon multi-account later must cost one
 * connect flow and no changes to this file.
 */

import type { ChannelConnection } from "@prisma/client";
import prisma from "../db.js";

/** Thrown when the scope does not identify one account and more than one is live. */
export class AmbiguousConnectionError extends Error {
  readonly code = "AMBIGUOUS_CONNECTION";
  constructor(
    readonly channel: string,
    readonly candidateIds: string[],
    hint?: string,
  ) {
    super(
      `Ambiguous ${channel} connection: ${candidateIds.length} accounts are active and the caller did not name one. ` +
        `Pass an explicit scope (accountId, listingId, itemId, orderId, or { channel, primary: true }).` +
        (hint ? ` ${hint}` : ""),
    );
    this.name = "AmbiguousConnectionError";
  }
}

/** Thrown when nothing matches the scope at all. */
export class NoConnectionError extends Error {
  readonly code = "NO_CONNECTION";
  constructor(message: string) {
    super(message);
    this.name = "NoConnectionError";
  }
}

/**
 * How a caller says which account it means.
 *
 * The forms fall into three groups:
 *   • NAMED     — the caller already holds the id.
 *   • DERIVED   — the account is recoverable from a row the caller holds
 *                 (a listing, an eBay ItemID, an order). Preferred: it cannot
 *                 drift, because it reads the same attribution MAP.2a backfilled.
 *   • DECLARED  — `{ channel, primary: true }`. For genuinely ambient work that
 *                 has no row to derive from. It is deliberately verbose and
 *                 greppable: it states "the primary account for this channel",
 *                 which is a claim someone can audit, rather than "whichever row
 *                 findFirst returned", which is not.
 */
export type ConnectionScope =
  /** NAMED — the connection id itself. */
  | { accountId: string }
  /** DERIVED — a ChannelListing row. */
  | { listingId: string }
  /** DERIVED — a VariantChannelListing row. */
  | { variantListingId: string }
  /** DERIVED — an eBay ItemID, via SharedListingMembership. */
  | { itemId: string; marketplace?: string }
  /** DERIVED — an Order (our id, or the marketplace's). */
  | { orderId: string }
  | { channel: string; channelOrderId: string }
  /** DECLARED — the channel's primary account, stated on purpose. */
  | { channel: string; primary: true };

function isPrimaryScope(s: ConnectionScope): s is { channel: string; primary: true } {
  return "primary" in s && s.primary === true;
}

/**
 * The decision, as a pure function — no database, so it is directly testable.
 *
 * `candidates` is the set of ACTIVE connections that could serve the scope.
 * Returns the one to use, or throws. Exported for tests and for callers that have
 * already loaded their candidates (a job iterating accounts, say).
 */
export function chooseConnection(
  candidates: Pick<ChannelConnection, "id" | "channelType" | "isActive" | "isPrimary">[],
  opts: { channel: string; wantPrimary?: boolean; hint?: string },
): Pick<ChannelConnection, "id" | "channelType" | "isActive" | "isPrimary"> {
  const active = candidates.filter((c) => c.isActive && c.channelType === opts.channel);

  if (active.length === 0) {
    throw new NoConnectionError(
      `No active ${opts.channel} connection.${opts.hint ? ` ${opts.hint}` : ""}`,
    );
  }
  if (active.length === 1) return active[0]!;

  // More than one account is live. Only an explicit request for the primary is
  // allowed to proceed — and only if exactly one row claims to be primary, which
  // ChannelConnection_channelType_primary_key enforces at the database.
  if (opts.wantPrimary) {
    const primaries = active.filter((c) => c.isPrimary);
    if (primaries.length === 1) return primaries[0]!;
    throw new AmbiguousConnectionError(
      opts.channel,
      active.map((c) => c.id),
      primaries.length === 0
        ? "No account is marked primary for this channel."
        : `${primaries.length} accounts claim to be primary.`,
    );
  }

  throw new AmbiguousConnectionError(opts.channel, active.map((c) => c.id), opts.hint);
}

/** Every active connection for a channel, in the operator's own order. */
export async function listActiveConnections(channel: string): Promise<ChannelConnection[]> {
  return prisma.channelConnection.findMany({
    where: { channelType: channel, isActive: true },
    orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

async function byId(id: string, whatFor: string): Promise<ChannelConnection> {
  const row = await prisma.channelConnection.findUnique({ where: { id } });
  if (!row) throw new NoConnectionError(`ChannelConnection ${id} not found (${whatFor}).`);
  if (!row.isActive) {
    throw new NoConnectionError(
      `ChannelConnection ${id} is not active (${whatFor}). Reconnect the account before using it.`,
    );
  }
  return row;
}

/**
 * Resolve the connection a scope names.
 *
 * Derived forms read the attribution MAP.2a backfilled, so they answer with the
 * account that actually owns the row. If that attribution is missing — a row
 * written before the backfill by a path MAP.3 has not converted yet — the derived
 * form falls back to the channel's single active account, and throws the moment
 * there is more than one. That is the fail-closed rule doing its job rather than
 * a gap: an unattributed row genuinely does not know which store it belongs to.
 */
export async function resolveConnection(scope: ConnectionScope): Promise<ChannelConnection> {
  if ("accountId" in scope) return byId(scope.accountId, "explicit accountId");

  if ("listingId" in scope) {
    const row = await prisma.channelListing.findUnique({
      where: { id: scope.listingId },
      select: { channel: true, channelConnectionId: true },
    });
    if (!row) throw new NoConnectionError(`ChannelListing ${scope.listingId} not found.`);
    if (row.channelConnectionId) return byId(row.channelConnectionId, `listing ${scope.listingId}`);
    return resolveDeclared(row.channel, `ChannelListing ${scope.listingId} has no account attribution.`);
  }

  if ("variantListingId" in scope) {
    const row = await prisma.variantChannelListing.findUnique({
      where: { id: scope.variantListingId },
      select: { channel: true, channelConnectionId: true },
    });
    if (!row) throw new NoConnectionError(`VariantChannelListing ${scope.variantListingId} not found.`);
    if (row.channelConnectionId) return byId(row.channelConnectionId, `variant listing ${scope.variantListingId}`);
    if (!row.channel) throw new NoConnectionError(`VariantChannelListing ${scope.variantListingId} has no channel.`);
    return resolveDeclared(row.channel, `VariantChannelListing ${scope.variantListingId} has no account attribution.`);
  }

  if ("itemId" in scope) {
    // An eBay ItemID is globally unique, so marketplace is an optional narrowing
    // rather than part of the key.
    const row = await prisma.sharedListingMembership.findFirst({
      where: {
        itemId: scope.itemId,
        ...(scope.marketplace ? { marketplace: scope.marketplace } : {}),
      },
      select: { channelConnectionId: true },
    });
    if (!row) throw new NoConnectionError(`No SharedListingMembership for itemId ${scope.itemId}.`);
    if (row.channelConnectionId) return byId(row.channelConnectionId, `itemId ${scope.itemId}`);
    return resolveDeclared("EBAY", `Item ${scope.itemId} has no account attribution.`);
  }

  if ("orderId" in scope) {
    const row = await prisma.order.findUnique({
      where: { id: scope.orderId },
      select: { channel: true, channelConnectionId: true },
    });
    if (!row) throw new NoConnectionError(`Order ${scope.orderId} not found.`);
    if (row.channelConnectionId) return byId(row.channelConnectionId, `order ${scope.orderId}`);
    return resolveDeclared(String(row.channel), `Order ${scope.orderId} has no account attribution.`);
  }

  if ("channelOrderId" in scope) {
    const row = await prisma.order.findFirst({
      where: { channel: scope.channel as never, channelOrderId: scope.channelOrderId },
      select: { channel: true, channelConnectionId: true },
    });
    if (!row) {
      throw new NoConnectionError(
        `No ${scope.channel} order with channelOrderId ${scope.channelOrderId}.`,
      );
    }
    if (row.channelConnectionId) return byId(row.channelConnectionId, `order ${scope.channelOrderId}`);
    return resolveDeclared(scope.channel, `Order ${scope.channelOrderId} has no account attribution.`);
  }

  if (isPrimaryScope(scope)) return resolveDeclared(scope.channel);

  throw new NoConnectionError(`Unrecognised connection scope: ${JSON.stringify(scope)}`);
}

/** The channel's single active account, or its primary when several are live. */
async function resolveDeclared(channel: string, hint?: string): Promise<ChannelConnection> {
  const active = await listActiveConnections(channel);
  const chosen = chooseConnection(active, { channel, wantPrimary: true, hint });
  return active.find((c) => c.id === chosen.id)!;
}

/**
 * Resolve, or `null`.
 *
 * For the many call sites whose existing contract is to DEGRADE rather than throw
 * — "no active eBay connection" already meant `return summary` / `return 'failed'`
 * / skip the tick. Converting those to a throwing resolver would turn a graceful
 * no-op into an exception, which is a behaviour change MAP.3 has no business
 * making while it is meant to be invisible.
 *
 * ⚠ Use it only with a scope that CANNOT be ambiguous — a NAMED or DERIVED scope,
 * or `{ channel, primary: true }` (the database allows exactly one primary per
 * channel). Passing an ambiguity-capable scope here would swallow the very
 * refusal this phase exists to create, so there is no such scope form.
 */
export async function tryResolveConnection(
  scope: ConnectionScope,
): Promise<ChannelConnection | null> {
  try {
    return await resolveConnection(scope);
  } catch {
    return null;
  }
}

/**
 * The primary connection id for each of several channels, resolved in ONE query.
 *
 * For loops that upsert many rows across a small set of channels — a bulk market
 * toggle over 50 products, say. Resolving inside the loop would be N round-trips
 * for an answer that cannot change during it.
 *
 * A channel with no active connection maps to `null`, which is a legitimate value:
 * the unique indexes are declared NULLS NOT DISTINCT, so unattributed rows still
 * collide with each other exactly as they did before the account column existed.
 */
export async function primaryConnectionIds(
  channels: string[],
): Promise<Map<string, string | null>> {
  const wanted = [...new Set(channels)];
  const rows = await prisma.channelConnection.findMany({
    where: { channelType: { in: wanted }, isActive: true },
    orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, channelType: true, isActive: true, isPrimary: true },
  });
  const out = new Map<string, string | null>();
  for (const channel of wanted) {
    try {
      out.set(channel, chooseConnection(rows, { channel, wantPrimary: true }).id);
    } catch {
      // No active account for this channel — null, not a throw. These callers are
      // writing a row, not calling the marketplace, and a DRAFT listing for a
      // channel nobody has connected yet is a legitimate thing to store.
      out.set(channel, null);
    }
  }
  return out;
}

// ── Connect-flow lookups ─────────────────────────────────────────────────────
// These do not resolve an account for WORK — they ask what the account set
// already contains, during OAuth. They live here rather than in the auth route so
// there is one place that knows how to look an account up, and so the MAP.3
// ratchet stays honest: a direct `channelConnection.findFirst` in the callback is
// indistinguishable, to the audit, from the singleton assumption being reintroduced.

/**
 * The active account for a channel with this marketplace identity, if any.
 *
 * The re-consent case: an operator reconnecting an account we already hold must
 * refresh that row, not mint a second one for the same seller.
 */
export async function findAccountByExternalId(
  channel: string,
  externalAccountId: string,
  excludeConnectionId?: string,
): Promise<ChannelConnection | null> {
  return prisma.channelConnection.findFirst({
    where: {
      channelType: channel,
      isActive: true,
      externalAccountId,
      ...(excludeConnectionId ? { NOT: { id: excludeConnectionId } } : {}),
    },
  });
}

/**
 * How many active accounts on this channel have NO marketplace identity.
 *
 * Admitting a second one would leave two accounts nobody can tell apart — which
 * `ChannelConnection_active_account_key` refuses at the database anyway. Asking
 * here lets the connect flow say so in words, before the operator has consented.
 */
export async function countUnidentifiedAccounts(channel: string): Promise<number> {
  return prisma.channelConnection.count({
    where: { channelType: channel, isActive: true, externalAccountId: null },
  });
}

/** Convenience for the many callers that only need the id to pass downstream. */
export async function resolveConnectionId(scope: ConnectionScope): Promise<string> {
  return (await resolveConnection(scope)).id;
}
