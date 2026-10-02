/**
 * The notification bell's list for ONE signed-in person.
 *
 * Lives here and not in notifications.routes.ts: route files may not gain direct
 * database calls (scripts/check-route-prisma-ratchet.mjs), and this is the query
 * that changed.
 *
 * 🔴 UNREAD FIRST, from the query — not re-sorted afterwards.
 *
 * The route used to return the `limit` NEWEST rows. Measured 2026-09-16:
 * `unreadCount: 1`, `unreadRowsReturned: 0`. The one unread notice, a `danger`
 * automation-halt alarm, was older than all 30 rows returned, so the badge counted a
 * row the list could never show — and no amount of client-side ordering can surface
 * a row the client was never sent. The panel's own sort test passed throughout,
 * because the test handed it the alarm.
 *
 * So every unread row is fetched first (bounded by the same limit), and read rows
 * only fill whatever room is left.
 */
import prisma from '../db.js'

export async function listInbox(userId: string, opts: { unreadOnly: boolean; limit: number }) {
  const [unread, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where: { userId, readAt: null }, orderBy: { createdAt: 'desc' }, take: opts.limit }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ])
  const room = opts.unreadOnly ? 0 : opts.limit - unread.length
  const read = room > 0
    ? await prisma.notification.findMany({ where: { userId, readAt: { not: null } }, orderBy: { createdAt: 'desc' }, take: room })
    : []
  return { rows: [...unread, ...read], unreadCount }
}

/**
 * MCP full control P7 — mark notifications read: the bell's "mark read" (POST /api/notifications/:id/read) and
 * Claude's acknowledge-alerts. Only unread ones are touched, and with `userId` only that person's: a person marks
 * their own notices, never someone else's. Returns how many changed.
 */
export async function markNotificationsRead(ids: readonly string[], userId?: string, at: Date = new Date()): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { id: { in: [...ids] }, ...(userId ? { userId } : {}), readAt: null },
    data: { readAt: at },
  })
  return result.count
}

/** MCP full control P7 — the undo of marking read: these notifications are unread again. Returns how many changed. */
export async function markNotificationsUnread(ids: readonly string[]): Promise<number> {
  const result = await prisma.notification.updateMany({ where: { id: { in: [...ids] }, readAt: { not: null } }, data: { readAt: null } })
  return result.count
}
