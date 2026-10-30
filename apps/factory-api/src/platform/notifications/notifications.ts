import type { Prisma } from '@nexus/factory-db'
import { heldGrains, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  BULK_MAX,
  NOTIFICATION_TABS,
  paramsFor,
  peopleOf,
  sentenceOf,
  snoozeProblem,
  stateOf,
  TAB_CATEGORIES,
  type NotificationState,
  type NotificationTab,
} from '@nexus/factory-domain/notifications/rules'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { latestPerRecord, NOTIFICATION_COLUMNS, ownNotifications, type NotificationRow } from './store'

/**
 * The person's own notifications (B-W2a-20; PLT-138; design home.notifications, the shell's bell): office only, each
 * person only their own rows (another person's id is not found, as a wrong one). Read only what is theirs; write only
 * read, done and snooze (the table's guard keeps the words, record and event fixed).
 *
 *   GET  /notifications             a tab (All · Mentions · Assigned to me · Approvals · System), OPEN (not done, not
 *                                   snoozed now) by default, newest first, groups folded (PLT-142), with the tabs' counts
 *   GET  /notifications/counts      the bell: unread OPEN ones, per tab
 *   POST /notifications/read        mark read or unread (Mark read N; ⇧E all of a tab)
 *   POST /notifications/done        done (E) or back (Undo)
 *   POST /notifications/snooze      until a time, or (null) until there is new activity on the record (H)
 *   POST /notifications/wake        not snoozed any more
 *
 * A snooze "until new activity" (snoozedAt set, snoozedUntil null) ends when a newer notification of the same record
 * reaches the person. Each answer's sentence is in English (`sentence`) and as its key and params (the web's words);
 * params went through the grain filter (an amount the reader no longer holds the grain of is dropped).
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface ListQuery {
  readonly tab: NotificationTab
  readonly state: NotificationState
  readonly unread?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const keyOf = (row: Pick<NotificationRow, 'recordType' | 'recordId'>) => `${row.recordType}:${row.recordId}`

function cursorOf(row: NotificationRow): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url')
}
function parseCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (cursor === undefined || cursor === '') return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && !Number.isNaN(Date.parse(value[0]))) return { at: new Date(value[0]), id: value[1] }
  } catch {
    // fall through
  }
  throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/**
 * The person's rows of a state, newest first, after the cursor: SQL keeps what is surely in the state; a snooze "until
 * new activity" is decided against the newest notification of its record (they are few).
 */
async function rowsIn(caller: CommandCaller, context: OfficeContext, tab: NotificationTab, state: NotificationState, extra: Prisma.NotificationWhereInput, take: number, after: { at: Date; id: string } | null, now: Date) {
  const categories = [...TAB_CATEGORIES[tab]]
  const keyset: Prisma.NotificationWhereInput = after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}
  const base: Prisma.NotificationWhereInput = { AND: [{ userId: context.actorId, category: { in: categories } }, extra, keyset] }
  return caller.withClient(async (client) => {
    const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
    let sure: Prisma.NotificationWhereInput
    let maybe: Prisma.NotificationWhereInput | null
    if (state === 'DONE') {
      sure = { doneAt: { not: null } }
      maybe = null
    } else if (state === 'OPEN') {
      sure = { doneAt: null, OR: [{ snoozedAt: null }, { snoozedUntil: { lte: now } }] }
      maybe = { doneAt: null, snoozedAt: { not: null }, snoozedUntil: null }
    } else {
      sure = { doneAt: null, snoozedUntil: { gt: now } }
      maybe = { doneAt: null, snoozedAt: { not: null }, snoozedUntil: null }
    }
    const rows = await client.notification.findMany({ where: { AND: [base, sure] }, orderBy: order, take, select: NOTIFICATION_COLUMNS })
    if (maybe) {
      const waiting = await client.notification.findMany({ where: { AND: [base, maybe] }, orderBy: order, take: 500, select: NOTIFICATION_COLUMNS })
      const latest = await latestPerRecord(client, context.actorId, waiting.map((row) => row.recordId))
      for (const row of waiting) if (stateOf(row, now, latest.get(keyOf(row)) ?? null) === state) rows.push(row)
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    }
    return rows.slice(0, take)
  })
}

