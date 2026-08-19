/**
 * MAP.0 / MAP.1 — accounts.
 *
 * Two read-only endpoints:
 *
 *   GET /api/accounts              the list the top-right account chip renders
 *   GET /api/accounts/diagnostics  MAP.0's proof of the current single-account state
 *
 * Why this exists alongside `/api/connections`: that endpoint deliberately
 * collapses to ONE row per channel (`connections.routes.ts` — "Keep one row per
 * channel — first wins") and pads missing channels with `pending` placeholders.
 * That shape is correct for the settings grid and wrong for an account switcher,
 * which must be able to show two eBay accounts side by side. Rather than change a
 * contract `ChannelsClient` depends on, accounts get their own uncollapsed read.
 *
 * Neither endpoint writes anything.
 *
 * ── Two measured decisions that shaped this file ──────────────────────────
 *
 * 1. **Health is derived from `lastSyncStatus` only, never from token expiry.**
 *    `EbayAuthService.getValidToken` (`ebay-auth.service.ts:228`) refreshes any
 *    access token within 5 minutes of expiry, on demand. eBay access tokens live
 *    ~2 hours, so `tokenExpiresAt` is *always* imminent — measured on prod
 *    2026-08-19, the healthy eBay row expired in under two hours. A
 *    "token expiring soon" rule would paint a working account amber forever.
 *    The field is still returned so the settings page can show it; it just does
 *    not drive the dot.
 *
 * 2. **`markets` comes only from `connectionMetadata.activeMarketplaces`, and is
 *    empty today.** Measured on prod: `connectionMetadata` is NULL on all 11 rows.
 *    Falling back to the per-channel allowlist would render five market badges
 *    that nothing configured — the `reference_fleet_stale_constant_class` defect
 *    this phase exists to retire. An empty array means the UI renders nothing.
 */

import type { FastifyPluginAsync } from "fastify";
import type { ChannelConnection } from "@prisma/client";
import prisma from "../db.js";
import { logger } from "../utils/logger.js";
import { listActiveConnections } from "../services/connection-resolver.service.js";

type Channel = "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY";

/** Xavia's operational scope (`project_active_channels`): Amazon + eBay + Shopify. */
const ACTIVE_CHANNELS: Channel[] = ["AMAZON", "EBAY", "SHOPIFY"];
const CHANNEL_ORDER: Record<string, number> = {
  AMAZON: 0,
  EBAY: 1,
  SHOPIFY: 2,
  WOOCOMMERCE: 3,
  ETSY: 4,
};

type Health = "ok" | "warn" | "error" | "unknown";

