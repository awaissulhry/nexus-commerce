import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingMinutesBetween } from '@nexus/factory-domain/calendars/working-time'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { amberOf, waitingOf, type Waiting, type WaitingOn } from '@nexus/factory-domain/threads/waiting'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { heldRoles } from '../auth/roles/access'
import { ownerKey, workingCalendarsFor } from '../calendars/service'
import { mayOnThread } from './records'
import { wallScopeOf } from './records' // B-PR-08a part 2
import { contextOf, ensureThread, officeRecord, type RecordRef } from './threads' // B-PR-08a part 2: scopeOfThread → wallScopeOf

/**
 * B-TH-028 (threads plan TH-2, N1, N2, X-G05; production lane agreement T8; design T1-F01..F03, O-SAL-INQ-LIST.pane-head):
 * who answers a conversation and what waits — read by the office only (the portal's and a link's thread answers carry neither:
 * wall W08).
 *
 *   owner      ONE owner, the chain's first: the thread's own (Thread.ownerId, set by whoever may post on it) → the record's
 *              responsible person by its type's resolver (a request: its assignee; a sales order: its production supervisor —
 *              registered by the production lane, `registerOwnerResolver`, skipped until it is) → the record's maker (the
 *              office person of its first audit row). Inactive people stay named, marked inactive (the head says so).
 *   waiting    factory-domain threads/waiting `waitingOf`: a request by its state, any other record by its newest shared
 *              message; the working minutes on the record's company calendar (clock minutes without one), amber after 1
 *              working day for a request and 3 for any other record, on us only.
 *
 *   PUT /threads/<type>/<id>/owner {ownerId}   threads.post over the record: an ACTIVE office person who may read the thread, or
 *                                              null (back to the record's own); the thread is made when it has none.
 */

export const OWNER_SOURCES = ['SET', 'ASSIGNEE', 'SUPERVISOR', 'MAKER'] as const
export type OwnerSource = (typeof OWNER_SOURCES)[number]

type Reader = FactoryClient | CommandTx

/** A record type's responsible person: a user id, or null (none named). */
export type OwnerResolver = (client: Reader, recordId: string) => Promise<string | null>

/** The registered resolvers per record type, in the chain's order (SET first, MAKER last are built in). */
const RESOLVERS = new Map<string, { readonly source: Exclude<OwnerSource, 'SET' | 'MAKER'>; readonly resolve: OwnerResolver }[]>([
  // A request's responsible person is its assignee (sales.inquiries).
  ['Inquiry', [{ source: 'ASSIGNEE', resolve: async (client, id) => (await client.inquiry.findUnique({ where: { id }, select: { assigneeId: true } }))?.assigneeId ?? null }]],
])

/**
 * The registration hook (agreement T8): a module names a record type's responsible person — the production lane registers
 * SalesOrder → its production supervisor (SUPERVISOR) when that field exists. Registered after the built-in ones of the type.
 */
export function registerOwnerResolver(recordType: string, source: 'ASSIGNEE' | 'SUPERVISOR', resolve: OwnerResolver): void {
  RESOLVERS.set(recordType, [...(RESOLVERS.get(recordType) ?? []).filter((entry) => entry.source !== source), { source, resolve }])
}

/** Test only: the built-in resolvers again. */
export function resetOwnerResolvers(): void {
  for (const key of [...RESOLVERS.keys()]) if (key !== 'Inquiry') RESOLVERS.delete(key)
  RESOLVERS.set('Inquiry', RESOLVERS.get('Inquiry')!.filter((entry) => entry.source === 'ASSIGNEE'))
}

/** The record's maker: the office person of its first audit row (the command that made it); null: the system or a portal person. */
async function makerOf(client: Reader, record: RecordRef): Promise<string | null> {
  const first = await client.auditLog.findFirst({ where: { recordType: record.type, recordId: record.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { actorId: true, audience: true } })
  return first && first.audience === 'OFFICE' ? first.actorId : null
}

export interface OwnerView {
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly source: OwnerSource
}

/** The conversation's owner by the chain (see the module's head), or null: nobody. */
export async function ownerOf(client: Reader, record: RecordRef, thread: { readonly ownerId: string | null } | null): Promise<OwnerView | null> {
  const chain: { source: OwnerSource; resolve: () => Promise<string | null> }[] = [
    { source: 'SET', resolve: async () => thread?.ownerId ?? null },
    ...(RESOLVERS.get(record.type) ?? []).map((entry) => ({ source: entry.source, resolve: () => entry.resolve(client, record.id) })),
    { source: 'MAKER', resolve: () => makerOf(client, record) },
  ]
  for (const step of chain) {
    const userId = await step.resolve()
    if (!userId) continue
    const user = await client.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, status: true, audience: true } })
    if (!user || user.audience !== 'OFFICE') continue
    return { id: user.id, name: user.displayName, active: user.status === 'ACTIVE', source: step.source }
  }
  return null
}

export interface WaitingView {
  readonly on: WaitingOn
  readonly since: Date
  readonly workingMinutes: number
  readonly calendar: boolean
  readonly amber: boolean
  readonly thresholdDays: number
}

/** The longest a waiting time reaches back (a year), as the inquiries list. */
const REACH_DAYS = 366

