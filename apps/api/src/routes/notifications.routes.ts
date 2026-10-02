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
 * Scoped to the SIGNED-IN user, and — through the Notification isolation policy —
 * to the business profile in context.
 *
 * 🔴 2026-09-16 — this used to return the literal 'default-user' for every request,
 * with a note that it would scope on the session "when real auth lands". Real auth
 * landed; this never followed. Measured on the local database: 391,197 notifications,
 * EVERY one addressed to a real user id, ZERO to 'default-user'. The bell had shown
 * nothing, ever — 195,806 unread for one owner alone, including a `danger`
 * automation-halt alarm. Anything written to a person was written where no person
 * could see it.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import prisma from '../db.js'
import { listInbox, markNotificationsRead } from '../services/notification-inbox.service.js'

/**
 * The session's user, or a 401. Never a fallback identity: a shared default id is how
 * every notification became invisible, and it would also let one person read another's.
 */
function userIdFor(request: FastifyRequest, reply: FastifyReply): string | null {
  const id = request.authUser?.id
  if (!id) {
    void reply.code(401).send({ error: 'Sign in to see your notifications.', code: 'unauthenticated' })
    return null
  }
  return id
}

const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { unread?: string; limit?: string }
  }>('/notifications', async (request, reply) => {
    const userId = userIdFor(request, reply)
    if (!userId) return reply
    const unreadOnly = request.query?.unread === 'true'
    const limit = Math.min(
      Math.max(parseInt(request.query?.limit ?? '50', 10) || 50, 1),
      200,
    )
    // Unread first, then read rows fill the room left — see the service for why.
    return listInbox(userId, { unreadOnly, limit })
  })

  fastify.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request, reply)
      if (!userId) return reply
      // MCP full control P7 — the write lives in the notification service (Claude's acknowledge-alerts uses it too).
      const updated = await markNotificationsRead([id], userId)
      if (updated === 0) {
        // Not an error; might be already read or wrong user. Return
        // 200 so the client can be idempotent.
        return { ok: true, updated: 0 }
      }
      return { ok: true, updated }
    },
  )

  fastify.post('/notifications/read-all', async (request, reply) => {
    const userId = userIdFor(request, reply)
    if (!userId) return reply
    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { ok: true, updated: result.count }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/notifications/:id',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request, reply)
      if (!userId) return reply
      const result = await prisma.notification.deleteMany({
        where: { id, userId },
      })
      return { ok: true, deleted: result.count }
    },
  )
}

export default notificationsRoutes
