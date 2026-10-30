import type { FactoryClient, Prisma, StockMoveReason } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { locationDelta, siteDelta } from '@nexus/factory-domain/inventory/ledger/moves'
import { WRITE_OFF_COMMAND, writeOffGroupOf, writeOffOf } from '@nexus/factory-domain/inventory/ledger/write-off'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { scanSubjectFor } from '../../production/settings/subject'
import { mayAt, officeContextOf, seesCost } from '../ledger/access'
import { fixed, SCOPE } from './read-kit'
import type { LedgerRow } from './reads-contract'

/**
 * Warehouse › Movements (A2 SCR-064; design warehouse.moves, Owner answer W2 B: one long fast grid): the append-only
 * ledger as the grid shows it — names, the document behind each move, both clocks, who posted it (an office user by
 * name; a floor move by its device, never a worker: Owner answer W1) and its value with the cost grain — read newest
 * first in pages of up to 1000 with a cursor; the tiles' counts; one move with everything about it (the DetailModal:
 * the worker's name only where the site records workers). Office reads, inventory.stock.view. The ledger's own list
 * (`GET /inventory/moves`, modules/inventory/ledger) stays as it is.
 */

const ROW_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  reason: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  fromLocationId: true,
  toLocationId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  receiptLineId: true,
  workOrderId: true,
  reference: true,
  note: true,
  reversalOfId: true,
  idempotencyKey: true,
  occurredAt: true,
  createdAt: true,
  createdById: true,
  deviceId: true,
  site: { select: { code: true } },
  item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  lot: { select: { id: true, code: true } },
  hide: { select: { id: true, code: true } },
  fromLocation: { select: { id: true, code: true, name: true } },
  toLocation: { select: { id: true, code: true, name: true } },
  device: { select: { id: true, name: true } },
  receiptLine: { select: { receipt: { select: { id: true, number: true } } } },
  reversals: { select: { id: true } },
} as const satisfies Prisma.StockMoveSelect
type MoveData = Prisma.StockMoveGetPayload<{ select: typeof ROW_SELECT }>

/** Where a move comes from or goes to when it is not a place of the site: the reason says it. */
function outside(reason: StockMoveReason, end: 'from' | 'to'): LedgerRow['from']['kind'] {
  switch (reason) {
    case 'RECEIPT':
      return end === 'from' ? 'SUPPLIER' : 'OUTSIDE'
    case 'OPENING':
      return 'OPENING'
    case 'ISSUE':
    case 'RETURN':
      return 'WORK_ORDER'
    case 'COUNT':
      return 'COUNT'
    case 'ADJUSTMENT':
      return 'ADJUSTMENT'
    case 'SCRAP':
      return 'SCRAP'
    default:
      return 'OUTSIDE'
  }
}

interface Extras {
  /** A write-off's group key → its first move's id (the write-off's id). */
  readonly writeOffs: ReadonlyMap<string, string>
  readonly users: ReadonlyMap<string, string>
  readonly orders: ReadonlyMap<string, string>
  readonly valuations: ReadonlyMap<string, { method: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal; valueAmount: number; currency: string }>
  readonly withCost: boolean
  readonly locationId: string | null
}

/** Office users' names, work order numbers and (with the cost grain) the values of these moves. */
async function extrasFor(client: FactoryClient, rows: readonly MoveData[], context: OfficeContext, locationId: string | null): Promise<Extras> {
  const withCost = seesCost(context)
  // A floor move's createdById is the worker: never resolved here (the list names its device).
  const userIds = [...new Set(rows.flatMap((row) => (row.createdById && !row.deviceId ? [row.createdById] : [])))]
  const orderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
  const [users, orders, valuations] = await Promise.all([
    userIds.length > 0 ? client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    orderIds.length > 0 ? client.workOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
    withCost && rows.length > 0
      ? client.stockValuation.findMany({ where: { moveId: { in: rows.map((row) => row.id) } }, select: { moveId: true, method: true, quantity: true, unitCost: true, valueAmount: true, currency: true } })
      : Promise.resolve([]),
  ])
  // A write-off's id is its first move's (`…:1`): found by its group key for the rows of a write-off.
  const groups = [...new Set(rows.flatMap((row) => (writeOffOf(row) ? [writeOffGroupOf(row.idempotencyKey)!] : [])))]
  const firsts = groups.length > 0 ? await client.stockMove.findMany({ where: { idempotencyKey: { in: groups.map((group) => `${group}:1`) } }, select: { id: true, idempotencyKey: true } }) : []
  return {
    writeOffs: new Map(firsts.map((row) => [writeOffGroupOf(row.idempotencyKey)!, row.id])),
    users: new Map(users.map((user) => [user.id, user.displayName])),
    orders: new Map(orders.map((order) => [order.id, order.number])),
    valuations: new Map(valuations.map((row) => [row.moveId, row])),
    withCost,
    locationId,
  }
}

