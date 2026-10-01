import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { deleteSavedView, listSavedViewGroups, listSavedViewsWithAlerts, SavedViewError, savedViewOwner, writeSavedView, type SavedViewWriteInput } from '../services/saved-views/persistence.service.js'
import { readUserSheetLayout, writeUserSheetLayout, type UserSheetLayoutWrite } from '../services/sheet-layouts/user-sheet-layout.service.js'

function fail(reply: FastifyReply, error: unknown) {
  return reply.code(error instanceof SavedViewError ? error.status : 500).send({ error: error instanceof Error ? error.message : String(error) })
}

/** Registered once by products-catalog; keeps its existing API paths and alert summaries. */
const savedViewPersistenceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/saved-views', async (request, reply) => {
    try {
      const owner = savedViewOwner(request)
      const { surface, surfaces } = request.query as { surface?: string; surfaces?: unknown }
      if (surfaces !== undefined) {
        if (surface !== undefined) throw new SavedViewError('Choose surface or surfaces, not both')
        return { results: await listSavedViewGroups(owner, surfaces) }
      }
      return { items: await listSavedViewsWithAlerts(owner, surface ?? 'products') }
    } catch (error) { return fail(reply, error) }
  })

  fastify.post('/saved-views', async (request, reply) => {
    try { return await writeSavedView(savedViewOwner(request), null, request.body as SavedViewWriteInput) }
    catch (error) { return fail(reply, error) }
  })

  fastify.patch('/saved-views/:id', async (request, reply) => {
    try { return await writeSavedView(savedViewOwner(request), (request.params as { id: string }).id, request.body as SavedViewWriteInput) }
    catch (error) { return fail(reply, error) }
  })

  /* 2026-10-01 — a person's own product sheet layout, the same in every business profile (`user-sheet-layout.service.ts`).
     Same list / write shapes as the saved views above, so the sheet reads and writes it the same way. */
  fastify.get('/sheet-layouts', async (request, reply) => {
    try { return { items: await readUserSheetLayout(savedViewOwner(request), (request.query as { surface?: unknown }).surface) } }
    catch (error) { return fail(reply, error) }
  })

  fastify.put('/sheet-layouts', async (request, reply) => {
    try { return await writeUserSheetLayout(savedViewOwner(request), request.body as UserSheetLayoutWrite) }
    catch (error) { return fail(reply, error) }
  })

  fastify.delete('/saved-views/:id', async (request, reply) => {
    try {
      await deleteSavedView(savedViewOwner(request), (request.params as { id: string }).id)
      return { ok: true }
    } catch (error) { return fail(reply, error) }
  })
}

export default savedViewPersistenceRoutes
