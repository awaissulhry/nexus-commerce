/**
 * Unified channel-connections endpoint.
 *
 * Single source of truth for the /settings/channels page and the
 * sidebar's per-channel status dot. Returns one row per supported
 * channel:
 *
 *   - eBay rows come from the ChannelConnection table (one row per
 *     OAuth grant; the most recent active row wins).
 *   - Amazon is synthesised from env vars (AMAZON_LWA_CLIENT_ID,
 *     AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AWS_*) until
 *     P2-2 ships per-account LWA OAuth. The synthetic row uses a
 *     stable id of `env:AMAZON` and `isManagedBy: 'env'` so the UI
 *     can disable Disconnect.
 *   - Shopify, WooCommerce, Etsy: not yet implemented — their entries
 *     report `isActive: false` and `isManagedBy: 'pending'` so the
 *     UI shows "Not connected" without false-claiming env support.
 *
 * The contract is intentionally a flat list of typed rows rather
 * than a per-channel object: the FE iterates a fixed list of channel
 * cards and matches by `channel`, so a flat list keeps both the
 * server and client logic boring.
 */

import type { FastifyPluginAsync } from "fastify";
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

/**
 * Synthesise an Amazon connection row from env vars.
 *
 * SP-API access uses an LWA refresh token that doesn't expire (eBay
 * tokens last 18 months and rotate; LWA refresh tokens last forever
 * unless the seller revokes the grant). So `tokenExpiresAt` is null
 * for the synthetic row — there's nothing to count down to.
 *
 * `createdAt` / `updatedAt` are pegged to the API process start time
 * so the row is stable across requests within a single deploy. The
 * UI doesn't render these for env-managed rows but the type contract
 * requires them.
 */
const PROCESS_START = new Date().toISOString();

function synthesiseAmazonRow(): ConnectionRow {
  const isConfigured = !!(
    process.env.AMAZON_LWA_CLIENT_ID &&
    process.env.AMAZON_LWA_CLIENT_SECRET &&
    process.env.AMAZON_REFRESH_TOKEN &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_ROLE_ARN
  );

  // AMAZON_SELLER_ID is the human-meaningful identifier of the
  // connected Seller Central account. AMAZON_MERCHANT_ID is an
  // older alias still set in some environments.
  const sellerId =
    process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? null;

  return {
    id: "env:AMAZON",
    channel: "AMAZON",
    isActive: isConfigured,
    isManagedBy: "env",
    sellerName: sellerId,
    storeName: null,
    storeFrontUrl: null,
    tokenExpiresAt: null,
    lastSyncAt: null,
    lastSyncStatus: isConfigured ? "SUCCESS" : null,
    lastSyncError: isConfigured
      ? null
      : "Amazon credentials not configured (AMAZON_LWA_* and AWS_* env vars required)",
    createdAt: PROCESS_START,
    updatedAt: PROCESS_START,
  };
}

/**
 * Pick the eBay row to surface to the UI when multiple
 * ChannelConnection rows exist for channelType=EBAY. Active rows
 * win over inactive; within a tie, most recent updatedAt wins.
 * Returns null if there are no eBay rows at all.
 */
async function loadEbayRow(): Promise<ConnectionRow | null> {
  const rows = await prisma.channelConnection.findMany({
    where: { channelType: "EBAY" },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    take: 1,
  });
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    channel: "EBAY",
    isActive: r.isActive,
    isManagedBy: "oauth",
    sellerName: r.ebaySignInName,
    storeName: r.ebayStoreName,
    storeFrontUrl: r.ebayStoreFrontUrl,
    tokenExpiresAt: r.ebayTokenExpiresAt?.toISOString() ?? null,
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: r.lastSyncStatus,
    lastSyncError: r.lastSyncError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

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
      const ebay = await loadEbayRow();

      const rows: ConnectionRow[] = [
        synthesiseAmazonRow(),
        ebay ?? pendingRow("EBAY"),
        pendingRow("SHOPIFY"),
        pendingRow("WOOCOMMERCE"),
        pendingRow("ETSY"),
      ];

      return reply.send({
        success: true,
        connections: rows,
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
