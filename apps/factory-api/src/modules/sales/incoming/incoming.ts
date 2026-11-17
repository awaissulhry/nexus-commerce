import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import type { IncomingListQuery, IncomingRow } from '@nexus/factory-domain/sales/incoming/contracts'
import {
  changeSummaryOf,
  INCOMING_CHANGE_KINDS,
  INCOMING_KINDS,
  INCOMING_LIMITS,
  INCOMING_TILES,
  isOpenState,
  KIND_RANK,
  mergePage,
  QUEUE_TILES,
  stateWords,
  TILE_KINDS,
  waitsOnUs,
  type IncomingChangeKind,
  type IncomingCursor,
  type IncomingKind,
  type IncomingTile,
} from '@nexus/factory-domain/sales/incoming/rules'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { OPEN_STATUSES, summaryOf, WORKING_DAY_MINUTES } from '@nexus/factory-domain/sales/inquiries/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { relativeRange } from '@nexus/factory-domain/views/quick/relative'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue' // B-TH-047
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { baseWhere } from '../inquiries/inquiries'
import { INQUIRY_COLUMNS, officeOf, type InquiryData, type Reader } from '../inquiries/store'
import { rowsOf, waitingMinutesOf } from '../inquiries/views'
import { readLines } from '../portal-ordering/store'
// B-TH-047: "Customer replies", the conversations waiting on us across the customer's other records.
import { waitingRowsOf } from '../../../platform/threads/waiting-list'

/**
 * Sales › Incoming over every door (B-TH-039; threads plan G2, L2-G07): GET /sales/incoming — requests, catalogue orders and
 * change requests in ONE paged list, the tiles under the same filters (factory-domain sales/incoming/rules.ts says what each tile
 * counts of each kind). Each kind is read with the reader's OWN view permission of that kind over each row's company and
 * customer (requests sales.inquiries.view; catalogue orders and change requests orders.view): a person limited to customer A never
 * lists, counts or pages a row of customer B of any kind (wall T30), and a reader without orders.view lists requests only (the
 * kind's counts are null). Change requests: only CHANGE and CANCEL (agreement T3), opening Home › Approvals.
 *
 * The order is (when it came, kind, id): oldest first for the queue tiles, newest first for the others; `cursor` continues after
 * the last row of a page (keyset, so a row arriving meanwhile never moves a page). Reads only; one client.
 */

const DAY_MS = 86_400_000
const plusOne = (day: string): string => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS).toISOString().slice(0, 10)
const unique = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]
const partyName = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName
const PARTY_SCOPE = { company: 'companyId', party: 'partyId' } as const
/** The most customers a search's words may name for the catalogue orders and change requests (by code or name). */
const Q_PARTIES_MAX = 500

// ---- the cursor --------------------------------------------------------------------------------------------------------

const encodeCursor = (cursor: IncomingCursor): string => Buffer.from(JSON.stringify([cursor.at, cursor.kind, cursor.id]), 'utf8').toString('base64url')

function decodeCursor(value: string | undefined): IncomingCursor | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string' && !Number.isNaN(Date.parse(parsed[0])) && (INCOMING_KINDS as readonly string[]).includes(parsed[1] as string) && typeof parsed[2] === 'string') {
      return { at: new Date(parsed[0]).toISOString(), kind: parsed[1] as IncomingKind, id: parsed[2] }
    }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back next as it came.' }])
}

/** The rows of `kind` after the cursor in the list's order ((at, kind, id), ascending or descending), on the kind's own instant field. */
function afterCursor(cursor: IncomingCursor | null, kind: IncomingKind, field: string, descending: boolean): Record<string, unknown> {
  if (!cursor) return {}
  const at = new Date(cursor.at)
  const beyond = descending ? 'lt' : 'gt'
  const rank = KIND_RANK[kind] - KIND_RANK[cursor.kind]
  // A kind ranked after the cursor's (in the list's direction) keeps the rows at the same instant; one ranked before drops them.
  if (rank === 0) return { OR: [{ [field]: { [beyond]: at } }, { [field]: at, id: { [beyond]: cursor.id } }] }
  const keepsSameInstant = descending ? rank < 0 : rank > 0
  return { [field]: { [keepsSameInstant ? (descending ? 'lte' : 'gte') : beyond]: at } }
}

// ---- who sees which kind -----------------------------------------------------------------------------------------------

