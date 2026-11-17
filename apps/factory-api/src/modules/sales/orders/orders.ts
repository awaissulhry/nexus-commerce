import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { BOARD_LANES, daysLate, OPEN_STATUSES, SALES_ORDER_STATUSES, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { customFilter } from '../../../platform/fields/registry' // B-TH-057 (SHEET-G05)
import { type OrderSortKey, type OrderSortTerm } from './sort' // B-TH-057 (SHEET-G15)
import { ORDER_DEPOSIT_ONLY } from '../deposits/deposits'
import { assertMay, officeContextOf } from './access'
import { makeOrderInCommand } from './make'
// B-TH-017: what each row carries beside the order (picture, labels, Invoiced, the ids its doors open).
import { orderRowExtras } from './row-extras'
import { orderWaitWords } from '../../parties/holds/stops'
import { officeOrder, recordAfter } from './moves'
import { asDay, dayOf, dayOrNull, LEFT } from './store'
import type { OrderView } from './views'

/**
 * The office's sales orders (B-W1-25; SAL-200, SAL-204, SAL-206, SAL-214; A2 SCR-038 "Orders", SCR-039 "Order record"):
 * the list with its filters, the board's counts by state and the tiles (in W1 the board is these counts and saved rows:
 * the design's board view is W2a), the record, and the order of an accepted version made by the office when the
 * acceptance could not make it (no SALES_ORDER series then). The moves are ./moves.
 */

const todayNow = (): BusinessDate => businessDate(serverClock.now())

export async function getOrder(caller: CommandCaller, orderId: string): Promise<{ order: OrderView }> {
  const order = await officeOrder(caller, orderId)
  return { order: await recordAfter(caller, order.id) }
}

// ---- the list, the board, the tiles ------------------------------------------------------------------------------------

export interface ListFilters {
  readonly status?: SalesOrderStatus | undefined
  /** Only orders not shipped yet (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED). */
  readonly open?: 'true' | 'false' | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  /** The promise passed and the order is not shipped yet. */
  readonly late?: 'true' | 'false' | undefined
  /** The order needs a deposit and a request of it is still OPEN. */
  readonly deposit?: 'OPEN' | undefined
  /** B-W2b-323: a change waits for the customer to accept it. */
  readonly reaccept?: 'true' | 'false' | undefined
  readonly promiseFrom?: BusinessDate | undefined
  readonly promiseTo?: BusinessDate | undefined
  /** Number or customer reference, case-insensitive. B-TH-057: also the customer, a line's style code and the garment's label. */
  readonly q?: string | undefined
  /** B-TH-225: the label on the garment — a line's style of this brand party, or `own` (our own collection: no brand). */
  readonly brand?: string | undefined
  /** B-TH-057 (SHEET-G05): the custom fields' `cf` term (platform/fields filters), applied by the list as by its file. */
  readonly cf?: string | undefined
}

export interface ListQuery extends ListFilters {
  /** Without `sort`: the last id read (newest first). With `sort`: the opaque cursor of the page before (sort key + id). */
  readonly cursor?: string | undefined
  readonly limit: number
  /** B-TH-057 (SHEET-G15): `customer`, `brand`, `promise`, `daysLate`, `ordered`; `-` in front: the other way round. */
  readonly sort?: OrderSortTerm | undefined
}


// B-TH-019: exported for the Customer switcher's counts (./customers), the one definition of late.
export const lateWhere = (today: BusinessDate): Prisma.SalesOrderWhereInput => ({ status: { in: [...OPEN_STATUSES] }, promiseDate: { lt: asDay(today) } })
// B-W2a-F2: the deposit's requests only (a before-shipping step's own request is the balance, not the deposit).
const depositOpenWhere: Prisma.SalesOrderWhereInput = { depositRequired: true, depositRequests: { some: { status: 'OPEN', ...ORDER_DEPOSIT_ONLY } } }
// B-W2b-323: the customer must accept a change (W2a's amendment flag, a priced change of B-W2b-309), the order still running.
const reacceptWhere: Prisma.SalesOrderWhereInput = { reapprovalNeededAt: { not: null }, status: { notIn: ['CLOSED', 'CANCELLED'] } }

// ── B-TH-057 (ORD-G07): the search reads the number, the customer PO, the customer (name, trade name, code), a line's style
// code and the label on the garment (a brand's name or code) — a label only of a party the reader's orders.view reaches, as
// the Brand cell names it (row-extras.ts), so a person limited to some customers never finds an order by a hidden label. ──
function searchWhere(context: OfficeContext, q: string): Prisma.SalesOrderWhereInput {
  const words = { contains: q, mode: 'insensitive' as const }
  const named: Prisma.PartyWhereInput = { OR: [{ legalName: words }, { tradeName: words }, { code: words }] }
  const reached = scopeWhere(actorOf(context), ORDERS_VIEW, { party: 'id' }) as Prisma.PartyWhereInput
  return {
    OR: [
      { number: words },
      { customerRef: words },
      { party: named },
      { lines: { some: { style: { code: words } } } },
      { lines: { some: { style: { brandParty: { AND: [reached, named] } } } } },
    ],
  }
}
// ── end B-TH-057 ──

// B-TH-019: exported for the Customer switcher (./customers): the same scope and terms as the list.
export function whereOf(context: OfficeContext, filters: ListFilters, today: BusinessDate): Prisma.SalesOrderWhereInput {
  return {
    AND: [
      scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput,
      filters.status ? { status: filters.status } : {},
      filters.open === 'true' ? { status: { in: [...OPEN_STATUSES] } } : {},
      filters.companyId ? { companyId: filters.companyId } : {},
      filters.partyId ? { partyId: filters.partyId } : {},
      filters.late === 'true' ? lateWhere(today) : {},
      filters.deposit === 'OPEN' ? depositOpenWhere : {},
      filters.reaccept === 'true' ? reacceptWhere : {}, // B-W2b-323
      filters.promiseFrom ? { promiseDate: { gte: asDay(filters.promiseFrom) } } : {},
      filters.promiseTo ? { promiseDate: { lte: asDay(filters.promiseTo) } } : {},
      filters.q ? searchWhere(context, filters.q) : {}, // B-TH-057 (ORD-G07)
      filters.brand ? { lines: { some: { style: { brandPartyId: filters.brand === 'own' ? null : filters.brand } } } } : {}, // B-TH-225
    ],
  }
}

type DepositState = 'NOT_NEEDED' | 'MISSING' | 'OPEN' | 'PAID' | 'WAIVED'

// ── B-TH-057 (SHEET-G05, SHEET-G15) ─────────────────────────────────────────────────────────────────────────────────────
type Reader = Parameters<Parameters<CommandCaller['withClient']>[0]>[0]

/**
 * The `cf` term as a filter on the orders (platform/fields registry customFilter, the one the export wrapper applies): the
 * records its clauses keep, less those a "has none" clause drops; no term: every order. A clause on a field the person does
 * not see is refused (400 at query/cf), never dropped — the screen holds what the file holds.
 */
async function customWhere(client: Reader, context: OfficeContext, cf: string | undefined): Promise<Prisma.SalesOrderWhereInput> {
  const match = await customFilter(client as unknown as Prisma.TransactionClient, 'SalesOrder', cf, actorOf(context))
  if (!match) return {}
  return { AND: [match.include ? { id: { in: [...match.include] } } : {}, match.exclude.size > 0 ? { id: { notIn: [...match.exclude] } } : {}] }
}

const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true })
/** A sort key: a group (a value, a label of our own collection, a hidden label, nothing to sort by) and the value inside it. */
type SortKey = readonly [group: number, value: string | number | null]
/** The groups after the values stay last whichever way the sort runs (no promise, no lateness, no label). */
const LAST_GROUP = 3

