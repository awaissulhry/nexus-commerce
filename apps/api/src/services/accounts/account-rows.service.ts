/**
 * MCP full control P3 — the account rows (MAP.1 / CX.1), read in one place: GET /api/accounts (accounts.routes.ts)
 * and Claude's `channel-connections` read call `listAccountRows`; PATCH /api/accounts/:id answers with `toAccountRow`.
 *
 * Moved from the route without a change in behaviour (account-rows.service.vitest.test.ts holds the route's answers
 * byte for byte). Why health is never a function of token expiry, and why `markets` is empty until connection
 * metadata names them: see the header of accounts.routes.ts.
 *
 * A row carries no credential: the connections are read through CONNECTION_PUBLIC_SELECT, which names none.
 */

import prisma from "../../db.js";
import { isOwnConnection, listManagedConnections, type ConnectionRow as ChannelConnection } from "../connection-resolver.service.js";
import { scopeDriftOf, tryGetChannelSpec, channelKeyOf } from "../cx/catalog.js";
import { connectionLabel } from "../connection-label.js";

export type Channel = "AMAZON" | "AMAZON_ADS" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY";

/** Xavia's operational scope (`project_active_channels`): Amazon + eBay + Shopify. */
const ACTIVE_CHANNELS: Channel[] = ["AMAZON", "EBAY", "SHOPIFY"];
const CHANNEL_ORDER: Record<string, number> = {
  AMAZON: 0,
  // CX.3a — next to Amazon, because that is where the operator looks for it.
  AMAZON_ADS: 0.5,
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
   *   • Amazon — `displayName` is the raw merchant id (e.g. "AFXSELLER8BC38").
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
  isActive: boolean;
  sortOrder: number;
  /** The account's identity at the marketplace. NULL until MAP.4 captures eBay's. */
  externalAccountId: string | null;
  accountColor: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  // ── CX.1 — the connection core, all measured ────────────────────────────
  /** connected | degraded | needs_reauth | revoked | disconnected | unknown */
  authStatus: string;
  region: string | null;
  grantedScopes: string[];
  /** OAuth scopes, or roles approved on the channel application (Amazon SP-API). */
  permissionModel: "oauth_scopes" | "application_roles";
  /** Scopes the catalog wants that this grant lacks — non-empty means "Reconnect to grant new permissions". */
  scopeDrift: string[];
  /** Markets / marketplaces this grant reaches (ConnectionScope rows). */
  scopes: Array<{ kind: string; externalId: string; label: string | null; isActive?: boolean }>;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  lastRefreshAt: string | null;
  lastHeartbeatAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  identity: Record<string, unknown> | null;
}

/**
 * Health, from what we can actually measure. Deliberately NOT a function of
 * tokenExpiresAt — see the file header, decision 1.
 */