const VIEW_OF: Readonly<Record<IncomingKind, Permission>> = Object.freeze({ REQUEST: SALES_INQUIRIES_VIEW, CATALOGUE_ORDER: ORDERS_VIEW, CHANGE_REQUEST: ORDERS_VIEW })

/** The kinds this reader may see at all (a grant of the kind's view permission) and this query lets in. */
function kindsOf(actor: Actor, query: IncomingListQuery): { readonly sees: ReadonlySet<IncomingKind>; readonly listed: readonly IncomingKind[] } {
  const sees = new Set(INCOMING_KINDS.filter((kind) => grantsFor(actor, VIEW_OF[kind]).length > 0))
  // B-TH-235: `outcome` (what a request became, Sales › Reports' request figure) lists requests only.
  const requestsOnly = query.status !== undefined || query.prospect === true || (query.source !== undefined && query.source !== 'PORTAL') || query.outcome !== undefined
  const listed = INCOMING_KINDS.filter((kind) => sees.has(kind) && (query.kind === undefined || query.kind === kind) && (!requestsOnly || kind === 'REQUEST'))
  return { sees, listed }
}

// ---- the kinds' filters ------------------------------------------------------------------------------------------------

interface Filters {
  readonly request: Prisma.InquiryWhereInput
  readonly catalogue: Prisma.PortalOrderRequestWhereInput
  readonly change: Prisma.OrderChangeRequestWhereInput
}

/** The customers the search's words name (code or name), for the kinds whose rows hold no customer words of their own. */
async function partiesNamed(db: Reader, q: string | undefined): Promise<string[]> {
  if (!q) return []
  const rows = await db.party.findMany({
    where: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }] },
    select: { id: true },
    take: Q_PARTIES_MAX,
  })
  return rows.map((row) => row.id)
}

async function filtersOf(db: Reader, context: OfficeContext, query: IncomingListQuery): Promise<Filters> {
  const actor = actorOf(context)
  const q = query.q?.trim() || undefined
  const named = await partiesNamed(db, q)
  const from = query.receivedFrom ? businessDayStart(query.receivedFrom) : null
  const to = query.receivedTo ? businessDayStart(plusOne(query.receivedTo)) : null
  const range = (field: string) => ({ ...(from || to ? { [field]: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) })
  const common = [query.partyId ? { partyId: query.partyId } : {}, query.companyId ? { companyId: query.companyId } : {}]
  return {
    // The requests: the inquiries' own list filter (the same scope, the same words).
    request: baseWhere(context, { status: query.status, source: query.source, partyId: query.partyId, prospect: query.prospect, companyId: query.companyId, receivedFrom: query.receivedFrom, receivedTo: query.receivedTo, q, outcome: query.outcome /* B-TH-235 */ }),
    catalogue: {
      AND: [
        scopeWhere(actor, ORDERS_VIEW, PARTY_SCOPE) as Prisma.PortalOrderRequestWhereInput,
        // Never a draft: it is the customer's alone.
        { status: { not: 'DRAFT' } },
        ...common,
        range('sentAt'),
        q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { customerRef: { contains: q, mode: 'insensitive' } }, { note: { contains: q, mode: 'insensitive' } }, ...(named.length > 0 ? [{ partyId: { in: named } }] : [])] } : {},
      ],
    },
    change: {
      AND: [
        scopeWhere(actor, ORDERS_VIEW, PARTY_SCOPE) as Prisma.OrderChangeRequestWhereInput,
        // Agreement T3: every other kind is answered in Home › Approvals alone.
        { kind: { in: [...INCOMING_CHANGE_KINDS] } },
        ...common,
        range('createdAt'),
        q ? { OR: [{ order: { number: { contains: q, mode: 'insensitive' } } }, { reason: { contains: q, mode: 'insensitive' } }, ...(named.length > 0 ? [{ partyId: { in: named } }] : [])] } : {},
      ],
    },
  }
}

// ---- waiting -----------------------------------------------------------------------------------------------------------

/** A state that waits on us, for waitingMinutesOf (it counts only such rows). */
const WAITS: InquiryData['status'] = 'NEW'

interface Waiting {
  /** Working minutes since each open row came, on its company's calendar (rows that wait on us). */
  readonly minutes: Map<string, number>
  /** The rows over one working day, per kind. */
  readonly overdue: Readonly<Record<IncomingKind, readonly string[]>>
  readonly complete: boolean
}

