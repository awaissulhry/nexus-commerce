/**
 * MB.1 — Brand Brain RAG API.
 *
 *   GET  /api/brand-brain/status       — embedding counts + pgvector health
 *   POST /api/brand-brain/ingest       — trigger full re-index
 *   GET  /api/brand-brain/query?q=...  — nearest-neighbour retrieval (operator test)
 *   POST /api/brand-brain/ingest/:entityType/:id — single-entity ingest
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  getBrainStatus,
  ingestAllPendingContent,
  ingestBrandKit,
  ingestBrandVoice,
  ingestAPlusContent,
  queryBrandBrain,
  type EmbeddingEntityType,
} from '../services/ai/brand-brain.service.js'
import { runEmbeddingIngesterOnce } from '../jobs/embedding-ingester.job.js'

const brandBrainRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/brand-brain/status', async (_request, reply) => {
    const status = await getBrainStatus()
    reply.header('Cache-Control', 'private, max-age=30')
    return status
  })

  fastify.post('/brand-brain/ingest', async (_request, reply) => {
    const summary = await ingestAllPendingContent()
    return { ok: true, summary }
  })

  fastify.post('/brand-brain/cron/embedding-ingester/trigger', async (_request, _reply) => {
    const summary = await runEmbeddingIngesterOnce()
    return { ok: true, summary }
  })

  fastify.post(
    '/brand-brain/ingest/:entityType/:id',
    async (request, reply) => {
      const { entityType, id } = request.params as { entityType: string; id: string }
      let ok = false
      if (entityType === 'BRAND_KIT') ok = await ingestBrandKit(id)
      else if (entityType === 'BRAND_VOICE') ok = await ingestBrandVoice(id)
      else if (entityType === 'APLUS_CONTENT') ok = await ingestAPlusContent(id)
      else {
        reply.code(400)
        return { error: `Unknown entityType: ${entityType}` }
      }
      return { ok, entityType, id }
    },
  )

  fastify.get('/brand-brain/query', async (request, reply) => {
    const q = request.query as { q?: string; entityType?: string; limit?: string }
    if (!q.q?.trim()) {
      reply.code(400)
      return { error: 'q parameter required' }
    }
    const results = await queryBrandBrain(q.q, {
      entityType: q.entityType as EmbeddingEntityType | undefined,
      limit: Math.min(Number(q.limit) || 5, 20),
    })
    return { results, count: results.length }
  })
}

export default brandBrainRoutes
