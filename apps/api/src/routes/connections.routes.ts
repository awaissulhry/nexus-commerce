/**
 * Unified channel-connections endpoint.
 *
 * Reads directly from the ChannelConnection table for all connectors —
 * eBay grants are written by the OAuth callback flow, Amazon's
 * synthetic env-managed row is written by seedEnvManagedConnections()
 * on API startup (apps/api/src/index.ts). Shopify/Woo/Etsy don't have
 * adapters yet; we emit "pending" placeholder rows so the UI can
 * still render their cards.
 *
 * Generic-first read with legacy fallback: `displayName`/`tokenExpiresAt`/
 * `accessToken` came from the H.2 schema unification (2026-05-06) and
 * are populated by the same migration's backfill UPDATE plus the
 * dual-writes in ebay-auth.service.ts. The `r.ebay*` fallbacks remain
 * until the legacy columns are dropped in a follow-up migration.
 */

import type { FastifyPluginAsync } from "fastify";
import type { ChannelConnection } from "@prisma/client";
import prisma from "../db.js";
import { logger } from "../utils/logger.js";

type Channel = "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY";
type IsManagedBy = "oauth" | "env" | "pending";

interface ConnectionRow {
  id: string;
  channel: Channel;
  isActive: boolean;
  isManagedBy: IsManagedBy;
  sellerName: string | null;
  storeName: string | null;
  storeFrontUrl: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

const CHANNEL_ORDER: Record<Channel, number> = {
  AMAZON: 0,
  EBAY: 1,
  SHOPIFY: 2,
  WOOCOMMERCE: 3,
  ETSY: 4,
};
const ALL_CHANNELS: Channel[] = ["AMAZON", "EBAY", "SHOPIFY", "WOOCOMMERCE", "ETSY"];

/**
 * Convert a raw DB row to the API contract. Generic columns win;
 * legacy ebay* serve as fallbacks for fields the migration didn't
 * (or couldn't) backfill — e.g. ebayStoreName/ebayStoreFrontUrl were
 * never lifted to generic equivalents because they're eBay-specific.
 */
function toConnectionRow(r: ChannelConnection): ConnectionRow {
  const channel = r.channelType as Channel;
  const managed = (r.managedBy ?? "oauth") as IsManagedBy;
  return {
    id: r.id,
    channel,
    isActive: r.isActive,
    isManagedBy: managed,
    sellerName: r.displayName ?? r.ebaySignInName ?? null,
    storeName: r.ebayStoreName ?? null,
    storeFrontUrl: r.ebayStoreFrontUrl ?? null,
    tokenExpiresAt:
      (r.tokenExpiresAt ?? r.ebayTokenExpiresAt)?.toISOString() ?? null,
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: r.lastSyncStatus,
    lastSyncError: r.lastSyncError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const PROCESS_START = new Date().toISOString();

function pendingRow(channel: Channel): ConnectionRow {
  return {
    id: `pending:${channel}`,
    channel,
    isActive: false,
    isManagedBy: "pending",
    sellerName: null,
    storeName: null,
    storeFrontUrl: null,
    tokenExpiresAt: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: PROCESS_START,
    updatedAt: PROCESS_START,
  };
}

const connectionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/connections", async (_request, reply) => {
    try {
      // Pull every real row (oauth + env). Order: active first, then
      // most recently updated — handles the rare case where a channel
      // has multiple revoked rows alongside a fresh one.
      const rows = await prisma.channelConnection.findMany({
        where: {
          OR: [{ managedBy: "oauth" }, { managedBy: "env" }],
        },
        orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
      });

      // Keep one row per channel — first wins given the orderBy above.
      const byChannel = new Map<Channel, ConnectionRow>();
      for (const r of rows) {
        const channel = r.channelType as Channel;
        if (!byChannel.has(channel)) {
          byChannel.set(channel, toConnectionRow(r));
        }
      }

      // Pad missing channels with pending placeholders so the FE can
      // render a complete grid without per-channel branching.
      const result: ConnectionRow[] = ALL_CHANNELS.map(
        (c) => byChannel.get(c) ?? pendingRow(c),
      ).sort((a, b) => CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel]);

      return reply.send({
        success: true,
        connections: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("GET /api/connections failed", { error: message });
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
};

export default connectionsRoutes;