async function waitingOf(db: Reader, filters: Filters, kinds: readonly IncomingKind[], now: Date): Promise<Waiting> {
  const take = INCOMING_LIMITS.waitingRead + 1
  const [requests, catalogue, changes] = await Promise.all([
    kinds.includes('REQUEST') ? db.inquiry.findMany({ where: { AND: [filters.request, { status: { in: ['NEW', 'ASSIGNED'] } }] }, select: { id: true, companyId: true, receivedAt: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take }) : [],
    kinds.includes('CATALOGUE_ORDER') ? db.portalOrderRequest.findMany({ where: { AND: [filters.catalogue, { status: 'SENT' }] }, select: { id: true, companyId: true, sentAt: true }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }], take }) : [],
    kinds.includes('CHANGE_REQUEST') ? db.orderChangeRequest.findMany({ where: { AND: [filters.change, { status: 'OPEN' }] }, select: { id: true, companyId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take }) : [],
  ])
  const max = INCOMING_LIMITS.waitingRead
  const complete = requests.length <= max && catalogue.length <= max && changes.length <= max
  // waitingMinutesOf counts a row that waits on us: every row here does (the state given only says so).
  const open = [
    ...requests.slice(0, max).map((row) => ({ id: row.id, companyId: row.companyId, status: WAITS, receivedAt: row.receivedAt })),
    ...catalogue.slice(0, max).map((row) => ({ id: row.id, companyId: row.companyId, status: WAITS, receivedAt: row.sentAt ?? now })),
    ...changes.slice(0, max).map((row) => ({ id: row.id, companyId: row.companyId, status: WAITS, receivedAt: row.createdAt })),
  ]
  const minutes = await waitingMinutesOf(db, open, now)
  const over = (ids: readonly { id: string }[]) => ids.slice(0, max).filter((row) => (minutes.get(row.id) ?? 0) > WORKING_DAY_MINUTES).map((row) => row.id)
  return { minutes, overdue: { REQUEST: over(requests), CATALOGUE_ORDER: over(catalogue), CHANGE_REQUEST: over(changes) }, complete }
}

// ---- the tiles ---------------------------------------------------------------------------------------------------------

interface TileFacts {
  readonly context: OfficeContext
  readonly today: string
  readonly waiting: Waiting
  /** The catalogue orders whose thread the reader owns (B-TH-028): their MINE. */
  readonly owned: readonly string[]
}

function weekOf(today: string): { gte: Date; lt: Date } {
  const week = relativeRange('this-week', today)
  return { gte: businessDayStart(week.from!), lt: businessDayStart(plusOne(week.to!)) }
}

function requestTile(tile: IncomingTile, facts: TileFacts): Prisma.InquiryWhereInput | null {
  switch (tile) {
    case 'NEW':
      return { status: 'NEW' }
    case 'WAITING_US':
      return { id: { in: [...facts.waiting.overdue.REQUEST] } }
    case 'WAITING_CUSTOMER':
      return { status: 'NEED_INFO' }
    case 'QUOTED_THIS_WEEK':
      return { status: 'QUOTED', closedAt: weekOf(facts.today) }
    case 'MINE':
      return { status: { in: [...OPEN_STATUSES] }, assigneeId: facts.context.actorId }
    case 'OPEN':
      return { status: { in: [...OPEN_STATUSES] } }
    case 'QUOTED':
      return { status: 'QUOTED' }
    case 'ORDERED':
      return { status: 'ORDERED' }
    case 'DECLINED':
      return { status: 'DECLINED', NOT: { declineReason: 'NOT_AN_ORDER' } }
    case 'NOT_AN_ORDER':
      return { status: 'DECLINED', declineReason: 'NOT_AN_ORDER' }
    case 'LOST':
      return { status: 'LOST' }
    case 'ALL':
      return {}
  }
}