/** A write-off's move: its reason code, its note without the code, its write-off's id. */
function writeOffRow(move: MoveData, extras: Extras): LedgerRow['writeOff'] {
  const parsed = writeOffOf(move)
  const group = parsed ? writeOffGroupOf(move.idempotencyKey) : null
  const id = group ? extras.writeOffs.get(group) : undefined
  return parsed && id ? { id, reasonCode: parsed.reasonCode, note: parsed.note } : null
}

function rowOf(move: MoveData, extras: Extras): LedgerRow {
  const ledger = { ...move, baseQuantity: move.baseQuantity.toString() }
  const delta: Decimal = extras.locationId ? locationDelta(ledger, extras.locationId) : siteDelta(ledger)
  const receipt = move.receiptLine?.receipt ?? null
  const orderNumber = move.workOrderId ? extras.orders.get(move.workOrderId) : undefined
  const valuation = extras.valuations.get(move.id)
  const audience = move.deviceId ? 'FLOOR' : move.createdById ? 'OFFICE' : 'SYSTEM'
  return {
    id: move.id,
    companyId: move.companyId,
    siteId: move.siteId,
    siteCode: move.site.code,
    reason: move.reason,
    occurredAt: toUtcIso(move.occurredAt),
    createdAt: toUtcIso(move.createdAt),
    item: move.item,
    colour: move.itemColour,
    lot: move.lot,
    hide: move.hide,
    from: { kind: move.fromLocation ? 'LOCATION' : outside(move.reason, 'from'), location: move.fromLocation },
    to: { kind: move.toLocation ? 'LOCATION' : outside(move.reason, 'to'), location: move.toLocation },
    quantity: move.quantity.toFixed(4),
    uom: move.uom,
    baseQuantity: move.baseQuantity.toFixed(4),
    delta: fixed(delta),
    document: receipt ? { type: 'GoodsReceipt', id: receipt.id, number: receipt.number } : move.workOrderId && orderNumber ? { type: 'WorkOrder', id: move.workOrderId, number: orderNumber } : null,
    reference: move.reference,
    note: move.note,
    reversalOfId: move.reversalOfId,
    reversedById: move.reversals[0]?.id ?? null,
    postedBy: {
      audience,
      name: audience === 'OFFICE' && move.createdById ? (extras.users.get(move.createdById) ?? null) : null,
      device: move.device,
    },
    writeOff: writeOffRow(move, extras),
    ...(extras.withCost
      ? {
          valuation: asMoney(
            'cost',
            valuation
              ? {
                  method: valuation.method as never,
                  quantity: valuation.quantity.toFixed(4),
                  unitCost: asMoney('cost', valuation.unitCost.toFixed(6)),
                  valueAmount: asMoney('cost', valuation.valueAmount),
                  currency: valuation.currency,
                }
              : null,
          ),
        }
      : {}),
  }
}

export interface LedgerQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly locationId?: string | undefined
  readonly reasons?: readonly StockMoveReason[] | undefined
  readonly createdById?: string | undefined
  readonly deviceId?: string | undefined
  readonly documentId?: string | undefined
  readonly hasNote?: boolean | undefined
  readonly reversed?: boolean | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  /** Text or a scanned code (SCM-195). */
  readonly q?: string | undefined
  readonly writeOffs?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** Write-offs: SCRAP moves posted by the write-off command (their keys), not reversals. */
