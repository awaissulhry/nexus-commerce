/**
 * IH-series — /api/insights/* route namespace.
 *
 * IH.0 registers:
 *   GET  /api/insights/summary   — KPI strip backing /insights landing
 *   GET  /api/insights/ping      — wiring smoke test
 *
 * Subsequent phases (IH.2 sales, IH.3 profit, IH.4 ads, …) layer
 * additional endpoints onto this namespace. Cache headers mirror the
 * dashboard route family: 30s private cache + 60s stale-while-revalidate
 * so quick navigation between insight tabs feels instant while real
 * mutations propagate within ~2s via SSE.
 */

import type { FastifyPluginAsync } from 'fastify'
import { parseInsightsFilters } from '../services/insights/index.js'
import { computeInsightsSummary } from '../services/insights/insights-summary.service.js'
import { computeInsightsBreakdown } from '../services/insights/insights-breakdown.service.js'
import { computeTopSKUs } from '../services/insights/insights-top-skus.service.js'
import { computeWhatChanged } from '../services/insights/insights-what-changed.service.js'
import {
  computeSalesReport,
  salesReportToCsv,
} from '../services/insights/insights-sales.service.js'
import {
  computeProfitReport,
  profitReportToCsv,
} from '../services/insights/insights-profit.service.js'
import {
  computeAdvertisingReport,
  advertisingReportToCsv,
} from '../services/insights/insights-advertising.service.js'
import {
  computeProductReport,
  productReportToCsv,
} from '../services/insights/insights-products.service.js'
import {
  computeCustomerReport,
  customerReportToCsv,
} from '../services/insights/insights-customers.service.js'
import {
  computeInventoryReport,
  inventoryReportToCsv,
} from '../services/insights/insights-inventory.service.js'
import {
  computeFiscalReport,
  fiscalReportToCsv,
} from '../services/insights/insights-fiscal.service.js'

const insightsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/insights/ping', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=5')
    return { ok: true, ts: new Date().toISOString() }
  })

  fastify.get('/insights/summary', async (request, reply) => {
    reply.header(
      'Cache-Control',
      'private, max-age=30, stale-while-revalidate=60',
    )
    const filters = parseInsightsFilters(request)
    try {
      const summary = await computeInsightsSummary(filters)
      return summary
    } catch (err) {
      request.log.error({ err }, 'insights.summary failed')
      reply.code(500)
      return { error: 'insights_summary_failed' }
    }
  })

  fastify.get('/insights/breakdown', async (request, reply) => {
    reply.header(
      'Cache-Control',
      'private, max-age=30, stale-while-revalidate=60',
    )
    const filters = parseInsightsFilters(request)
    try {
      return await computeInsightsBreakdown(filters)
    } catch (err) {
      request.log.error({ err }, 'insights.breakdown failed')
      reply.code(500)
      return { error: 'insights_breakdown_failed' }
    }
  })

  fastify.get<{ Querystring: { limit?: string } }>(
    '/insights/top-skus',
    async (request, reply) => {
      reply.header(
        'Cache-Control',
        'private, max-age=30, stale-while-revalidate=60',
      )
      const filters = parseInsightsFilters(request)
      const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 10)))
      try {
        return { rows: await computeTopSKUs(filters, limit) }
      } catch (err) {
        request.log.error({ err }, 'insights.top-skus failed')
        reply.code(500)
        return { error: 'insights_top_skus_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/sales',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeSalesReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-sales-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return salesReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.sales failed')
        reply.code(500)
        return { error: 'insights_sales_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/profit',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeProfitReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-profit-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return profitReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.profit failed')
        reply.code(500)
        return { error: 'insights_profit_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/advertising',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeAdvertisingReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-advertising-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return advertisingReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.advertising failed')
        reply.code(500)
        return { error: 'insights_advertising_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/products',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeProductReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-products-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return productReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.products failed')
        reply.code(500)
        return { error: 'insights_products_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/customers',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeCustomerReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-customers-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return customerReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.customers failed')
        reply.code(500)
        return { error: 'insights_customers_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/inventory',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeInventoryReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-inventory-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return inventoryReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.inventory failed')
        reply.code(500)
        return { error: 'insights_inventory_failed' }
      }
    },
  )

  fastify.get<{ Querystring: { format?: string } }>(
    '/insights/fiscal',
    async (request, reply) => {
      const filters = parseInsightsFilters(request)
      try {
        const report = await computeFiscalReport(filters)
        if (request.query.format === 'csv') {
          reply.header('Content-Type', 'text/csv; charset=utf-8')
          reply.header(
            'Content-Disposition',
            `attachment; filename="insights-fiscal-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          reply.header('Cache-Control', 'private, no-store')
          return fiscalReportToCsv(report)
        }
        reply.header(
          'Cache-Control',
          'private, max-age=30, stale-while-revalidate=60',
        )
        return report
      } catch (err) {
        request.log.error({ err }, 'insights.fiscal failed')
        reply.code(500)
        return { error: 'insights_fiscal_failed' }
      }
    },
  )

  fastify.get('/insights/what-changed', async (request, reply) => {
    reply.header(
      'Cache-Control',
      'private, max-age=30, stale-while-revalidate=60',
    )
    const filters = parseInsightsFilters(request)
    try {
      return await computeWhatChanged(filters)
    } catch (err) {
      request.log.error({ err }, 'insights.what-changed failed')
      reply.code(500)
      return { error: 'insights_what_changed_failed' }
    }
  })
}

export default insightsRoutes
