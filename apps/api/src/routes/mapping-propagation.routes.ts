/**
 * FM.5 — catalog propagation preview API (read-only).
 *
 *   POST /api/products/:id/mapping/propagate-preview
 *     Body: { changes: { <masterAttr>: <newValue>, ... }, channels?, markets?,
 *             locale?, sourceMarketplace? }
 *     → MappingPropagationPlan: per-(channel, marketplace, fieldKey) diff of
 *       current → proposed with flags (transformed / needsTranslation /
 *       channelLimitTrimmed / currencyMismatch / unmappedRequired). No writes.
 */

import type { FastifyPluginAsync } from 'fastify'
import { planMappingPropagation } from '../services/pim/mapping-propagation.service.js'
import { applyCatalogCascade } from '../services/pim/apply-mapping.service.js'

const mappingPropagationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string }
    Body: {
      changes: Record<string, unknown>
      channels?: string[]
      markets?: string[]
      locale?: string
      sourceMarketplace?: string
    }
  }>('/products/:id/mapping/propagate-preview', async (request, reply) => {
    const { id } = request.params
    const b = request.body
    if (
      !b?.changes ||
      typeof b.changes !== 'object' ||
      Array.isArray(b.changes) ||
      Object.keys(b.changes).length === 0
    ) {
      return reply.status(400).send({ error: 'changes (non-empty object of attribute → value) is required' })
    }
    try {
      const plan = await planMappingPropagation({
        productId: id,
        changes: b.changes,
        channels: b.channels,
        markets: b.markets,
        locale: b.locale,
        sourceMarketplace: b.sourceMarketplace,
      })
      return reply.send(plan)
    } catch (err: any) {
      const msg = err?.message ?? 'preview failed'
      if (msg.startsWith('Product not found')) return reply.status(404).send({ error: msg })
      request.log.error({ err }, 'mapping propagate-preview failed')
      return reply.status(500).send({ error: msg })
    }
  })

  // FM.6 — apply the cascade: persist translations (both stores), enqueue
  // pushes (holdUntil undo), audit. Price fields stay with master-price.
  fastify.post<{
    Params: { id: string }
    Body: {
      changes: Record<string, unknown>
      channels?: string[]
      markets?: string[]
      locale?: string
      sourceMarketplace?: string
      reason?: string
      applyGrace?: boolean
    }
  }>('/products/:id/mapping/apply', async (request, reply) => {
    const { id } = request.params
    const b = request.body
    if (
      !b?.changes ||
      typeof b.changes !== 'object' ||
      Array.isArray(b.changes) ||
      Object.keys(b.changes).length === 0
    ) {
      return reply.status(400).send({ error: 'changes (non-empty object of attribute → value) is required' })
    }
    try {
      const result = await applyCatalogCascade(
        {
          productId: id,
          changes: b.changes,
          channels: b.channels,
          markets: b.markets,
          locale: b.locale,
          sourceMarketplace: b.sourceMarketplace,
        },
        { actor: (request as any).user?.id ?? null, reason: b.reason ?? 'editor-cascade', applyGrace: b.applyGrace },
      )
      return reply.send(result)
    } catch (err: any) {
      const msg = err?.message ?? 'apply failed'
      if (msg.startsWith('Product not found')) return reply.status(404).send({ error: msg })
      request.log.error({ err }, 'mapping apply failed')
      return reply.status(500).send({ error: msg })
    }
  })
}

export default mappingPropagationRoutes
