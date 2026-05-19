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
import { writeSettingsAudit } from "../utils/settings-audit.js";

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

  // ── Phase F.2 — per-channel deep detail ─────────────────────────
  // Surfaces the data the redesigned /settings/channels/[type] page
  // needs in one round-trip: the full connection row, parsed
  // metadata (scopes + activeMarketplaces, both optional), and the
  // last 50 inbound webhook events for that channel.
  fastify.get<{ Params: { type: string } }>(
    "/settings/channels/:type/detail",
    async (request, reply) => {
      try {
        const channel = request.params.type.toUpperCase() as Channel;
        if (!ALL_CHANNELS.includes(channel)) {
          return reply.code(400).send({ error: `Unknown channel: ${channel}` });
        }
        // Pick the freshest connection for this channel (active wins,
        // then updatedAt — mirrors the GET /connections ordering).
        const rows = await prisma.channelConnection.findMany({
          where: {
            channelType: channel,
            OR: [{ managedBy: "oauth" }, { managedBy: "env" }],
          },
          orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
          take: 1,
        });
        const row = rows[0];
        const connection = row ? toConnectionRow(row) : pendingRow(channel);

        // connectionMetadata is a free-form JSON column; we read two
        // optional keys here. Anything else (per-channel adapter
        // diagnostics, e.g.) stays untouched.
        const meta = (row?.connectionMetadata ?? {}) as Record<string, unknown>;
        const scopes = Array.isArray(meta.scopes)
          ? meta.scopes.filter((s): s is string => typeof s === "string")
          : [];
        const activeMarketplaces = Array.isArray(meta.activeMarketplaces)
          ? meta.activeMarketplaces.filter(
              (s): s is string => typeof s === "string",
            )
          : [];

        // Last 50 inbound webhook events for this channel — used to
        // populate the "Recent webhook events" table.
        const events = await prisma.webhookEvent.findMany({
          where: { channel },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            eventType: true,
            externalId: true,
            isProcessed: true,
            processedAt: true,
            error: true,
            createdAt: true,
          },
        });
        // Cheap rollup over the same set so the UI can show a
        // "success rate over the last 50 events" chip without a
        // separate query.
        const stats = events.reduce(
          (acc, e) => {
            if (e.isProcessed && !e.error) acc.success++;
            else if (e.error) acc.failed++;
            else acc.pending++;
            return acc;
          },
          { success: 0, failed: 0, pending: 0 },
        );

        return {
          connection,
          scopes,
          activeMarketplaces,
          // Per-channel diagnostics namespaced under `meta` so the
          // UI can render an "Advanced" details block without us
          // having to enumerate every adapter's quirks here.
          meta: row?.connectionMetadata ?? null,
          recentEvents: events.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            externalId: e.externalId,
            isProcessed: e.isProcessed,
            processedAt: e.processedAt?.toISOString() ?? null,
            error: e.error,
            createdAt: e.createdAt.toISOString(),
          })),
          eventStats: { ...stats, total: events.length },
        };
      } catch (err: any) {
        logger.error("GET /api/settings/channels/:type/detail failed", {
          error: err?.message ?? String(err),
        });
        return reply.code(500).send({ error: err?.message ?? String(err) });
      }
    },
  );

  // ── Phase F.3 — per-marketplace toggle ──────────────────────────
  // Updates connectionMetadata.activeMarketplaces. We deliberately
  // store this in the JSON column rather than a new schema column —
  // it's lightweight, doesn't need indexed query, and avoids another
  // migration this session. Channel-specific guardrails:
  //   • Amazon EU marketplaces: IT, DE, FR, ES, UK
  //   • eBay EU marketplaces:   IT, DE, FR, ES, UK
  //   • Shopify: single-store, marketplaces concept doesn't apply
  //     — endpoint accepts the call but persists an empty array.
  fastify.patch<{
    Params: { type: string };
    Body: { marketplaces?: string[] };
  }>("/settings/channels/:type/marketplaces", async (request, reply) => {
    try {
      const channel = request.params.type.toUpperCase() as Channel;
      if (!ALL_CHANNELS.includes(channel)) {
        return reply.code(400).send({ error: `Unknown channel: ${channel}` });
      }
      const incoming = Array.isArray(request.body?.marketplaces)
        ? request.body!.marketplaces!
        : [];
      const allowed = ALLOWED_MARKETPLACES[channel] ?? [];
      // Normalise (uppercase, dedupe) + reject unknown values up
      // front so we never write garbage to the JSON column.
      const next = Array.from(
        new Set(incoming.map((m) => String(m).toUpperCase())),
      );
      const invalid = next.filter((m) => !allowed.includes(m));
      if (invalid.length > 0) {
        return reply.code(400).send({
          error: `Unsupported marketplaces for ${channel}: ${invalid.join(", ")}. Allowed: ${allowed.join(", ") || "(none)"}.`,
        });
      }

      const existing = await prisma.channelConnection.findFirst({
        where: {
          channelType: channel,
          OR: [{ managedBy: "oauth" }, { managedBy: "env" }],
        },
        orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
      });
      if (!existing) {
        return reply.code(404).send({
          error: `No active connection for ${channel}. Connect the channel before scoping marketplaces.`,
        });
      }

      const meta = (existing.connectionMetadata ?? {}) as Record<string, unknown>;
      const before = Array.isArray(meta.activeMarketplaces)
        ? meta.activeMarketplaces
        : [];
      const updated = await prisma.channelConnection.update({
        where: { id: existing.id },
        data: {
          connectionMetadata: {
            ...meta,
            activeMarketplaces: next,
          },
        },
      });

      // Audit the marketplace scope change — operators may need to
      // explain "why didn't we publish to UK last week" later.
      await writeSettingsAudit({
        key: "company", // closest existing key; Phase G adds 'channels'
        action: "update",
        before: { [`${channel}.activeMarketplaces`]: before },
        after: { [`${channel}.activeMarketplaces`]: next },
        metadata: { event: "channel_marketplaces_updated", channel },
      });

      return {
        ok: true,
        connectionId: updated.id,
        channel,
        activeMarketplaces: next,
      };
    } catch (err: any) {
      logger.error("PATCH /api/settings/channels/:type/marketplaces failed", {
        error: err?.message ?? String(err),
      });
      return reply.code(500).send({ error: err?.message ?? String(err) });
    }
  });
};

// ── Per-channel marketplace allowlist ───────────────────────────────
// Mirrors the operator's "active channel scope" — IT primary, DE/FR/
// ES/UK supplementary. Single-store channels get an empty allowlist
// so the UI knows to render a "Marketplaces don't apply" message.
const ALLOWED_MARKETPLACES: Record<Channel, string[]> = {
  AMAZON: ["IT", "DE", "FR", "ES", "UK"],
  EBAY: ["IT", "DE", "FR", "ES", "UK"],
  SHOPIFY: [],
  WOOCOMMERCE: [],
  ETSY: [],
};

export default connectionsRoutes;
