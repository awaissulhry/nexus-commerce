import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingMinutesBetween } from '@nexus/factory-domain/calendars/working-time'
import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { EITHER_SIDE_TYPES, onSide, typesOfSide, viewGateOf, type WaitingSide } from '@nexus/factory-domain/threads/view-gates'
import { amberOf, waitingOf } from '@nexus/factory-domain/threads/waiting'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { ownerKey, workingCalendarsFor } from '../calendars/service'
import { recordLabelOf } from './labels'
import { mayOnThread, wallScopesOf } from './records'
import { contextOf } from './threads'

/**
 * Conversations waiting on us across records (B-TH-047; threads plan TH-3, N10, N25, X-G06; design O-SAL-INQ-LIST.list-F05/F11/F14
 * "Customer replies", X-PUR-ORD-LIST.grid-F01 "Supplier replies"; wall W27, W30):
 *
 *   GET /threads/waiting?side=CUSTOMER|SUPPLIER   the open conversations whose newest SHARED message came from the customer or the
 *                                                 supplier (the one waiting rule, factory-domain threads/waiting: an office note
 *                                                 never flips it; our reply takes the row off), oldest first, paged.
 *
 * ONE grouped read of the candidates: each open thread of the side's record types that has a party, with its newest shared
 * message (a lateral top-1 on the messages' (threadId, at) index), kept when that message is INBOUND — at most READ_MAX of them
 * (beyond: `complete` false, never a wrong "all"). Then each row is checked as its own record page checks it: threads.read over
 * the record's scope (mayOnThread, with B-TH-005's people gates and B-PR-08a's wall party) AND the record type's own view
 * permission over the same scope (factory-domain threads/view-gates: one per type; a type without one is listed to nobody). So a
 * person limited to customer A lists none of customer B's conversations (W27, W30), and the production manager, who reads threads
 * but no quotes, is never listed a quote's conversation. A party's own thread, a product change request, an approval request …
 * are on the side of the party's roles. Incoming's own kinds (requests, catalogue orders, change requests) wait as Incoming's rows.
 *
 * Each row names its record (its label, as a chip shows it), the customer or supplier, the message that waits (who wrote it, when,
 * its first words) and how long it waits (working minutes on the record's company calendar; amber over the rule's days). Office
 * only; reads only. Sales › Incoming counts the customer side (`counts.CUSTOMER_REPLIES`); Purchasing › Orders lists and counts
 * the supplier side of its orders (`supplierReplies`).
 */

/** The most candidate conversations one read keeps (the queue of what waits; beyond it the list says it is partial). */
export const WAITING_READ_MAX = 1000
/** The most rows one page brings. */
export const WAITING_PAGE_MAX = 100
/** A row's first words of the message that waits. */
const EXCERPT_MAX = 160
/** The longest a waiting time reaches back (a year), as the thread head's pill. */
const REACH_DAYS = 366

type Reader = FactoryClient | CommandTx

export interface WaitingQuery {
  readonly side: WaitingSide
  /** One record type of the side only (e.g. PurchaseOrder for Purchasing › Orders). */
  readonly recordType?: string | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
}

/** A candidate as the grouped read returns it. */
export interface WaitingCandidate {
  readonly threadId: string
  readonly recordType: string
  readonly recordId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string
  readonly messageId: string
  readonly at: Date
}

// ---- the cursor: the last row's (at, threadId) ---------------------------------------------------------------------------

const encodeCursor = (row: WaitingCandidate): string => Buffer.from(JSON.stringify([row.at.toISOString(), row.threadId]), 'utf8').toString('base64url')

function decodeCursor(value: string | undefined): { at: Date; threadId: string } | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && !Number.isNaN(Date.parse(parsed[0])) && typeof parsed[1] === 'string' && isUuid(parsed[1])) return { at: new Date(parsed[0]), threadId: parsed[1] }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back next as it came.' }])
}