function compareKeys(a: SortKey, b: SortKey, desc: boolean): number {
  const lastA = a[0] === LAST_GROUP
  const lastB = b[0] === LAST_GROUP
  if (lastA !== lastB) return lastA ? 1 : -1
  const way = desc ? -1 : 1
  if (a[0] !== b[0]) return (a[0] - b[0]) * way
  const [x, y] = [a[1], b[1]]
  if (x === y) return 0
  if (x === null || y === null) return x === null ? 1 : -1
  return (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y))) * way
}

interface SortCursor {
  readonly s: OrderSortTerm
  readonly k: SortKey
  readonly i: string
}
const cursorOf = (cursor: SortCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url')
function readCursor(text: string, sort: OrderSortTerm): SortCursor {
  try {
    const cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<SortCursor>
    if (cursor.s === sort && typeof cursor.i === 'string' && isUuid(cursor.i) && Array.isArray(cursor.k) && cursor.k.length === 2 && typeof cursor.k[0] === 'number') return cursor as SortCursor
  } catch {
    // said below
  }
  throw new ValidationError('This page belongs to another sort: read the list from its start again.', [{ path: 'query/cursor', message: 'The cursor of a page of this sort.' }])
}

/**
 * One page of the orders in a server sort (SHEET-G15): every order the terms keep is read once with only what its key needs,
 * sorted here by its key and then its id (the same way round), and the page starts after the cursor's key and id — a row
 * added or moved meanwhile never repeats nor hides a row already read. The keys:
 *   customer  the customer's name;      ordered  the order date;      promise  the promise (none: last);
 *   daysLate  days past the promise while not shipped (factory-domain daysLate; on time 0, shipped or no promise: last);
 *   brand     the first label the Brand cell names (row-extras.ts): a label's name the reader may see, then our own collection,
 *             then a label the reader may not see whose it is (all alike: its name never orders a row), then no line (last).
 */
async function sortedPage(client: Reader, context: OfficeContext, where: Prisma.SalesOrderWhereInput, query: ListQuery & { readonly sort: OrderSortTerm }, today: BusinessDate): Promise<{ ids: string[]; nextCursor: string | null }> {
  const sort = query.sort
  const desc = sort.startsWith('-')
  const key = (desc ? sort.slice(1) : sort) as OrderSortKey
  const rows = await client.salesOrder.findMany({ where, select: { id: true, partyId: true, status: true, orderDate: true, promiseDate: true, party: { select: { legalName: true } } } })
  const actor = actorOf(context)
  // The brand sort's facts: each order's lines in their order with their style's label, and the labels' names.
  const linesOf = new Map<string, (string | null)[]>()
  if (key === 'brand' && rows.length > 0) {
    const lines = await client.salesOrderLine.findMany({ where: { orderId: { in: rows.map((row) => row.id) } }, select: { orderId: true, style: { select: { brandPartyId: true } } }, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] })
    for (const line of lines) linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line.style.brandPartyId])
  }
  const labels = [...new Set([...linesOf.values()].flat().filter((party): party is string => party !== null))]
  const labelNames = new Map(labels.length > 0 ? (await client.party.findMany({ where: { id: { in: labels } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]) : [])
  const keyOf = (row: (typeof rows)[number]): SortKey => {
    if (key === 'customer') return [0, row.party.legalName]
    if (key === 'ordered') return [0, dayOf(row.orderDate)]
    const promise = dayOrNull(row.promiseDate)
    if (key === 'promise') return promise === null ? [LAST_GROUP, null] : [0, promise]
    if (key === 'daysLate') {
      const late = daysLate(row.status as SalesOrderStatus, promise, today)
      return late === null ? [LAST_GROUP, null] : [0, late]
    }
    const own = linesOf.get(row.id) ?? []
    if (own.length === 0) return [LAST_GROUP, null]
    const names = own.flatMap((party) => (party && (party === row.partyId || can(actor, ORDERS_VIEW, { partyId: party })) ? [labelNames.get(party) ?? ''] : []))
    if (names.length > 0) return [0, [...names].sort(collator.compare)[0]!]
    if (own.includes(null)) return [1, null]
    return [2, null]
  }
  const keyed = rows.map((row) => ({ id: row.id, key: keyOf(row) }))
  const compare = (a: { id: string; key: SortKey }, b: { id: string; key: SortKey }): number => compareKeys(a.key, b.key, desc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * (desc ? -1 : 1)
  keyed.sort(compare)
  const after = query.cursor ? readCursor(query.cursor, sort) : null
  const start = after ? keyed.findIndex((row) => compare(row, { id: after.i, key: after.k }) > 0) : 0
  const page = start < 0 ? [] : keyed.slice(start, start + query.limit)
  const more = start >= 0 && keyed.length > start + query.limit
  return { ids: page.map((row) => row.id), nextCursor: more ? cursorOf({ s: sort, k: page.at(-1)!.key, i: page.at(-1)!.id }) : null }
}
// ── end B-TH-057 ──

/** The orders the caller may see (its companies and parties), newest first, with SCR-038's columns. */
// B-TH-057: + the `cf` term, and a server sort (`sort`) with its own cursor.
export async function listOrders(caller: CommandCaller, query: ListQuery) {
  const context = officeContextOf(caller)
  const today = todayNow()
  if (!query.sort && query.cursor !== undefined && !isUuid(query.cursor)) throw new ValidationError('This page belongs to a sorted list: read the list from its start again.', [{ path: 'query/cursor', message: 'The last id read.' }])
  return caller.withClient(async (client) => {
    const scoped: Prisma.SalesOrderWhereInput = { AND: [whereOf(context, query, today), await customWhere(client, context, query.cf)] }
    const select = { id: true, number: true, companyId: true, partyId: true, customerRef: true, status: true, orderDate: true, requestedDate: true, promiseDate: true, currency: true, netAmount: true, grossAmount: true, depositRequired: true, quoteVersionId: true, version: true, updatedAt: true } as const
    let page: Prisma.SalesOrderGetPayload<{ select: typeof select }>[]
    let nextCursor: string | null
    if (query.sort) {
      const sorted = await sortedPage(client, context, scoped, { ...query, sort: query.sort }, today)
      const found = sorted.ids.length > 0 ? await client.salesOrder.findMany({ where: { AND: [scoped, { id: { in: sorted.ids } }] }, select }) : []
      const byId = new Map(found.map((row) => [row.id, row]))
      page = sorted.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      nextCursor = sorted.nextCursor
    } else {
      const rows = await client.salesOrder.findMany({ where: { AND: [scoped, query.cursor ? { id: { lt: query.cursor } } : {}] }, orderBy: { id: 'desc' }, take: query.limit + 1, select })
      page = rows.slice(0, query.limit)
      nextCursor = rows.length > query.limit ? page[page.length - 1]!.id : null
    }
    const ids = page.map((row) => row.id)
    const lines = ids.length > 0 ? await client.salesOrderLine.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _sum: { quantity: true }, _count: { _all: true } }) : []
    // B-TH-017: + the request's id (its deposit invoice) and every shipment (their delivery notes).
    const deposits = ids.length > 0 ? await client.depositRequest.findMany({ where: { orderId: { in: ids }, ...ORDER_DEPOSIT_ONLY }, select: { id: true, orderId: true, status: true, dueDate: true }, orderBy: { dueDate: 'asc' } }) : []
    const allShipments = ids.length > 0 ? await client.shipment.findMany({ where: { salesOrderId: { in: ids } }, select: { id: true, salesOrderId: true, status: true } }) : []
    const shipments = allShipments.filter((row) => (LEFT as readonly string[]).includes(row.status))
    const shipped = shipments.length > 0 ? await client.shipmentLine.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: shipments.map((row) => row.id) } }, _sum: { quantity: true } }) : []
    const versionIds = page.flatMap((row) => (row.quoteVersionId ? [row.quoteVersionId] : []))
    const versions = versionIds.length > 0 ? await client.quoteVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, quoteId: true, revision: true } }) : []
    const quotes = versions.length > 0 ? await client.quote.findMany({ where: { id: { in: [...new Set(versions.map((row) => row.quoteId))] } }, select: { id: true, number: true } }) : []
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.partyId))] } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
    // B-TH-017
    const extras = await orderRowExtras(
      client,
      actorOf(context),
      page.map((row) => {
        const version = versions.find((entry) => entry.id === row.quoteVersionId)
        return { id: row.id, companyId: row.companyId, partyId: row.partyId, quote: version ? { id: version.quoteId, versionId: version.id } : null }
      }),
      deposits,
      allShipments,
    )
    const shippedOf = new Map<string, number>()
    for (const row of shipped) {
      const orderId = shipments.find((shipment) => shipment.id === row.shipmentId)!.salesOrderId
      shippedOf.set(orderId, (shippedOf.get(orderId) ?? 0) + (row._sum.quantity ?? 0))
    }
    return {
      orders: page.map((row) => {
        const own = deposits.filter((deposit) => deposit.orderId === row.id && deposit.status !== 'CANCELLED')
        const open = own.find((deposit) => deposit.status === 'OPEN')
        const state: DepositState = !row.depositRequired ? 'NOT_NEEDED' : open ? 'OPEN' : own.some((deposit) => deposit.status === 'PAID') ? 'PAID' : own.some((deposit) => deposit.status === 'WAIVED') ? 'WAIVED' : 'MISSING'
        const version = versions.find((entry) => entry.id === row.quoteVersionId)
        const quote = version ? quotes.find((entry) => entry.id === version.quoteId) : undefined
        const count = lines.find((entry) => entry.orderId === row.id)
        const promiseDate = dayOrNull(row.promiseDate)
        return {
          id: row.id,
          number: row.number,
          companyId: row.companyId,
          partyId: row.partyId,
          partyName: parties.get(row.partyId) ?? '',
          customerRef: row.customerRef,
          status: row.status,
          deposit: { state, dueDate: open ? dayOf(open.dueDate) : null },
          lineCount: count?._count._all ?? 0,
          units: count?._sum.quantity ?? 0,
          shippedUnits: shippedOf.get(row.id) ?? 0,
          orderDate: dayOf(row.orderDate),
          requestedDate: dayOrNull(row.requestedDate),
          promiseDate,
          daysLate: daysLate(row.status, promiseDate, today),
          currency: row.currency,
          netAmount: asMoney('price', row.netAmount),
          grossAmount: asMoney('price', row.grossAmount),
          quote: quote && version ? { id: quote.id, number: quote.number, versionId: version.id, revision: version.revision } : null,
          version: row.version,
          updatedAt: toUtcIso(row.updatedAt),
          // B-TH-017
          ...extras.get(row.id)!,
        }
      }),
      nextCursor, // B-TH-057
    }
  })
}

