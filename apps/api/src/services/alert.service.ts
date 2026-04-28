/**
 * Phase 23.2: Safety Buffers & Alerts
 * Low-stock monitoring and critical inventory alerts
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

/**
 * Alert event for tracking critical stock situations
 */
export interface StockAlert {
  id: string
  sku: string
  productId: string
  currentStock: number
  threshold: number
  alertType: 'CRITICAL_LOW_STOCK' | 'APPROACHING_THRESHOLD' | 'OUT_OF_STOCK'
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  message: string
  timestamp: Date
  notified: boolean
}

// In-memory store for recent alerts
const recentAlerts: StockAlert[] = []
const MAX_RECENT_ALERTS = 100

// Configurable thresholds
const STOCK_THRESHOLDS = {
  CRITICAL: 5,      // Critical alert when stock < 5
  WARNING: 10,      // Warning alert when stock < 10
  OUT_OF_STOCK: 0,  // Out of stock alert when stock = 0
}

/**
 * Evaluate stock health for a product
 * Phase 23.2: Comprehensive stock health check with threshold awareness
 */
export async function evaluateStockHealth(productId: string): Promise<StockAlert | null> {
  try {
    // Fetch product with stock and threshold info
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        totalStock: true,
        lowStockThreshold: true,
      },
    })

    if (!product) {
      logger.warn(`[ALERT] Product not found for ID: ${productId}`)
      return null
    }

    // Use product's configured threshold
    const threshold = product.lowStockThreshold || STOCK_THRESHOLDS.WARNING
    const currentStock = product.totalStock || 0

    // Determine alert type and severity based on threshold
    let alertType: StockAlert['alertType'] = 'APPROACHING_THRESHOLD'
    let severity: StockAlert['severity'] = 'INFO'
    let message = ''

    if (currentStock === 0) {
      alertType = 'OUT_OF_STOCK'
      severity = 'CRITICAL'
      message = `🚨 CRITICAL ALERT: Product "${product.name}" (${product.sku}) is OUT OF STOCK!`
    } else if (currentStock < STOCK_THRESHOLDS.CRITICAL) {
      alertType = 'CRITICAL_LOW_STOCK'
      severity = 'CRITICAL'
      message = `🚨 CRITICAL ALERT: Product "${product.name}" (${product.sku}) has only ${currentStock} units left!`
    } else if (currentStock <= threshold) {
      alertType = 'APPROACHING_THRESHOLD'
      severity = 'WARNING'
      message = `⚠️ WARNING: Product "${product.name}" (${product.sku}) stock is low (${currentStock} units, threshold: ${threshold})`
    } else {
      // Stock is healthy, no alert needed
      return null
    }

    // Create alert record
    const alert: StockAlert = {
      id: `alert-${Date.now()}`,
      sku: product.sku,
      productId: product.id,
      currentStock,
      threshold,
      alertType,
      severity,
      message,
      timestamp: new Date(),
      notified: false,
    }

    // Store in recent alerts
    recentAlerts.unshift(alert)
    if (recentAlerts.length > MAX_RECENT_ALERTS) {
      recentAlerts.pop()
    }

    // Log the alert with severity
    logger.warn(`[CRITICAL ALERT] ${message}`, {
      sku: product.sku,
      currentStock,
      threshold,
      severity,
      alertType,
    })

    return alert
  } catch (error: any) {
    logger.error(`[ALERT] Error evaluating stock health for product ${productId}:`, error.message)
    throw error
  }
}

/**
 * Check stock level and trigger alerts if necessary
 */
