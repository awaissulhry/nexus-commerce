/**
 * eBay Integration Routes
 * Handles eBay inventory sync, listing management, and order synchronization
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { ebaySyncService } from "../services/ebay-sync.service.js";
import { ebayAuthService } from "../services/ebay-auth.service.js";
import { ebayAccountService } from "../services/ebay-account.service.js";
import { EbayCategoryService } from "../services/ebay-category.service.js";
import { logger } from "../utils/logger.js";

const ebayCategoryService = new EbayCategoryService();

interface SyncInventoryBody {
  connectionId: string;
}

export async function ebayRoutes(app: FastifyInstance) {
  /**
   * POST /api/sync/ebay/inventory
   * Trigger eBay inventory sync for a specific connection
   * Fetches all active eBay listings and auto-matches them to Nexus products
   */
  app.post<{ Body: SyncInventoryBody }>(
    "/api/sync/ebay/inventory",
    async (request, reply) => {
      try {
        const { connectionId } = request.body;

        if (!connectionId) {
          return reply.status(400).send({
            success: false,
            error: "connectionId is required",
          });
        }

        // Verify connection exists and is active
        const connection = await prisma.channelConnection.findUnique({
          where: { id: connectionId },
        });

        if (!connection) {
          return reply.status(404).send({
            success: false,
            error: "ChannelConnection not found",
          });
        }

        if (!connection.isActive) {
          return reply.status(400).send({
            success: false,
            error: "eBay connection is not active",
          });
        }

        logger.info("Starting eBay inventory sync", { connectionId });

        // Execute sync
        const result = await ebaySyncService.syncEbayInventory(connectionId);

        // Update connection with sync status
        await prisma.channelConnection.update({
          where: { id: connectionId },
          data: {
            lastSyncAt: new Date(),
            lastSyncStatus: result.status,
            lastSyncError: result.errors.length > 0 ? result.errors[0].error : null,
          },
        });

        logger.info("eBay inventory sync completed", {
          syncId: result.syncId,
          status: result.status,
          listingsFetched: result.listingsFetched,
          listingsMatched: result.listingsMatched,
          listingsCreated: result.listingsCreated,
          listingsUpdated: result.listingsUpdated,
        });

        return reply.send({
          success: result.status === "SUCCESS",
          syncId: result.syncId,
          status: result.status,
          summary: {
            listingsFetched: result.listingsFetched,
            listingsMatched: result.listingsMatched,
            listingsUnmatched: result.listingsUnmatched,
            listingsCreated: result.listingsCreated,
            listingsUpdated: result.listingsUpdated,
            errorCount: result.errors.length,
          },
          matches: result.matches,
          errors: result.errors,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("eBay inventory sync failed", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /api/sync/ebay/inventory/:connectionId
   * Get sync status for a connection
   */
  app.get<{ Params: { connectionId: string } }>(
    "/api/sync/ebay/inventory/:connectionId",
    async (request, reply) => {
      try {
        const { connectionId } = request.params;

        const connection = await prisma.channelConnection.findUnique({
          where: { id: connectionId },
        });

        if (!connection) {
          return reply.status(404).send({
            success: false,
            error: "ChannelConnection not found",
          });
        }

        return reply.send({
          success: true,
          connection: {
            id: connection.id,
            isActive: connection.isActive,
            lastSyncAt: connection.lastSyncAt,
            lastSyncStatus: connection.lastSyncStatus,
            lastSyncError: connection.lastSyncError,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error fetching sync status", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /api/sync/ebay/listings/:connectionId
   * Get all VariantChannelListings for an eBay connection
   */
  app.get<{ Params: { connectionId: string } }>(
    "/api/sync/ebay/listings/:connectionId",
    async (request, reply) => {
      try {
        const { connectionId } = request.params;

        const listings = await prisma.variantChannelListing.findMany({
          where: {
            channelConnectionId: connectionId,
          },
          include: {
            variant: {
              include: {
                product: true,
              },
            },
          },
          orderBy: {
            lastSyncedAt: "desc",
          },
        });

        return reply.send({
          success: true,
          count: listings.length,
          listings: listings.map((listing) => ({
            id: listing.id,
            variantId: listing.variantId,
            productName: listing.variant.product?.name,
            productSku: listing.variant.product?.sku,
            externalListingId: listing.externalListingId,
            externalSku: listing.externalSku,
            listingUrl: listing.listingUrl,
            listingStatus: listing.listingStatus,
            currentPrice: listing.currentPrice,
            quantity: listing.quantity,
            quantitySold: listing.quantitySold,
            lastSyncedAt: listing.lastSyncedAt,
            lastSyncStatus: listing.lastSyncStatus,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error fetching eBay listings", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /api/sync/ebay/unmatched/:connectionId
   * Get unmatched eBay listings (for manual mapping)
   */
  app.get<{ Params: { connectionId: string } }>(
    "/api/sync/ebay/unmatched/:connectionId",
    async (request, reply) => {
      try {
        const { connectionId } = request.params;

        // Get all listings for this connection
        const listings = await prisma.variantChannelListing.findMany({
          where: {
            channelConnectionId: connectionId,
          },
          include: {
            variant: {
              include: {
                product: true,
              },
            },
          },
        });

        // Filter for unmatched (those without a variant or product)
        const unmatched = listings.filter(
          (listing) => !listing.variant || !listing.variant.product
        );

        return reply.send({
          success: true,
          count: unmatched.length,
          unmatched: unmatched.map((listing) => ({
            id: listing.id,
            externalListingId: listing.externalListingId,
            externalSku: listing.externalSku,
            listingUrl: listing.listingUrl,
            listingStatus: listing.listingStatus,
            currentPrice: listing.currentPrice,
            quantity: listing.quantity,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error fetching unmatched listings", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /api/sync/ebay/listings/:listingId/link
   * Manually link an eBay listing to a Nexus product
   */
  app.post<{
    Params: { listingId: string };
    Body: { variantId: string };
  }>("/api/sync/ebay/listings/:listingId/link", async (request, reply) => {
    try {
      const { listingId } = request.params;
      const { variantId } = request.body;

      if (!variantId) {
        return reply.status(400).send({
          success: false,
          error: "variantId is required",
        });
      }

      // Verify variant exists
      const variant = await prisma.productVariation.findUnique({
        where: { id: variantId },
      });

      if (!variant) {
        return reply.status(404).send({
          success: false,
          error: "ProductVariation not found",
        });
      }

      // Update listing with variant
      const updated = await prisma.variantChannelListing.update({
        where: { id: listingId },
        data: {
          variantId,
        },
        include: {
          variant: {
            include: {
              product: true,
            },
          },
        },
      });

      logger.info("Manually linked eBay listing to product", {
        listingId,
        variantId,
        productId: variant.productId,
      });

      return reply.send({
        success: true,
        message: "Listing linked successfully",
        listing: {
          id: updated.id,
          variantId: updated.variantId,
          productName: updated.variant?.product?.name,
          externalListingId: updated.externalListingId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Error linking eBay listing", { error: message });
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * DD.3 — GET /api/ebay/pull-listing
   * Mirror of the Amazon "pull from channel" flow on the edit page.
   * Picks the active EBAY ChannelConnection, exchanges credentials for a
   * valid OAuth token, then fetches the inventory item by SKU via the
   * eBay Inventory API. Returns a normalised summary the UI surfaces in
   * its status bar.
   *
   * Query: ?sku=XXX&marketplace=YY
   * marketplace param is informational here — eBay's Inventory API is
   * seller-account-scoped, but we keep it for parity with Amazon and so
   * future per-marketplace branches (e.g. category-tree resolution) can
   * key off it.
   */
  app.get<{ Querystring: { sku?: string; marketplace?: string } }>(
    "/api/ebay/pull-listing",
    async (request, reply) => {
      const sku = request.query.sku?.trim();
      if (!sku) {
        return reply.status(400).send({
          success: false,
          error: "sku is required",
        });
      }

      try {
        // Pick the first active eBay connection. v1 assumes one seller
        // account per workspace; multi-account support keys off
        // marketplace/connectionId once that lands.
        const connection = await prisma.channelConnection.findFirst({
          where: { channelType: "EBAY", isActive: true },
          orderBy: { updatedAt: "desc" },
        });
        if (!connection) {
          return reply.status(400).send({
            success: false,
            error: "No active eBay connection — link an eBay account first.",
          });
        }

        const token = await ebayAuthService.getValidToken(connection.id);
        const apiBase = process.env.EBAY_API_BASE ?? "https://api.ebay.com";
        const res = await fetch(
          `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Accept-Language": "en-US",
            },
          },
        );

        if (res.status === 404) {
          return reply.send({
            success: true,
            found: false,
            message: `No eBay inventory item with SKU "${sku}".`,
          });
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          logger.warn("eBay pull-listing non-OK", {
            status: res.status,
            sku,
            body: body.slice(0, 500),
          });
          return reply.status(502).send({
            success: false,
            error: `eBay API ${res.status}: ${body.slice(0, 200)}`,
          });
        }

        const item = (await res.json().catch(() => null)) as {
          sku?: string;
          product?: {
            title?: string;
            description?: string;
            aspects?: Record<string, string[]>;
            imageUrls?: string[];
          };
          availability?: {
            shipToLocationAvailability?: { quantity?: number };
          };
          condition?: string;
        } | null;

        return reply.send({
          success: true,
          found: true,
          summary: {
            sku: item?.sku ?? sku,
            title: item?.product?.title ?? null,
            description: item?.product?.description ?? null,
            quantity:
              item?.availability?.shipToLocationAvailability?.quantity ?? null,
            condition: item?.condition ?? null,
            imageUrls: item?.product?.imageUrls ?? [],
            aspects: item?.product?.aspects ?? {},
          },
          marketplace: request.query.marketplace ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error pulling eBay listing", { error: message, sku });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    },
  );

  /**
   * HH — GET /api/ebay/diagnostics
   * Quick health check: Does an eBay connection exist? Can we get a
   * usable token? Does a sample Taxonomy call work? Used by Settings
   * + future surfacing in the wizard's Step 1 platform card so users
   * can self-diagnose missing creds without reading server logs.
   *
   * Query: ?marketplaceId=EBAY_IT (defaults to EBAY_IT for the smoke
   * test). Doesn't write anything.
   */
  app.get<{ Querystring: { marketplaceId?: string } }>(
    "/api/ebay/diagnostics",
    async (request, reply) => {
      const marketplaceId = request.query.marketplaceId?.trim() || "EBAY_IT";
      const result: {
        marketplaceId: string;
        connection: {
          present: boolean;
          isActive: boolean;
          tokenOk: boolean;
          tokenError?: string;
        };
        envCredentials: {
          appIdSet: boolean;
          certIdSet: boolean;
          looksLikePlaceholder: boolean;
        };
        sampleSearch: {
          ok: boolean;
          itemCount?: number;
          error?: string;
        };
        recommendation: string;
      } = {
        marketplaceId,
        connection: {
          present: false,
          isActive: false,
          tokenOk: false,
        },
        envCredentials: {
          appIdSet: false,
          certIdSet: false,
          looksLikePlaceholder: false,
        },
        sampleSearch: { ok: false },
        recommendation: "",
      };

      // Connection state
      try {
        const conn = await prisma.channelConnection.findFirst({
          where: { channelType: "EBAY" },
          orderBy: { updatedAt: "desc" },
        });
        result.connection.present = !!conn;
        result.connection.isActive = !!conn?.isActive;
        if (conn?.isActive && conn.ebayAccessToken && conn.ebayRefreshToken) {
          try {
            await ebayAuthService.getValidToken(conn.id);
            result.connection.tokenOk = true;
          } catch (err) {
            result.connection.tokenError =
              err instanceof Error ? err.message : String(err);
          }
        }
      } catch (err) {
        result.connection.tokenError =
          err instanceof Error ? err.message : String(err);
      }

      // Env credentials state
      const appId = process.env.EBAY_APP_ID;
      const certId = process.env.EBAY_CERT_ID;
      result.envCredentials.appIdSet = !!appId && appId.length > 0;
      result.envCredentials.certIdSet = !!certId && certId.length > 0;
      result.envCredentials.looksLikePlaceholder =
        appId === "your_app_id" ||
        certId === "your_cert_id" ||
        (!!appId && appId.length < 8) ||
        (!!certId && certId.length < 8);

      // Sample Taxonomy call — uses the same token path the wizard
      // hits, so a green here means the wizard will work too.
      try {
        const items = await ebayCategoryService.searchCategories(
          marketplaceId.replace(/^EBAY_/, ""),
          "jacket",
          { throwOnError: true, limit: 3 },
        );
        result.sampleSearch.ok = true;
        result.sampleSearch.itemCount = items.length;
      } catch (err) {
        result.sampleSearch.ok = false;
        result.sampleSearch.error =
          err instanceof Error ? err.message : String(err);
      }

      // Pick the most actionable recommendation.
      if (result.sampleSearch.ok) {
        result.recommendation = "OK — eBay categories should fetch in the wizard.";
      } else if (
        !result.connection.tokenOk &&
        result.envCredentials.looksLikePlaceholder
      ) {
        result.recommendation =
          "Link an eBay account at /settings/channels (preferred) or set real EBAY_APP_ID + EBAY_CERT_ID env vars.";
      } else if (!result.connection.tokenOk) {
        result.recommendation =
          "Reconnect your eBay account at /settings/channels — current OAuth token cannot be refreshed.";
      } else if (result.connection.tokenOk) {
        result.recommendation =
          "Token is valid but Taxonomy API call failed — check eBay's status page and retry.";
      } else {
        result.recommendation =
          "Set EBAY_APP_ID + EBAY_CERT_ID, or link an eBay account at /settings/channels.";
      }

      return reply.send({ success: true, ...result });
    },
  );

  /**
   * GG.1 — GET /api/ebay/conditions
   * Live condition policy for a (marketplace, categoryId). UI uses
   * this to populate the condition dropdown at submit time so users
   * can't pick a condition the category rejects.
   *
   * Query: ?marketplaceId=EBAY_IT&categoryId=NNN
   */
  app.get<{
    Querystring: { marketplaceId?: string; categoryId?: string };
  }>("/api/ebay/conditions", async (request, reply) => {
    const marketplaceId = request.query.marketplaceId?.trim();
    const categoryId = request.query.categoryId?.trim();
    if (!marketplaceId || !categoryId) {
      return reply.status(400).send({
        success: false,
        error: "marketplaceId and categoryId are required",
      });
    }
    try {
      const conditions = await ebayCategoryService.getItemConditionPolicies(
        categoryId,
        marketplaceId,
      );
      return reply.send({ success: true, conditions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Error fetching eBay conditions", {
        error: message,
        marketplaceId,
        categoryId,
      });
      return reply.status(500).send({ success: false, error: message });
    }
  });

  /**
   * GG.2 — GET /api/ebay/policies
   * Live seller policies + locations from the Account API. Used
   * by Settings to let the user pick which policy to use, and by
   * the publish adapter as a fallback when
   * ChannelConnection.connectionMetadata.ebayPolicies is missing.
   *
   * Query: ?marketplaceId=EBAY_IT[&connectionId=XXX][&refresh=1]
   * connectionId optional — defaults to first active EBAY connection.
   */
  app.get<{
    Querystring: {
      marketplaceId?: string;
      connectionId?: string;
      refresh?: string;
    };
  }>("/api/ebay/policies", async (request, reply) => {
    const marketplaceId = request.query.marketplaceId?.trim();
    if (!marketplaceId) {
      return reply.status(400).send({
        success: false,
        error: "marketplaceId is required (e.g. EBAY_IT)",
      });
    }
    let connectionId = request.query.connectionId?.trim();
    try {
      if (!connectionId) {
        const connection = await prisma.channelConnection.findFirst({
          where: { channelType: "EBAY", isActive: true },
          orderBy: { updatedAt: "desc" },
        });
        if (!connection) {
          return reply.status(400).send({
            success: false,
            error: "No active eBay connection — link an eBay account first.",
          });
        }
        connectionId = connection.id;
      }
      const snapshot = await ebayAccountService.getSnapshot(
        connectionId,
        marketplaceId,
        { forceRefresh: request.query.refresh === "1" },
      );
      return reply.send({
        success: true,
        connectionId,
        marketplaceId,
        ...snapshot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Error fetching eBay policies", {
        error: message,
        connectionId,
        marketplaceId,
      });
      return reply.status(500).send({ success: false, error: message });
    }
  });

  // POST /api/ebay/financials/sync — pull eBay Sell Finances transactions
  // Body: { start?, end?, daysBack? }. Defaults to yesterday.
  app.post<{ Body?: { start?: string; end?: string; daysBack?: number } }>('/ebay/financials/sync', async (request, reply) => {
    const { syncEbayFinancialEvents, syncEbayYesterdayFinancials } = await import('../services/ebay-financial-events.service.js')
    try {
      const body = request.body ?? {}
      let summary
      if (body.start && body.end) {
        summary = await syncEbayFinancialEvents(new Date(body.start), new Date(body.end))
      } else if (typeof body.daysBack === 'number') {
        const end = new Date()
        summary = await syncEbayFinancialEvents(new Date(end.getTime() - body.daysBack * 86400000), end)
      } else {
        summary = await syncEbayYesterdayFinancials()
      }
      return reply.send({ success: true, ...summary })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[ebay/financials/sync] failed', { error: msg })
      return reply.code(500).send({ success: false, error: msg })
    }
  })
}
