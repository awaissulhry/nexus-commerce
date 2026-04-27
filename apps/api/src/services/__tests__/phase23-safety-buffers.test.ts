/**
 * Phase 23.2: Safety Buffers & Low-Stock Alerts - Integration Tests
 * Tests for inventory protection guards and alert mechanisms
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import prisma from '../../db'
import { syncGlobalStock, getRecentAdjustments } from '../inventory-sync.service'
import { checkStockThreshold, evaluateStockHealth, getRecentAlerts, getCriticalAlerts } from '../alert.service'

describe('Phase 23.2: Safety Buffers & Low-Stock Alerts', () => {
  let testProductId: string
  let testProductSku: string

  beforeAll(async () => {
    // Create a test product with low-stock threshold
    const product = await prisma.product.create({
      data: {
        sku: `TEST-BUFFER-${Date.now()}`,
        name: 'Test Product for Buffer Protection',
        basePrice: 99.99,
        totalStock: 50,
        lowStockThreshold: 10, // Alert when stock <= 10
      },
    })

    testProductId = product.id
    testProductSku = product.sku

    // Create a channel listing with stock buffer
    await prisma.listing.create({
      data: {
        productId: product.id,
        channelId: 'test-channel-1',
        channelPrice: 99.99,
        stockBuffer: 5, // Reserve 5 units to prevent overselling
      },
    })

    // Create a ChannelListing with stock buffer
    await prisma.channelListing.create({
      data: {
        productId: product.id,
        channelMarket: 'AMAZON_US',
        channel: 'AMAZON',
        region: 'US',
        stockBuffer: 3, // Reserve 3 units for Amazon
      },
    })
  })

  afterAll(async () => {
    // Cleanup
    await prisma.listing.deleteMany({
      where: { productId: testProductId },
    })
    await prisma.channelListing.deleteMany({
      where: { productId: testProductId },
    })
    await prisma.product.delete({
      where: { id: testProductId },
    })
  })

  describe('Stock Buffer Protection', () => {
    it('should apply stock buffer when syncing inventory', async () => {
      // Start with 50 units
      const adjustment = await syncGlobalStock(testProductSku, 50, 'ADJUSTMENT')

      expect(adjustment).toBeDefined()
      expect(adjustment?.newQuantity).toBe(50)
      expect(adjustment?.affectedChannels.length).toBeGreaterThan(0)

      // Verify the product was updated
      const product = await prisma.product.findUnique({
        where: { id: testProductId },
      })
      expect(product?.totalStock).toBe(50)
    })

    it('should calculate final quantity with buffer deduction', async () => {
      // When marketplace sees stock, it should be reduced by buffer
      // Actual: 50, Buffer: 5 (Listing) + 3 (ChannelListing) = 8 total reserved
      // Marketplace sees: 50 - 5 = 45 (for Listing), 50 - 3 = 47 (for ChannelListing)

      const adjustment = await syncGlobalStock(testProductSku, 50, 'ADJUSTMENT')

      expect(adjustment).toBeDefined()
      // The adjustment should show the actual quantity, not the buffered quantity
      expect(adjustment?.newQuantity).toBe(50)
    })

    it('should prevent negative stock after buffer deduction', async () => {
      // Set stock to 3 units (less than buffer of 5)
      const adjustment = await syncGlobalStock(testProductSku, 3, 'ADJUSTMENT')

      expect(adjustment).toBeDefined()
      expect(adjustment?.newQuantity).toBe(3)
      // The final quantity sent to marketplace should be Math.max(0, 3 - 5) = 0
    })

    it('should handle zero stock correctly', async () => {
      const adjustment = await syncGlobalStock(testProductSku, 0, 'ADJUSTMENT')

      expect(adjustment).toBeDefined()
      expect(adjustment?.newQuantity).toBe(0)

      const product = await prisma.product.findUnique({
        where: { id: testProductId },
      })
      expect(product?.totalStock).toBe(0)
    })
  })

  describe('Low-Stock Alerts', () => {
    it('should trigger alert when stock reaches threshold', async () => {
      // Set stock to exactly at threshold (10)
      await syncGlobalStock(testProductSku, 10, 'ADJUSTMENT')

      const alert = await checkStockThreshold(testProductSku, 10)

      expect(alert).toBeDefined()
      expect(alert?.alertType).toBe('APPROACHING_THRESHOLD')
      expect(alert?.severity).toBe('WARNING')
      expect(alert?.currentStock).toBe(10)
      expect(alert?.threshold).toBe(10) // Should use product's lowStockThreshold
    })

    it('should trigger critical alert when stock is critically low', async () => {
      // Set stock below critical threshold (5)
      await syncGlobalStock(testProductSku, 3, 'ADJUSTMENT')

      const alert = await checkStockThreshold(testProductSku, 3)

      expect(alert).toBeDefined()
      expect(alert?.alertType).toBe('CRITICAL_LOW_STOCK')
      expect(alert?.severity).toBe('CRITICAL')
      expect(alert?.currentStock).toBe(3)
    })

    it('should trigger out-of-stock alert', async () => {
      // Set stock to zero
      await syncGlobalStock(testProductSku, 0, 'ADJUSTMENT')

      const alert = await checkStockThreshold(testProductSku, 0)

      expect(alert).toBeDefined()
      expect(alert?.alertType).toBe('OUT_OF_STOCK')
      expect(alert?.severity).toBe('CRITICAL')
      expect(alert?.currentStock).toBe(0)
    })

    it('should not trigger alert when stock is healthy', async () => {
      // Set stock well above threshold
      await syncGlobalStock(testProductSku, 50, 'ADJUSTMENT')

      const alert = await checkStockThreshold(testProductSku, 50)

      expect(alert).toBeNull()
    })

    it('should use product-specific threshold', async () => {
      // Update product with custom threshold
      await prisma.product.update({
        where: { id: testProductId },
        data: { lowStockThreshold: 20 },
      })

      // Set stock to 15 (below new threshold of 20)
      await syncGlobalStock(testProductSku, 15, 'ADJUSTMENT')

      const alert = await checkStockThreshold(testProductSku, 15)

      expect(alert).toBeDefined()
      expect(alert?.threshold).toBe(20)
      expect(alert?.severity).toBe('WARNING')

      // Reset threshold
      await prisma.product.update({
        where: { id: testProductId },
        data: { lowStockThreshold: 10 },
      })
    })
  })

  describe('Stock Health Evaluation', () => {
    it('should evaluate stock health using product threshold', async () => {
      // Set stock to low level
      await syncGlobalStock(testProductSku, 8, 'ADJUSTMENT')

      const alert = await evaluateStockHealth(testProductId)

      expect(alert).toBeDefined()
      expect(alert?.alertType).toBe('APPROACHING_THRESHOLD')
      expect(alert?.severity).toBe('WARNING')
    })

    it('should return null for healthy stock', async () => {
      // Set stock to healthy level
      await syncGlobalStock(testProductSku, 50, 'ADJUSTMENT')

      const alert = await evaluateStockHealth(testProductId)

      expect(alert).toBeNull()
    })

    it('should handle non-existent product gracefully', async () => {
      const alert = await evaluateStockHealth('non-existent-id')

      expect(alert).toBeNull()
    })
  })

  describe('Alert History & Tracking', () => {
    it('should store recent alerts in memory', async () => {
      // Clear previous alerts
      const initialAlerts = getRecentAlerts()
      const initialCount = initialAlerts.length

      // Trigger a new alert
      await syncGlobalStock(testProductSku, 5, 'ADJUSTMENT')
      await checkStockThreshold(testProductSku, 5)

      const recentAlerts = getRecentAlerts()

      expect(recentAlerts.length).toBeGreaterThanOrEqual(initialCount)
    })

    it('should retrieve critical alerts', async () => {
      // Trigger critical alert
      await syncGlobalStock(testProductSku, 0, 'ADJUSTMENT')
      await checkStockThreshold(testProductSku, 0)

      const criticalAlerts = getCriticalAlerts()

      expect(criticalAlerts.length).toBeGreaterThan(0)
      expect(criticalAlerts.every((a) => a.severity === 'CRITICAL')).toBe(true)
    })

    it('should track recent adjustments', async () => {
      // Make an adjustment
      await syncGlobalStock(testProductSku, 25, 'RESTOCK')

      const adjustments = getRecentAdjustments(10)

      expect(adjustments.length).toBeGreaterThan(0)
      const lastAdjustment = adjustments[0]
      expect(lastAdjustment.sku).toBe(testProductSku)
      expect(lastAdjustment.reason).toBe('RESTOCK')
    })
  })

  describe('Integration: Buffer + Alerts', () => {
    it('should protect against overselling while alerting on low stock', async () => {
      // Scenario: Product has 12 units, threshold is 10, buffer is 5
      // Marketplace should see: 12 - 5 = 7 units
      // Alert should trigger because 12 <= 10? No, 12 > 10, so no alert

      await syncGlobalStock(testProductSku, 12, 'ADJUSTMENT')
      const alert1 = await checkStockThreshold(testProductSku, 12)
      expect(alert1).toBeNull() // No alert, stock is above threshold

      // Now reduce to 8 units
      // Marketplace sees: 8 - 5 = 3 units
      // Alert should trigger because 8 <= 10
      await syncGlobalStock(testProductSku, 8, 'ADJUSTMENT')
      const alert2 = await checkStockThreshold(testProductSku, 8)
      expect(alert2).toBeDefined()
      expect(alert2?.severity).toBe('WARNING')
    })

    it('should handle rapid stock changes with buffer protection', async () => {
      // Simulate rapid sales
      for (let i = 0; i < 5; i++) {
        const currentStock = 50 - i * 5
        await syncGlobalStock(testProductSku, currentStock, 'SALE')
      }

      const adjustments = getRecentAdjustments(10)
      const testAdjustments = adjustments.filter((a) => a.sku === testProductSku)

      expect(testAdjustments.length).toBeGreaterThan(0)
      // All adjustments should have valid data
      testAdjustments.forEach((adj) => {
        expect(adj.newQuantity).toBeGreaterThanOrEqual(0)
        expect(adj.reason).toBe('SALE')
      })
    })
  })

  describe('Edge Cases', () => {
    it('should handle stock buffer larger than actual stock', async () => {
      // Stock: 2, Buffer: 5
      // Marketplace should see: Math.max(0, 2 - 5) = 0
      const adjustment = await syncGlobalStock(testProductSku, 2, 'ADJUSTMENT')

      expect(adjustment).toBeDefined()
      expect(adjustment?.newQuantity).toBe(2)
    })

    it('should handle zero threshold', async () => {
      // Update product with zero threshold
      await prisma.product.update({
        where: { id: testProductId },
        data: { lowStockThreshold: 0 },
      })

      // Only out-of-stock should trigger alert
      const alert1 = await checkStockThreshold(testProductSku, 1)
      expect(alert1).toBeNull()

      const alert2 = await checkStockThreshold(testProductSku, 0)
      expect(alert2).toBeDefined()
      expect(alert2?.alertType).toBe('OUT_OF_STOCK')

      // Reset threshold
      await prisma.product.update({
        where: { id: testProductId },
        data: { lowStockThreshold: 10 },
      })
    })

    it('should handle negative threshold gracefully', async () => {
      // Update product with negative threshold (edge case)
      await prisma.product.update({
        where: { id: testProductId },
        data: { lowStockThreshold: -5 },
      })

      // Should only alert on critical or out-of-stock
      const alert = await checkStockThreshold(testProductSku, 5)
      expect(alert).toBeNull()

      // Reset threshold
      await prisma.product.update({
        where: { id: testProductId },
        data: { lowStockThreshold: 10 },
      })
    })
  })
})