async function namesFor(caller: CommandCaller, rows: readonly NotificationRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => peopleOf(row)))]
  if (ids.length === 0) return new Map()
  return caller.withClient(async (client) => new Map((await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName])))
}

function viewOf(row: NotificationRow, names: ReadonlyMap<string, string>, state: NotificationState, group: { key: string; count: number; ids: string[] }, held: ReadonlySet<Grain>) {
  const people = Object.fromEntries(peopleOf(row).map((id) => [id, names.get(id) ?? '']))
  // The words with only the amounts the reader holds the grain of now (the params field is filtered again by the API).
  const params = paramsFor(row.params, held)
  return {
    id: row.id,
    category: row.category,
    eventType: row.eventType,
    record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
    companyId: row.companyId,
    anchor: row.anchor,
    messageKey: row.messageKey,
    params,
    sentence: sentenceOf({ ...row, params }, names, 'en'),
    actor: row.actorId ? { id: row.actorId, name: names.get(row.actorId) ?? '' } : null,
    people,
    state,
    read: row.readAt !== null,
    readAt: row.readAt ? toUtcIso(row.readAt) : null,
    doneAt: row.doneAt ? toUtcIso(row.doneAt) : null,
    snoozed: row.snoozedAt ? { at: toUtcIso(row.snoozedAt), until: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null } : null,
    createdAt: toUtcIso(row.createdAt),
    group,
  }
}

/** GET /notifications: one page of a tab, newest first; a group shows once, as its newest row, with its members' ids. */
export async function listNotifications(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const after = parseCursor(query.cursor)
  const extra: Prisma.NotificationWhereInput = query.unread ? { readAt: null } : {}
  // Read one page more than asked so groups fold inside it; a group cut by the page end goes on in the next one.
  const rows = await rowsIn(caller, context, query.tab, query.state, extra, query.limit * 3 + 1, after, now)
  const groups = new Map<string, NotificationRow[]>()
  const order: string[] = []
  for (const row of rows) {
    const key = row.groupKey ?? row.id
    if (!groups.has(key)) {
      if (order.length === query.limit) break
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(row)
  }
  const shown = order.map((key) => groups.get(key)!)
  const consumed = shown.reduce((sum, group) => sum + group.length, 0)
  const last = shown.at(-1)?.at(-1)
  const names = await namesFor(caller, shown.map((group) => group[0]!))
  return {
    asOf: toUtcIso(now),
    tab: query.tab,
    state: query.state,
    counts: await countsFor(caller, context, now),
    items: shown.map((group) => viewOf(group[0]!, names, query.state, { key: group[0]!.groupKey ?? group[0]!.id, count: group.length, ids: group.map((row) => row.id) }, heldGrains(actorOf(context)))),
    nextCursor: rows.length > consumed && last ? cursorOf(last) : null,
    live: { events: ['notification.created'] },
  }
}

/** Unread OPEN notifications per tab (the bell and the tabs; 0 is an answer). */
async function countsFor(caller: CommandCaller, context: OfficeContext, now: Date) {
  const rows = await rowsIn(caller, context, 'ALL', 'OPEN', { readAt: null }, 1000, null, now)
  const tabs = NOTIFICATION_TABS.map((tab) => ({ tab, unread: rows.filter((row) => (TAB_CATEGORIES[tab] as readonly string[]).includes(row.category)).length }))
  return { unread: rows.length, complete: rows.length < 1000, tabs }
}

/** GET /notifications/counts: the bell. */
export async function notificationCounts(caller: CommandCaller) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return { asOf: toUtcIso(now), ...(await countsFor(caller, context, now)), live: { events: ['notification.created'] } }
}

