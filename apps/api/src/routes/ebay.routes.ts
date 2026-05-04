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
}
