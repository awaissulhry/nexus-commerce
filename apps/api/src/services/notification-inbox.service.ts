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
