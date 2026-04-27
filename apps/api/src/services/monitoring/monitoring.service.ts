/**
 * Monitoring Service
 * 
 * Monitors data integrity and triggers alerts based on validation results.
 * Tracks metrics and provides health insights.
 */

import { DataValidationService } from '../sync/data-validation.service.js'
import { AlertService, AlertType, AlertSeverity } from './alert.service.js'

export interface MonitoringMetrics {
  timestamp: Date
  totalProducts: number
  totalVariations: number
  orphanedVariants: number
  inconsistentThemes: number
  missingAttributes: number
  invalidListings: number
  healthScore: number // 0-100
  lastValidationTime: Date
  validationDuration: number // milliseconds
}

export interface MonitoringAlert {
  id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  affectedCount: number
  createdAt: Date
  acknowledged: boolean
}

export interface MonitoringReport {
  metrics: MonitoringMetrics
  alerts: MonitoringAlert[]
  recommendations: string[]
}

/**
 * Monitoring Service
 */
export class MonitoringService {
  private validationService: DataValidationService
  private alertService: AlertService
  private metricsHistory: MonitoringMetrics[] = []
  private maxHistorySize = 1000

  constructor() {
    this.validationService = new DataValidationService()
    this.alertService = new AlertService()
  }

  /**
   * Run full monitoring cycle
   */
  async runMonitoring(): Promise<MonitoringReport> {
    const startTime = Date.now()

    // Run validation
    const validationReport = await this.validationService.validateAllProducts()

    // Calculate metrics
    const metrics = await this.calculateMetrics(validationReport, Date.now() - startTime)

    // Store metrics history
    this.storeMetrics(metrics)

    // Check thresholds and create alerts
    const alerts = await this.checkThresholdsAndAlert(validationReport)

    // Generate recommendations
    const recommendations = this.generateRecommendations(validationReport, metrics)

    return {
      metrics,
      alerts,
      recommendations,
    }
  }

  /**
   * Calculate monitoring metrics
   */
  private async calculateMetrics(
    validationReport: any,
    duration: number
  ): Promise<MonitoringMetrics> {
    // Get total product and variation counts
    const totalProducts = await (global as any).prisma?.product?.count?.() || 0
    const totalVariations = await (global as any).prisma?.productVariation?.count?.() || 0

    // Calculate health score (0-100)
    const totalIssues =
      validationReport.orphanedVariants +
      validationReport.inconsistentThemes +
      validationReport.missingAttributes +
      validationReport.invalidChannelListings

    const healthScore = Math.max(
      0,
      100 - (totalIssues / Math.max(totalVariations, 1)) * 100
    )

    return {
      timestamp: new Date(),
      totalProducts,
      totalVariations,
      orphanedVariants: validationReport.orphanedVariants,
      inconsistentThemes: validationReport.inconsistentThemes,
      missingAttributes: validationReport.missingAttributes,
      invalidListings: validationReport.invalidChannelListings,
      healthScore: Math.round(healthScore * 100) / 100,
      lastValidationTime: new Date(),
      validationDuration: duration,
    }
  }

  /**
   * Store metrics in history
   */
  private storeMetrics(metrics: MonitoringMetrics): void {
    this.metricsHistory.push(metrics)

    // Keep history size manageable
    if (this.metricsHistory.length > this.maxHistorySize) {
      this.metricsHistory = this.metricsHistory.slice(-this.maxHistorySize)
    }
  }