function catalogueTile(tile: IncomingTile, facts: TileFacts): Prisma.PortalOrderRequestWhereInput | null {
  switch (tile) {
    case 'NEW':
    case 'OPEN':
      return { status: 'SENT' }
    case 'WAITING_US':
      return { id: { in: [...facts.waiting.overdue.CATALOGUE_ORDER] } }
    case 'QUOTED_THIS_WEEK':
      return { status: 'ACCEPTED', quoteId: { not: null }, decidedAt: weekOf(facts.today) }
    case 'MINE':
      return { status: 'SENT', id: { in: [...facts.owned] } }
    case 'QUOTED':
      return { status: 'ACCEPTED', quoteId: { not: null } }
    case 'ORDERED':
      return { status: 'ACCEPTED', salesOrderId: { not: null } }
    case 'DECLINED':
      return { status: 'REFUSED' }
    case 'LOST':
      return { status: 'WITHDRAWN' }
    case 'ALL':
      return {}
    case 'WAITING_CUSTOMER':
    case 'NOT_AN_ORDER':
      return null
  }
}

function changeTile(tile: IncomingTile, facts: TileFacts): Prisma.OrderChangeRequestWhereInput | null {
  switch (tile) {
    case 'NEW':
    case 'OPEN':
      return { status: 'OPEN' }
    case 'WAITING_US':
      return { id: { in: [...facts.waiting.overdue.CHANGE_REQUEST] } }
    case 'DECLINED':
      return { status: 'REFUSED' }
    case 'LOST':
      return { status: 'WITHDRAWN' }
    case 'ALL':
      return {}
    default:
      return null
  }
}

/** How many rows of each kind a tile holds under the filters (a kind the tile cannot hold: 0; one not listed: absent). */
async function countTile(db: Reader, filters: Filters, kinds: readonly IncomingKind[], tile: IncomingTile, facts: TileFacts): Promise<Partial<Record<IncomingKind, number>>> {
  const out: Partial<Record<IncomingKind, number>> = {}
  for (const kind of kinds) {
    if (!TILE_KINDS[tile].includes(kind)) {
      out[kind] = 0
      continue
    }
    if (tile === 'WAITING_US') {
      out[kind] = facts.waiting.overdue[kind].length
      continue
    }
    if (kind === 'REQUEST') out[kind] = await db.inquiry.count({ where: { AND: [filters.request, requestTile(tile, facts)!] } })
    else if (kind === 'CATALOGUE_ORDER') out[kind] = await db.portalOrderRequest.count({ where: { AND: [filters.catalogue, catalogueTile(tile, facts)!] } })
    else out[kind] = await db.orderChangeRequest.count({ where: { AND: [filters.change, changeTile(tile, facts)!] } })
  }
  return out
}

// ---- the rows ----------------------------------------------------------------------------------------------------------

type KeyedRow = IncomingRow & { readonly key: string; readonly sortKey: IncomingCursor }

async function requestRows(db: Reader, context: OfficeContext, rows: readonly InquiryData[], now: Date, waiting: Waiting): Promise<KeyedRow[]> {
  const missing = rows.filter((row) => !waiting.minutes.has(row.id))
  const minutes = new Map(waiting.minutes)
  if (missing.length > 0) for (const [id, value] of await waitingMinutesOf(db, missing, now)) minutes.set(id, value)
  const views = await rowsOf(db, context, rows, now, minutes)
  return views.map((view, index) => {
    const row = rows[index]!
    const state = view.status
    return {
      key: `REQUEST:${view.id}`,
      sortKey: { at: toUtcIso(row.receivedAt), kind: 'REQUEST', id: row.id },
      kind: 'REQUEST',
      id: view.id,
      number: view.number,
      companyId: view.companyId,
      receivedAt: view.receivedAt,
      party: view.party,
      fromWords: view.fromWords,
      prospect: view.prospect,
      summary: view.summary,
      pieces: view.pieces > 0 ? view.pieces : null,
      wantedDate: view.wantedDate,
      state,
      stateWords: stateWords('REQUEST', state, view.declineReason),
      open: isOpenState('REQUEST', state),
      waiting: view.waiting,
      version: view.version,
      opens: { place: 'INCOMING', id: view.id },
      request: view as unknown as IncomingRow['request'],
      catalogueOrder: null,
      changeRequest: null,
    }
  })
}

