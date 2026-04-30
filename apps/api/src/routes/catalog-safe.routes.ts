import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import { logger } from "../utils/logger.js";

/**
 * Supplemental catalog routes that are NOT covered by catalog.routes.ts.
 * Registered with prefix '/api/catalog'. Keep this file minimal — every route
 * here must be unique (i.e. not redeclared in catalog.routes.ts) to avoid
 * Fastify FST_ERR_DUPLICATED_ROUTE crashes at boot.
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

  logger.info("Catalog safe routes registered");
}
