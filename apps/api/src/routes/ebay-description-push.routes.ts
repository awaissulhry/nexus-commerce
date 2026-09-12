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
import { executePresentationPublication, getPresentationPublication, reviewPresentationPublication } from '../services/ebay-presentation-publication.service.js'
import type { PresentationDestinationInput } from '../services/ebay-presentation-order.service.js'
import { MappingConflict } from '../services/pim/mapping/revision-token.js'
import { collectInventoryDrift } from '../services/ebay-inventory-drift.service.js'
import { relinkEbayItemId } from '../services/ebay-itemid-relink.service.js'
import { resolveConnection, tryResolveConnection, listActiveConnections } from '../services/connection-resolver.service.js'


export default async function ebayDescriptionPushRoutes(fastify: FastifyInstance) {
  // ── ItemID re-link: verify against eBay, then repair ChannelListing AND
  // SharedListingMembership together. DRY RUN unless apply:true — the response
  // shows the verdict and the exact diff first. See the service header for the
  // VENTRA incident that made stored ItemIDs un-correctable.
  fastify.post<{
    Body: { parentSku?: string; marketplace?: string; itemId?: string; apply?: boolean; acknowledgeUnverifiable?: boolean }
  }>('/ebay/relink-item-id', async (request, reply) => {
    const { parentSku, marketplace = 'IT', itemId, apply, acknowledgeUnverifiable } = request.body ?? {}
    if (!parentSku?.trim()) return reply.code(400).send({ error: 'parentSku required' })
    if (!itemId) return reply.code(400).send({ error: 'itemId required' })
    const mp = String(marketplace).toUpperCase()
    try {
      siteIdForMarket(mp)
    } catch {
      return reply.code(400).send({ error: `unknown marketplace: ${mp}` })
    }
    // MAP.3 — DECLARED. A description push targets a marketplace, not an account.
    const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
    if (!connection) return reply.code(503).send({ error: 'No active eBay connection' })
    let token: string
    try {
      token = await ebayAuthService.getValidToken(connection.id)
    } catch (err: unknown) {
      return reply.code(503).send({ error: `Failed to get eBay token: ${err instanceof Error ? err.message : String(err)}` })
    }
    try {
      const result = await relinkEbayItemId(
        prisma,
        { parentSku: parentSku.trim(), marketplace: mp, itemId: String(itemId), apply: apply === true, acknowledgeUnverifiable: acknowledgeUnverifiable === true },
        { oauthToken: token },
      )
      return reply.send(result)
    } catch (err: unknown) {
      request.log.error(err, 'ebay/relink-item-id failed')
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'relink failed' })
    }
  })

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
      // MAP.3 — DECLARED.
      const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
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

  // The historical endpoint coupled global theme assignment and unscoped marketplace writes.
  // Require the exact destination review; a theme library sample is never an assignment target.
  fastify.post('/ebay/description-push', async (_request, reply) => reply.code(409).send({ error: 'Save the listing theme assignment first, then create and execute a destination-specific presentation publication review', reviewUrl: '/api/ebay/presentation-publications/review' }))

  const actor = (request: any): string | null => request.user?.id ?? request.authUser?.id ?? null
  fastify.post<{ Body: { destinations: PresentationDestinationInput[]; operation: 'order' | 'description' } }>('/ebay/presentation-publications/review', async (request, reply) => {
    try { return await reviewPresentationPublication(request.body?.destinations, request.body?.operation, actor(request)) }
    catch (e) { if (e instanceof MappingConflict) return reply.code(409).send({ error: e.message }); throw e }
  })
  fastify.get<{ Params: { id: string } }>('/ebay/presentation-publications/:id', async (request, reply) => {
    const result = await getPresentationPublication(request.params.id, actor(request))
    return result ?? reply.code(404).send({ error: 'Publication review not found' })
  })
  fastify.post<{ Params: { id: string } }>('/ebay/presentation-publications/:id/execute', async (request, reply) => {
    try { const result = await executePresentationPublication(request.params.id, actor(request)); return result ?? reply.code(404).send({ error: 'Publication review not found' }) }
    catch (e) { if (e instanceof MappingConflict) return reply.code(409).send({ error: e.message }); throw e }
  })
}