export async function checkStockThreshold(
  sku: string,
  currentStock: number,
  customThreshold?: number
): Promise<StockAlert | null> {
  try {
    const threshold = customThreshold || STOCK_THRESHOLDS.WARNING

    // Find product
    const product = await prisma.product.findUnique({
      where: { sku },
      select: { id: true, sku: true, name: true, lowStockThreshold: true },
    })

    if (!product) {
      logger.warn(`[ALERT] Product not found for SKU: ${sku}`)
      return null
    }

    // Use product's configured threshold if available
    const effectiveThreshold = customThreshold || product.lowStockThreshold || threshold

    // Determine alert type and severity
    let alertType: StockAlert['alertType'] = 'APPROACHING_THRESHOLD'
    let severity: StockAlert['severity'] = 'INFO'
    let message = ''

    if (currentStock === 0) {
      alertType = 'OUT_OF_STOCK'
      severity = 'CRITICAL'
      message = `🚨 CRITICAL ALERT: Product "${product.name}" (${sku}) is OUT OF STOCK!`
    } else if (currentStock < STOCK_THRESHOLDS.CRITICAL) {
      alertType = 'CRITICAL_LOW_STOCK'
      severity = 'CRITICAL'
      message = `🚨 CRITICAL ALERT: Product "${product.name}" (${sku}) has only ${currentStock} units left!`
    } else if (currentStock <= effectiveThreshold) {
      alertType = 'APPROACHING_THRESHOLD'
      severity = 'WARNING'
      message = `⚠️ WARNING: Product "${product.name}" (${sku}) stock is low (${currentStock} units, threshold: ${effectiveThreshold})`
    } else {
      // Stock is healthy, no alert needed
      return null
    }

    // Create alert record
    const alert: StockAlert = {
      id: `alert-${Date.now()}`,
      sku: product.sku,
      productId: product.id,
      currentStock,
      threshold: effectiveThreshold,
      alertType,
      severity,
      message,
      timestamp: new Date(),
      notified: false,
    }

    // Store in recent alerts
    recentAlerts.unshift(alert)
    if (recentAlerts.length > MAX_RECENT_ALERTS) {
      recentAlerts.pop()
    }

    // Log the alert with severity
    logger.warn(`[CRITICAL ALERT] ${message}`, {
      sku,
      currentStock,
      threshold: effectiveThreshold,
      severity,
      alertType,
    })

    // TODO: In production, integrate with:
    // - Email notifications
    // - Slack webhooks
    // - SMS alerts
    // - Dashboard notifications
    // - Webhook callbacks to external systems

    return alert
  } catch (error: any) {
    logger.error(`[ALERT] Error checking stock threshold for ${sku}:`, error.message)
    throw error
  }
}

/**
 * Get recent stock alerts
 */
export function getRecentAlerts(limit: number = 20): StockAlert[] {
  return recentAlerts.slice(0, limit)
}

/**
 * Get alerts for a specific product
 */
export function getProductAlerts(productId: string, limit: number = 50): StockAlert[] {
  return recentAlerts.filter((alert) => alert.productId === productId).slice(0, limit)
}

/**
 * Get critical alerts only
 */
export function getCriticalAlerts(): StockAlert[] {
  return recentAlerts.filter((alert) => alert.severity === 'CRITICAL')
}

/**
 * Mark alert as notified
 */
export function markAlertNotified(alertId: string): boolean {
  const alert = recentAlerts.find((a) => a.id === alertId)
  if (alert) {
    alert.notified = true
    return true
  }
  return false
}

/**
 * Batch check stock levels for all products
 * Useful for periodic health checks
 */
export async function checkAllProductStocks(threshold?: number): Promise<StockAlert[]> {
  try {
    logger.info('[ALERT] Starting batch stock check for all products')

    const products = await prisma.product.findMany({
      select: { id: true, sku: true, totalStock: true },
    })

    const alerts: StockAlert[] = []

    for (const product of products) {
      const alert = await checkStockThreshold(product.sku, product.totalStock, threshold)
      if (alert) {
        alerts.push(alert)
      }
    }

    logger.info(`[ALERT] Batch check complete: ${alerts.length} alerts triggered`, {
      totalProducts: products.length,
      alertsTriggered: alerts.length,
    })

    return alerts
  } catch (error: any) {
    logger.error('[ALERT] Error during batch stock check:', error.message)
    throw error
  }
}

/**
 * Get stock alert statistics
 */
export function getAlertStats() {
  const critical = recentAlerts.filter((a) => a.severity === 'CRITICAL').length
  const warning = recentAlerts.filter((a) => a.severity === 'WARNING').length
  const notified = recentAlerts.filter((a) => a.notified).length

  return {
    totalAlerts: recentAlerts.length,
    criticalAlerts: critical,
    warningAlerts: warning,
    notifiedAlerts: notified,
    unnotifiedAlerts: recentAlerts.length - notified,
  }
}

/**
 * Clear old alerts (older than specified hours)
 */
export function clearOldAlerts(hoursOld: number = 24): number {
  const cutoffTime = new Date(Date.now() - hoursOld * 60 * 60 * 1000)
  const initialLength = recentAlerts.length

  // Remove alerts older than cutoff
  for (let i = recentAlerts.length - 1; i >= 0; i--) {
    if (recentAlerts[i].timestamp < cutoffTime) {
      recentAlerts.splice(i, 1)
    }
  }

  const removed = initialLength - recentAlerts.length
  logger.info(`[ALERT] Cleared ${removed} old alerts (older than ${hoursOld} hours)`)

  return removed
}
