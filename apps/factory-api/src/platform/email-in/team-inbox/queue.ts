import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { workStateOf, type QueueView } from '@nexus/factory-domain/mail-depth/rules'
import { encodeCursor } from '@nexus/factory-domain/threads/timeline'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { afterCursor, cursorOf } from '../../threads/threads'
import { attachmentsOf } from '../sort'
import type { QueueMailView } from './contract'
import { INBOX_COLUMNS, mayWork, namesOf } from './inboxes'
import { officeOf, WORK_COLUMNS, type Reader } from './store'

/**
 * A team inbox's queue (B-W2b-394; COL-027; design home.mail "Team inboxes" tile → chip, the Assignee column): its mail in one
 * view, newest first. OPEN is what still waits for someone (not closed, not snoozed now: a snooze that passed is over by
 * itself); MINE and UNASSIGNED narrow it; SNOOZED, FOLLOW_UP (a follow-up waits for the partner), CLOSED and ALL. A REJECTED
 * mail is never listed. GET /email/team-inboxes/:teamInboxId/mail (email.triage; the inbox's members, or a manager).
 */

export const QUEUE_COLUMNS = {
  ...WORK_COLUMNS,
  receivedAt: true,
  fromAddress: true,
  fromName: true,
  subject: true,
  dmarcVerdict: true,
  spamVerdict: true,
  attachments: true,
} as const satisfies Prisma.InboundEmailSelect
type QueueRow = Prisma.InboundEmailGetPayload<{ select: typeof QUEUE_COLUMNS }>

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** The where of a view (the mail of one inbox, never a REJECTED one). */
export function viewWhere(inboxId: string, view: QueueView, me: string, now: Date): Prisma.InboundEmailWhereInput {
  const base: Prisma.InboundEmailWhereInput = { teamInboxId: inboxId, status: { not: 'REJECTED' } }
  const open: Prisma.InboundEmailWhereInput = { ...base, closedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
  switch (view) {
    case 'OPEN':
      return open
    case 'MINE':
      return { ...open, assigneeId: me }
    case 'UNASSIGNED':
      return { ...open, assigneeId: null }
    case 'SNOOZED':
      return { ...base, closedAt: null, snoozedUntil: { gt: now } }
    case 'FOLLOW_UP':
      return { ...base, followUpUntil: { not: null } }
    case 'CLOSED':
      return { ...base, closedAt: { not: null } }
    default:
      return base
  }
}

/** The views of some mails as the person sees them (their threads' records, the assignees' names, the inquiries made of them). */
export async function queueViewsOf(db: Reader, context: OfficeContext, rows: readonly QueueRow[], now: Date): Promise<QueueMailView[]> {
  const threadIds = [...new Set(rows.flatMap((row) => (row.threadId ? [row.threadId] : [])))]
  const threads = threadIds.length === 0 ? [] : await db.thread.findMany({ where: { id: { in: threadIds } }, select: { id: true, recordType: true, recordId: true } })
  const names = await namesOf(db, rows.flatMap((row) => (row.assigneeId ? [row.assigneeId] : [])))
  const ids = rows.map((row) => row.id)
  const inquiries = ids.length === 0 ? [] : await db.inquiry.findMany({ where: { sourceEmailId: { in: ids } }, select: { id: true, number: true, sourceEmailId: true } })
  return rows.map((row) => {
    const thread = threads.find((entry) => entry.id === row.threadId) ?? null
    const inquiry = inquiries.find((entry) => entry.sourceEmailId === row.id) ?? null
    return {
      id: row.id,
      status: row.status,
      receivedAt: toUtcIso(row.receivedAt),
      from: { address: row.fromAddress, name: row.fromName },
      subject: row.subject,
      verdicts: { dmarc: row.dmarcVerdict, spam: row.spamVerdict },
      attachmentCount: attachmentsOf(row).length,
      thread,
      teamInboxId: row.teamInboxId,
      state: workStateOf(row, now),
      assignee: row.assigneeId ? { id: row.assigneeId, name: names.get(row.assigneeId) ?? '—' } : null,
      mine: row.assigneeId === context.actorId,
      assignedAt: iso(row.assignedAt),
      closedAt: iso(row.closedAt),
      snoozedUntil: iso(row.snoozedUntil),
      followUpUntil: iso(row.followUpUntil),
      inquiry: inquiry ? { id: inquiry.id, number: inquiry.number } : null,
      version: row.version,
    }
  })
}

/** GET /email/team-inboxes/:teamInboxId/mail */
export async function listQueue(caller: CommandCaller, inboxId: string, query: { readonly view: QueueView; readonly cursor?: string | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  const cursor = cursorOf(query.cursor)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const inbox = isUuid(inboxId) ? await db.teamInbox.findUnique({ where: { id: inboxId }, select: INBOX_COLUMNS }) : null
    if (!inbox || !mayWork(context, inbox)) throw new NotFoundError('Team inbox not found.')
    const rows = await db.inboundEmail.findMany({
      where: { AND: [viewWhere(inbox.id, query.view, context.actorId, now), afterCursor(cursor, 'receivedAt') as Prisma.InboundEmailWhereInput] },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: QUEUE_COLUMNS,
    })
    const shown = rows.slice(0, query.limit)
    const last = shown.at(-1)
    return { mails: await queueViewsOf(db, context, shown, now), nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.receivedAt, id: last.id }) : null }
  })
}