const CATALOGUE_SELECT = { id: true, companyId: true, partyId: true, number: true, source: true, customerRef: true, requestedDate: true, note: true, status: true, sentAt: true, decidedAt: true, salesOrderId: true, quoteId: true, version: true } as const satisfies Prisma.PortalOrderRequestSelect
type CatalogueData = Prisma.PortalOrderRequestGetPayload<{ select: typeof CATALOGUE_SELECT }>
const CHANGE_SELECT = { id: true, companyId: true, partyId: true, orderId: true, kind: true, reasonCode: true, reason: true, requestedDate: true, status: true, answeredAt: true, version: true, createdAt: true } as const satisfies Prisma.OrderChangeRequestSelect
type ChangeData = Prisma.OrderChangeRequestGetPayload<{ select: typeof CHANGE_SELECT }>
/** One row of a kind on the way to the merged page: its key and its data. */
type Entry = { readonly key: IncomingCursor; readonly row: { readonly kind: 'REQUEST'; readonly data: InquiryData } | { readonly kind: 'CATALOGUE_ORDER'; readonly data: CatalogueData } | { readonly kind: 'CHANGE_REQUEST'; readonly data: ChangeData } }

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const waitingView = (kind: IncomingKind, state: string, minutes: number | null) => {
  const us = waitsOnUs(kind, state)
  return { for: us ? ('US' as const) : null, workingMinutes: us ? minutes : null, overdue: us && minutes !== null && minutes > WORKING_DAY_MINUTES }
}

async function partiesOf(db: Reader, ids: readonly string[]) {
  const rows = ids.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: partyName(row) }]))
}

async function minutesFor(db: Reader, waiting: Waiting, rows: readonly { id: string; companyId: string; at: Date; waits: boolean }[], now: Date): Promise<Map<string, number>> {
  const minutes = new Map(waiting.minutes)
  const missing = rows.filter((row) => row.waits && !minutes.has(row.id)).map((row) => ({ id: row.id, companyId: row.companyId, status: WAITS, receivedAt: row.at }))
  if (missing.length > 0) for (const [id, value] of await waitingMinutesOf(db, missing, now)) minutes.set(id, value)
  return minutes
}

async function catalogueRows(db: Reader, actor: Actor, rows: readonly CatalogueData[], now: Date, waiting: Waiting): Promise<KeyedRow[]> {
  if (rows.length === 0) return []
  const [lines, parties, orders, quotes] = await Promise.all([
    readLines(db, rows.map((row) => row.id)),
    partiesOf(db, unique(rows.map((row) => row.partyId))),
    db.salesOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.salesOrderId)) } }, select: { id: true, number: true, companyId: true, partyId: true } }),
    db.quote.findMany({ where: { id: { in: unique(rows.map((row) => row.quoteId)) } }, select: { id: true, number: true, companyId: true, partyId: true } }),
  ])
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(lines.map((line) => line.styleId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const minutes = await minutesFor(db, waiting, rows.map((row) => ({ id: row.id, companyId: row.companyId, at: row.sentAt ?? now, waits: row.status === 'SENT' })), now)
  return rows.map((row) => {
    const own = lines.filter((line) => line.requestId === row.id)
    const pieces = own.reduce((sum, line) => sum + line.sizes.reduce((total, size) => total + size.quantity, 0), 0)
    const codes = [...new Set(own.map((line) => styles.get(line.styleId) ?? ''))].filter((code) => code !== '')
    const order = orders.find((entry) => entry.id === row.salesOrderId)
    const quote = quotes.find((entry) => entry.id === row.quoteId)
    const party = parties.get(row.partyId) ?? null
    const state = row.status
    return {
      key: `CATALOGUE_ORDER:${row.id}`,
      sortKey: { at: toUtcIso(row.sentAt ?? now), kind: 'CATALOGUE_ORDER', id: row.id },
      kind: 'CATALOGUE_ORDER',
      id: row.id,
      number: row.number ?? '—',
      companyId: row.companyId,
      receivedAt: toUtcIso(row.sentAt ?? now),
      party,
      fromWords: party?.name ?? '—',
      prospect: false,
      summary: row.note?.trim() ? summaryOf(row.note) : codes.join(', ') || '—',
      pieces: pieces > 0 ? pieces : null,
      wantedDate: day(row.requestedDate),
      state,
      stateWords: stateWords('CATALOGUE_ORDER', state),
      open: isOpenState('CATALOGUE_ORDER', state),
      waiting: waitingView('CATALOGUE_ORDER', state, minutes.get(row.id) ?? null),
      version: row.version,
      opens: { place: 'INCOMING', id: row.id },
      request: null,
      catalogueOrder: {
        status: state as 'SENT' | 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN',
        source: row.source,
        customerRef: row.customerRef,
        lines: own.length,
        styles: codes,
        requestedDate: day(row.requestedDate),
        decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
        // What it became, only for a reader who may see it there.
        salesOrder: order && can(actor, ORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId }) ? { id: order.id, number: order.number } : null,
        quote: quote && can(actor, QUOTES_VIEW, { companyId: quote.companyId, partyId: quote.partyId }) ? { id: quote.id, number: quote.number } : null,
      },
      changeRequest: null,
    }
  })
}