type Change = { readonly readAt?: Date | null; readonly doneAt?: Date | null; readonly snoozedAt?: Date | null; readonly snoozedUntil?: Date | null }

/** One command over the person's own rows: those of the ids sent (or of a whole tab); unknown ids are listed back. */
async function change(caller: CommandCaller, name: 'notifications.read' | 'notifications.done' | 'notifications.snooze' | 'notifications.wake', input: { readonly ids?: readonly string[] | undefined; readonly tab?: NotificationTab | undefined }, value: (row: NotificationRow, now: Date) => Change | null, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!input.ids && !input.tab) throw new ValidationError('Name the notifications.', [{ path: 'body/ids', message: 'Send ids, or a tab for all of it.' }])
  if (input.ids && input.ids.length > BULK_MAX) throw new ValidationError(`At most ${BULK_MAX} at once.`, [{ path: 'body/ids', message: `At most ${BULK_MAX} at once.` }])
  const { result } = await command(caller, { name, idempotencyKey, input }, async (tools) => {
    const { tx, now } = tools
    const rows = input.ids
      ? await ownNotifications(tx, context.actorId, input.ids)
      : await tx.notification.findMany({ where: { userId: context.actorId, category: { in: [...TAB_CATEGORIES[input.tab!]] }, doneAt: null, readAt: null }, take: 1000, select: NOTIFICATION_COLUMNS })
    let changed = 0
    for (const row of rows) {
      const data = value(row, now)
      if (data === null) continue
      await tx.notification.update({ where: { id: row.id }, data: { ...data, version: row.version + 1, updatedAt: now }, select: { id: true } })
      changed += 1
    }
    const found = new Set(rows.map((row) => row.id))
    const unknown = (input.ids ?? []).filter((id) => !found.has(id))
    // One audit row for the person's own list: which rows, never their words.
    tools.audit({ recordType: 'Notification', recordId: context.actorId, after: { ids: rows.map((row) => row.id), changed, ...(input.tab ? { tab: input.tab } : {}) } })
    return { changed, unknown }
  })
  return result
}

/** POST /notifications/read. */
export function markRead(caller: CommandCaller, body: { readonly ids?: readonly string[] | undefined; readonly tab?: NotificationTab | undefined; readonly read: boolean }, key?: string) {
  return change(caller, 'notifications.read', body, (row, now) => (body.read ? (row.readAt ? null : { readAt: now }) : row.readAt ? { readAt: null } : null), key)
}

/** POST /notifications/done: done (it is read too) or back. */
export function markDone(caller: CommandCaller, body: { readonly ids: readonly string[]; readonly done: boolean }, key?: string) {
  return change(caller, 'notifications.done', body, (row, now) => (body.done ? (row.doneAt ? null : { doneAt: now, readAt: row.readAt ?? now, snoozedAt: null, snoozedUntil: null }) : row.doneAt ? { doneAt: null } : null), key)
}

/** POST /notifications/snooze: until a time, or (null) until there is new activity on the record. */
export function snooze(caller: CommandCaller, body: { readonly ids: readonly string[]; readonly until: string | null }, key?: string) {
  const until = body.until === null ? null : new Date(body.until)
  const problem = snoozeProblem(until, serverClock.now())
  if (problem) throw new ValidationError(problem, [{ path: 'body/until', message: problem }])
  return change(caller, 'notifications.snooze', body, (row, now) => (row.doneAt ? null : { snoozedAt: now, snoozedUntil: until }), key)
}

/** POST /notifications/wake: back on the list now. */
export function wake(caller: CommandCaller, body: { readonly ids: readonly string[] }, key?: string) {
  return change(caller, 'notifications.wake', body, (row) => (row.snoozedAt ? { snoozedAt: null, snoozedUntil: null } : null), key)
}
