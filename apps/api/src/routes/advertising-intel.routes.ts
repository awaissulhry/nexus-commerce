/**
 * Apex C.2 — advertising intelligence routes (profit-native target ACOS).
 *
 * Kept in a SEPARATE plugin from advertising.routes.ts on purpose: that file
 * carries a € literal that trips plain grep into binary mode, and it sees heavy
 * concurrent edits — new read-only intel endpoints are safer here. Registered
 * under the same /api prefix.
 */

import type { FastifyPluginAsync } from 'fastify'
import { computeProductTargetAcos, computeFleetTargetAcos, type AcosMode } from '../services/advertising/ads-target-acos.service.js'

const advertisingIntelRoutes: FastifyPluginAsync = async (fastify) => {
  // Per-product profit-native target ACOS + break-even + TACOS/TACoP.
  fastify.get('/advertising/target-acos', async (request, reply) => {
    const q = request.query as { productId?: string; marketplace?: string; windowDays?: string; mode?: string }
    if (!q.productId) { reply.status(400); return { error: 'productId required' } }
    const result = await computeProductTargetAcos({
      productId: q.productId,
      marketplace: q.marketplace ?? null,
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      mode: (q.mode as AcosMode) ?? undefined,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return result
  })

  // Fleet view — every advertised product's target ACOS, revenue-ranked.
  fastify.get('/advertising/target-acos/fleet', async (request, reply) => {
    const q = request.query as { marketplace?: string; windowDays?: string; mode?: string }
    const items = await computeFleetTargetAcos({
      marketplace: q.marketplace ?? null,
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      mode: (q.mode as AcosMode) ?? undefined,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return { items, count: items.length }
  })
}

export default advertisingIntelRoutes
