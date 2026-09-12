import type { FastifyPluginAsync } from 'fastify'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'
import { ebayMediaWorkspace } from '../../services/images/ebay-media-workspace.service.js'

type Request = { Params: { productId: string }; Querystring: { market?: string; accountId?: string; listingId?: string }; Body: unknown }

export const ebayMediaWorkspaceRoutes: FastifyPluginAsync = async app => {
  for (const method of ['GET', 'PUT'] as const) {
    app.route<Request>({ method, url: '/products/:productId/images-workspace/ebay', handler: async (request, reply) => {
      try {
        return await ebayMediaWorkspace(request.params.productId, request.query, method, request.body)
      } catch (error) {
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        request.log.error({ err: error }, 'eBay media workspace failed')
        return reply.code(500).send({ error: method === 'PUT'
          ? 'The save result could not be confirmed. Keep your edits and reload the saved gallery before retrying.'
          : 'The gallery could not be loaded. Please retry.' })
      }
    } })
  }
}
