/**
 * Approvals grid (docs/approvals-grid/PLAN.md §8 wave 1, agent A) — the one queue's reads.
 *
 *   GET /api/agent/fleet/approvals/queue?show=open|done|all&cursor=&limit=   (limit 100 by default, 200 at most)
 *   GET /api/agent/fleet/approvals/queue/counts                              the health strip and the nav badge
 *   GET /api/agent/fleet/approvals/queue/:id                                 the drawer
 *
 * The contract is packages/shared/approval-queue.ts; everything is built in services/agent-fleet/approval-queue.service.ts.
 * Permissions: under /api/agent/, so ai.view for these reads (permissions-manifest.ts), as the other approvals reads.
 * What a viewer may approve, and the money in a preview, are worked out for the signed-in person (`inboxViewer`).
 */
import type { FastifyPluginAsync } from 'fastify'
import { inboxViewer } from '../services/agent-fleet/approval-inbox.service.js'
import { queueCounts, queueDetail, queuePage, QueueQueryError } from '../services/agent-fleet/approval-queue.service.js'

const approvalQueueRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { show?: string; cursor?: string; limit?: string } }>('/agent/fleet/approvals/queue', async (request, reply) => {
    try {
      return await queuePage(request.query ?? {}, await inboxViewer(request))
    } catch (error) {
      if (error instanceof QueueQueryError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })

  fastify.get('/agent/fleet/approvals/queue/counts', async () => queueCounts())

  fastify.get<{ Params: { id: string } }>('/agent/fleet/approvals/queue/:id', async (request, reply) => {
    const detail = await queueDetail(request.params.id, await inboxViewer(request))
    if (!detail) return reply.code(404).send({ error: 'approval not found' })
    return detail
  })
}

export default approvalQueueRoutes
