import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import { isNumberValue, scopeKeyFor, yearOfScope } from '@nexus/factory-domain/numbering/kinds'
import { QUOTES_APPROVE, QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import type { ApprovalReason, ApprovalStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { day, decimal, grainsOf, mayOn, officeContextOf } from './store'

/**
 * The quote approvals queue (B-W1-21 part 2; A2 SCR-030 Home › Approvals, W1: quote approvals only; SAL-184): every
 * approval request of the quotes the caller may see (quotes.view over the quote's company and customer), with who asked
 * and who decided by name, and whether the CALLER may decide it — the quotes module's own rules, said before the click:
 * never the person who asked (OWN_REQUEST), quotes.approve over the quote (NO_RIGHT), a request about the margin floor
 * only with the margin grain (NEEDS_MARGIN). The decision itself stays POST …/approval/approve | reject (approval.ts).
 *
 *   view=waiting   requests PENDING that the caller may decide (the queue)
 *   view=mine      the caller's own requests: waiting first, then decided in the last 30 days
 *   view=decided   decided (approved, rejected) in the last 7 days, by the caller or on the caller's requests
 *   view=all       every request (with quoteId: one quote's rounds, newest first)
 *
 * `counts` are the tiles: each is the total of its view (unknown never; the views are capped at 200 rows, and a count
 * over the cap says `capped`). Money is marked: the version's net (price), its margin % and floor (margin).
 *
 * And the number a new quote will get (the New quote dialog, "shown before Create"): the company's one active QUOTE
 * series, its next value as printed (a yearly series that has not issued this year starts at 1) — a preview: another
 * quote made first takes it.
 */

const CAP = 200
const DAY_MS = 86_400_000

export interface ApprovalsQuery {
  readonly view: 'waiting' | 'mine' | 'decided' | 'all'
  readonly quoteId?: string | undefined
}

export type DecideHeld = 'OWN_REQUEST' | 'NO_RIGHT' | 'NEEDS_MARGIN' | 'NOT_WAITING'

const COLUMNS = {
  id: true,
  versionId: true,
  reasons: true,
  requestNote: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  decisionNote: true,
  createdAt: true,
  createdById: true,
  quoteVersion: {
    select: {
      revision: true,
      status: true,
      currency: true,
      netAmount: true,
      grossAmount: true,
      marginPct: true,
      marginFloorPct: true,
      validUntil: true,
      quote: { select: { id: true, number: true, companyId: true, partyId: true, version: true, currentRevision: true, status: true } },
    },
  },
} as const satisfies Prisma.QuoteApprovalSelect

type Row = Prisma.QuoteApprovalGetPayload<{ select: typeof COLUMNS }>

export async function listQuoteApprovals(caller: CommandCaller, query: ApprovalsQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const me = context.actorId
  const grains = grainsOf(context)
  const now = serverClock.now()
  const scope = scopeWhere(actor, QUOTES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.QuoteWhereInput
  const inScope: Prisma.QuoteApprovalWhereInput = { quoteVersion: { quote: { AND: [scope, query.quoteId ? { id: query.quoteId } : {}] } } }
  const decidedSince = new Date(now.getTime() - 7 * DAY_MS)
  const mineSince = new Date(now.getTime() - 30 * DAY_MS)

  const held = (row: Row): DecideHeld | null => {
    if (row.status !== 'PENDING') return 'NOT_WAITING'
    if (row.createdById !== null && row.createdById === me) return 'OWN_REQUEST'
    const quote = row.quoteVersion.quote
    if (!mayOn(context, QUOTES_APPROVE, { companyId: quote.companyId, partyId: quote.partyId })) return 'NO_RIGHT'
    if (row.reasons.includes('MARGIN_FLOOR') && !grains.has('margin')) return 'NEEDS_MARGIN'
    return null
  }

  return caller.withClient(async (client) => {
    const read = (where: Prisma.QuoteApprovalWhereInput, orderBy: Prisma.QuoteApprovalOrderByWithRelationInput[]) =>
      client.quoteApproval.findMany({ where: { AND: [inScope, where] }, orderBy, take: CAP + 1, select: COLUMNS })
    const [pending, mine, decided] = await Promise.all([
      read({ status: 'PENDING' }, [{ createdAt: 'asc' }, { id: 'asc' }]),
      read({ createdById: me, OR: [{ status: 'PENDING' }, { createdAt: { gte: mineSince } }] }, [{ createdAt: 'desc' }, { id: 'desc' }]),
      read({ status: { in: ['APPROVED', 'REJECTED'] }, decidedAt: { gte: decidedSince }, OR: [{ decidedById: me }, { createdById: me }] }, [{ decidedAt: 'desc' }, { id: 'desc' }]),
    ])
    const waiting = pending.filter((row) => held(row) === null)
    const minePending = mine.filter((row) => row.status === 'PENDING')
    let rows: Row[]
    if (query.view === 'waiting') rows = waiting
    else if (query.view === 'mine') rows = [...minePending, ...mine.filter((row) => row.status !== 'PENDING')]
    else if (query.view === 'decided') rows = decided
    else rows = await read({}, [{ createdAt: 'desc' }, { id: 'desc' }])
    rows = rows.slice(0, CAP)

    const people = [...new Set(rows.flatMap((row) => [row.createdById, row.decidedById]).filter((id): id is string => id !== null))]
    const names = new Map((people.length > 0 ? await client.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
    const parties = [...new Set(rows.map((row) => row.quoteVersion.quote.partyId))]
    const partyNames = new Map((parties.length > 0 ? await client.party.findMany({ where: { id: { in: parties } }, select: { id: true, legalName: true, tradeName: true } }) : []).map((party) => [party.id, party.tradeName ?? party.legalName]))
    const person = (id: string | null) => (id === null ? null : { id, name: names.get(id) ?? null, you: id === me })

    return {
      approvals: rows.map((row) => {
        const version = row.quoteVersion
        const quote = version.quote
        const because = held(row)
        return {
          id: row.id,
          quoteId: quote.id,
          number: quote.number,
          companyId: quote.companyId,
          partyId: quote.partyId,
          partyName: partyNames.get(quote.partyId) ?? '',
          /** The quote's version (the edit-conflict guard the decision sends). */
          quoteVersion: quote.version,
          revision: version.revision,
          current: quote.currentRevision === version.revision,
          status: row.status as ApprovalStatus,
          reasons: row.reasons as ApprovalReason[],
          requestNote: row.requestNote,
          askedBy: person(row.createdById),
          askedAt: toUtcIso(row.createdAt),
          decidedBy: person(row.decidedById),
          decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
          decisionNote: row.decisionNote,
          currency: version.currency,
          netAmount: asMoney('price', version.netAmount),
          grossAmount: asMoney('price', version.grossAmount),
          marginPct: asMoney('margin', decimal(version.marginPct)),
          marginFloorPct: asMoney('margin', decimal(version.marginFloorPct)),
          validUntil: day(version.validUntil),
          mayDecide: because === null,
          held: because,
        }
      }),
      counts: {
        waiting: Math.min(waiting.length, CAP),
        mine: Math.min(minePending.length, CAP),
        decided: Math.min(decided.length, CAP),
        capped: pending.length > CAP || mine.length > CAP || decided.length > CAP,
      },
      at: toUtcIso(now),
    }
  })
}

/** quotes.manage over the company: the number its next quote will get (null: no single active QUOTE series). */
export async function nextQuoteNumber(caller: CommandCaller, companyId: string): Promise<{ number: string | null }> {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), QUOTES_MANAGE, { companyId })) throw new NotFoundError('Company not found.')
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const codes = await client.numberSeries.findMany({ where: { companyId, kind: 'QUOTE', status: 'ACTIVE' }, select: { code: true }, distinct: ['code'] })
    if (codes.length !== 1) return { number: null }
    const newest = await client.numberSeries.findFirst({ where: { companyId, kind: 'QUOTE', code: codes[0]!.code }, orderBy: { scopeKey: 'desc' }, select: { reset: true, scopeKey: true, pattern: true, nextValue: true, status: true } })
    if (!newest || newest.status !== 'ACTIVE') return { number: null }
    const scopeKey = scopeKeyFor(newest.reset, today)
    const fresh = newest.reset === 'YEARLY' && scopeKey > newest.scopeKey
    const value = fresh ? 1 : newest.nextValue
    if (!isNumberValue(value)) return { number: null }
    return { number: formatNumber(newest.pattern, { value, year: yearOfScope(scopeKey) }) }
  })
}
