/**
 * H.8 — in-app notifications surface for the topnav bell.
 *
 *   GET   /api/notifications?unread=true&limit=50
 *     → { rows, unreadCount }
 *
 *   POST  /api/notifications/:id/read
 *     Marks one read.
 *
 *   POST  /api/notifications/read-all
 *     Marks every unread for the user as read in one shot.
 *
 *   DELETE /api/notifications/:id
 *
 * Single-user pre-auth (default-user) — when real auth lands, this
 * endpoint will scope on session.userId.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import prisma from '../db.js'

function userIdFor(_req: FastifyRequest): string {
  return 'default-user'
}

const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { unread?: string; limit?: string }
  }>('/notifications', async (request) => {
    const userId = userIdFor(request)
    const unreadOnly = request.query?.unread === 'true'
    const limit = Math.min(
      Math.max(parseInt(request.query?.limit ?? '50', 10) || 50, 1),
      200,
    )
    const [rows, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId,
          ...(unreadOnly ? { readAt: null } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ])
    return { rows, unreadCount }
  })

  fastify.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request)
      const result = await prisma.notification.updateMany({
        where: { id, userId, readAt: null },
        data: { readAt: new Date() },
      })
      if (result.count === 0) {
        // Not an error; might be already read or wrong user. Return
        // 200 so the client can be idempotent.
        return { ok: true, updated: 0 }
      }
      return { ok: true, updated: result.count }
    },
  )

  fastify.post('/notifications/read-all', async (request) => {
    const userId = userIdFor(request)
    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { ok: true, updated: result.count }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/notifications/:id',
    async (request) => {
      const { id } = request.params
      const userId = userIdFor(request)
      const result = await prisma.notification.deleteMany({
        where: { id, userId },
      })
      return { ok: true, deleted: result.count }
    },
  )
}

export default notificationsRoutes
