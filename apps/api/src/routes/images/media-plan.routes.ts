import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { MEDIA_LAYERS, mediaOpSchema } from '@nexus/shared/media-plan'
import { applyMediaPlanOps, joinVersions, leaveVersions, markDistinctPhotos, markSamePhoto, MEDIA_LANGUAGE, readMediaWorkspace, separateSamePhoto, undoSamePhoto, undoVersions, updateMediaLibrary, type SamePhotoUndo, type VersionsUndo } from '../../services/images/media-plan.service.js'
import { previewMediaSwitch, switchToMediaPlan } from '../../services/images/media-plan-seed.service.js'
import { amazonArchiveDownload, amazonArchivePreview } from '../../services/images/media-plan-archive.service.js'
import { AMAZON_ARCHIVE_KINDS } from '@nexus/shared/media-plan-archive'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'

/** Images rebuild P1 — one read for the Media page, and small edits to one layer (docs/images-studio-rebuild/PLAN.md §6.3). */
const opsBodySchema = z.object({
  address: z.object({
    layer: z.enum(MEDIA_LAYERS),
    channel: z.string().max(32).optional(),
    marketplace: z.string().max(16).optional(),
    accountId: z.string().max(256).optional(),
    aliasKey: z.string().max(256).optional(),
    // An Amazon market's own photos (`marketplace` = the market), not the account's "All Amazon markets".
    marketOnly: z.boolean().optional(),
  }).strict(),
  ops: z.array(mediaOpSchema).min(1).max(50),
}).strict()

const id = z.string().min(1).max(64)
const libraryBodySchema = z.object({
  languages: z.array(z.object({ id, languageTag: z.string().regex(MEDIA_LANGUAGE) }).strict()).max(200),
  groups: z.array(z.object({ ids: z.array(id).min(1).max(20), join: id.nullish() }).strict()).max(100),
}).strict()

const archiveQuerySchema = z.object({ accountId: z.string().min(1).max(256), market: z.string().regex(/^[A-Za-z]{2,3}$/), kind: z.enum(AMAZON_ARCHIVE_KINDS as [string, ...string[]]) })

// W4a — the same picture at two addresses: mark it (and undo), or answer "not the same" (and undo).
const lookalikeBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('same'), keep: id, drop: id }).strict(),
  z.object({ action: z.literal('undo-same'), undo: z.object({ keep: id, drop: id, previous: id.nullable(), repointed: z.array(id).max(500),
    layers: z.array(z.object({ layer: z.enum(MEDIA_LAYERS), channel: z.string().max(40), marketplace: z.string().max(40), accountId: z.string().max(256),
      aliasKey: z.string().max(256), ops: z.array(mediaOpSchema).max(100) }).strict()).max(200) }).strict() }).strict(),
  z.object({ action: z.literal('separate'), drop: id }).strict(),
  // W4b — language versions of one photo: join (each photo with its language), undo, leave.
  z.object({ action: z.literal('versions'), ids: z.array(id).min(2).max(20), languages: z.record(id, z.string().regex(MEDIA_LANGUAGE)) }).strict(),
  z.object({ action: z.literal('undo-versions'), undo: z.object({ groupId: z.string().min(1).max(64),
    members: z.array(z.object({ id, languageTag: z.string().regex(MEDIA_LANGUAGE), versionGroupId: z.string().max(64).nullable() }).strict()).max(40),
    layers: z.array(z.object({ layer: z.enum(MEDIA_LAYERS), channel: z.string().max(40), marketplace: z.string().max(40), accountId: z.string().max(256),
      aliasKey: z.string().max(256), ops: z.array(mediaOpSchema).max(100) }).strict()).max(200) }).strict() }).strict(),
  z.object({ action: z.literal('leave-versions'), id }).strict(),
  z.object({ action: z.literal('distinct'), a: id, b: id }).strict(),
  z.object({ action: z.literal('undo-distinct'), a: id, b: id }).strict(),
])

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
  app.post<{ Params: { productId: string }; Body: unknown }>('/products/:productId/media/library/lookalikes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const body = lookalikeBodySchema.parse(request.body)
      if (body.action === 'same') return await markSamePhoto(request.params.productId, body, request.authUser?.id ?? null)
      if (body.action === 'undo-same') return await undoSamePhoto(request.params.productId, { ...body.undo, previous: body.undo.previous ?? null } as SamePhotoUndo)
      if (body.action === 'separate') return await separateSamePhoto(request.params.productId, body)
      if (body.action === 'versions') return await joinVersions(request.params.productId, body, request.authUser?.id ?? null)
      if (body.action === 'undo-versions') return await undoVersions(request.params.productId, { ...body.undo, members: body.undo.members.map(m => ({ ...m, versionGroupId: m.versionGroupId ?? null })) } as VersionsUndo)
      if (body.action === 'leave-versions') return await leaveVersions(request.params.productId, body)
      return await markDistinctPhotos(request.params.productId, body, body.action === 'undo-distinct')
    } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      if (error instanceof z.ZodError) return reply.code(422).send({ error: 'This photo answer is not valid. Reload the page and try again.' })
      request.log.error({ err: error }, 'Media look-alike answer failed')
      return reply.code(500).send({ error: 'The answer could not be saved. Nothing changed; reload the page before trying again.' })
    }
  })
  // P4d — the Amazon ZIPs for Seller Central: a preview of every file, then the archive bound to that preview. Reads only.
  app.get<{ Params: { productId: string }; Querystring: unknown }>('/products/:productId/media/amazon-archive', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const query = archiveQuerySchema.parse(request.query)
      return await amazonArchivePreview(request.params.productId, query as never)
    } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      if (error instanceof z.ZodError) return reply.code(422).send({ error: 'Choose an Amazon account, a market and what to export.' })
      request.log.error({ err: error }, 'Amazon archive preview failed')
      return reply.code(500).send({ error: 'The archive could not be prepared. Retry.' })
    }
  })
  app.get<{ Params: { productId: string }; Querystring: unknown }>('/products/:productId/media/amazon-archive/file', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const query = archiveQuerySchema.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.query)
      const archive = await amazonArchiveDownload(request.params.productId, query as never)
      return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${archive.filename}"`).send(archive.buffer)
    } catch (error) {
      if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
      if (error instanceof z.ZodError) return reply.code(422).send({ error: 'Check the archive list again, then download.' })
      request.log.error({ err: error }, 'Amazon archive download failed')
      return reply.code(500).send({ error: 'The archive could not be built. Retry.' })
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
