import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { productMediaQuerySchema } from '@nexus/shared/product-media'
import { readProductMedia, saveProductMedia, copyProductMedia } from '../../services/images/product-media.service.js'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'

export const productMediaRoutes: FastifyPluginAsync = async app => {
  app.route<{ Params: { productId: string }; Querystring: unknown; Body: unknown }>({
    method: ['GET', 'PUT'], url: '/products/:productId/product-media', handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      try {
        const input = { ...productMediaQuerySchema.parse(request.query), productId: request.params.productId }
        return request.method === 'GET' ? await readProductMedia(input)
          : request.body && typeof request.body === 'object' && 'source' in request.body ? await copyProductMedia(input, request.body) : await saveProductMedia(input, request.body)
      } catch (error) {
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        if (error instanceof z.ZodError) return reply.code(422).send({ error: 'The media data or destination is invalid. Reload the gallery and check the selected language and listing.' })
        request.log.error({ err: error }, 'Product media request failed')
        return reply.code(500).send({ error: request.method === 'GET' ? 'Media could not be loaded. Retry to load the gallery.' : 'The save result could not be confirmed. Reload the gallery before retrying.' })
      }
    },
  })
}