const after = (row: WaitingCandidate, cursor: { at: Date; threadId: string } | null): boolean => !cursor || row.at > cursor.at || (row.at.getTime() === cursor.at.getTime() && row.threadId > cursor.threadId)

// ---- the read ------------------------------------------------------------------------------------------------------------

/** The side's record types this reader may list at all: it holds threads.read and the type's own view permission somewhere. */
function typesFor(actor: Actor, query: Pick<WaitingQuery, 'side' | 'recordType'>): string[] {
  if (grantsFor(actor, THREADS_READ).length === 0) return []
  return typesOfSide(query.side).filter((type) => (query.recordType === undefined || query.recordType === type) && grantsFor(actor, viewGateOf(type)!).length > 0)
}

/**
 * The conversations of the side that wait on us and that this office reader may open (see the module's head), oldest first.
 * `complete`: every candidate was read (false: more than WAITING_READ_MAX wait, the list and its count are partial).
 */
export async function waitingRowsOf(client: Reader, context: RequestContext, query: Omit<WaitingQuery, 'limit' | 'cursor'>): Promise<{ rows: WaitingCandidate[]; complete: boolean }> {
  if (context.audience !== 'office') return { rows: [], complete: true }
  const actor = actorOf(context)
  const types = typesFor(actor, query)
  if (types.length === 0) return { rows: [], complete: true }
  const companyId = query.companyId ?? null
  const partyId = query.partyId ?? null
  // The newest shared message of each open thread with a party (INTERNAL_NOTE never counts), kept when the customer or supplier
  // wrote it; one statement, a lateral top-1 per thread on the messages' (tenantId, threadId, at) index.
  const found = await (client as Prisma.TransactionClient).$queryRaw<{ threadId: string; recordType: string; recordId: string; companyId: string | null; siteId: string | null; partyId: string; messageId: string; at: Date }[]>`
    SELECT t."id"::text AS "threadId", t."recordType", t."recordId"::text AS "recordId", t."companyId"::text AS "companyId",
           t."siteId"::text AS "siteId", t."partyId"::text AS "partyId", last."id"::text AS "messageId", last."at"
      FROM "Thread" t
      CROSS JOIN LATERAL (
        SELECT m."id", m."at", m."direction"
          FROM "Message" m
         WHERE m."tenantId" = t."tenantId" AND m."threadId" = t."id" AND m."direction" IN ('INBOUND', 'OUTBOUND')
         ORDER BY m."at" DESC, m."id" DESC
         LIMIT 1
      ) last
     WHERE t."recordType" = ANY(${types}::text[])
       AND t."partyId" IS NOT NULL
       AND t."status" = 'OPEN'
       AND t."lastMessageAt" IS NOT NULL
       AND last."direction" = 'INBOUND'
       AND (${companyId}::uuid IS NULL OR t."companyId" = ${companyId}::uuid)
       AND (${partyId}::uuid IS NULL OR t."partyId" = ${partyId}::uuid)
     ORDER BY last."at" ASC, t."id" ASC
     LIMIT ${WAITING_READ_MAX + 1}`
  const complete = found.length <= WAITING_READ_MAX
  const candidates = found.slice(0, WAITING_READ_MAX)
  if (candidates.length === 0) return { rows: [], complete }
  // Either-side records go by their party's roles (one read of the parties they name).
  const either = [...new Set(candidates.filter((row) => (EITHER_SIDE_TYPES as readonly string[]).includes(row.recordType)).map((row) => row.partyId))]
  const roles = new Map(either.length === 0 ? [] : (await client.party.findMany({ where: { id: { in: either } }, select: { id: true, roles: true } })).map((party) => [party.id, party.roles as string[]]))
  const scopeOf = await wallScopesOf(client, candidates)
  const rows = candidates.filter((row) => {
    if (!onSide(row.recordType, query.side, roles.get(row.partyId) ?? [])) return false
    const scope = scopeOf(row)
    const gate = viewGateOf(row.recordType)
    return gate !== null && mayOnThread(actor, THREADS_READ, row.recordType, scope) && can(actor, gate, scope)
  })
  return { rows, complete }
}

