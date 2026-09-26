import type { FastifyPluginAsync } from 'fastify'
import { WorkspaceScopeError } from '../services/pim/workspace-destination.js'
import { publicLiveRead, readLiveListing } from '../services/live-read/index.js'

/**
 * Read live (Owner, 2026-09-26): GET what one channel × market × account × listing alias holds right now. Read only — it
 * never changes a listing and never stores anything as Nexus data. A GET, so it needs only the product-view permission.
 */
const liveReadRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { productId: string }; Querystring: { channel?: string; marketplace?: string; accountId?: string; aliasKey?: string } }>(
    '/products/:productId/live-read', async (request, reply) => {
      const { channel, marketplace, accountId, aliasKey } = request.query
      if (!channel?.trim() || !marketplace?.trim() || !accountId?.trim()) return reply.code(400).send({ error: 'Choose a channel, market and account.' })
      try {
        return publicLiveRead(await readLiveListing(request.params.productId,
          { channel: channel.trim().toUpperCase(), marketplace: marketplace.trim().toUpperCase(), accountId: accountId.trim(), aliasKey: aliasKey?.trim() || undefined }))
      } catch (error) {
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        request.log.error({ err: error }, 'Live read failed')
        return reply.code(502).send({ error: 'The channel could not be read. Nothing was changed.' })
      }
    })
}

export default liveReadRoutes