export interface AccountRow {
  id: string;
  channel: Channel;
  managedBy: string;
  /** Best human name available. See `labelIsPlaceholder`. */
  label: string;
  /** Where `label` came from — so the UI never implies more identity than we hold. */
  labelSource: "accountLabel" | "storeName" | "displayName" | "signInName" | "sellerId" | "channel";
  /**
   * True when the label is not a real account name. Two known cases, both measured:
   *   • eBay  — `ebay-auth.service.ts:451` writes the literal "eBay seller (verified)"
   *             because the OAuth scope in use carries no identity claim.
   *   • Amazon — `displayName` is the raw merchant id (e.g. "A1VRHKTGYO1JNU").
   * MAP.2a shipped `accountLabel` for exactly this: set it and the label becomes
   * the operator's own name. Until someone does, the UI shows what we actually
   * hold and marks it, rather than inventing a friendlier name.
   */
  labelIsPlaceholder: boolean;
  /** Empty until something populates connectionMetadata.activeMarketplaces. */
  markets: string[];
  health: Health;
  healthReason: string | null;
  isPrimary: boolean;
  sortOrder: number;
  /** The account's identity at the marketplace. NULL until MAP.4 captures eBay's. */
  externalAccountId: string | null;
  accountColor: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

const EBAY_PLACEHOLDER_LABELS = new Set(["eBay seller (verified)", "eBay seller"]);
/** Amazon merchant ids look like A1VRHKTGYO1JNU — 12-16 uppercase alphanumerics starting with A. */
const AMAZON_MERCHANT_ID = /^A[A-Z0-9]{9,19}$/;

function deriveLabel(r: ChannelConnection): Pick<AccountRow, "label" | "labelSource" | "labelIsPlaceholder"> {
  const channel = r.channelType as Channel;
  // MAP.2a — the operator's own name for the account wins over anything the
  // channel gave us, because neither channel gives us a usable one.
  const own = r.accountLabel?.trim();
  if (own) return { label: own, labelSource: "accountLabel", labelIsPlaceholder: false };

  const storeName = r.ebayStoreName?.trim();
  if (storeName) return { label: storeName, labelSource: "storeName", labelIsPlaceholder: false };

  const displayName = r.displayName?.trim();
  const signIn = r.ebaySignInName?.trim();
  const candidate = displayName || signIn;
  if (candidate) {
    const isPlaceholder =
      EBAY_PLACEHOLDER_LABELS.has(candidate) ||
      (channel === "AMAZON" && AMAZON_MERCHANT_ID.test(candidate));
    return {
      label: candidate,
      labelSource: displayName
        ? channel === "AMAZON" && AMAZON_MERCHANT_ID.test(candidate)
          ? "sellerId"
          : "displayName"
        : "signInName",
      labelIsPlaceholder: isPlaceholder,
    };
  }
  // Nothing at all — name it by its channel rather than rendering an empty chip.
  return { label: channel, labelSource: "channel", labelIsPlaceholder: true };
}

/**
 * Health, from what we can actually measure. Deliberately NOT a function of
 * tokenExpiresAt — see the file header, decision 1.
 */
function deriveHealth(r: ChannelConnection): { health: Health; healthReason: string | null } {
  if (!r.isActive) return { health: "error", healthReason: "Connection is not active" };
  switch (r.lastSyncStatus) {
    case "SUCCESS":
      return { health: "ok", healthReason: null };
    case "PARTIAL":
      return { health: "warn", healthReason: r.lastSyncError ?? "Last sync completed partially" };
    case "FAILED":
      return { health: "error", healthReason: r.lastSyncError ?? "Last sync failed" };
    default:
      // null status — the connection exists and is active but has never reported.
      // "unknown", not "ok": a green dot on an unmeasured connection is the lie
      // the two hard-coded TopBar chips were telling.
      return { health: "unknown", healthReason: "No sync has been reported yet" };
  }
}

function readMarkets(r: ChannelConnection): string[] {
  const meta = (r.connectionMetadata ?? {}) as Record<string, unknown>;
  return Array.isArray(meta.activeMarketplaces)
    ? meta.activeMarketplaces.filter((m): m is string => typeof m === "string")
    : [];
}

function toAccountRow(r: ChannelConnection, isPrimary: boolean): AccountRow {
  return {
    id: r.id,
    channel: r.channelType as Channel,
    managedBy: r.managedBy ?? "oauth",
    ...deriveLabel(r),
    markets: readMarkets(r),
    ...deriveHealth(r),
    isPrimary,
    sortOrder: r.sortOrder,
    externalAccountId: r.externalAccountId,
    accountColor: r.accountColor,
    tokenExpiresAt: (r.tokenExpiresAt ?? r.ebayTokenExpiresAt)?.toISOString() ?? null,
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: r.lastSyncStatus,
    lastSyncError: r.lastSyncError,
  };
}

/** Rows that reference an account — what disconnecting it would orphan. */
async function blastRadius(connectionId: string) {
  const [listings, variantListings, memberships, orders, policies, campaigns] = await Promise.all([
    prisma.channelListing.count({ where: { channelConnectionId: connectionId } }),
    prisma.variantChannelListing.count({ where: { channelConnectionId: connectionId } }),
    prisma.sharedListingMembership.count({ where: { channelConnectionId: connectionId } }),
    prisma.order.count({ where: { channelConnectionId: connectionId } }),
    prisma.syncChannelPolicy.count({ where: { channelConnectionId: connectionId } }),
    prisma.ebayCampaign.count({ where: { channelConnectionId: connectionId } }).catch(() => 0),
  ]);
  return { listings, variantListings, memberships, orders, policies, campaigns };
}

const accountsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── MAP.1 — the chip's source ────────────────────────────────────
  fastify.get("/accounts", async (_request, reply) => {
    try {
      // ACTIVE rows only. Measured on prod 2026-08-19: 11 rows exist, 9 of them
      // revoked eBay grants from the reconnect history. Those are not accounts
      // the operator is "using", and listing them would make the panel unreadable.
      // /accounts/diagnostics reports the full population.
      const rows = await prisma.channelConnection.findMany({
        where: { isActive: true, OR: [{ managedBy: "oauth" }, { managedBy: "env" }] },
        orderBy: [{ channelType: "asc" }, { isPrimary: "desc" }, { sortOrder: "asc" }, { updatedAt: "desc" }],
      });

      // MAP.2a made isPrimary a real column, backfilled and constrained to one
      // true row per channelType by a partial unique index — so it is read, not
      // derived. Ordering honours the operator's sortOrder, primary first.
      const accounts = rows
        .map((r) => toAccountRow(r, r.isPrimary))
        .sort(
          (a, b) =>
            (CHANNEL_ORDER[a.channel] ?? 99) - (CHANNEL_ORDER[b.channel] ?? 99) ||
            Number(b.isPrimary) - Number(a.isPrimary) ||
            a.sortOrder - b.sortOrder ||
            a.label.localeCompare(b.label),
        );

      const connectedChannels = new Set(accounts.map((a) => a.channel));
      const notConnected = ACTIVE_CHANNELS.filter((c) => !connectedChannels.has(c));

      return reply.send({
        success: true,
        accounts,
        notConnected,
        // The chip uses this to decide whether it is a *switcher* or a *status
        // badge*. Today every channel has at most one account, so it is a badge
        // and renders no caret — a dropdown that cannot change anything is worse
        // than no dropdown. MAP.4 is what flips this to true.
        canSwitch: accounts.length > 0 && hasAnyChannelWithTwo(accounts),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("GET /api/accounts failed", { error: message });
      return reply.status(500).send({ success: false, error: message });
    }
  });

  // ── MAP.0 — the proof ────────────────────────────────────────────
  // Read-only. Answers "can a second account exist today, and if not, what
  // exactly is stopping it" with measurements rather than assertions.
  fastify.get("/accounts/diagnostics", async (_request, reply) => {
    try {
      const rows = await prisma.channelConnection.findMany({
        orderBy: [{ channelType: "asc" }, { isActive: "desc" }, { updatedAt: "desc" }],
      });

      const byChannel = new Map<
        string,
        { total: number; active: number; managedBy: Record<string, number> }
      >();
      for (const r of rows) {
        const e =
          byChannel.get(r.channelType) ?? { total: 0, active: 0, managedBy: {} as Record<string, number> };
        e.total++;
        if (r.isActive) e.active++;
        const m = r.managedBy ?? "oauth";
        e.managedBy[m] = (e.managedBy[m] ?? 0) + 1;
        byChannel.set(r.channelType, e);
      }

      // The blocker, read from the live catalog rather than from the migration
      // file. `indexname`/`indexdef` are pg `name` columns — they must be cast
      // to text or Prisma fails to deserialise them (P2010).
      const indexes = await prisma.$queryRaw<Array<{ name: string; def: string }>>`
        SELECT indexname::text AS name, indexdef::text AS def
        FROM pg_indexes
        WHERE tablename = 'ChannelConnection'
        ORDER BY indexname
      `;
      const singleton = indexes.find((i) => i.name === "ChannelConnection_channelType_marketplace_active_key");

      return reply.send({
        success: true,
        measuredAt: new Date().toISOString(),
        totals: {
          rows: rows.length,
          active: rows.filter((r) => r.isActive).length,
          inactive: rows.filter((r) => !r.isActive).length,
        },
        byChannel: Object.fromEntries(byChannel),
        singletonIndex: {
          present: !!singleton,
          name: singleton?.name ?? null,
          definition: singleton?.def ?? null,
          // While this index exists, a second ACTIVE connection for a channel
          // fails with P2002 at the end of the OAuth callback — after the
          // operator has already consented at the marketplace. MAP.2 drops it.
          blocksSecondActiveAccount: !!singleton,
        },
        indexes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("GET /api/accounts/diagnostics failed", { error: message });
      return reply.status(500).send({ success: false, error: message });
    }
  });
  // ── MAP.4 — what disconnecting this account would affect ─────────
  fastify.get<{ Params: { id: string } }>("/accounts/:id/blast-radius", async (request, reply) => {
    const row = await prisma.channelConnection.findUnique({ where: { id: request.params.id } });
    if (!row) return reply.code(404).send({ success: false, error: "Account not found" });
    const counts = await blastRadius(row.id);
    return reply.send({
      success: true,
      accountId: row.id,
      channel: row.channelType,
      isPrimary: row.isPrimary,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    });
  });

  // ── MAP.4 — the operator's own name, colour and ordering ─────────
  fastify.patch<{
    Params: { id: string };
    Body: { accountLabel?: string | null; accountColor?: string | null; sortOrder?: number };
  }>("/accounts/:id", async (request, reply) => {
    const { accountLabel, accountColor, sortOrder } = request.body ?? {};
    const row = await prisma.channelConnection.findUnique({ where: { id: request.params.id } });
    if (!row) return reply.code(404).send({ success: false, error: "Account not found" });

    // A colour drives an identity chip, so it has to be a colour — an arbitrary
    // string here would end up interpolated into a style attribute.
    if (accountColor != null && accountColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(accountColor)) {
      return reply.code(400).send({ success: false, error: "accountColor must be #rrggbb" });
    }

    const updated = await prisma.channelConnection.update({
      where: { id: row.id },
      data: {
        ...(accountLabel !== undefined ? { accountLabel: accountLabel?.trim() || null } : {}),
        ...(accountColor !== undefined ? { accountColor: accountColor || null } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
      },
    });
    return reply.send({ success: true, account: toAccountRow(updated, updated.isPrimary) });
  });

  // ── MAP.4 — which account a channel defaults to ──────────────────
  fastify.post<{ Params: { id: string } }>("/accounts/:id/primary", async (request, reply) => {
    const row = await prisma.channelConnection.findUnique({ where: { id: request.params.id } });
    if (!row) return reply.code(404).send({ success: false, error: "Account not found" });
    if (!row.isActive) {
      return reply.code(409).send({ success: false, error: "A disconnected account cannot be primary" });
    }

    // Order matters. `ChannelConnection_channelType_primary_key` is a partial
    // unique index on (channelType) WHERE isPrimary — so the outgoing primary
    // must be cleared BEFORE the incoming one is set, or the second write
    // collides with the first. Both in one transaction so a failure between them
    // cannot leave the channel with no primary at all, which is a state the
    // resolver's DECLARED scope would refuse to work with.
    await prisma.$transaction([
      prisma.channelConnection.updateMany({
        where: { channelType: row.channelType, isPrimary: true },
        data: { isPrimary: false },
      }),
      prisma.channelConnection.update({ where: { id: row.id }, data: { isPrimary: true } }),
    ]);

    logger.info("MAP.4 primary account changed", { channel: row.channelType, accountId: row.id });
    return reply.send({ success: true });
  });

  // ── MAP.4 — disconnect, without destroying anything ──────────────
  fastify.post<{ Params: { id: string } }>("/accounts/:id/disconnect", async (request, reply) => {
    const row = await prisma.channelConnection.findUnique({ where: { id: request.params.id } });
    if (!row) return reply.code(404).send({ success: false, error: "Account not found" });

    // Through the resolver, like every other "what accounts exist" question — a
    // direct findFirst/count here is indistinguishable, to the MAP.3 audit, from
    // the singleton assumption coming back. (Also avoids Prisma's `NOT` dropping
    // NULL rows, per reference_prisma_not_excludes_null.)
    const siblings = (await listActiveConnections(row.channelType)).filter(
      (c) => c.id !== row.id,
    ).length;
    if (row.isPrimary && siblings > 0) {
      return reply.code(409).send({
        success: false,
        error:
          "This is the primary account for its channel. Make another account primary first, " +
          "so ambient work has somewhere to go.",
        code: "PRIMARY_ACCOUNT",
      });
    }

    // Deactivate; never delete. The rows that reference it (MAP.2a attributed
    // them) keep their attribution, so history still says which account it came
    // from — the FKs are ON DELETE SET NULL precisely so a delete could not
    // quietly erase that, and this path does not delete at all.
    // Tokens for OTHER accounts are untouched (feedback_preserve_sensitive_config).
    await prisma.channelConnection.update({
      where: { id: row.id },
      data: { isActive: false, isPrimary: false, lastSyncStatus: "FAILED", lastSyncError: "Disconnected by operator" },
    });

    logger.info("MAP.4 account disconnected", { channel: row.channelType, accountId: row.id });
    return reply.send({ success: true, blastRadius: await blastRadius(row.id) });
  });
};

function hasAnyChannelWithTwo(accounts: AccountRow[]): boolean {
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(a.channel, (counts.get(a.channel) ?? 0) + 1);
  return [...counts.values()].some((n) => n > 1);
}

export default accountsRoutes;