function deriveHealth(r: ChannelConnection): { health: Health; healthReason: string | null } {
  if (!r.isActive) return { health: "error", healthReason: "Connection is not active" };
  // CX.1 — the auth state machine is measured by the heartbeat and by every real
  // call; it outranks the last sync outcome because a sync can succeed on a token
  // that is one refresh away from dying, and can fail for reasons that are not auth.
  switch (r.authStatus) {
    case "needs_reauth":
      return { health: "error", healthReason: r.lastError ?? "Sign-in expired or was revoked — reconnect" };
    case "revoked":
      return { health: "error", healthReason: "Access was revoked at the channel — reconnect" };
    case "disconnected":
      return { health: "error", healthReason: "Disconnected" };
    case "degraded":
      return { health: "warn", healthReason: r.lastError ?? ` consecutive failures` };
    default:
      break;
  }
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

export function toAccountRow(
  r: ChannelConnection,
  isPrimary: boolean,
  scopes: Array<{ kind: string; externalId: string; label: string | null; isActive?: boolean }> = [],
): AccountRow {
  const spec = tryGetChannelSpec(channelKeyOf(r.channelType));
  return {
    id: r.id,
    channel: r.channelType as Channel,
    managedBy: r.managedBy ?? "oauth",
    ...connectionLabel(r),
    markets: readMarkets(r),
    ...deriveHealth(r),
    isPrimary,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    externalAccountId: r.externalAccountId,
    accountColor: r.accountColor,
    tokenExpiresAt: (r.tokenExpiresAt ?? r.ebayTokenExpiresAt)?.toISOString() ?? null,
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: r.lastSyncStatus,
    lastSyncError: r.lastSyncError,
    authStatus: r.authStatus,
    region: r.region,
    grantedScopes: r.grantedScopes,
    permissionModel: spec?.auth.permissionModel ?? "oauth_scopes",
    scopeDrift: spec ? scopeDriftOf(spec, r.grantedScopes) : [],
    scopes,
    accessTokenExpiresAt: r.accessTokenExpiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: r.refreshTokenExpiresAt?.toISOString() ?? null,
    lastRefreshAt: r.lastRefreshAt?.toISOString() ?? null,
    lastHeartbeatAt: r.lastHeartbeatAt?.toISOString() ?? null,
    lastInboundAt: r.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: r.lastOutboundAt?.toISOString() ?? null,
    lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
    lastError: r.lastError,
    consecutiveFailures: r.consecutiveFailures,
    identity: (r.identity as Record<string, unknown> | null) ?? null,
  };
}

function hasAnyChannelWithTwo(accounts: AccountRow[]): boolean {
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(a.channel, (counts.get(a.channel) ?? 0) + 1);
  return [...counts.values()].some((n) => n > 1);
}

/** The account list the top-right chip and Settings › Channels render. */
export interface AccountRowList {
  accounts: AccountRow[];
  /** Channels of Xavia's operational scope with no live account. */
  notConnected: Channel[];
  /** True when some channel has two accounts: the chip becomes a switcher. */
  canSwitch: boolean;
}

/**
 * The business's channel accounts: live ones, or every one when `includeDisconnected` (the route asks for that only
 * with business profiles on). An account another business shares with this one is listed and is never its primary.
 */
export async function listAccountRows({ includeDisconnected }: { includeDisconnected: boolean }): Promise<AccountRowList> {
  const rows = await listManagedConnections(includeDisconnected);

  // MAP.2a made isPrimary a real column, backfilled and constrained to one
  // true row per channelType by a partial unique index — so it is read, not
  // derived. Ordering honours the operator's sortOrder, primary first.
  // CX.1 — the markets / marketplaces each grant reaches, one query for the page.
  const scopeRows = rows.length
    ? await prisma.connectionScope.findMany({
        // EVERY scope, not just the live ones: an account that reaches nine Ads
        // profiles of which four are production reaches nine. Filtering to the
        // live ones under-reports the account's own reach; the label carries the
        // distinction ("· sandbox").
        where: { connectionId: { in: rows.map((r) => r.id) } },
        orderBy: [{ kind: "asc" }, { externalId: "asc" }],
        select: { connectionId: true, kind: true, externalId: true, label: true, isActive: true },
      })
    : [];
  const scopesByConnection = new Map<string, Array<{ kind: string; externalId: string; label: string | null; isActive?: boolean }>>();
  for (const s of scopeRows) {
    const list = scopesByConnection.get(s.connectionId) ?? [];
    list.push({ kind: s.kind, externalId: s.externalId, label: s.label, isActive: s.isActive });
    scopesByConnection.set(s.connectionId, list);
  }

  const accounts = rows
    // An account another business shares with this one is never this business's primary.
    .map((r) => toAccountRow(r, r.isPrimary && isOwnConnection(r), scopesByConnection.get(r.id) ?? []))
    .sort(
      (a, b) =>
        (CHANNEL_ORDER[a.channel] ?? 99) - (CHANNEL_ORDER[b.channel] ?? 99) ||
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.sortOrder - b.sortOrder ||
        a.label.localeCompare(b.label),
    );

  const connectedChannels = new Set(accounts.map((a) => a.channel));
  const notConnected = ACTIVE_CHANNELS.filter((c) => !connectedChannels.has(c));

  return {
    accounts,
    notConnected,
    // The chip uses this to decide whether it is a *switcher* or a *status
    // badge*. Today every channel has at most one account, so it is a badge
    // and renders no caret — a dropdown that cannot change anything is worse
    // than no dropdown. MAP.4 is what flips this to true.
    canSwitch: accounts.length > 0 && hasAnyChannelWithTwo(accounts),
  };
}