async function changeRows(db: Reader, rows: readonly ChangeData[], now: Date, waiting: Waiting): Promise<KeyedRow[]> {
  if (rows.length === 0) return []
  const [parties, orders, cells] = await Promise.all([
    partiesOf(db, unique(rows.map((row) => row.partyId))),
    db.salesOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.orderId)) } }, select: { id: true, number: true } }),
    db.orderChangeRequestLine.findMany({ where: { requestId: { in: rows.map((row) => row.id) } }, select: { requestId: true, orderLineId: true, size: true } }),
  ])
  const minutes = await minutesFor(db, waiting, rows.map((row) => ({ id: row.id, companyId: row.companyId, at: row.createdAt, waits: row.status === 'OPEN' })), now)
  return rows.map((row) => {
    const own = cells.filter((cell) => cell.requestId === row.id)
    const lines = new Set(own.map((cell) => cell.orderLineId)).size
    const sizes = own.filter((cell) => cell.size !== null).length
    const number = orders.find((order) => order.id === row.orderId)?.number ?? '—'
    const kind = row.kind as IncomingChangeKind
    const party = parties.get(row.partyId) ?? null
    const what = changeSummaryOf(kind, number, lines, sizes)
    const state = row.status
    return {
      key: `CHANGE_REQUEST:${row.id}`,
      sortKey: { at: toUtcIso(row.createdAt), kind: 'CHANGE_REQUEST', id: row.id },
      kind: 'CHANGE_REQUEST',
      id: row.id,
      number,
      companyId: row.companyId,
      receivedAt: toUtcIso(row.createdAt),
      party,
      fromWords: party?.name ?? '—',
      prospect: false,
      summary: row.reason?.trim() ? `${what}: ${summaryOf(row.reason)}` : what,
      pieces: null,
      wantedDate: day(row.requestedDate),
      state,
      stateWords: stateWords('CHANGE_REQUEST', state, null, kind),
      open: isOpenState('CHANGE_REQUEST', state),
      waiting: waitingView('CHANGE_REQUEST', state, minutes.get(row.id) ?? null),
      version: row.version,
      // Agreement T3: a change request is answered in the Home › Approvals review window.
      opens: { place: 'APPROVALS', id: row.id },
      request: null,
      catalogueOrder: null,
      changeRequest: {
        kind,
        status: state as 'OPEN' | 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN',
        order: { id: row.orderId, number },
        reasonCode: row.reasonCode,
        requestedDate: day(row.requestedDate),
        lines,
        sizes,
        answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null,
      },
    }
  })
}

// ---- the read ----------------------------------------------------------------------------------------------------------

export interface IncomingOptions {
  /** Count the tiles (default true); the export pages without them. */
  readonly counts?: boolean
}

export interface IncomingAnswer {
  readonly rows: IncomingRow[]
  readonly counts: Record<string, number | null>
  readonly kinds: Record<IncomingKind, number | null>
  readonly next: string | null
  readonly complete: boolean
}