  /**
   * Check thresholds and create alerts
   */
  private async checkThresholdsAndAlert(validationReport: any): Promise<MonitoringAlert[]> {
    const alerts: MonitoringAlert[] = []

    // Check orphaned variants
    if (validationReport.orphanedVariants > 0) {
      const alert = await this.alertService.createAlert(
        AlertType.ORPHANED_VARIANTS,
        'Orphaned Variants Detected',
        `Found ${validationReport.orphanedVariants} variations without parent products`,
        validationReport.orphanedVariants
      )
      if (alert) alerts.push(alert as any)
    }

    // Check inconsistent themes
    if (validationReport.inconsistentThemes > 0) {
      const alert = await this.alertService.createAlert(
        AlertType.INCONSISTENT_THEMES,
        'Inconsistent Variation Themes',
        `Found ${validationReport.inconsistentThemes} products with variations but no theme`,
        validationReport.inconsistentThemes
      )
      if (alert) alerts.push(alert as any)
    }

    // Check missing attributes
    if (validationReport.missingAttributes > 0) {
      const alert = await this.alertService.createAlert(
        AlertType.MISSING_ATTRIBUTES,
        'Missing Variation Attributes',
        `Found ${validationReport.missingAttributes} variations without attributes`,
        validationReport.missingAttributes
      )
      if (alert) alerts.push(alert as any)
    }

    // Check invalid listings
    if (validationReport.invalidChannelListings > 0) {
      const alert = await this.alertService.createAlert(
        AlertType.INVALID_LISTINGS,
        'Invalid Channel Listings',
        `Found ${validationReport.invalidChannelListings} variations with invalid listings`,
        validationReport.invalidChannelListings
      )
      if (alert) alerts.push(alert as any)
    }

    return alerts
  }

  /**
   * Generate recommendations based on metrics
   */
  private generateRecommendations(validationReport: any, metrics: MonitoringMetrics): string[] {
    const recommendations: string[] = []

    // Health score recommendations
    if (metrics.healthScore < 50) {
      recommendations.push(
        '⚠️ CRITICAL: Health score below 50%. Run batch repairs immediately.'
      )
    } else if (metrics.healthScore < 80) {
      recommendations.push('⚠️ WARNING: Health score below 80%. Consider running repairs soon.')
    }

    // Specific issue recommendations
    if (validationReport.orphanedVariants > 0) {
      recommendations.push(
        `🔧 Run "Repair Orphaned Variations" to remove ${validationReport.orphanedVariants} orphaned records`
      )
    }

    if (validationReport.inconsistentThemes > 0) {
      recommendations.push(
        `🔧 Run "Repair Missing Themes" to infer themes for ${validationReport.inconsistentThemes} products`
      )
    }

    if (validationReport.missingAttributes > 0) {
      recommendations.push(
        `🔧 Run "Repair Missing Attributes" to populate ${validationReport.missingAttributes} variations`
      )
    }

    if (validationReport.invalidChannelListings > 0) {
      recommendations.push(
        `🔧 Run "Repair Channel Listings" to fix ${validationReport.invalidChannelListings} listings`
      )
    }

    // Performance recommendations
    if (metrics.validationDuration > 5000) {
      recommendations.push(
        '⏱️ Validation took longer than expected. Consider running during off-peak hours.'
      )
    }

    // Success message
    if (recommendations.length === 0) {
      recommendations.push('✅ All systems healthy! No action required.')
    }

    return recommendations
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(limit: number = 100): MonitoringMetrics[] {
    return this.metricsHistory.slice(-limit)
  }

  /**
   * Get health trend
   */
  getHealthTrend(hours: number = 24): { timestamp: Date; healthScore: number }[] {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000)
    return this.metricsHistory
      .filter((m) => m.timestamp >= cutoffTime)
      .map((m) => ({
        timestamp: m.timestamp,
        healthScore: m.healthScore,
      }))
  }

  /**
   * Get alert configuration
   */
  getAlertConfigs() {
    return this.alertService.getAllAlertConfigs()
  }

  /**
   * Update alert configuration
   */
  updateAlertConfig(type: AlertType, config: any) {
    this.alertService.updateAlertConfig(type, config)
  }

  /**
   * Get current health status
   */
  getCurrentHealth(): MonitoringMetrics | null {
    return this.metricsHistory.length > 0 ? this.metricsHistory[this.metricsHistory.length - 1] : null
  }
}
