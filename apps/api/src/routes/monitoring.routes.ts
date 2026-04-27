import type { FastifyInstance } from "fastify";
import syncMonitoringService from "../services/sync-monitoring.service.js";

export async function monitoringRoutes(app: FastifyInstance) {
  /**
   * GET /api/monitoring/health
   * Get overall sync health status
   */
  app.get("/api/monitoring/health", async (request, reply) => {
    try {
      const health = await syncMonitoringService.getSyncHealthStatus();
      return reply.send({
        success: true,
        data: health,
      });
    } catch (error) {
      console.error("Error getting health status:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get health status",
      });
    }
  });

  /**
   * GET /api/monitoring/metrics
   * Get aggregated sync metrics for a time period
   * Query params: startDate, endDate (ISO 8601 format)
   */
  app.get<{
    Querystring: {
      startDate?: string;
      endDate?: string;
    };
  }>("/api/monitoring/metrics", async (request, reply) => {
    try {
      const { startDate, endDate } = request.query;

      const start = startDate
        ? new Date(startDate)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days
      const end = endDate ? new Date(endDate) : new Date();

      const metrics = await syncMonitoringService.getAggregatedMetrics(
        start,
        end
      );

      return reply.send({
        success: true,
        data: {
          period: {
            start: start.toISOString(),
            end: end.toISOString(),
          },
          metrics,
        },
      });
    } catch (error) {
      console.error("Error getting metrics:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get metrics",
      });
    }
  });

  /**
   * GET /api/monitoring/alerts
   * Get recent alerts
   * Query params: limit (default: 50)
   */
  app.get<{
    Querystring: {
      limit?: string;
    };
  }>("/api/monitoring/alerts", async (request, reply) => {
    try {
      const limit = request.query.limit
        ? parseInt(request.query.limit, 10)
        : 50;
      const alerts = await syncMonitoringService.getRecentAlerts(limit);

      return reply.send({
        success: true,
        data: {
          count: alerts.length,
          alerts,
        },
      });
    } catch (error) {
      console.error("Error getting alerts:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get alerts",
      });
    }
  });

  /**
   * POST /api/monitoring/alerts/:alertId/acknowledge
   * Acknowledge an alert
   */
  app.post<{
    Params: {
      alertId: string;
    };
    Body: {
      acknowledgedBy: string;
    };
  }>("/api/monitoring/alerts/:alertId/acknowledge", async (request, reply) => {
    try {
      const { alertId } = request.params;
      const { acknowledgedBy } = request.body;

      if (!acknowledgedBy) {
        return reply.status(400).send({
          success: false,
          error: "acknowledgedBy is required",
        });
      }

      await syncMonitoringService.acknowledgeAlert(alertId, acknowledgedBy);

      return reply.send({
        success: true,
        message: `Alert ${alertId} acknowledged`,
      });
    } catch (error) {
      console.error("Error acknowledging alert:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to acknowledge alert",
      });
    }
  });

  /**
   * GET /api/monitoring/alert-configs
   * Get all alert configurations
   */
  app.get("/api/monitoring/alert-configs", async (request, reply) => {
    try {
      const configs = await syncMonitoringService.getAlertConfigs();

      return reply.send({
        success: true,
        data: {
          count: configs.length,
          configs,
        },
      });
    } catch (error) {
      console.error("Error getting alert configs:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get alert configs",
      });
    }
  });

  /**
   * GET /api/monitoring/alert-configs/:configId
   * Get a specific alert configuration
   */
  app.get<{
    Params: {
      configId: string;
    };
  }>("/api/monitoring/alert-configs/:configId", async (request, reply) => {
    try {
      const { configId } = request.params;
      const config = await syncMonitoringService.getAlertConfig(configId);

      if (!config) {
        return reply.status(404).send({
          success: false,
          error: "Alert config not found",
        });
      }

      return reply.send({
        success: true,
        data: config,
      });
    } catch (error) {
      console.error("Error getting alert config:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to get alert config",
      });
    }
  });

  /**
   * PATCH /api/monitoring/alert-configs/:configId
   * Update an alert configuration
   */
  app.patch<{
    Params: {
      configId: string;
    };
    Body: {
      name?: string;
      threshold?: number;
      enabled?: boolean;
      channels?: ("email" | "slack" | "webhook" | "database")[];
      slackChannel?: string;
      emailRecipients?: string[];
      webhookUrl?: string;
    };
  }>("/api/monitoring/alert-configs/:configId", async (request, reply) => {
    try {
      const { configId } = request.params;
      const updates = request.body as any;

      const updated = await syncMonitoringService.updateAlertConfig(
        configId,
        updates
      );

      if (!updated) {
        return reply.status(404).send({
          success: false,
          error: "Alert config not found",
        });
      }

      return reply.send({
        success: true,
        data: updated,
        message: `Alert config ${configId} updated`,
      });
    } catch (error) {
      console.error("Error updating alert config:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to update alert config",
      });
    }
  });

  /**
   * POST /api/monitoring/test-alert
   * Send a test alert (for testing notification channels)
   */
  app.post<{
    Body: {
      configId: string;
      severity?: "info" | "warning" | "critical";
    };
  }>("/api/monitoring/test-alert", async (request, reply) => {
    try {
      const { configId, severity = "info" } = request.body;

      const config = await syncMonitoringService.getAlertConfig(configId);
      if (!config) {
        return reply.status(404).send({
          success: false,
          error: "Alert config not found",
        });
      }

      const testMessage = `[TEST] This is a test alert from Nexus Commerce monitoring system (${new Date().toISOString()})`;

      // Send test notification through configured channels
      for (const channel of config.channels) {
        console.log(
          `[TEST ALERT] Sending test alert through ${channel} channel`
        );

        if (channel === "email" && config.emailRecipients?.length) {
          console.log(
            `[TEST EMAIL] To: ${config.emailRecipients.join(", ")}\n${testMessage}`
          );
        } else if (channel === "slack" && config.slackChannel) {
          console.log(
            `[TEST SLACK] Channel: ${config.slackChannel}\n${testMessage}`
          );
        } else if (channel === "webhook" && config.webhookUrl) {
          console.log(
            `[TEST WEBHOOK] URL: ${config.webhookUrl}\n${testMessage}`
          );
        }
      }

      return reply.send({
        success: true,
        message: `Test alert sent through ${config.channels.join(", ")} channel(s)`,
      });
    } catch (error) {
      console.error("Error sending test alert:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to send test alert",
      });
    }
  });
}
