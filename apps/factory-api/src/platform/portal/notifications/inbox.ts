import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { portalRecordPath } from '@nexus/factory-domain/portal/home/links'
import { partnerSentence } from '@nexus/factory-domain/portal/notifications/messages'
import { portalSessionOf, type PortalSession } from '../../auth/portal/authenticator'
import { portalOf } from '../../auth/portal/service'

/**
 * The partner person's bell (B-W2b-167, PLT-148; design portal.frame Notifications: "Newest first: what changed, on which record,
 * when · Unread mark; 'Mark all as read' · Each row is a link to the record and tab"):
 *
 *   GET  /portal/notifications           newest first, a page at a time; a group (same record and kind within 15 minutes)
 *                                        shows once, with how many it holds
 *   GET  /portal/notifications/counts    the bell: unread ones
 *   POST /portal/notifications/read      ids, or all; read or unread again
 * Read in the session's party scope, filtered to the person (the policy is by party; `actorId` is never selected: the partner
 * role cannot read it). The partner role cannot update Notification: marking read runs in the tenant's office scope as the
 * partner person, after checking each row is theirs (plan B-W2b-156 Decided 6).
 */

const COLUMNS = { id: true, userId: true, companyId: true, category: true, eventType: true, recordType: true, recordId: true, recordLabel: true, anchor: true, messageKey: true, params: true, groupKey: true, readAt: true, createdAt: true } as const satisfies Prisma.NotificationSelect
type Row = Prisma.NotificationGetPayload<{ select: typeof COLUMNS }>

export const READ_MAX = 200
const UNREAD_MAX = 1000

function cursorOf(row: Row): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url')
}
function parseCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && !Number.isNaN(Date.parse(value[0]))) return { at: new Date(value[0]), id: value[1] }
  } catch {
    // fall through
  }
  throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

async function partyCode(request: FastifyRequest, session: PortalSession): Promise<string> {
  const party = await request.withClient((client) => client.party.findUnique({ where: { id: session.partyId }, select: { code: true } }))
  return party?.code ?? session.partyId
}

async function unreadOf(request: FastifyRequest, session: PortalSession): Promise<{ unread: number; complete: boolean }> {
  const unread = await request.withClient((client) => client.notification.count({ where: { userId: session.userId, readAt: null, doneAt: null }, take: UNREAD_MAX + 1 } as Prisma.NotificationCountArgs))
  return { unread: Math.min(unread, UNREAD_MAX), complete: unread <= UNREAD_MAX }
}

export async function listMine(request: FastifyRequest, query: { readonly unread?: boolean | undefined; readonly cursor?: string | undefined; readonly limit: number }, now: Date) {
  const session = portalSessionOf(request)
  const after = parseCursor(query.cursor)
  const keyset: Prisma.NotificationWhereInput = after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}
  const rows = await request.withClient((client) =>
    client.notification.findMany({ where: { AND: [{ userId: session.userId }, query.unread ? { readAt: null } : {}, keyset] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit * 3 + 1, select: COLUMNS }),
  )
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = row.groupKey ?? row.id
    if (!groups.has(key)) {
      if (groups.size === query.limit) break
      groups.set(key, [])
    }
    groups.get(key)!.push(row)
  }
  const shown = [...groups.values()]
  const consumed = shown.reduce((sum, group) => sum + group.length, 0)
  const last = shown.at(-1)?.at(-1)
  const code = await partyCode(request, session)
  const company = session.company.name
  return {
    asOf: toUtcIso(now),
    ...(await unreadOf(request, session)),
    items: shown.map((group) => {
      const row = group[0]!
      return {
        id: row.id,
        category: row.category,
        eventType: row.eventType,
        record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
        messageKey: row.messageKey,
        sentence: { it: partnerSentence(row, 'it', company), en: partnerSentence(row, 'en', company) },
        link: portalRecordPath(code, row.recordType, row.recordId, row.anchor),
        read: group.every((member) => member.readAt !== null),
        createdAt: toUtcIso(row.createdAt),
        group: { key: row.groupKey ?? row.id, count: group.length, ids: group.map((member) => member.id) },
      }
    }),
    nextCursor: rows.length > consumed && last ? cursorOf(last) : null,
    live: { events: ['partner_notification.created'] },
  }
}

export async function counts(request: FastifyRequest, now: Date) {
  const session = portalSessionOf(request)
  return { asOf: toUtcIso(now), ...(await unreadOf(request, session)), live: { events: ['partner_notification.created'] } }
}

export async function markRead(app: FastifyInstance, request: FastifyRequest, body: { readonly ids?: readonly string[] | undefined; readonly all?: boolean | undefined; readonly read: boolean }, idempotencyKey?: string) {
  const session = portalSessionOf(request)
  if (!body.ids && body.all !== true) throw new ValidationError('Name the notifications.', [{ path: 'body/ids', message: 'Send ids, or all: true.' }])
  // Which rows are the person's: read in their own party scope, filtered to them.
  const own = await request.withClient((client) =>
    client.notification.findMany({ where: { userId: session.userId, ...(body.ids ? { id: { in: [...new Set(body.ids)] } } : { readAt: null }) }, take: body.ids ? READ_MAX : UNREAD_MAX, select: { id: true } }),
  )
  const ids = own.map((row) => row.id)
  const unknown = (body.ids ?? []).filter((id) => !ids.includes(id))
  if (ids.length === 0) return { changed: 0, unknown }
  const p = portalOf(app)
  const { result } = await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalNotifications.read', idempotencyKey, input: { ids, read: body.read } }, async (tools) => {
    const rows = await tools.tx.notification.findMany({ where: { id: { in: ids }, userId: session.userId, partyId: session.partyId }, select: { id: true, readAt: true, version: true } })
    let changed = 0
    for (const row of rows) {
      if ((row.readAt !== null) === body.read) continue
      await tools.tx.notification.update({ where: { id: row.id }, data: { readAt: body.read ? tools.now : null, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
      changed += 1
    }
    tools.audit({ recordType: 'Notification', recordId: session.userId, after: { ids: rows.map((row) => row.id), changed, read: body.read, byPartner: true } })
    return changed
  })
  return { changed: result, unknown }
}
