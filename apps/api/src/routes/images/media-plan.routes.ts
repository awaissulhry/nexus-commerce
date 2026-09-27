import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { MEDIA_LAYERS, mediaOpSchema } from '@nexus/shared/media-plan'
import { applyMediaPlanOps, MEDIA_LANGUAGE, readMediaWorkspace, updateMediaLibrary } from '../../services/images/media-plan.service.js'
import { previewMediaSwitch, switchToMediaPlan } from '../../services/images/media-plan-seed.service.js'
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

const id = z.string().min(1).max(64)
const libraryBodySchema = z.object({
  languages: z.array(z.object({ id, languageTag: z.string().regex(MEDIA_LANGUAGE) }).strict()).max(200),
  groups: z.array(z.object({ ids: z.array(id).min(1).max(20), join: id.nullish() }).strict()).max(100),
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
  // P4b — the upload dialog's reading of the file names: each photo's language, and which photos are versions of one.
  app.patch<{ Params: { productId: string }; Body: unknown }>('/products/:productId/media/library', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      return await updateMediaLibrary(request.params.productId, libraryBodySchema.parse(request.body))
    } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      if (error instanceof z.ZodError) return reply.code(422).send({ error: 'These photo languages are not valid. Reload the page and try again.' })
      request.log.error({ err: error }, 'Media library update failed')
      return reply.code(500).send({ error: 'The photo languages could not be saved. Reload the page before trying again.' })
    }
  })
  // P3a — move one family onto the plan: a preview that writes nothing, then the switch bound to that preview.
  app.get<{ Params: { productId: string } }>('/products/:productId/media/switch-preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { return await previewMediaSwitch(request.params.productId) } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      request.log.error({ err: error }, 'Media switch preview failed')
      return reply.code(500).send({ error: 'The preview could not be built. Retry.' })
    }
  })
  app.post<{ Params: { productId: string }; Body: unknown }>('/products/:productId/media/switch', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const body = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body)
      return await switchToMediaPlan(request.params.productId, body, request.authUser?.id ?? null)
    } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      if (error instanceof z.ZodError) return reply.code(422).send({ error: 'Review the preview again before switching.' })
      request.log.error({ err: error }, 'Media switch failed')
      return reply.code(500).send({ error: 'The switch could not be confirmed. Reload the page before trying again.' })
    }
  })
}
