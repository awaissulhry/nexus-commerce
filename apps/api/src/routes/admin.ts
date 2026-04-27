/**
 * Admin Routes
 * 
 * Protected endpoints for administrative operations:
 * - Data validation and repair
 * - Batch operations
 * - System diagnostics
 */

import type { FastifyInstance } from 'fastify'
import { DataValidationService } from '../services/sync/data-validation.service.js'
import { BatchRepairService } from '../services/sync/batch-repair.service.js'

export async function adminRoutes(app: FastifyInstance) {
  const validationService = new DataValidationService()
  const repairService = new BatchRepairService()

  /**
   * GET /admin/validation/report
   * Get comprehensive validation report for all products
   */
  app.get('/admin/validation/report', async (request, reply) => {
    try {
      const report = await validationService.validateAllProducts()

      return reply.send({
        success: true,
        data: report,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * GET /admin/validation/product/:productId
   * Validate a specific product
   */
  app.get<{ Params: { productId: string } }>(
    '/admin/validation/product/:productId',
    async (request, reply) => {
      try {
        const { productId } = request.params
        const report = await validationService.validateProduct(productId)

        return reply.send({
          success: true,
          data: report,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return reply.status(500).send({
          success: false,
          error: message,
        })
      }
    }
  )

  /**
   * POST /admin/repair/all
   * Run all batch repair operations
   */
  app.post('/admin/repair/all', async (request, reply) => {
    try {
      const result = await repairService.repairAll()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/orphaned-variations
   * Remove variations without products
   */
  app.post('/admin/repair/orphaned-variations', async (request, reply) => {
    try {
      const result = await repairService.repairOrphanedVariations()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/missing-themes
   * Infer and set variation themes for products
   */
  app.post('/admin/repair/missing-themes', async (request, reply) => {
    try {
      const result = await repairService.repairMissingVariationThemes()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/missing-attributes
   * Populate variation attributes from legacy fields
   */
  app.post('/admin/repair/missing-attributes', async (request, reply) => {
    try {
      const result = await repairService.repairMissingVariationAttributes()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/product-status
   * Ensure all products have valid status
   */
  app.post('/admin/repair/product-status', async (request, reply) => {
    try {
      const result = await repairService.repairProductStatus()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/channel-listings
   * Fix inconsistent channel listings
   */
  app.post('/admin/repair/channel-listings', async (request, reply) => {
    try {
      const result = await repairService.repairInconsistentChannelListings()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * GET /admin/health
   * System health check
   */
  app.get('/admin/health', async (request, reply) => {
    try {
      const report = await validationService.validateAllProducts()

      const health = {
        status: 'healthy',
        timestamp: new Date(),
        issues: {
          orphanedVariants: report.orphanedVariants,
          inconsistentThemes: report.inconsistentThemes,
          missingAttributes: report.missingAttributes,
          invalidChannelListings: report.invalidChannelListings,
        },
        totalIssues:
          report.orphanedVariants +
          report.inconsistentThemes +
          report.missingAttributes +
          report.invalidChannelListings,
      }

      if (health.totalIssues > 0) {
        health.status = 'warning'
      }

      return reply.send(health)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        status: 'unhealthy',
        error: message,
      })
    }
  })
}
