/**
 * Alert Service
 * 
 * Manages alerts for validation failures and data inconsistencies.
 * Supports multiple alert channels (email, in-app, webhooks).
 */

import { prisma } from '@nexus/database'

export enum AlertSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export enum AlertType {
  ORPHANED_VARIANTS = 'ORPHANED_VARIANTS',
  INCONSISTENT_THEMES = 'INCONSISTENT_THEMES',
  MISSING_ATTRIBUTES = 'MISSING_ATTRIBUTES',
  INVALID_LISTINGS = 'INVALID_LISTINGS',
  SYNC_FAILURE = 'SYNC_FAILURE',
  DATA_CORRUPTION = 'DATA_CORRUPTION',
  PERFORMANCE_DEGRADATION = 'PERFORMANCE_DEGRADATION',
}

export interface AlertConfig {
  type: AlertType
  severity: AlertSeverity
  threshold: number // Number of issues before alerting
  enabled: boolean
  channels: AlertChannel[]
}

export interface AlertChannel {
  type: 'EMAIL' | 'WEBHOOK' | 'IN_APP'
  destination: string
  enabled: boolean
}

export interface Alert {
  id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  affectedCount: number
  affectedIds?: string[]
  createdAt: Date
  resolvedAt?: Date
  acknowledged: boolean
}

export interface AlertHistory {
  alertId: string
  action: 'CREATED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ESCALATED'
  timestamp: Date
  details?: Record<string, any>
}

/**
 * Alert Service
 */
export class AlertService {
  private alertConfigs: Map<AlertType, AlertConfig> = new Map()

  constructor() {
    this.initializeDefaultConfigs()
  }

  /**
   * Initialize default alert configurations
   */
  private initializeDefaultConfigs() {
    const defaults: AlertConfig[] = [
      {
        type: AlertType.ORPHANED_VARIANTS,
        severity: AlertSeverity.ERROR,
        threshold: 1,
        enabled: true,
        channels: [
          { type: 'IN_APP', destination: 'admin', enabled: true },
          { type: 'EMAIL', destination: 'admin@nexus.local', enabled: false },
        ],
      },
      {
        type: AlertType.INCONSISTENT_THEMES,
        severity: AlertSeverity.WARNING,
        threshold: 5,
        enabled: true,
        channels: [
          { type: 'IN_APP', destination: 'admin', enabled: true },
        ],
      },
      {
        type: AlertType.MISSING_ATTRIBUTES,
        severity: AlertSeverity.WARNING,
        threshold: 10,
        enabled: true,
        channels: [
          { type: 'IN_APP', destination: 'admin', enabled: true },
        ],
      },
      {
        type: AlertType.INVALID_LISTINGS,
        severity: AlertSeverity.ERROR,
        threshold: 3,
        enabled: true,
        channels: [
          { type: 'IN_APP', destination: 'admin', enabled: true },
        ],
      },
      {
        type: AlertType.SYNC_FAILURE,
        severity: AlertSeverity.CRITICAL,
        threshold: 1,
        enabled: true,
        channels: [
          { type: 'IN_APP', destination: 'admin', enabled: true },
          { type: 'EMAIL', destination: 'admin@nexus.local', enabled: false },
        ],
      },
    ]

    defaults.forEach((config) => {
      this.alertConfigs.set(config.type, config)
    })
  }

  /**
   * Create an alert
   */
  async createAlert(
    type: AlertType,
    title: string,
    message: string,
    affectedCount: number,
    affectedIds?: string[]
  ): Promise<Alert | null> {
    const config = this.alertConfigs.get(type)

    if (!config || !config.enabled) {
      return null
    }

    // Check if threshold is met
    if (affectedCount < config.threshold) {
      return null
    }

    const alert: Alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      severity: config.severity,
      title,
      message,
      affectedCount,
      affectedIds,
      createdAt: new Date(),
      acknowledged: false,
    }

    // Send to configured channels
    await this.sendAlert(alert, config.channels)

    // Log alert history
    await this.logAlertHistory(alert.id, 'CREATED', {
      type,
      affectedCount,
    })

    return alert
  }

  /**
   * Send alert to configured channels
   */
  private async sendAlert(alert: Alert, channels: AlertChannel[]): Promise<void> {
    for (const channel of channels) {
      if (!channel.enabled) continue

      try {
        switch (channel.type) {
          case 'EMAIL':
            await this.sendEmailAlert(alert, channel.destination)
            break
          case 'WEBHOOK':
            await this.sendWebhookAlert(alert, channel.destination)
            break
          case 'IN_APP':
            await this.createInAppAlert(alert, channel.destination)
            break
        }
      } catch (error) {
        console.error(`Failed to send ${channel.type} alert:`, error)
      }
    }
  }

  /**
   * Send email alert
   */
  private async sendEmailAlert(alert: Alert, email: string): Promise<void> {
    // TODO: Implement email sending via nodemailer or similar
    console.log(`[EMAIL] Sending alert to ${email}:`, alert.title)
  }

  /**
   * Send webhook alert
   */
  private async sendWebhookAlert(alert: Alert, webhookUrl: string): Promise<void> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: alert,
          timestamp: new Date().toISOString(),
        }),
      })

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`)
      }
    } catch (error) {
      console.error(`Failed to send webhook alert to ${webhookUrl}:`, error)
    }
  }

  /**
   * Create in-app alert
   */
  private async createInAppAlert(alert: Alert, destination: string): Promise<void> {
    // Store in database for in-app notification
    console.log(`[IN_APP] Alert for ${destination}:`, alert.title)
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId: string): Promise<void> {
    await this.logAlertHistory(alertId, 'ACKNOWLEDGED', {
      acknowledgedAt: new Date(),
    })
  }

  /**
   * Resolve an alert
   */
  async resolveAlert(alertId: string): Promise<void> {
    await this.logAlertHistory(alertId, 'RESOLVED', {
      resolvedAt: new Date(),
    })
  }

  /**
   * Log alert history
   */
  private async logAlertHistory(
    alertId: string,
    action: 'CREATED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ESCALATED',
    details?: Record<string, any>
  ): Promise<void> {
    // TODO: Store in database
    console.log(`[ALERT_HISTORY] ${alertId}: ${action}`, details)
  }

  /**
   * Get alert configuration
   */
  getAlertConfig(type: AlertType): AlertConfig | undefined {
    return this.alertConfigs.get(type)
  }

  /**
   * Update alert configuration
   */
  updateAlertConfig(type: AlertType, config: Partial<AlertConfig>): void {
    const existing = this.alertConfigs.get(type)
    if (existing) {
      this.alertConfigs.set(type, { ...existing, ...config })
    }
  }

  /**
   * Get all alert configurations
   */
  getAllAlertConfigs(): AlertConfig[] {
    return Array.from(this.alertConfigs.values())
  }
}
