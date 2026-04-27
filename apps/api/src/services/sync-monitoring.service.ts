import prisma from "../db.js";

export interface SyncMetrics {
  syncId: string;
  totalProducts: number;
  successfulProducts: number;
  failedProducts: number;
  successRate: number;
  duration: number; // milliseconds
  startTime: Date;
  endTime: Date;
  averageTimePerProduct: number;
  errorCategories: Record<string, number>;
}

export interface AlertConfig {
  id: string;
  name: string;
  type: "failure_rate" | "duration" | "error_count" | "success_threshold";
  threshold: number;
  enabled: boolean;
  channels: ("email" | "slack" | "webhook" | "database")[];
  webhookUrl?: string;
  slackChannel?: string;
  emailRecipients?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Alert {
  id: string;
  configId: string;
  syncId: string;
  severity: "info" | "warning" | "critical";
  message: string;
  metadata: Record<string, any>;
  acknowledged: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  createdAt: Date;
}

export class SyncMonitoringService {
  private alerts: Map<string, Alert> = new Map();
  private alertConfigs: AlertConfig[] = [];

  constructor() {
    this.initializeAlertConfigs();
  }

  /**
   * Initialize default alert configurations
   */
  private initializeAlertConfigs(): void {
    this.alertConfigs = [
      {
        id: "alert-failure-rate",
        name: "High Failure Rate",
        type: "failure_rate",
        threshold: 10, // 10% failure rate
        enabled: true,
        channels: ["slack", "email"],
        slackChannel: "#sync-alerts",
        emailRecipients: [process.env.ALERT_EMAIL || "admin@example.com"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "alert-duration",
        name: "Long Sync Duration",
        type: "duration",
        threshold: 300000, // 5 minutes
        enabled: true,
        channels: ["slack"],
        slackChannel: "#sync-alerts",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "alert-error-count",
        name: "High Error Count",
        type: "error_count",
        threshold: 50,
        enabled: true,
        channels: ["slack", "email"],
        slackChannel: "#sync-alerts",
        emailRecipients: [process.env.ALERT_EMAIL || "admin@example.com"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "alert-success-threshold",
        name: "Low Success Rate",
        type: "success_threshold",
        threshold: 80, // 80% success rate minimum
        enabled: true,
        channels: ["slack", "email"],
        slackChannel: "#sync-alerts",
        emailRecipients: [process.env.ALERT_EMAIL || "admin@example.com"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  }

  /**
   * Record sync metrics after completion
   */
  async recordSyncMetrics(
    syncId: string,
    metrics: Omit<SyncMetrics, "syncId">
  ): Promise<SyncMetrics> {
    try {
      const result: SyncMetrics = {
        syncId,
        ...metrics,
      };

      // Log metrics
      console.log(`[SYNC METRICS] ${syncId}:`, {
        totalProducts: metrics.totalProducts,
        successfulProducts: metrics.successfulProducts,
        failedProducts: metrics.failedProducts,
        successRate: `${metrics.successRate.toFixed(2)}%`,
        duration: `${metrics.duration}ms`,
        averageTimePerProduct: `${metrics.averageTimePerProduct.toFixed(2)}ms`,
      });

      // Check alerts
      await this.evaluateAlerts(result);

      return result;
    } catch (error) {
      console.error("Error recording sync metrics:", error);
      throw error;
    }
  }

  /**
   * Get sync metrics for a specific sync
   */
  async getSyncMetrics(syncId: string): Promise<SyncMetrics | null> {
    try {
      // In a real implementation, this would query the database
      // For now, return null as metrics are logged but not persisted
      console.log(`[SYNC METRICS] Retrieving metrics for sync: ${syncId}`);
      return null;
    } catch (error) {
      console.error("Error getting sync metrics:", error);
      throw error;
    }
  }

  /**
   * Get aggregated metrics for a time period
   */
  async getAggregatedMetrics(
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    averageSuccessRate: number;
    averageDuration: number;
    totalProductsProcessed: number;
    totalProductsFailed: number;
  }> {
    try {
      // Query sync logs from database
      const syncs = await (prisma as any).syncLog?.findMany?.({
        where: {
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
      });

      if (!syncs || syncs.length === 0) {
        return {
          totalSyncs: 0,
          successfulSyncs: 0,
          failedSyncs: 0,
          averageSuccessRate: 0,
          averageDuration: 0,
          totalProductsProcessed: 0,
          totalProductsFailed: 0,
        };
      }

      let successfulSyncs = 0;
      let failedSyncs = 0;
      let totalSuccessRate = 0;
      let totalDuration = 0;
      let totalProductsProcessed = 0;
      let totalProductsFailed = 0;

      syncs.forEach((sync: any) => {
        if (sync.status === "SUCCESS") {
          successfulSyncs++;
        } else if (sync.status === "FAILED") {
          failedSyncs++;
        }

        totalProductsProcessed += sync.itemsProcessed || 0;
        totalProductsFailed += sync.itemsFailed || 0;

        // Calculate success rate from items
        if (sync.itemsProcessed > 0) {
          const successRate =
            ((sync.itemsProcessed - sync.itemsFailed) / sync.itemsProcessed) *
            100;
          totalSuccessRate += successRate;
        }
      });

      return {
        totalSyncs: syncs.length,
        successfulSyncs,
        failedSyncs,
        averageSuccessRate:
          syncs.length > 0 ? totalSuccessRate / syncs.length : 0,
        averageDuration: 0, // Would need to calculate from timestamps
        totalProductsProcessed,
        totalProductsFailed,
      };
    } catch (error) {
      console.error("Error getting aggregated metrics:", error);
      return {
        totalSyncs: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        averageSuccessRate: 0,
        averageDuration: 0,
        totalProductsProcessed: 0,
        totalProductsFailed: 0,
      };
    }
  }

  /**
   * Evaluate alerts based on sync metrics
   */
  private async evaluateAlerts(metrics: SyncMetrics): Promise<void> {
    try {
      for (const config of this.alertConfigs) {
        if (!config.enabled) continue;

        let shouldAlert = false;
        let severity: "info" | "warning" | "critical" = "info";
        let message = "";

        switch (config.type) {
          case "failure_rate":
            const failureRate = 100 - metrics.successRate;
            if (failureRate > config.threshold) {
              shouldAlert = true;
              severity = failureRate > 50 ? "critical" : "warning";
              message = `Sync failure rate ${failureRate.toFixed(2)}% exceeds threshold of ${config.threshold}%`;
            }
            break;

          case "duration":
            if (metrics.duration > config.threshold) {
              shouldAlert = true;
              severity = "warning";
              message = `Sync duration ${metrics.duration}ms exceeds threshold of ${config.threshold}ms`;
            }
            break;

          case "error_count":
            if (metrics.failedProducts > config.threshold) {
              shouldAlert = true;
              severity =
                metrics.failedProducts > 100 ? "critical" : "warning";
              message = `Failed products ${metrics.failedProducts} exceeds threshold of ${config.threshold}`;
            }
            break;

          case "success_threshold":
            if (metrics.successRate < config.threshold) {
              shouldAlert = true;
              severity = "critical";
              message = `Success rate ${metrics.successRate.toFixed(2)}% below threshold of ${config.threshold}%`;
            }
            break;
        }

        if (shouldAlert) {
          await this.createAlert(
            config.id,
            metrics.syncId,
            severity,
            message,
            {
              metrics,
              threshold: config.threshold,
            }
          );

          // Send notifications
          await this.sendAlertNotifications(config, message, severity);
        }
      }
    } catch (error) {
      console.error("Error evaluating alerts:", error);
    }
  }

  /**
   * Create an alert record
   */
  private async createAlert(
    configId: string,
    syncId: string,
    severity: "info" | "warning" | "critical",
    message: string,
    metadata: Record<string, any>
  ): Promise<Alert> {
    try {
      const alert: Alert = {
        id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        configId,
        syncId,
        severity,
        message,
        metadata,
        acknowledged: false,
        createdAt: new Date(),
      };

      this.alerts.set(alert.id, alert);

      console.log(`[ALERT] ${severity.toUpperCase()}: ${message}`);

      return alert;
    } catch (error) {
      console.error("Error creating alert:", error);
      throw error;
    }
  }

  /**
   * Send alert notifications through configured channels
   */
  private async sendAlertNotifications(
    config: AlertConfig,
    message: string,
    severity: "info" | "warning" | "critical"
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const fullMessage = `[${severity.toUpperCase()}] ${message} (${timestamp})`;

    for (const channel of config.channels) {
      try {
        switch (channel) {
          case "email":
            if (config.emailRecipients?.length) {
              await this.sendEmailAlert(
                config.emailRecipients,
                fullMessage,
                severity
              );
            }
            break;

          case "slack":
            if (config.slackChannel) {
              await this.sendSlackAlert(
                config.slackChannel,
                fullMessage,
                severity
              );
            }
            break;

          case "webhook":
            if (config.webhookUrl) {
              await this.sendWebhookAlert(config.webhookUrl, {
                message: fullMessage,
                severity,
                timestamp,
              });
            }
            break;

          case "database":
            // Already stored in memory via createAlert
            break;
        }
      } catch (error) {
        console.error(`Error sending ${channel} alert:`, error);
      }
    }
  }

  /**
   * Send email alert
   */
  private async sendEmailAlert(
    recipients: string[],
    message: string,
    severity: string
  ): Promise<void> {
    // Implementation would integrate with email service (SendGrid, AWS SES, etc.)
    console.log(`[EMAIL] To: ${recipients.join(", ")}`);
    console.log(`[EMAIL] ${message}`);
  }

  /**
   * Send Slack alert
   */
  private async sendSlackAlert(
    channel: string,
    message: string,
    severity: string
  ): Promise<void> {
    try {
      const slackWebhook = process.env.SLACK_WEBHOOK_URL;
      if (!slackWebhook) {
        console.warn("SLACK_WEBHOOK_URL not configured");
        return;
      }

      const color =
        severity === "critical"
          ? "danger"
          : severity === "warning"
            ? "warning"
            : "good";

      const payload = {
        channel,
        attachments: [
          {
            color,
            title: `Sync Alert - ${severity.toUpperCase()}`,
            text: message,
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      };

      const response = await fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error("Failed to send Slack alert:", response.statusText);
      }
    } catch (error) {
      console.error("Error sending Slack alert:", error);
    }
  }

  /**
   * Send webhook alert
   */
  private async sendWebhookAlert(
    webhookUrl: string,
    payload: Record<string, any>
  ): Promise<void> {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error("Failed to send webhook alert:", response.statusText);
      }
    } catch (error) {
      console.error("Error sending webhook alert:", error);
    }
  }

  /**
   * Get all alert configurations
   */
  async getAlertConfigs(): Promise<AlertConfig[]> {
    return this.alertConfigs;
  }

  /**
   * Get recent alerts
   */
  async getRecentAlerts(limit: number = 50): Promise<Alert[]> {
    try {
      const alertArray = Array.from(this.alerts.values());
      return alertArray.slice(-limit).reverse();
    } catch (error) {
      console.error("Error getting recent alerts:", error);
      throw error;
    }
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(
    alertId: string,
    acknowledgedBy: string
  ): Promise<void> {
    try {
      const alert = this.alerts.get(alertId);
      if (alert) {
        alert.acknowledged = true;
        alert.acknowledgedAt = new Date();
        alert.acknowledgedBy = acknowledgedBy;
        console.log(`[ALERT] Alert ${alertId} acknowledged by ${acknowledgedBy}`);
      }
    } catch (error) {
      console.error("Error acknowledging alert:", error);
      throw error;
    }
  }

  /**
   * Get sync health status
   */
  async getSyncHealthStatus(): Promise<{
    status: "healthy" | "degraded" | "critical";
    lastSyncTime: Date | null;
    lastSyncStatus: string | null;
    recentFailureRate: number;
    activeAlerts: number;
    message: string;
  }> {
    try {
      // Get recent metrics (last 24 hours)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentMetrics = await this.getAggregatedMetrics(
        oneDayAgo,
        new Date()
      );

      // Get active alerts
      const activeAlerts = Array.from(this.alerts.values()).filter(
        (a) => !a.acknowledged
      ).length;

      const failureRate = 100 - recentMetrics.averageSuccessRate;
      let status: "healthy" | "degraded" | "critical" = "healthy";
      let message = "All systems operational";

      if (failureRate > 50 || activeAlerts > 10) {
        status = "critical";
        message = `Critical: ${failureRate.toFixed(2)}% failure rate, ${activeAlerts} active alerts`;
      } else if (failureRate > 10 || activeAlerts > 5) {
        status = "degraded";
        message = `Degraded: ${failureRate.toFixed(2)}% failure rate, ${activeAlerts} active alerts`;
      }

      return {
        status,
        lastSyncTime: null, // Would need to query database
        lastSyncStatus: null,
        recentFailureRate: failureRate,
        activeAlerts,
        message,
      };
    } catch (error) {
      console.error("Error getting sync health status:", error);
      throw error;
    }
  }

  /**
   * Update alert configuration
   */
  async updateAlertConfig(
    configId: string,
    updates: Partial<AlertConfig>
  ): Promise<AlertConfig | null> {
    try {
      const index = this.alertConfigs.findIndex((c) => c.id === configId);
      if (index === -1) return null;

      this.alertConfigs[index] = {
        ...this.alertConfigs[index],
        ...updates,
        updatedAt: new Date(),
      };

      console.log(`[ALERT CONFIG] Updated config ${configId}`);
      return this.alertConfigs[index];
    } catch (error) {
      console.error("Error updating alert config:", error);
      throw error;
    }
  }

  /**
   * Get alert configuration by ID
   */
  async getAlertConfig(configId: string): Promise<AlertConfig | null> {
    return this.alertConfigs.find((c) => c.id === configId) || null;
  }
}

export default new SyncMonitoringService();