const WRITE_OFFS: Prisma.StockMoveWhereInput = { reason: 'SCRAP', reversalOfId: null, idempotencyKey: { startsWith: `${WRITE_OFF_COMMAND}:` } }

/**
 * The moves a search names (SCM-195): a material's code or name, a lot, a hide, a location (from or to), a work order's
 * or a goods receipt's number, the reference or the note — case-insensitive, contained. Work orders by number are read
 * first (the ledger names them by id only).
 */
async function searchWhere(client: FactoryClient, text: string): Promise<Prisma.StockMoveWhereInput> {
  const like = { contains: text, mode: 'insensitive' as const }
  const orders = await client.workOrder.findMany({ where: { number: like }, select: { id: true }, take: 200 })
  return {
    OR: [
      { item: { OR: [{ code: like }, { name: like }] } },
      { lot: { code: like } },
      { hide: { code: like } },
      { fromLocation: { code: like } },
      { toLocation: { code: like } },
      { receiptLine: { receipt: { number: like } } },
      { reference: like },
      { note: like },
      ...(orders.length > 0 ? [{ workOrderId: { in: orders.map((order) => order.id) } }] : []),
    ],
  }
}

/** The stock key a filter names (site + item, narrowed by colour, lot, hide, location), for the moves and the balance. */
function keyWhere(query: Pick<LedgerQuery, 'siteId' | 'itemId' | 'itemColourId' | 'lotId' | 'hideId' | 'locationId'>): Prisma.StockMoveWhereInput[] {
  return [
    query.siteId ? { siteId: query.siteId } : {},
    query.itemId ? { itemId: query.itemId } : {},
    query.itemColourId ? { itemColourId: query.itemColourId } : {},
    query.lotId ? { lotId: query.lotId } : {},
    query.hideId ? { hideId: query.hideId } : {},
    query.locationId ? { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] } : {},
  ]
}

