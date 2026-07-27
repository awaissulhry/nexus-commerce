/**
 * ED v2 Phase 4a — description-only push endpoint.
 *
 * POST /api/ebay/description-push { productIds, marketplace?, themeId? }
 *   → revises Description (ONLY Description) on every live eBay listing of
 *     each product's family: adopted Trading listings get a minimal
 *     ReviseFixedPriceItem with a per-listing themed body (operator decision
 *     D5) + a GetItem parity read-back; Inventory-managed primaries report an
 *     explicit skip pointing at the safe Full Publish path.
 *
 * Auth mirrors the flat-file reconcile-item route: active eBay connection →
 * ebayAuthService token. Writes go through callTradingApi, which refuses in
 * production unless NEXUS_EBAY_REAL_API is enabled. The /api/ebay prefix
 * already maps to RBAC channelsSync for writes.
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { ebayAuthService } from '../services/ebay-auth.service.js'
import { siteIdForMarket } from '../services/ebay-trading-api.service.js'
import { pushDescriptions } from '../services/ebay-description-push.service.js'
import { collectInventoryDrift } from '../services/ebay-inventory-drift.service.js'

const MAX_PRODUCTS_PER_CALL = 50

export default async function ebayDescriptionPushRoutes(fastify: FastifyInstance) {
  // ── READ-ONLY diagnostic: how far has each Inventory-managed family's live
  // inventory_item_group drifted from what a Full Publish would re-assert?
  // Lane A can't take a description-only revise, so operators are sent to Full
  // Publish — which rewrites the whole group. This measures whether that is a
  // real risk before anyone touches that write path. GETs only; no writes to
  // eBay or the DB. Maps to listingsView under the /api/ebay RBAC prefix.
  fastify.get<{ Querystring: { marketplace?: string } }>(
    '/ebay/inventory-drift',
    async (request, reply) => {
      const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
      try {
        siteIdForMarket(marketplace)
      } catch {
        return reply.code(400).send({ error: `unknown marketplace: ${marketplace}` })
      }
      const connection = await prisma.channelConnection.findFirst({
        where: { channelType: 'EBAY', isActive: true },
        select: { id: true },
      })
      if (!connection) return reply.code(503).send({ error: 'No active eBay connection' })
      let token: string
      try {
        token = await ebayAuthService.getValidToken(connection.id)
      } catch (err: unknown) {
        return reply
          .code(503)
          .send({ error: `Failed to get eBay token: ${err instanceof Error ? err.message : String(err)}` })
      }
      try {
        return reply.send(await collectInventoryDrift(prisma, { marketplace, oauthToken: token }))
      } catch (err: unknown) {
        request.log.error(err, 'ebay/inventory-drift failed')
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'drift check failed' })
      }
    },
  )

  fastify.post<{ Body: { productIds?: unknown; marketplace?: string; themeId?: string } }>(
    '/ebay/description-push',
    async (request, reply) => {
      const rawIds = request.body?.productIds
      const productIds = Array.isArray(rawIds)
        ? [...new Set(rawIds.map((p) => String(p).trim()).filter(Boolean))]
        : []
      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds (non-empty string[]) required' })
      }
      if (productIds.length > MAX_PRODUCTS_PER_CALL) {
        return reply.code(400).send({ error: `too many products — max ${MAX_PRODUCTS_PER_CALL} per call` })
      }
      const marketplace = String(request.body?.marketplace ?? 'IT').toUpperCase()
      try {
        siteIdForMarket(marketplace)
      } catch {
        return reply.code(400).send({ error: `unknown marketplace: ${marketplace}` })
      }
      const themeId =
        typeof request.body?.themeId === 'string' && request.body.themeId.trim()
          ? request.body.themeId.trim()
          : undefined
      // A typo'd themeId must fail loudly HERE — the renderer silently falls
      // back to the raw body for unknown ids, which would push unthemed
      // descriptions live while looking like success.
      if (themeId && themeId !== 'none') {
        const theme = await prisma.ebayDescriptionTheme.findUnique({ where: { id: themeId } })
        if (!theme) return reply.code(400).send({ error: `unknown themeId: ${themeId}` })
        if (!theme.active) return reply.code(400).send({ error: `theme "${theme.name}" is inactive` })
      }

      const connection = await prisma.channelConnection.findFirst({
        where: { channelType: 'EBAY', isActive: true },
        select: { id: true },
      })
      if (!connection) return reply.code(503).send({ error: 'No active eBay connection' })
      let token: string
      try {
        token = await ebayAuthService.getValidToken(connection.id)
      } catch (err: unknown) {
        return reply
          .code(503)
          .send({ error: `Failed to get eBay token: ${err instanceof Error ? err.message : String(err)}` })
      }

      try {
        const result = await pushDescriptions(
          { productIds, marketplace, themeId },
          { prisma, oauthToken: token, log: request.log },
        )
        return reply.send(result)
      } catch (err: unknown) {
        request.log.error(err, 'ebay/description-push failed')
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : 'Description push failed' })
      }
    },
  )
}
