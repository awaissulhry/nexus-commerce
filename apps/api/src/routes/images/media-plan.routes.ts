import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { MEDIA_LAYERS, mediaOpSchema } from '@nexus/shared/media-plan'
import { applyMediaPlanOps, readMediaWorkspace } from '../../services/images/media-plan.service.js'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'

/** Images rebuild P1 — one read for the Media page, and small edits to one layer (docs/images-studio-rebuild/PLAN.md §6.3). */
const opsBodySchema = z.object({
  address: z.object({
    layer: z.enum(MEDIA_LAYERS),
    channel: z.string().max(32).optional(),
    marketplace: z.string().max(16).optional(),
    accountId: z.string().max(256).optional(),
    aliasKey: z.string().max(256).optional(),
  }).strict(),
  ops: z.array(mediaOpSchema).min(1).max(50),
}).strict()

export const mediaPlanRoutes: FastifyPluginAsync = async app => {
  app.get<{ Params: { productId: string } }>('/products/:productId/media', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { return await readMediaWorkspace(request.params.productId) } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      request.log.error({ err: error }, 'Media read failed')
      return reply.code(500).send({ error: 'Photos could not be loaded. Retry to load them.' })
    }
  })
  app.post<{ Params: { productId: string }; Body: unknown }>('/products/:productId/media/ops', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const body = opsBodySchema.parse(request.body)
      return await applyMediaPlanOps(request.params.productId, body, request.authUser?.id ?? null)
    } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      if (error instanceof z.ZodError) return reply.code(422).send({ error: 'This photo change is not valid. Reload the page and try again.' })
      request.log.error({ err: error }, 'Media edit failed')
      return reply.code(500).send({ error: 'The change could not be confirmed. Reload the page before trying again.' })
    }
  })
}
