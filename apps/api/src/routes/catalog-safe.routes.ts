import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { importEbayCatalog, getEbayImportStats } from "../services/ebay-import.service.js";
import { logger } from "../utils/logger.js";

/**
 * Queue-free subset of catalog routes.
 * Contains only the import endpoints — no channelSyncQueue dependency.
 * Registered with prefix '/api/catalog'.
 */
export async function catalogSafeRoutes(app: FastifyInstance) {
  /**
   * POST /api/catalog/amazon/import
   * Returns the current count of Amazon-synced products already in the DB.
   * Full SP-API re-sync is handled separately via GET /api/amazon/products.
   */
  app.post("/amazon/import", async (_request, reply) => {
    try {
      logger.info("[AMAZON IMPORT] Counting Amazon-synced products…");

      const total = await prisma.product.count({
        where: { syncChannels: { has: "AMAZON" } },
      });

      logger.info(`[AMAZON IMPORT] Found ${total} Amazon-synced products`);

      return reply.status(200).send({
        success: true,
        data: { total },
        message: `${total} Amazon products are in your catalog. To pull fresh data from the SP-API use the dedicated sync endpoint.`,
      });
    } catch (error: any) {
      logger.error("[AMAZON IMPORT] Error:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "IMPORT_FAILED",
          message: error.message || "Failed to read Amazon catalog",
        },
      });
    }
  });

  /**
   * POST /api/catalog/ebay/import
   * Imports eBay catalog into the database.
   */
  app.post("/ebay/import", async (_request, reply) => {
    try {
      logger.info("[EBAY IMPORT] Starting import…");

      const result = await importEbayCatalog();

      logger.info("[EBAY IMPORT] Import complete:", result);

      return reply.status(201).send({
        success: true,
        data: {
          created: result.created,
          updated: result.updated,
          total: result.total,
          products: result.products,
        },
        message: `Successfully imported ${result.total} products from eBay (${result.created} created, ${result.updated} updated)`,
      });
    } catch (error: any) {
      logger.error("[EBAY IMPORT] Error:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "IMPORT_FAILED",
          message: error.message || "Failed to import eBay catalog",
        },
      });
    }
  });

  /**
   * GET /api/catalog/ebay/stats
   */
  app.get("/ebay/stats", async (_request, reply) => {
    try {
      const stats = await getEbayImportStats();
      return reply.status(200).send({ success: true, data: stats });
    } catch (error: any) {
      logger.error("[EBAY STATS] Error:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "STATS_FAILED",
          message: error.message || "Failed to get eBay import statistics",
        },
      });
    }
  });

  /**
   * DELETE /api/catalog/products/:id
   * Deletes a product from the database.
   */
  app.delete<{ Params: { id: string } }>("/products/:id", async (request, reply) => {
    try {
      const { id } = request.params;

      await prisma.product.delete({ where: { id } });

      return reply.status(200).send({
        success: true,
        message: `Product ${id} deleted`,
      });
    } catch (error: any) {
      logger.error("[DELETE PRODUCT] Error:", error);
      return reply.status(500).send({
        success: false,
        error: {
          code: "DELETE_FAILED",
          message: error.message || "Failed to delete product",
        },
      });
    }
  });

  logger.info("Catalog safe routes registered");
}
