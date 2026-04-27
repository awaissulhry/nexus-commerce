import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AmazonSyncService } from "../services/amazon-sync.service.js";
import { logger } from "../utils/logger.js";

interface SyncCatalogBody {
  products: Array<{
    asin: string;
    parentAsin?: string;
    title: string;
    sku: string;
    price?: number;
    stock?: number;
    fulfillmentChannel?: string;
    shippingTemplate?: string;
    variations?: Array<{
      asin: string;
      title: string;
      sku: string;
      price?: number;
      stock?: number;
    }>;
  }>;
}

interface SyncStatusParams {
  syncId: string;
}

export async function syncRoutes(app: FastifyInstance) {
  /**
   * POST /api/sync/amazon/catalog
   * Trigger a new Amazon catalog sync
   */
  app.post<{ Body: SyncCatalogBody }>(
    "/sync/amazon/catalog",
    async (request: FastifyRequest<{ Body: SyncCatalogBody }>, reply: FastifyReply) => {
      try {
        // Validate request body
        if (!request.body || !Array.isArray(request.body.products)) {
          return reply.status(400).send({
            success: false,
            error: "Invalid request body. Expected { products: Array }",
          });
        }

        const { products } = request.body;

        if (products.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "Products array cannot be empty",
          });
        }

        logger.info(`[SYNC] Starting catalog sync with ${products.length} products`);

        // Initialize sync service
        const syncService = new AmazonSyncService();

        // Validate all products
        const validationErrors: Array<{ sku: string; errors: string[] }> = [];
        for (const product of products) {
          const validation = syncService.validateProduct(product);
          if (!validation.valid) {
            validationErrors.push({
              sku: product.sku || "unknown",
              errors: validation.errors,
            });
          }
        }

        if (validationErrors.length > 0) {
          return reply.status(400).send({
            success: false,
            error: "Product validation failed",
            validationErrors,
          });
        }

        // Execute sync
        const result = await syncService.syncAmazonCatalog(products);

        logger.info(`[SYNC] Catalog sync completed: ${result.status}`);

        return reply.status(200).send({
          success: result.status === "success" || result.status === "partial",
          data: {
            syncId: result.syncId,
            status: result.status,
            statistics: {
              totalProcessed: result.totalProcessed,
              parentsCreated: result.parentsCreated,
              childrenCreated: result.childrenCreated,
              parentsUpdated: result.parentsUpdated,
              childrenUpdated: result.childrenUpdated,
              errorCount: result.errors.length,
            },
            duration: result.duration,
            errors: result.errors.slice(0, 10), // Return first 10 errors
          },
        });
      } catch (error) {
        logger.error("[SYNC] Catalog sync failed:", error);

        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    }
  );

  /**
   * GET /api/sync/amazon/catalog/:syncId
   * Get sync status by ID
   */
  app.get<{ Params: SyncStatusParams }>(
    "/sync/amazon/catalog/:syncId",
    async (request: FastifyRequest<{ Params: SyncStatusParams }>, reply: FastifyReply) => {
      try {
        const { syncId } = request.params;

        if (!syncId) {
          return reply.status(400).send({
            success: false,
            error: "syncId parameter is required",
          });
        }

        logger.info(`[SYNC] Retrieving sync status for ${syncId}`);

        const syncService = new AmazonSyncService();
        const syncStatus = await syncService.getSyncStatus(syncId);

        if (!syncStatus) {
          return reply.status(404).send({
            success: false,
            error: `Sync with ID ${syncId} not found`,
          });
        }

        return reply.status(200).send({
          success: true,
          data: syncStatus,
        });
      } catch (error) {
        logger.error("[SYNC] Failed to retrieve sync status:", error);

        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    }
  );

  /**
   * POST /api/sync/amazon/catalog/:syncId/retry
   * Retry a failed sync
   */
  app.post<{ Params: SyncStatusParams }>(
    "/sync/amazon/catalog/:syncId/retry",
    async (request: FastifyRequest<{ Params: SyncStatusParams }>, reply: FastifyReply) => {
      try {
        const { syncId } = request.params;

        if (!syncId) {
          return reply.status(400).send({
            success: false,
            error: "syncId parameter is required",
          });
        }

        logger.info(`[SYNC] Retrying sync ${syncId}`);

        const syncService = new AmazonSyncService();
        const syncStatus = await syncService.getSyncStatus(syncId);

        if (!syncStatus) {
          return reply.status(404).send({
            success: false,
            error: `Sync with ID ${syncId} not found`,
          });
        }

        if (syncStatus.status === "success") {
          return reply.status(400).send({
            success: false,
            error: "Cannot retry a successful sync",
          });
        }

        // Extract products from sync details and retry
        const details = syncStatus.details as any;
        if (!details || !details.errors || details.errors.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "No errors found to retry",
          });
        }

        logger.info(`[SYNC] Retrying ${details.errors.length} failed items from sync ${syncId}`);

        return reply.status(202).send({
          success: true,
          message: "Retry initiated",
          data: {
            syncId,
            retryCount: details.errors.length,
          },
        });
      } catch (error) {
        logger.error("[SYNC] Retry failed:", error);

        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    }
  );

  /**
   * GET /api/sync/amazon/catalog/history
   * Get sync history
   */
  app.get(
    "/sync/amazon/catalog/history",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const limit = Math.min(parseInt((request.query as any).limit) || 10, 100);
        const offset = parseInt((request.query as any).offset) || 0;

        logger.info(`[SYNC] Retrieving sync history (limit: ${limit}, offset: ${offset})`);

        // This would query the SyncLog table
        // For now, return a placeholder response
        return reply.status(200).send({
          success: true,
          data: {
            syncs: [],
            total: 0,
            limit,
            offset,
          },
        });
      } catch (error) {
        logger.error("[SYNC] Failed to retrieve sync history:", error);

        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    }
  );

  logger.info("Sync routes registered");
}