/** Minutes since `since` on the company's working calendar; clock minutes without a calendar (or a record of no company). */
async function minutesSince(client: Reader, companyId: string | null, since: Date, now: Date): Promise<{ minutes: number; calendar: boolean }> {
  const clock = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000))
  if (companyId === null) return { minutes: clock, calendar: false }
  const today = businessDate(now)
  const day = businessDate(since)
  const from = daysFrom(day, today) > REACH_DAYS ? plusDays(today, -REACH_DAYS) : plusDays(day, -2)
  const calendars = await workingCalendarsFor(client as Prisma.TransactionClient, [{ scope: 'COMPANY', id: companyId }], { from, to: plusDays(today, 1) })
  const calendar = calendars.get(ownerKey({ scope: 'COMPANY', id: companyId }))?.calendar
  if (!calendar) return { minutes: clock, calendar: false }
  const reach = new Date(`${plusDays(from, 1)}T00:00:00.000Z`)
  return { minutes: Math.max(0, Math.round(workingMinutesBetween(calendar, since < reach ? reach : since, now))), calendar: true }
}

/** What the conversation waits on now (see the module's head), or null. */
export async function waitingNow(client: Reader, record: RecordRef, thread: { readonly id: string; readonly companyId: string | null; readonly partyId: string | null } | null, now: Date): Promise<WaitingView | null> {
  const request = record.type === 'Inquiry' ? await client.inquiry.findUnique({ where: { id: record.id }, select: { status: true, receivedAt: true, companyId: true, partyId: true } }) : null
  const shared = thread ? await client.message.findFirst({ where: { threadId: thread.id, direction: { in: ['INBOUND', 'OUTBOUND'] } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { direction: true, at: true } }) : null
  const lastOutbound = thread && request ? ((await client.message.findFirst({ where: { threadId: thread.id, direction: 'OUTBOUND' }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { at: true } }))?.at ?? null) : null
  const waiting: Waiting | null = waitingOf({
    ...(request ? { request: { status: request.status as InquiryStatus, receivedAt: request.receivedAt } } : {}),
    lastShared: shared ? { direction: shared.direction as 'INBOUND' | 'OUTBOUND', at: shared.at } : null,
    lastOutbound,
    hasParty: (thread?.partyId ?? request?.partyId ?? null) !== null,
  })
  if (!waiting) return null
  const { minutes, calendar } = await minutesSince(client, thread?.companyId ?? request?.companyId ?? null, waiting.since, now)
  return { on: waiting.on, since: waiting.since, workingMinutes: minutes, calendar, amber: amberOf(waiting, minutes), thresholdDays: waiting.thresholdDays }
}

/** PUT /threads/<type>/<id>/owner: who answers this conversation (null: the record's own, by the chain). */
export async function setThreadOwner(caller: CommandCaller, record: RecordRef, body: { readonly ownerId: string | null }, idempotencyKey?: string): Promise<{ owner: OwnerView | null }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, scope)) throw new ForbiddenError('Choosing who answers needs the right to write on this conversation.')
  const { result } = await command(caller, { name: 'threads.setOwner', idempotencyKey, input: { recordType: record.type, recordId: record.id, ownerId: body.ownerId } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, context.actorId)
    if (body.ownerId !== null) {
      const words = 'Choose an active office person who can read this conversation.'
      const user = await tools.tx.user.findUnique({ where: { id: body.ownerId }, select: { id: true, status: true, audience: true } })
      if (!user || user.status !== 'ACTIVE' || user.audience !== 'OFFICE') throw new ValidationError(words, [{ path: 'body/ownerId', message: words }])
      const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(tools.tx, user.id, tools.now), true) }
      // B-PR-08a part 2: a work order's, hold's or NCR's thread is answered only by someone who reaches its customer (its wall party).
      if (!mayOnThread(reader, THREADS_READ, record.type, await wallScopeOf(tools.tx, thread))) throw new ValidationError(words, [{ path: 'body/ownerId', message: words }])
    }
    const before = await tools.tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: { ownerId: true, version: true } })
    if (before.ownerId !== body.ownerId) {
      await tools.tx.thread.update({ where: { id: thread.id }, data: { ownerId: body.ownerId, version: before.version + 1, updatedAt: tools.now }, select: { id: true } })
    }
    tools.audit({ action: 'threads.setOwner', recordType: 'Thread', recordId: thread.id, companyId: thread.companyId, siteId: thread.siteId, before: { ownerId: before.ownerId }, after: { ownerId: body.ownerId } })
    return { owner: await ownerOf(tools.tx, record, { ownerId: body.ownerId }) }
  })
  return result
}

/** The time a head's waiting started, for the answer. */
export const sinceOf = (waiting: WaitingView): string => waiting.since.toISOString()

/** The office's head of a conversation (owner and waiting); never for a portal or link reader. */
export async function headOf(client: Reader, record: RecordRef, thread: { readonly id: string; readonly companyId: string | null; readonly partyId: string | null; readonly ownerId?: string | null } | null, now: Date) {
  const [owner, waiting] = await Promise.all([ownerOf(client, record, thread ? { ownerId: thread.ownerId ?? null } : null), waitingNow(client, record, thread, now)])
  return { owner, waiting: waiting ? { on: waiting.on, since: sinceOf(waiting), workingMinutes: waiting.workingMinutes, calendar: waiting.calendar, amber: waiting.amber, thresholdDays: waiting.thresholdDays } : null }
}