/** GET /sales/incoming */
export async function listIncoming(caller: CommandCaller, query: IncomingListQuery, options: IncomingOptions = {}): Promise<IncomingAnswer> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const today = businessDate(now)
  const tile = query.tile ?? 'OPEN'
  const limit = Math.min(query.limit ?? INCOMING_LIMITS.list, INCOMING_LIMITS.list)
  const cursor = decodeCursor(query.cursor)
  const descending = !QUEUE_TILES.includes(tile)
  const direction = descending ? ('desc' as const) : ('asc' as const)
  const { sees, listed } = kindsOf(actor, query)
  return caller.withClient(async (db) => {
    const filters = await filtersOf(db, context, query)
    const waiting = await waitingOf(db, filters, listed, now)
    const owned = listed.includes('CATALOGUE_ORDER') ? (await db.thread.findMany({ where: { recordType: 'PortalOrderRequest', ownerId: context.actorId }, select: { recordId: true }, take: INCOMING_LIMITS.waitingRead })).map((row) => row.recordId) : []
    const facts: TileFacts = { context, today, waiting, owned }

    // The page: each kind the tile can hold, after the cursor, in the list's order; then merged.
    const take = limit + 1
    const pageKinds = listed.filter((kind) => TILE_KINDS[tile].includes(kind))
    const [requests, catalogue, changes] = await Promise.all([
      pageKinds.includes('REQUEST')
        ? db.inquiry.findMany({ where: { AND: [filters.request, requestTile(tile, facts)!, afterCursor(cursor, 'REQUEST', 'receivedAt', descending)] }, select: INQUIRY_COLUMNS, orderBy: [{ receivedAt: direction }, { id: direction }], take })
        : [],
      pageKinds.includes('CATALOGUE_ORDER')
        ? db.portalOrderRequest.findMany({ where: { AND: [filters.catalogue, catalogueTile(tile, facts)!, afterCursor(cursor, 'CATALOGUE_ORDER', 'sentAt', descending)] }, select: CATALOGUE_SELECT, orderBy: [{ sentAt: direction }, { id: direction }], take })
        : [],
      pageKinds.includes('CHANGE_REQUEST')
        ? db.orderChangeRequest.findMany({ where: { AND: [filters.change, changeTile(tile, facts)!, afterCursor(cursor, 'CHANGE_REQUEST', 'createdAt', descending)] }, select: CHANGE_SELECT, orderBy: [{ createdAt: direction }, { id: direction }], take })
        : [],
    ])
    const keys: Entry[][] = [
      requests.map((row) => ({ key: { at: toUtcIso(row.receivedAt), kind: 'REQUEST', id: row.id }, row: { kind: 'REQUEST', data: row } })),
      catalogue.map((row) => ({ key: { at: toUtcIso(row.sentAt ?? now), kind: 'CATALOGUE_ORDER', id: row.id }, row: { kind: 'CATALOGUE_ORDER', data: row } })),
      changes.map((row) => ({ key: { at: toUtcIso(row.createdAt), kind: 'CHANGE_REQUEST', id: row.id }, row: { kind: 'CHANGE_REQUEST', data: row } })),
    ]
    const page = mergePage(keys, limit, descending)
    const made = [
      ...(await requestRows(db, context, page.rows.flatMap((entry) => (entry.row.kind === 'REQUEST' ? [entry.row.data] : [])), now, waiting)),
      ...(await catalogueRows(db, actor, page.rows.flatMap((entry) => (entry.row.kind === 'CATALOGUE_ORDER' ? [entry.row.data] : [])), now, waiting)),
      ...(await changeRows(db, page.rows.flatMap((entry) => (entry.row.kind === 'CHANGE_REQUEST' ? [entry.row.data] : [])), now, waiting)),
    ]
    const byKey = new Map(made.map((row) => [row.key, row]))
    const rows = page.rows.map((entry) => {
      const { sortKey: _sortKey, ...row } = byKey.get(`${entry.key.kind}:${entry.key.id}`)!
      return row as IncomingRow
    })

    // The tiles, every kind the reader may see under the filters; the tile's own rows per kind.
    const counts: Record<string, number | null> = {}
    const kinds: Record<IncomingKind, number | null> = { REQUEST: null, CATALOGUE_ORDER: null, CHANGE_REQUEST: null }
    if (options.counts !== false) {
      for (const each of INCOMING_TILES) {
        const perKind = await countTile(db, filters, listed, each, facts)
        counts[each] = listed.length === 0 ? null : Object.values(perKind).reduce((sum, value) => sum + (value ?? 0), 0)
        if (each === tile) for (const kind of INCOMING_KINDS) kinds[kind] = sees.has(kind) && listed.includes(kind) ? (perKind[kind] ?? 0) : null
      }
      // ---- B-TH-047: the "Customer replies" saved row (GET /threads/waiting?side=CUSTOMER lists them): every conversation on the
      // customer's other records (orders, quotes, returns …) whose newest shared message is the customer's, that this reader may
      // open, under the company and customer filters; null when the reader reads no conversation ("—").
      const replies = await waitingRowsOf(db, context, { side: 'CUSTOMER', companyId: query.companyId, partyId: query.partyId })
      counts.CUSTOMER_REPLIES = grantsFor(actor, THREADS_READ).length === 0 ? null : replies.rows.length
      // ---- end B-TH-047
    }
    return { rows, counts, kinds, next: page.next ? encodeCursor(page.next) : null, complete: waiting.complete }
  })
}