/** The balance of the moves matching `where` now: the location's, else the site's (Σ in − Σ out). */
async function balanceOf(client: FactoryClient, where: Prisma.StockMoveWhereInput, locationId: string | null): Promise<Decimal> {
  const [into, outOf] = await Promise.all([
    client.stockMove.aggregate({ where: { AND: [where, locationId ? { toLocationId: locationId } : { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
    client.stockMove.aggregate({ where: { AND: [where, locationId ? { fromLocationId: locationId } : { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
  ])
  return new Dec(into._sum.baseQuantity?.toString() ?? '0').minus(outOf._sum.baseQuantity?.toString() ?? '0')
}

/** The ledger the caller may see, newest first (UUIDv7 ids: the posting order), up to `limit` a page. */
export async function readLedger(caller: CommandCaller, query: LedgerQuery) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.StockMoveWhereInput
  const key = keyWhere(query)
  const where: Prisma.StockMoveWhereInput = {
    AND: [
      scope,
      ...key,
      query.reasons && query.reasons.length > 0 ? { reason: { in: [...query.reasons] } } : {},
      query.createdById ? { createdById: query.createdById, deviceId: null } : {},
      query.deviceId ? { deviceId: query.deviceId } : {},
      query.documentId ? { OR: [{ workOrderId: query.documentId }, { receiptLine: { receiptId: query.documentId } }] } : {},
      query.hasNote === true ? { note: { not: null } } : query.hasNote === false ? { note: null } : {},
      query.reversed === true ? { OR: [{ reversalOfId: { not: null } }, { reversals: { some: {} } }] } : query.reversed === false ? { reversalOfId: null, reversals: { none: {} } } : {},
      query.from ? { occurredAt: { gte: parseInstant(query.from)! } } : {},
      query.to ? { occurredAt: { lt: parseInstant(query.to)! } } : {},
      query.writeOffs === true ? WRITE_OFFS : query.writeOffs === false ? { NOT: WRITE_OFFS } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const searched: Prisma.StockMoveWhereInput = query.q ? { AND: [where, await searchWhere(client, query.q)] } : where
    const rows = await client.stockMove.findMany({ where: { AND: [searched, query.cursor ? { id: { lt: query.cursor } } : {}] }, select: ROW_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 })
    // The one long grid sizes itself from the first page's total (Owner answer W2 B); later pages need none.
    const rowCount = query.cursor ? null : rows.length <= query.limit ? rows.length : await client.stockMove.count({ where: searched })
    const page = rows.slice(0, query.limit)
    const extras = await extrasFor(client, page, context, query.locationId ?? null)
    // One stock key (site and item at least) and no other narrowing: the running balance is meaningful. A `from` only
    // trims older rows (the newest row's balance is still the balance now); a `to` would cut newer ones, so it has none.
    const oneKey =
      Boolean(query.siteId && query.itemId) && !query.reasons?.length && !query.createdById && !query.deviceId && !query.documentId && query.hasNote === undefined && query.reversed === undefined && !query.to && !query.q && query.writeOffs === undefined
    const closing = oneKey ? fixed(await balanceOf(client, { AND: [scope, ...key] }, query.locationId ?? null)) : null
    return { moves: page.map((row) => rowOf(row, extras)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null, rowCount, closing }
  })
}

/** The tiles of the Movements page: adjustments of 7 days, scraps, count differences and reversals of 30 days; moves not valued yet (cost grain). */
export async function ledgerCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const scope: Prisma.StockMoveWhereInput = { AND: [scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.StockMoveWhereInput, query.siteId ? { siteId: query.siteId } : {}] }
  const since = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const [adjustments7d, scraps30d, writeOffs30d, counts30d, reversals30d, changing] = await Promise.all([
      client.stockMove.count({ where: { AND: [scope, { reason: 'ADJUSTMENT', reversalOfId: null, createdAt: { gte: since(7) } }] } }),
      client.stockMove.count({ where: { AND: [scope, { reason: 'SCRAP', reversalOfId: null, createdAt: { gte: since(30) } }] } }),
      client.stockMove.count({ where: { AND: [scope, WRITE_OFFS, { reversals: { none: {} }, createdAt: { gte: since(30) } }] } }),
      client.stockMove.count({ where: { AND: [scope, { reason: 'COUNT', reversalOfId: null, createdAt: { gte: since(30) } }] } }),
      client.stockMove.count({ where: { AND: [scope, { reversalOfId: { not: null }, createdAt: { gte: since(30) } }] } }),
      withCost
        ? client.stockMove.count({ where: { AND: [scope, { valuations: { none: {} } }, { OR: [{ fromLocationId: null, toLocationId: { not: null } }, { toLocationId: null, fromLocationId: { not: null } }] }] } })
        : Promise.resolve(null),
    ])
    return { adjustments7d, scraps30d, writeOffs30d, counts30d, reversals30d, ...(withCost ? { unvalued: asMoney('cost', changing ?? 0) } : {}) }
  })
}

/** One move (the DetailModal): every field, its value, its reversal or original, and the worker where the site names one. */
export async function ledgerMove(caller: CommandCaller, moveId: string) {
  const context = officeContextOf(caller)
  const move = isUuid(moveId) ? await caller.withClient((client) => client.stockMove.findUnique({ where: { id: moveId }, select: ROW_SELECT })) : null
  if (!move || !mayAt(context, INVENTORY_STOCK_VIEW, move)) throw new NotFoundError('Stock move not found.')
  return caller.withClient(async (client) => {
    const related = await client.stockMove.findMany({ where: { id: { in: [move.reversalOfId, move.reversals[0]?.id].filter((id): id is string => !!id) } }, select: ROW_SELECT })
    const extras = await extrasFor(client, [move, ...related], context, null)
    const subject = await scanSubjectFor(client, move.siteId)
    const stationOnly = subject === 'STATION'
    let worker: string | null = null
    if (move.deviceId && move.createdById && !stationOnly) {
      worker = (await client.worker.findUnique({ where: { id: move.createdById }, select: { displayName: true } }))?.displayName ?? null
    }
    const original = move.reversalOfId ? related.find((row) => row.id === move.reversalOfId) : undefined
    const reversal = move.reversals[0] ? related.find((row) => row.id === move.reversals[0]!.id) : undefined
    return {
      move: { ...rowOf(move, extras), idempotencyKey: move.idempotencyKey, receiptLineId: move.receiptLineId, workOrderId: move.workOrderId, worker, stationOnly },
      original: original ? rowOf(original, extras) : null,
      reversal: reversal ? rowOf(reversal, extras) : null,
    }
  })
}

// ---- why is it this number (SCM-191) -----------------------------------------------------------------------------------

export interface ExplainQuery {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly locationId?: string | undefined
  /** The figure as it was at this instant (SCM-197). */
  readonly asOf?: string | undefined
}

// PRODUCTION_RECEIPT (W2a wave 5, finished goods) too: without it the sum would leave a gap where there is none.
const REASON_ORDER: readonly StockMoveReason[] = ['OPENING', 'RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'COUNT', 'SCRAP', 'PRODUCTION_RECEIPT']

/**
 * "Why is it 84.20 m²": the figure of one stock key (a site's stock, or one location's) as the sum of its moves by reason
 * — in, out and net per reason, and whether the nets add up to the balance the stock page shows (they always should: a
 * gap is a bug, and the answer says so).
 */
export async function explainFigure(caller: CommandCaller, query: ExplainQuery) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.StockMoveWhereInput
  const locationId = query.locationId ?? null
  const asOf = query.asOf ? parseInstant(query.asOf) : null
  const where: Prisma.StockMoveWhereInput = { AND: [scope, ...keyWhere(query), asOf ? { occurredAt: { lte: asOf } } : {}] }
  return caller.withClient(async (client) => {
    const [site, item, colour, lot, hide, location] = await Promise.all([
      client.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true } }),
      client.item.findUnique({ where: { id: query.itemId }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } }),
      query.itemColourId ? client.itemColour.findUnique({ where: { id: query.itemColourId }, select: { id: true, code: true, name: true } }) : Promise.resolve(null),
      query.lotId ? client.lot.findUnique({ where: { id: query.lotId }, select: { id: true, code: true } }) : Promise.resolve(null),
      query.hideId ? client.hide.findUnique({ where: { id: query.hideId }, select: { id: true, code: true } }) : Promise.resolve(null),
      locationId ? client.location.findUnique({ where: { id: locationId }, select: { id: true, code: true, name: true, siteId: true } }) : Promise.resolve(null),
    ])
    if (!site || !item || !mayAt(context, INVENTORY_STOCK_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Stock not found.')
    if ((query.itemColourId && !colour) || (query.lotId && !lot) || (query.hideId && !hide) || (locationId && location?.siteId !== site.id)) throw new NotFoundError('Stock not found.')
    const [into, outOf, counted] = await Promise.all([
      client.stockMove.groupBy({ by: ['reason'], where: { AND: [where, locationId ? { toLocationId: locationId } : { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
      client.stockMove.groupBy({ by: ['reason'], where: { AND: [where, locationId ? { fromLocationId: locationId } : { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
      client.stockMove.groupBy({ by: ['reason'], where, _count: { _all: true } }),
    ])
    const sumOf = (rows: typeof into, reason: StockMoveReason) => new Dec(rows.find((row) => row.reason === reason)?._sum.baseQuantity?.toString() ?? '0')
    const byReason = REASON_ORDER.flatMap((reason) => {
      const moves = counted.find((row) => row.reason === reason)?._count._all ?? 0
      if (moves === 0) return []
      const inQuantity = sumOf(into, reason)
      const outQuantity = sumOf(outOf, reason)
      return [{ reason, in: fixed(inQuantity), out: fixed(outQuantity), net: fixed(inQuantity.minus(outQuantity)), moves }]
    })
    const sum = byReason.reduce<Decimal>((total, row) => total.plus(row.net), ZERO)
    // The balance as the located balances give it (the stock page's figure), read independently of the reasons.
    const onHand = await balanceOf(client, where, locationId)
    const gap = onHand.minus(sum)
    return {
      siteId: site.id,
      asOf: asOf ? toUtcIso(asOf) : null,
      item,
      colour,
      lot,
      hide,
      location: location ? { id: location.id, code: location.code, name: location.name } : null,
      onHand: fixed(onHand),
      byReason,
      sum: fixed(sum),
      addsUp: gap.isZero(),
      gap: fixed(gap),
      moves: counted.reduce((total, row) => total + row._count._all, 0),
    }
  })
}

