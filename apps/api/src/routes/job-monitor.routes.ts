import type { FastifyInstance } from "fastify";
import { outboundSyncQueue, channelSyncQueue, getQueueStats } from "../lib/queue.js";
import { logger } from "../utils/logger.js";

export async function jobMonitorRoutes(app: FastifyInstance) {
  /**
   * GET /api/monitoring/queue-stats
   * Get current queue statistics
   */
  app.get("/api/monitoring/queue-stats", async (request, reply) => {
    try {
      const stats = await getQueueStats();

      if (!stats) {
        return reply.status(500).send({
          success: false,
          error: "Failed to get queue stats",
        });
      }

      return reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error("Error getting queue stats:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get queue stats",
      });
    }
  });

  /**
   * GET /api/monitoring/jobs
   * Get recent jobs from queue
   * Query params: limit, status
   */
  app.get<{
    Querystring: {
      limit?: string;
      status?: string;
    };
  }>("/api/monitoring/jobs", async (request, reply) => {
    try {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
      const status = request.query.status as
        | "waiting"
        | "active"
        | "completed"
        | "failed"
        | "delayed"
        | undefined;

      let jobs: any[] = [];

      if (status) {
        // Get jobs with specific status
        jobs = await outboundSyncQueue.getJobs([status as any], 0, limit - 1);
      } else {
        // Get all recent jobs
        const waiting = await outboundSyncQueue.getJobs(["waiting"], 0, Math.floor(limit / 2));
        const active = await outboundSyncQueue.getJobs(["active"], 0, Math.floor(limit / 2));
        jobs = [...active, ...waiting];
      }

      const formattedJobs = jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.getState?.() || "unknown",
        progress: typeof job.progress === "number" ? job.progress : 0,
        attempts: job.attemptsMade || 0,
        maxAttempts: job.opts?.attempts || 3,
        failedReason: job.failedReason || undefined,
        timestamp: job.timestamp || new Date(),
        duration: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined,
        queue: "outbound-sync",
      }));

      return reply.send({
        success: true,
        data: {
          jobs: formattedJobs,
          count: formattedJobs.length,
        },
      });
    } catch (error) {
      logger.error("Error getting jobs:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get jobs",
      });
    }
  });

  /**
   * POST /api/monitoring/jobs/:jobId/retry
   * Retry a failed job
   */
  app.post<{
    Params: {
      jobId: string;
    };
  }>("/api/monitoring/jobs/:jobId/retry", async (request, reply) => {
    try {
      const { jobId } = request.params;

      const job = await outboundSyncQueue.getJob(jobId);
      if (!job) {
        return reply.status(404).send({
          success: false,
          error: "Job not found",
        });
      }

      // Retry the job
      await job.retry();

      logger.info("Job retried", { jobId });

      return reply.send({
        success: true,
        message: `Job ${jobId} retried`,
      });
    } catch (error) {
      logger.error("Error retrying job:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to retry job",
      });
    }
  });

  /**
   * POST /api/monitoring/jobs/:jobId/cancel
   * Cancel an active job
   */
  app.post<{
    Params: {
      jobId: string;
    };
  }>("/api/monitoring/jobs/:jobId/cancel", async (request, reply) => {
    try {
      const { jobId } = request.params;

      const job = await outboundSyncQueue.getJob(jobId);
      if (!job) {
        return reply.status(404).send({
          success: false,
          error: "Job not found",
        });
      }

      // Cancel the job
      await job.remove();

      logger.info("Job canceled", { jobId });

      return reply.send({
        success: true,
        message: `Job ${jobId} canceled`,
      });
    } catch (error) {
      logger.error("Error canceling job:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to cancel job",
      });
    }
  });

  /**
   * POST /api/monitoring/queue/pause
   * Pause the queue
   */
  app.post("/api/monitoring/queue/pause", async (request, reply) => {
    try {
      await outboundSyncQueue.pause();

      logger.info("Queue paused");

      return reply.send({
        success: true,
        message: "Queue paused",
      });
    } catch (error) {
      logger.error("Error pausing queue:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to pause queue",
      });
    }
  });

  /**
   * POST /api/monitoring/queue/resume
   * Resume the queue
   */
  app.post("/api/monitoring/queue/resume", async (request, reply) => {
    try {
      await outboundSyncQueue.resume();

      logger.info("Queue resumed");

      return reply.send({
        success: true,
        message: "Queue resumed",
      });
    } catch (error) {
      logger.error("Error resuming queue:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to resume queue",
      });
    }
  });

  /**
   * GET /api/monitoring/queue/stats/detailed
   * Get detailed queue statistics
   */
  app.get("/api/monitoring/queue/stats/detailed", async (request, reply) => {
    try {
      const counts = await outboundSyncQueue.getJobCounts();
      const isPaused = await outboundSyncQueue.isPaused();

      // Get sample jobs from each status
      const waiting = await outboundSyncQueue.getJobs(["waiting"], 0, 5);
      const active = await outboundSyncQueue.getJobs(["active"], 0, 5);
      const completed = await outboundSyncQueue.getJobs(["completed"], 0, 5);
      const failed = await outboundSyncQueue.getJobs(["failed"], 0, 5);

      return reply.send({
        success: true,
        data: {
          counts,
          isPaused,
          samples: {
            waiting: waiting.map((j) => ({
              id: j.id,
              name: j.name,
              timestamp: j.timestamp,
            })),
            active: active.map((j) => ({
              id: j.id,
              name: j.name,
              progress: typeof j.progress === "number" ? j.progress : 0,
              timestamp: j.timestamp,
            })),
            completed: completed.map((j) => ({
              id: j.id,
              name: j.name,
              timestamp: j.timestamp,
            })),
            failed: failed.map((j) => ({
              id: j.id,
              name: j.name,
              failedReason: j.failedReason,
              timestamp: j.timestamp,
            })),
          },
        },
      });
    } catch (error) {
      logger.error("Error getting detailed queue stats:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get detailed queue stats",
      });
    }
  });
}
