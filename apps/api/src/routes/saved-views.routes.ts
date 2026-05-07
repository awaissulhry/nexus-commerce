/**
 * O.27 — SavedView CRUD.
 *
 * Powers the "saved views" dropdown on the Pending tab (and any other
 * surface that wants persisted filter combinations). The model
 * already exists (SavedView, schema.prisma:4126) and is consumed by
 * SavedViewAlert; this commit adds the missing CRUD endpoints.
 *
 * Scoping is per (userId, surface): two surfaces can have a view
 * named "Today" without collision. userId resolution mirrors
 * saved-view-alerts.routes.ts's stub ('default-user' until the real
 * auth layer lands).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import prisma from '../db.js'

function userIdFor(_req: FastifyRequest): string {
  return 'default-user'
}

const savedViewsRoutes = async (fastify: FastifyInstance) => {
  // List views for a surface.
  fastify.get<{ Querystring: { surface?: string } }>(
    '/saved-views',
    async (request, reply) => {
      const userId = userIdFor(request)
      const surface = request.query.surface ?? 'products'
      const items = await prisma.savedView.findMany({
        where: { userId, surface },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      })
      return { items }
    },
  )

  fastify.post<{
    Body: { surface?: string; name?: string; filters?: any; isDefault?: boolean }
  }>('/saved-views', async (request, reply) => {
    const userId = userIdFor(request)
    const surface = request.body.surface?.trim() || 'products'
    const name = request.body.name?.trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })

    // (userId, surface, name) is unique. If the operator picks an
    // existing name, treat it as overwrite — matches Linear/Notion
    // saved-view UX where saving over a name updates in place.
    try {
      // If isDefault=true is requested, demote any other default in
      // the same surface first (single-default invariant).
      if (request.body.isDefault) {
        await prisma.savedView.updateMany({
          where: { userId, surface, isDefault: true },
          data: { isDefault: false },
        })
      }
      const existing = await prisma.savedView.findUnique({
        where: { userId_surface_name: { userId, surface, name } },
      })
      const view = existing
        ? await prisma.savedView.update({
            where: { id: existing.id },
            data: {
              filters: request.body.filters ?? {},
              isDefault: request.body.isDefault ?? existing.isDefault,
            },
          })
        : await prisma.savedView.create({
            data: {
              userId,
              surface,
              name,
              filters: request.body.filters ?? {},
              isDefault: request.body.isDefault ?? false,
            },
          })
      return view
    } catch (err: any) {
      fastify.log.error({ err }, '[saved-views] create failed')
      return reply.code(500).send({ error: err?.message ?? 'create failed' })
    }
  })

  fastify.patch<{
    Params: { id: string }
    Body: { name?: string; filters?: any; isDefault?: boolean }
  }>('/saved-views/:id', async (request, reply) => {
    const userId = userIdFor(request)
    const { id } = request.params
    const existing = await prisma.savedView.findFirst({ where: { id, userId } })
    if (!existing) return reply.code(404).send({ error: 'View not found' })

    if (request.body.isDefault === true) {
      await prisma.savedView.updateMany({
        where: { userId, surface: existing.surface, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      })
    }

    const updated = await prisma.savedView.update({
      where: { id },
      data: {
        ...(request.body.name != null ? { name: request.body.name.trim() } : {}),
        ...(request.body.filters !== undefined ? { filters: request.body.filters } : {}),
        ...(request.body.isDefault !== undefined ? { isDefault: request.body.isDefault } : {}),
      },
    })
    return updated
  })

  fastify.delete<{ Params: { id: string } }>('/saved-views/:id', async (request, reply) => {
    const userId = userIdFor(request)
    const { id } = request.params
    const existing = await prisma.savedView.findFirst({ where: { id, userId } })
    if (!existing) return reply.code(404).send({ error: 'View not found' })
    await prisma.savedView.delete({ where: { id } })
    return { ok: true }
  })
}

export default savedViewsRoutes