/** The tiles (the design's saved-filter tiles): each count is the list's total under its filter. */
// B-W2b-323: + waitingForCustomer.
const TILES = ['late', 'waitingForDeposit', 'inProduction', 'readyToShip', 'waitingForCustomer'] as const

/**
 * The board (SAL-214; W1: the state counts as tiles and lanes, the drag-free board view is W2a): the count of every
 * state under the list's filters (scope, company, party, promise range, search), the board's lanes, and the tiles with
 * the filter each stands for.
 */
export async function orderBoard(caller: CommandCaller, filters: Pick<ListFilters, 'companyId' | 'partyId' | 'promiseFrom' | 'promiseTo' | 'q' | 'brand' /* B-TH-225 */ | 'cf' /* B-TH-057 */>) {
  const context = officeContextOf(caller)
  const today = todayNow()
  return caller.withClient(async (client) => {
    // B-TH-057 (SHEET-G05): the counts follow the custom field filter as the rows do.
    const base: Prisma.SalesOrderWhereInput = { AND: [whereOf(context, filters, today), await customWhere(client, context, filters.cf)] }
    const grouped = await client.salesOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } })
    const countOf = (status: SalesOrderStatus) => grouped.find((row) => row.status === status)?._count._all ?? 0
    const late = await client.salesOrder.count({ where: { AND: [base, lateWhere(today)] } })
    const deposit = await client.salesOrder.count({ where: { AND: [base, depositOpenWhere] } })
    const reaccept = await client.salesOrder.count({ where: { AND: [base, reacceptWhere] } }) // B-W2b-323
    const counts: Record<(typeof TILES)[number], { count: number; filter: Record<string, string> }> = {
      late: { count: late, filter: { late: 'true' } },
      waitingForDeposit: { count: deposit, filter: { deposit: 'OPEN' } },
      inProduction: { count: countOf('IN_PRODUCTION'), filter: { status: 'IN_PRODUCTION' } },
      readyToShip: { count: countOf('READY'), filter: { status: 'READY' } },
      waitingForCustomer: { count: reaccept, filter: { reaccept: 'true' } }, // B-W2b-323
    }
    return {
      byStatus: SALES_ORDER_STATUSES.map((status) => ({ status, count: countOf(status) })),
      lanes: [...BOARD_LANES],
      tiles: TILES.map((key) => ({ key, ...counts[key] })),
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

// ---- the order of an accepted version, by the office ------------------------------------------------------------------

/**
 * orders.manage: the order of an accepted quote version, when the acceptance could not make it (its company had no
 * active SALES_ORDER series then): 201 with the new order, 200 with the one that exists. The version's row is locked
 * first, as the acceptance's own step does, so the two never make two orders.
 */
export async function makeOrder(caller: CommandCaller, body: { readonly quoteVersionId: string; readonly customerRef?: string | null | undefined }, idempotencyKey?: string): Promise<{ created: boolean; order: OrderView }> {
  const context = officeContextOf(caller)
  const scope = isUuid(body.quoteVersionId)
    ? await caller.withClient(async (client) => {
        const version = await client.quoteVersion.findUnique({ where: { id: body.quoteVersionId }, select: { quoteId: true } })
        return version ? client.quote.findUnique({ where: { id: version.quoteId }, select: { companyId: true, partyId: true } }) : null
      })
    : null
  assertMay(context, ORDERS_MANAGE, scope, 'Quote version')
  const { result } = await command(caller, { name: 'orders.make', idempotencyKey, input: body }, async (tools) => {
    const locked = await tools.tx.$queryRaw<{ id: string }[]>`SELECT id FROM "QuoteVersion" WHERE id = ${body.quoteVersionId}::uuid FOR UPDATE`
    if (locked.length === 0) throw new NotFoundError('Quote version not found.')
    const made = await makeOrderInCommand(tools, body.quoteVersionId, body.customerRef)
    // B-W2b-290: the customer on hold for the company (409), or its PO number missing where its terms require one (400).
    if (!made.order && made.waits !== null && made.waits !== 'NO_SALES_ORDER_SERIES') {
      const words = await orderWaitWords(tools.tx, { partyId: scope!.partyId, companyId: scope!.companyId }, made.waits, body.customerRef)
      throw made.waits === 'ACCOUNT_ON_HOLD' ? new DomainError('conflict', words, [{ path: 'party/hold', message: 'The customer is on hold for this company.' }]) : new ValidationError(words, [{ path: 'body/customerRef', message: words }])
    }
    if (!made.order) throw new ConflictError('The company has no active SALES_ORDER number series: an administrator adds one under Numbering, then the order can be made.')
    if (!made.created) tools.audit({ action: 'orders.make', recordType: 'SalesOrder', recordId: made.order.id, companyId: scope!.companyId, after: { existing: true, linkedDepositRequestIds: made.linkedDepositRequestIds } })
    return { created: made.created, orderId: made.order.id }
  })
  return { created: result.created, order: await recordAfter(caller, result.orderId) }
}
