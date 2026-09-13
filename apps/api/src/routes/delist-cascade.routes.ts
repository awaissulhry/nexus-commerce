import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { cancelDelistCascade } from '../services/outbound-enqueue.js'
import { assertRequestPermission, requestUserId } from '../lib/auth/request-permission.js'

/** Cancel channel work only; the already-purged local product is not restored. */
export const delistCascadeRoutes: FastifyPluginAsync = async app => {
  app.post('/products/delist-cascade/cancel', {
    preHandler: async request => assertRequestPermission(request, 'products.delete'),
  }, async (request, reply) => {
    const body = request.body as { queueIds?: unknown } | null
    if (!Array.isArray(body?.queueIds) || body.queueIds.length === 0 || body.queueIds.length > 1000
      || body.queueIds.some(id => typeof id !== 'string' || !id.trim())) {
      return reply.code(400).send({ error: 'queueIds must contain between 1 and 1000 nonempty queue IDs.' })
    }
    const queueIds = [...new Set(body.queueIds as string[])]
    const actor = requestUserId(request)
    const cancelled = await cancelDelistCascade(prisma, queueIds, actor)
    return { cancelled, notCancelled: queueIds.filter(id => !cancelled.includes(id)) }
  })
}
