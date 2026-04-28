/**
 * eBay Integration Routes
 * Handles eBay inventory sync, listing management, and order synchronization
 */

import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { ebaySyncService } from "../services/ebay-sync.service.js";
import { logger } from "../utils/logger.js";

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
}
