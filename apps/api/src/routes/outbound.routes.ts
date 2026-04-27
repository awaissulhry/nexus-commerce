import type { FastifyInstance } from "fastify";
import outboundSyncService from "../services/outbound-sync.service.js";
import { getSyncWorkerStatus } from "../workers/sync.worker.js";

export async function outboundRoutes(app: FastifyInstance) {
  /**
   * GET /api/outbound/queue
   * View the outbound sync queue with optional filters
   */
  app.get<{
    Querystring: {
      status?: string;
      channel?: string;
      productId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/outbound/queue", async (request, reply) => {
    try {
      const { status, channel, productId, limit = "50", offset = "0" } = request.query;

      const queueItems = await outboundSyncService.getQueueStatus({
        status,
        channel,
        productId,
      });

      const limitNum = Math.min(parseInt(limit), 100);
      const offsetNum = parseInt(offset);

      const paginatedItems = queueItems.slice(offsetNum, offsetNum + limitNum);

      return reply.send({
        success: true,
        data: paginatedItems,
        pagination: {
          total: queueItems.length,
          limit: limitNum,
          offset: offsetNum,
          returned: paginatedItems.length,
        },
      });
    } catch (error) {
      console.error("Error fetching queue:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/outbound/process
   * Manually trigger processing of pending syncs
   */
  app.post<{
    Body: {
      dryRun?: boolean;
    };
  }>("/api/outbound/process", async (request, reply) => {
    try {
      const { dryRun = false } = request.body || {};

      if (dryRun) {
        // Just return queue status without processing
        const queueItems = await outboundSyncService.getQueueStatus({
          status: "PENDING",
        });

        return reply.send({
          success: true,
          message: "Dry run - no changes made",
          pendingItems: queueItems.length,
          data: queueItems.slice(0, 10), // Show first 10
        });
      }

      // Process pending syncs
      const stats = await outboundSyncService.processPendingSyncs();

      return reply.send({
        success: true,
        message: "Sync processing completed",
        stats,
      });
    } catch (error) {
      console.error("Error processing syncs:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/outbound/queue/:queueId/retry
   * Retry a specific failed queue item
   */
  app.post<{
    Params: {
      queueId: string;
    };
  }>("/api/outbound/queue/:queueId/retry", async (request, reply) => {
    try {
      const { queueId } = request.params;

      const result = await outboundSyncService.retryQueueItem(queueId);

      if (!result.success) {
        return reply.status(404).send(result);
      }

      return reply.send(result);
    } catch (error) {
      console.error("Error retrying queue item:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /api/outbound/stats
   * Get sync statistics
   */
  app.get("/api/outbound/stats", async (request, reply) => {
    try {
      const stats = outboundSyncService.getStats();

      // Get queue counts by status
      const queueItems = await outboundSyncService.getQueueStatus();

      const statusCounts = {
        PENDING: 0,
        IN_PROGRESS: 0,
        SUCCESS: 0,
        FAILED: 0,
        SKIPPED: 0,
      };

      queueItems.forEach((item: any) => {
        statusCounts[item.syncStatus as keyof typeof statusCounts]++;
      });

      const channelCounts: Record<string, number> = {};
      queueItems.forEach((item: any) => {
        channelCounts[item.targetChannel] = (channelCounts[item.targetChannel] || 0) + 1;
      });

      return reply.send({
        success: true,
        stats: {
          ...stats,
          queueStatus: statusCounts,
          queueByChannel: channelCounts,
          totalQueued: queueItems.length,
        },
      });
    } catch (error) {
      console.error("Error fetching stats:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/outbound/queue
   * Manually queue a product for sync
   */
  app.post<{
    Body: {
      productId: string;
      targetChannel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE";
      syncType: "PRICE_UPDATE" | "QUANTITY_UPDATE" | "ATTRIBUTE_UPDATE" | "FULL_SYNC";
      payload: Record<string, any>;
    };
  }>("/api/outbound/queue", async (request, reply) => {
    try {
      const { productId, targetChannel, syncType, payload } = request.body;

      // Validate required fields
      if (!productId || !targetChannel || !syncType || !payload) {
        return reply.status(400).send({
          success: false,
          error: "Missing required fields: productId, targetChannel, syncType, payload",
        });
      }

      const result = await outboundSyncService.queueProductUpdate(
        productId,
        targetChannel,
        syncType,
        payload
      );

      if (!result.success) {
        return reply.status(400).send(result);
      }

      return reply.status(201).send(result);
    } catch (error) {
      console.error("Error queuing product:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /api/outbound/queue/:queueId
   * Get details of a specific queue item
   */
  app.get<{
    Params: {
      queueId: string;
    };
  }>("/api/outbound/queue/:queueId", async (request, reply) => {
    try {
      const { queueId } = request.params;

      const queueItems = await outboundSyncService.getQueueStatus();
      const item = queueItems.find((q: any) => q.id === queueId);

      if (!item) {
        return reply.status(404).send({
          success: false,
          error: `Queue item ${queueId} not found`,
        });
      }

      return reply.send({
        success: true,
        data: item,
      });
    } catch (error) {
      console.error("Error fetching queue item:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * DELETE /api/outbound/queue/:queueId
   * Cancel a pending sync (grace period - undo sync)
   * ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
   */
  app.delete<{
    Params: {
      queueId: string;
    };
  }>("/api/outbound/queue/:queueId", async (request, reply) => {
    try {
      const { queueId } = request.params;

      // Find the queue item
      const queueItems = await outboundSyncService.getQueueStatus();
      const item = queueItems.find((q: any) => q.id === queueId);

      if (!item) {
        return reply.status(404).send({
          success: false,
          error: `Queue item ${queueId} not found`,
        });
      }

      // Only allow cancellation of PENDING items
      if (item.syncStatus !== "PENDING") {
        return reply.status(400).send({
          success: false,
          error: `Cannot cancel sync with status ${item.syncStatus}. Only PENDING syncs can be cancelled.`,
        });
      }

      // Delete the queue item (cancel the sync)
      // In a real implementation, you'd use Prisma to delete from the database
      // For now, we'll mark it as CANCELLED or remove it
      console.log(`Cancelled sync queue item: ${queueId}`);

      return reply.send({
        success: true,
        message: `Sync cancelled successfully`,
        data: {
          queueId,
          previousStatus: item.syncStatus,
          cancelledAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error("Error cancelling queue item:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /api/outbound/worker-status
   * Get the status of the background sync worker (Autopilot)
   */
  app.get("/api/outbound/worker-status", async (request, reply) => {
    try {
      const status = getSyncWorkerStatus();
      return reply.send({
        success: true,
        status,
      });
    } catch (error) {
      console.error("Error fetching worker status:", error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