/** Working minutes since each row's message on its company's calendar (clock minutes without one), one calendar read per page. */
async function minutesOf(client: Reader, rows: readonly WaitingCandidate[], now: Date): Promise<Map<string, { minutes: number; calendar: boolean }>> {
  const out = new Map<string, { minutes: number; calendar: boolean }>()
  const clock = (since: Date) => Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000))
  const companies = [...new Set(rows.flatMap((row) => (row.companyId ? [row.companyId] : [])))]
  if (rows.length === 0) return out
  const today = businessDate(now)
  const oldest = businessDate(rows.reduce((min, row) => (row.at < min ? row.at : min), rows[0]!.at))
  // As the thread head's pill (owner.ts): at most a year back, two days of margin before the oldest.
  const from = daysFrom(oldest, today) > REACH_DAYS ? plusDays(today, -REACH_DAYS) : plusDays(oldest, -2)
  const calendars = companies.length === 0 ? null : await workingCalendarsFor(client as Prisma.TransactionClient, companies.map((id) => ({ scope: 'COMPANY' as const, id })), { from, to: plusDays(today, 1) })
  const reach = new Date(`${plusDays(from, 1)}T00:00:00.000Z`)
  for (const row of rows) {
    const calendar = row.companyId && calendars ? calendars.get(ownerKey({ scope: 'COMPANY', id: row.companyId }))?.calendar : undefined
    out.set(row.threadId, calendar ? { minutes: Math.max(0, Math.round(workingMinutesBetween(calendar, row.at < reach ? reach : row.at, now))), calendar: true } : { minutes: clock(row.at), calendar: false })
  }
  return out
}

const excerptOf = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat
}
const partyName = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName

/** GET /threads/waiting: a page of the conversations of the side that wait on us (see the module's head). */
export async function listWaiting(caller: CommandCaller, query: WaitingQuery) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const limit = Math.min(query.limit ?? 50, WAITING_PAGE_MAX)
  const cursor = decodeCursor(query.cursor)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const { rows: all, complete } = await waitingRowsOf(client, context, query)
    const rest = all.filter((row) => after(row, cursor))
    const page = rest.slice(0, limit)
    const [parties, messages, minutes, labels] = await Promise.all([
      client.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
      client.message.findMany({ where: { id: { in: page.map((row) => row.messageId) } }, select: { id: true, channel: true, authorName: true, bodyText: true } }),
      minutesOf(client, page, now),
      Promise.all(page.map((row) => recordLabelOf(client, row.recordType, row.recordId))),
    ])
    const partyOf = new Map(parties.map((party) => [party.id, party]))
    const messageOf = new Map(messages.map((message) => [message.id, message]))
    return {
      rows: page.map((row, index) => {
        const party = partyOf.get(row.partyId)
        const message = messageOf.get(row.messageId)
        const waiting = waitingOf({ lastShared: { direction: 'INBOUND', at: row.at }, hasParty: true })!
        const spent = minutes.get(row.threadId) ?? { minutes: 0, calendar: false }
        return {
          recordType: row.recordType,
          recordId: row.recordId,
          label: labels[index] ?? `${row.recordType} ${row.recordId.slice(-6)}`,
          companyId: row.companyId,
          party: party ? { id: party.id, code: party.code, name: partyName(party) } : { id: row.partyId, code: '', name: '' },
          lastMessage: { id: row.messageId, at: toUtcIso(row.at), channel: message?.channel ?? 'EMAIL', authorName: message?.authorName ?? null, excerpt: excerptOf(message?.bodyText ?? '') },
          waiting: { since: toUtcIso(waiting.since), workingMinutes: spent.minutes, calendar: spent.calendar, amber: amberOf(waiting, spent.minutes), thresholdDays: waiting.thresholdDays },
        }
      }),
      count: all.length,
      complete,
      next: rest.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    }
  })
}
