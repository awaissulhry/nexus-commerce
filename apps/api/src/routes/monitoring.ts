/**
 * Monitoring Routes
 * 
 * Endpoints for monitoring, alerting, and health tracking.
 */

import type { FastifyInstance } from 'fastify'
import { MonitoringService } from '../services/monitoring/index.js'

export async function monitoringRoutes(app: FastifyInstance) {
  const monitoringService = new MonitoringService()

  /**
   * POST /monitoring/run
   * Run full monitoring cycle
   */
  app.post('/monitoring/run', async (request, reply) => {
    try {
      const report = await monitoringService.runMonitoring()

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
   * GET /monitoring/health
   * Get current health status
   */
  app.get('/monitoring/health', async (request, reply) => {
    try {
      const health = monitoringService.getCurrentHealth()

      if (!health) {
        return reply.send({
          success: true,
          data: {
            status: 'unknown',
            message: 'No monitoring data available yet',
          },
        })
      }

      const status =
        health.healthScore >= 80
          ? 'healthy'
          : health.healthScore >= 50
            ? 'warning'
            : 'critical'

      return reply.send({
        success: true,
        data: {
          status,
          healthScore: health.healthScore,
          metrics: health,
        },
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
   * GET /monitoring/metrics
   * Get metrics history
   */
  app.get<{ Querystring: { limit?: string } }>(
    '/monitoring/metrics',
    async (request, reply) => {
      try {
        const limit = request.query.limit ? parseInt(request.query.limit) : 100
        const metrics = monitoringService.getMetricsHistory(limit)

        return reply.send({
          success: true,
          data: {
            count: metrics.length,
            metrics,
          },
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
   * GET /monitoring/trend
   * Get health trend over time
   */
  app.get<{ Querystring: { hours?: string } }>(
    '/monitoring/trend',
    async (request, reply) => {
      try {
        const hours = request.query.hours ? parseInt(request.query.hours) : 24
        const trend = monitoringService.getHealthTrend(hours)

        return reply.send({
          success: true,
          data: {
            hours,
            dataPoints: trend.length,
            trend,
          },
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
   * GET /monitoring/alerts/config
   * Get alert configurations
   */
  app.get('/monitoring/alerts/config', async (request, reply) => {
    try {
      const configs = monitoringService.getAlertConfigs()

      return reply.send({
        success: true,
        data: {
          count: configs.length,
          configs,
        },
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
   * PUT /monitoring/alerts/config/:type
   * Update alert configuration
   */
  app.put<{ Params: { type: string }; Body: any }>(
    '/monitoring/alerts/config/:type',
    async (request, reply) => {
      try {
        const { type } = request.params
        const config = request.body

        monitoringService.updateAlertConfig(type as any, config)

        return reply.send({
          success: true,
          message: `Alert configuration updated for ${type}`,
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
   * GET /monitoring/report
   * Get comprehensive monitoring report
   */
  app.get('/monitoring/report', async (request, reply) => {
    try {
      const report = await monitoringService.runMonitoring()

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
}
