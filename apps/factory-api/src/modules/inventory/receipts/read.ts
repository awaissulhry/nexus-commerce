import type { Prisma, Uom } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import {
  expectedBaseOf,
  lineDifference,
  lotStateWords,
  reversalBlockers,
  reversalRefusal,
  type HoldReason,
  type ReversalBlockerCode,
} from '@nexus/factory-domain/inventory/receipts/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { mayAt, officeContextOf, seesCost, type StockContext } from '../ledger/access'
import {
  byId,
  ddtPhotosOf,
  dec,
  discrepancyCounts,
  HIDE_COLUMNS,
  ids,
  LOT_COLUMNS,
  readColours,
  readItems,
  readOrderLines,
  readReceiptMoves,
  RECEIPT_COLUMNS,
  RECEIPT_LINE_COLUMNS,
  type LotRow,
  type ReceiptMoveRow,
  type ReceiptRow,
  type Reader,
} from './store'

/**
 * The goods receipts' reads (B-W1-32; A2 SCR-063 Receipts, SCR-061 Lots, SCR-062 Hides): the list, the record (its lines
 * against the order, its lots with their quality in words, whether it may be reversed and what used its stock), its lots
 * with every hide one by one, and the order lines still expected at a site. Office only (inventory.stock.view; a
 * goods-in tablet reads through modules/inventory/receiving, B-W1-33). Values only for the cost grain. Every read here selects no relation, so the
 * record is built the same way inside the receipt's command and outside it.
 */

const day = (value: Date | null): string | null => (value === null ? null : businessDate(value, 'UTC'))
const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
const sumOf = (values: Iterable<Decimal>): Decimal => [...values].reduce((sum, value) => sum.plus(value), ZERO)

/** The receipt the caller may see (another company's or site's: not found). */
export async function visibleReceipt(caller: CommandCaller, receiptId: string, permission: Permission = INVENTORY_STOCK_VIEW): Promise<{ context: StockContext; receipt: ReceiptRow }> {
  const context = officeContextOf(caller)
  const receipt = isUuid(receiptId) ? await caller.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS })) : null
  if (!receipt || !mayAt(context, permission, receipt)) throw new NotFoundError('Goods receipt not found.')
  return { context, receipt }
}

/** A lot's holds while it is in quarantine, from what it carries. */
export function holdsOf(lot: Pick<LotRow, 'qualityStatus' | 'requiresCrViTest' | 'crViStatus' | 'qualityNote'>, isPpeComponent: boolean): HoldReason[] {
  if (lot.qualityStatus !== 'QUARANTINE') return []
  const holds: HoldReason[] = []
  if (lot.requiresCrViTest && lot.crViStatus !== 'PASS') holds.push('CR_VI_TEST')
  if (isPpeComponent) holds.push('PPE_CERTIFICATE')
  if (lot.qualityNote) holds.push('QUALITY_HOLD')
  return holds
}

export function lotView(lot: LotRow, facts: { readonly isPpeComponent: boolean; readonly baseQuantity: Decimal; readonly hideCount: number }) {
  const crViLimitMgKg = lot.crViLimitMgKg === null ? null : lot.crViLimitMgKg.toFixed(3)
  return {
    id: lot.id,
    code: lot.code,
    supplierLotRef: lot.supplierLotRef,
    dyeBatch: lot.dyeBatch,
    shade: lot.shade,
    receivedAt: iso(lot.receivedAt),
    qualityStatus: lot.qualityStatus,
    qualityNote: lot.qualityNote,
    requiresCrViTest: lot.requiresCrViTest,
    crViStatus: lot.crViStatus,
    crViLimitMgKg,
    holds: holdsOf(lot, facts.isPpeComponent),
    words: lotStateWords({
      qualityStatus: lot.qualityStatus,
      requiresCrViTest: lot.requiresCrViTest,
      crViStatus: lot.crViStatus,
      crViLimitMgKg,
      holdNote: lot.qualityStatus === 'QUARANTINE' ? lot.qualityNote : null,
      isPpeComponent: facts.isPpeComponent,
    }),
    baseQuantity: quantityText(facts.baseQuantity),
    hideCount: facts.hideCount,
  }
}

/** The values of these moves (the cost grain), one currency; null when unvalued or mixed. */
async function valueOf(db: Reader, moveIds: readonly string[]): Promise<Map<string, { currency: string; valueAmount: number }>> {
  const rows = moveIds.length === 0 ? [] : await db.stockValuation.findMany({ where: { moveId: { in: [...moveIds] } }, select: { moveId: true, currency: true, valueAmount: true } })
  return new Map(rows.map((row) => [row.moveId, { currency: row.currency, valueAmount: row.valueAmount }]))
}
function total(values: readonly ({ currency: string; valueAmount: number } | undefined)[]) {
  if (values.length === 0 || values.some((entry) => entry === undefined)) return null
  const currencies = new Set(values.map((entry) => entry!.currency))
  if (currencies.size !== 1) return null
  return { currency: [...currencies][0]!, valueAmount: asMoney('cost', values.reduce((sum, entry) => sum + entry!.valueAmount, 0)) }
}

// ---- what used a receipt's stock -----------------------------------------------------------------------------------------------

export interface Blockers {
  readonly receiptLocation: string
  readonly blockers: {
    readonly code: ReversalBlockerCode
    readonly path: string
    readonly message: string
    /** The work order number, the location code or the move's reason (as the message names it). */
    readonly where: string
    /** The lots and hides of this group, by their codes (a screen says the group in its own words). */
    readonly items: { readonly kind: 'LOT' | 'HIDE'; readonly code: string }[]
  }[]
  readonly message: string | null
}

/**
 * How the stock a receipt brought was touched since it was posted (factory-domain reversalBlockers): every other move of
 * its lots (lot-tracked) and hides (leather), per place. Untracked material has no key of its own: the ledger's balance
 * check refuses its mirror when the stock is gone.
 */
export async function blockersOf(db: Reader, moves: readonly ReceiptMoveRow[]): Promise<Blockers> {
  const tracked = moves.filter((move) => move.lotId !== null)
  const locationIds = ids(moves.map((move) => move.toLocationId))
  const receiptLocation = locationIds.length > 0 ? ((await db.location.findUnique({ where: { id: locationIds[0]! }, select: { code: true } }))?.code ?? '') : ''
  if (tracked.length === 0) return { receiptLocation, blockers: [], message: null }
  const own = moves.map((move) => move.id)
  const others = await db.stockMove.findMany({
    where: { lotId: { in: ids(tracked.map((move) => move.lotId)) }, id: { notIn: own }, OR: [{ reversalOfId: null }, { reversalOfId: { notIn: own } }] },
    select: { lotId: true, hideId: true, reason: true, fromLocationId: true, toLocationId: true, baseQuantity: true, workOrderId: true },
  })
  const [lots, hides, locations, workOrders] = [
    byId(await db.lot.findMany({ where: { id: { in: ids(tracked.map((move) => move.lotId)) } }, select: { id: true, code: true } })),
    byId(await db.hide.findMany({ where: { id: { in: ids(tracked.map((move) => move.hideId)) } }, select: { id: true, code: true } })),
    byId(await db.location.findMany({ where: { id: { in: ids(others.flatMap((move) => [move.fromLocationId, move.toLocationId])) } }, select: { id: true, code: true } })),
    byId(await db.workOrder.findMany({ where: { id: { in: ids(others.map((move) => move.workOrderId)) } }, select: { id: true, number: true } })),
  ]
  const blockers = reversalBlockers(
    tracked.map((move) => ({
      key: move.hideId ?? move.lotId!,
      label: move.hideId ? `hide ${hides.get(move.hideId)?.code ?? move.hideId}` : `lot ${lots.get(move.lotId!)?.code ?? move.lotId}`,
      toLocationId: move.toLocationId!,
    })),
    others.map((move) => ({ key: move.hideId ?? move.lotId!, reason: move.reason, fromLocationId: move.fromLocationId, toLocationId: move.toLocationId, baseQuantity: move.baseQuantity.toString(), workOrderId: move.workOrderId })),
    { location: (id) => locations.get(id)?.code ?? id, workOrder: (id) => workOrders.get(id)?.number ?? id },
  )
  if (blockers.length === 0) return { receiptLocation, blockers: [], message: null }
  const refusal = reversalRefusal(blockers, receiptLocation)
  // The same groups as the refusal's issues (one per kind of use and place, in the same order): what each names.
  const items = new Map(
    tracked.map((move) => [move.hideId ?? move.lotId!, move.hideId ? { kind: 'HIDE' as const, code: hides.get(move.hideId)?.code ?? move.hideId } : { kind: 'LOT' as const, code: lots.get(move.lotId!)?.code ?? move.lotId! }]),
  )
  const groups = new Map<string, typeof blockers>()
  for (const blocker of blockers) groups.set(`${blocker.code}|${blocker.where}`, [...(groups.get(`${blocker.code}|${blocker.where}`) ?? []), blocker])
  const named = [...groups.values()].map((group) => ({ where: group[0]!.where, items: [...new Map(group.map((blocker) => [blocker.key, items.get(blocker.key)!])).values()] }))
  return {
    receiptLocation,
    blockers: refusal.issues.map((issue, index) => ({ code: issue.path.split('/')[1] as ReversalBlockerCode, path: issue.path, message: issue.message, where: named[index]?.where ?? '', items: named[index]?.items ?? [] })),
    message: refusal.message,
  }
}

// ---- the record --------------------------------------------------------------------------------------------------------------------

/** The receipt as every route answers it (inside a command too: no relation select). */
export async function receiptDetail(db: Reader, context: RequestContext, receipt: ReceiptRow) {
  const withCost = seesCost(context)
  const lines = await db.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: RECEIPT_LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const items = await readItems(db, lines.map((line) => line.itemId))
  const colours = await readColours(db, lines.map((line) => line.itemColourId))
  const site = await db.site.findUniqueOrThrow({ where: { id: receipt.siteId }, select: { code: true, name: true } })
  const supplier = await db.party.findUnique({ where: { id: receipt.supplierId }, select: { id: true, legalName: true } })
  const order = receipt.purchaseOrderId ? await db.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId }, select: { id: true, number: true, status: true, version: true } }) : null
  const orderLines = order ? await readOrderLines(db, order.id) : null
  const lots = await db.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: LOT_COLUMNS, orderBy: { code: 'asc' } })
  const hideCounts = new Map(
    (await db.hide.groupBy({ by: ['lotId'], where: { lotId: { in: lots.map((lot) => lot.id) } }, _count: { _all: true } })).map((row) => [row.lotId, row._count._all]),
  )
  const moves = await readReceiptMoves(db, receipt.id)
  const locationId = moves[0]?.toLocationId ?? null
  const location = locationId ? await db.location.findUnique({ where: { id: locationId }, select: { id: true, code: true, name: true } }) : null
  const values = withCost ? await valueOf(db, moves.map((move) => move.id)) : new Map()
  const blockers = receipt.status === 'POSTED' ? await blockersOf(db, moves) : null
  // B-W2a-31: the delivery note's photos and the discrepancies by state.
  const ddtPhotos = await ddtPhotosOf(db, receipt.id)
  const discrepancies = (await discrepancyCounts(db, [receipt.id])).get(receipt.id) ?? { count: 0, open: 0, unsent: 0 }

  const lotBase = (lotId: string) => sumOf(moves.filter((move) => move.lotId === lotId).map((move) => dec(move.baseQuantity)))
  const quantities = new Map<Uom, Decimal>()
  for (const line of lines) {
    const baseUom = items.get(line.itemId)!.baseUom
    quantities.set(baseUom, (quantities.get(baseUom) ?? ZERO).plus(dec(line.baseQuantity)))
  }
  const viewLines = lines.map((line) => {
    const item = items.get(line.itemId)!
    const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
    const orderLine = line.purchaseOrderLineId ? orderLines?.lines.find((entry) => entry.id === line.purchaseOrderLineId) : undefined
    const received = orderLine ? (orderLines!.received.get(orderLine.id) ?? ZERO) : ZERO
    const expected = orderLine ? expectedBaseOf({ quantity: orderLine.quantity.toString(), baseQuantity: orderLine.baseQuantity.toString(), confirmedQuantity: orderLine.confirmedQuantity?.toString() ?? null }) : ZERO
    const others = receipt.status === 'POSTED' ? received.minus(dec(line.baseQuantity)) : received
    const lineLots = lots.filter((lot) => lot.receiptLineId === line.id)
    const lineMoves = moves.filter((move) => move.receiptLineId === line.id)
    return {
      id: line.id,
      seq: line.seq,
      purchaseOrderLineId: line.purchaseOrderLineId,
      item: { id: item.id, code: item.code, name: item.name, tracking: item.tracking, baseUom: item.baseUom },
      colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
      quantity: quantityText(line.quantity.toString()),
      uom: line.uom,
      baseQuantity: quantityText(line.baseQuantity.toString()),
      hideCount: line.hideCount,
      note: line.note,
      received:
        line.receivedQuantity !== null && line.receivedUom !== null && line.receivedFactor !== null
          ? { quantity: quantityText(line.receivedQuantity.toString()), uom: line.receivedUom, factor: line.receivedFactor.toFixed(8) }
          : null,
      orderLine: orderLine
        ? {
            seq: orderLine.seq,
            quantity: quantityText(orderLine.quantity.toString()),
            uom: orderLine.uom,
            baseQuantity: quantityText(orderLine.baseQuantity.toString()),
            expected: quantityText(expected),
            received: quantityText(received),
            open: quantityText(Dec.max(ZERO, expected.minus(received))),
            tolerancePct: orderLine.areaTolerancePct === null ? null : orderLine.areaTolerancePct.toString(),
            estimatedHides: orderLine.estimatedHides,
            oneDyeBatch: orderLine.oneDyeBatch,
            requiresCrViTest: orderLine.requiresCrViTest,
          }
        : null,
      difference: orderLine
        ? (({ kind, expected: e, receivedBefore, after, open, difference, tolerancePct, upTo }) => ({ kind, expected: e, receivedBefore, after, open, difference, tolerancePct, upTo }))(
            lineDifference({ expected, receivedBefore: others, receiving: line.baseQuantity.toString(), tolerancePct: orderLine.areaTolerancePct?.toString() ?? null }),
          )
        : null,
      lots: lineLots.map((lot) => lotView(lot, { isPpeComponent: item.isPpeComponent, baseQuantity: lotBase(lot.id), hideCount: hideCounts.get(lot.id) ?? 0 })),
      ...(withCost ? { value: asMoney('cost', total(lineMoves.map((move) => values.get(move.id)))) } : {}),
    }
  })
  return {
    id: receipt.id,
    number: receipt.number,
    status: receipt.status,
    companyId: receipt.companyId,
    siteId: receipt.siteId,
    site,
    supplier: { id: receipt.supplierId, name: supplier?.legalName ?? '' },
    purchaseOrder: order ? { id: order.id, number: order.number, status: order.status, version: order.version } : null,
    supplierDdtNumber: receipt.supplierDdtNumber,
    supplierDdtDate: day(receipt.supplierDdtDate),
    receivedAt: toUtcIso(receipt.receivedAt),
    note: receipt.note,
    location,
    postedAt: iso(receipt.postedAt),
    postedById: receipt.postedById,
    reversedAt: iso(receipt.reversedAt),
    reversedById: receipt.reversedById,
    reversalReason: receipt.reversalReason,
    cancelledAt: iso(receipt.cancelledAt),
    version: receipt.version,
    createdAt: toUtcIso(receipt.createdAt),
    createdById: receipt.createdById,
    summary: {
      lines: lines.length,
      lots: lots.length,
      lotsInQuarantine: lots.filter((lot) => lot.qualityStatus === 'QUARANTINE').length,
      lotsReleased: lots.filter((lot) => lot.qualityStatus === 'RELEASED').length,
      hides: [...hideCounts.values()].reduce((sum, count) => sum + count, 0),
      quantities: [...quantities].map(([uom, baseQuantity]) => ({ uom, baseQuantity: quantityText(baseQuantity) })),
    },
    lines: viewLines,
    ddtPhotos,
    discrepancies,
    reversal: blockers ? { possible: blockers.blockers.length === 0, location: blockers.receiptLocation || null, blockers: blockers.blockers } : null,
    ...(withCost ? { value: asMoney('cost', total(moves.map((move) => values.get(move.id)))) } : {}),
  }
}

/** GET /inventory/receipts/:receiptId */
export async function getReceipt(caller: CommandCaller, receiptId: string) {
  const { context, receipt } = await visibleReceipt(caller, receiptId)
  return { receipt: await caller.withClient((client) => receiptDetail(client, context, receipt)) }
}

// ---- the list --------------------------------------------------------------------------------------------------------------------

export interface ListReceiptsQuery {
  readonly siteId?: string | undefined
  readonly purchaseOrderId?: string | undefined
  readonly supplierId?: string | undefined
  readonly status?: 'OPEN' | 'POSTED' | 'REVERSED' | 'CANCELLED' | undefined
  readonly q?: string | undefined
  /** Posted at or after this instant (the screen's "Posted today": the start of the site's day). */
  readonly postedFrom?: string | undefined
  /** Posted receipts with a lot still in quarantine (waiting for its test, certificate or quality check). */
  readonly waiting?: boolean | undefined
  /** B-W2a-31: `open` — only receipts with a discrepancy not closed yet. */
  readonly discrepancies?: 'open' | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** A posted receipt with a lot still in quarantine. */
const WAITING: Prisma.GoodsReceiptWhereInput = { status: 'POSTED', lines: { some: { lots: { some: { qualityStatus: 'QUARANTINE' } } } } }

/** The list's walls and filters (the list and its counts read the same ones). */
function receiptsWhere(context: OfficeContext, query: Omit<ListReceiptsQuery, 'limit' | 'cursor'>): Prisma.GoodsReceiptWhereInput[] {
  return [
    scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.GoodsReceiptWhereInput,
    query.siteId ? { siteId: query.siteId } : {},
    query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {},
    query.supplierId ? { supplierId: query.supplierId } : {},
    query.status ? { status: query.status } : {},
    query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { supplierDdtNumber: { contains: query.q, mode: 'insensitive' } }] } : {},
    query.postedFrom ? { postedAt: { gte: new Date(query.postedFrom) } } : {},
    query.waiting ? WAITING : {},
    // B-W2a-31: receipts with a discrepancy not closed yet.
    query.discrepancies === 'open' ? { discrepancies: { some: { status: { not: 'CLOSED' } } } } : {},
  ]
}

/**
 * GET /inventory/receipts/counts: the Receipts tiles, in the list's walls — posted, posted since `postedFrom` (the
 * start of the site's day, which the screen knows), posted with a lot still in quarantine, reversed.
 */
export async function countReceipts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly postedFrom?: string | undefined }) {
  const context = officeContextOf(caller)
  const walls = receiptsWhere(context, { siteId: query.siteId })
  return caller.withClient(async (client) => {
    const count = (extra: Prisma.GoodsReceiptWhereInput) => client.goodsReceipt.count({ where: { AND: [...walls, extra] } })
    const [posted, reversed, waiting, postedSince] = await Promise.all([
      count({ status: 'POSTED' }),
      count({ status: 'REVERSED' }),
      count(WAITING),
      query.postedFrom ? count({ postedAt: { gte: new Date(query.postedFrom) } }) : Promise.resolve(null),
    ])
    // B-W2a-31: the discrepancies not closed yet, on the receipts in the list's walls (the "Discrepancies open" tile).
    const discrepanciesOpen = await client.receiptDiscrepancy.count({ where: { status: { not: 'CLOSED' }, receipt: { AND: walls } } })
    return { counts: { posted, reversed, waiting, postedSince, discrepanciesOpen } }
  })
}

/** GET /inventory/receipts: the receipts the caller may see, newest first (by id: UUIDv7). */
export async function listReceipts(caller: CommandCaller, query: ListReceiptsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.GoodsReceiptWhereInput = { AND: [...receiptsWhere(context, query), query.cursor ? { id: { lt: query.cursor } } : {}] }
  return caller.withClient(async (client) => {
    const rows = await client.goodsReceipt.findMany({ where, select: RECEIPT_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const receiptIds = page.map((row) => row.id)
    const lines = await client.goodsReceiptLine.findMany({ where: { receiptId: { in: receiptIds } }, select: { id: true, receiptId: true, itemId: true, baseQuantity: true } })
    const items = await readItems(client, lines.map((line) => line.itemId))
    const lots = await client.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: { id: true, receiptLineId: true, qualityStatus: true } })
    const hides = new Map((await client.hide.groupBy({ by: ['lotId'], where: { lotId: { in: lots.map((lot) => lot.id) } }, _count: { _all: true } })).map((row) => [row.lotId, row._count._all]))
    const parties = byId(await client.party.findMany({ where: { id: { in: ids(page.map((row) => row.supplierId)) } }, select: { id: true, legalName: true } }))
    const orders = byId(await client.purchaseOrder.findMany({ where: { id: { in: ids(page.map((row) => row.purchaseOrderId)) } }, select: { id: true, number: true } }))
    const withCost = seesCost(context)
    const moves = withCost ? await client.stockMove.findMany({ where: { reason: 'RECEIPT', reversalOfId: null, receiptLineId: { in: lines.map((line) => line.id) } }, select: { id: true, receiptLineId: true } }) : []
    const values = withCost ? await valueOf(client, moves.map((move) => move.id)) : new Map()
    const discrepancies = await discrepancyCounts(client, receiptIds)
    return {
      receipts: page.map((row) => {
        const own = lines.filter((line) => line.receiptId === row.id)
        const ownLots = lots.filter((lot) => own.some((line) => line.id === lot.receiptLineId))
        const quantities = new Map<Uom, Decimal>()
        for (const line of own) {
          const baseUom = items.get(line.itemId)!.baseUom
          quantities.set(baseUom, (quantities.get(baseUom) ?? ZERO).plus(dec(line.baseQuantity)))
        }
        const ownMoves = moves.filter((move) => own.some((line) => line.id === move.receiptLineId))
        return {
          id: row.id,
          number: row.number,
          status: row.status,
          companyId: row.companyId,
          siteId: row.siteId,
          supplier: { id: row.supplierId, name: parties.get(row.supplierId)?.legalName ?? '' },
          purchaseOrder: row.purchaseOrderId ? { id: row.purchaseOrderId, number: orders.get(row.purchaseOrderId)?.number ?? '' } : null,
          supplierDdtNumber: row.supplierDdtNumber,
          supplierDdtDate: day(row.supplierDdtDate),
          receivedAt: toUtcIso(row.receivedAt),
          lines: own.length,
          lots: ownLots.length,
          lotsReleased: ownLots.filter((lot) => lot.qualityStatus === 'RELEASED').length,
          hides: ownLots.reduce((sum, lot) => sum + (hides.get(lot.id) ?? 0), 0),
          quantities: [...quantities].map(([uom, baseQuantity]) => ({ uom, baseQuantity: quantityText(baseQuantity) })),
          postedAt: iso(row.postedAt),
          postedById: row.postedById,
          discrepancies: discrepancies.get(row.id) ?? { count: 0, open: 0, unsent: 0 },
          ...(withCost ? { value: asMoney('cost', total(ownMoves.map((move) => values.get(move.id)))) } : {}),
        }
      }),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    }
  })
}

// ---- lots and hides of a receipt -------------------------------------------------------------------------------------------------

/** GET /inventory/receipts/:receiptId/lots: its lots, each with its hides one by one and what lies of each now, where. */
export async function receiptLots(caller: CommandCaller, receiptId: string) {
  const { receipt } = await visibleReceipt(caller, receiptId)
  return caller.withClient(async (client) => {
    const lines = await client.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: { id: true, seq: true, itemId: true }, orderBy: { seq: 'asc' } })
    const items = await readItems(client, lines.map((line) => line.itemId))
    const lots = await client.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: LOT_COLUMNS, orderBy: { code: 'asc' } })
    const hides = await client.hide.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) } }, select: HIDE_COLUMNS, orderBy: { code: 'asc' } })
    const moves = await readReceiptMoves(client, receipt.id)
    // What lies now, per lot and hide, and where (the lot's whole ledger at the site).
    const ledger = await client.stockMove.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) } }, select: { lotId: true, hideId: true, fromLocationId: true, toLocationId: true, baseQuantity: true } })
    const onHand = (where: (move: (typeof ledger)[number]) => boolean) => {
      const places = new Map<string, Decimal>()
      for (const move of ledger.filter(where)) {
        if (move.toLocationId) places.set(move.toLocationId, (places.get(move.toLocationId) ?? ZERO).plus(dec(move.baseQuantity)))
        if (move.fromLocationId) places.set(move.fromLocationId, (places.get(move.fromLocationId) ?? ZERO).minus(dec(move.baseQuantity)))
      }
      const held = [...places].filter(([, quantity]) => !quantity.isZero())
      return { quantity: sumOf(held.map(([, quantity]) => quantity)), locationId: held.length === 1 ? held[0]![0] : null }
    }
    return {
      receiptId: receipt.id,
      number: receipt.number,
      lots: lots.map((lot) => {
        const line = lines.find((entry) => entry.id === lot.receiptLineId)!
        const item = items.get(line.itemId)!
        const own = hides.filter((hide) => hide.lotId === lot.id)
        const base = sumOf(moves.filter((move) => move.lotId === lot.id).map((move) => dec(move.baseQuantity)))
        return {
          ...lotView(lot, { isPpeComponent: item.isPpeComponent, baseQuantity: base, hideCount: own.length }),
          lineSeq: line.seq,
          itemId: lot.itemId,
          itemColourId: lot.itemColourId,
          onHand: quantityText(onHand((move) => move.lotId === lot.id).quantity),
          hides: own.map((hide) => {
            const now = onHand((move) => move.hideId === hide.id)
            return {
              id: hide.id,
              code: hide.code,
              supplierCode: hide.supplierCode,
              area: quantityText(hide.area.toString()),
              areaUom: hide.areaUom,
              baseArea: quantityText(hide.baseArea.toString()),
              grade: hide.grade,
              shade: hide.shade,
              thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toFixed(2),
              defects: hide.defects,
              state: hide.state,
              onHand: quantityText(now.quantity),
              locationId: now.locationId,
            }
          }),
        }
      }),
    }
  })
}

// ---- what is expected --------------------------------------------------------------------------------------------------------------

/**
 * GET /inventory/receipts/expected: the order lines still open at the caller's sites (SENT, CONFIRMED and PARTLY_RECEIVED
 * orders), with what every posted receipt brought: the "Expected" view and the form a new receipt starts from. No price.
 */
export async function expectedLines(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly purchaseOrderId?: string | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const orders = await client.purchaseOrder.findMany({
      where: {
        AND: [
          scopeWhere(actorOf(context), INVENTORY_RECEIVE, { company: 'companyId', site: 'siteId' }) as Prisma.PurchaseOrderWhereInput,
          { status: { in: ['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'] } },
          query.siteId ? { siteId: query.siteId } : {},
          query.purchaseOrderId ? { id: query.purchaseOrderId } : {},
        ],
      },
      select: { id: true, number: true, status: true, version: true, siteId: true, partyId: true },
      orderBy: { number: 'asc' },
      take: query.limit,
    })
    const parties = byId(await client.party.findMany({ where: { id: { in: ids(orders.map((order) => order.partyId)) } }, select: { id: true, legalName: true } }))
    const result = []
    for (const order of orders) {
      const { lines, received } = await readOrderLines(client, order.id)
      const items = await readItems(client, lines.map((line) => line.itemId))
      const colours = await readColours(client, lines.map((line) => line.itemColourId))
      for (const line of lines) {
        // B-W2a-31: a cancelled or closed-short line is no longer expected.
        if (line.cancelledAt || line.closedShortAt) continue
        const expected = expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null })
        const got = received.get(line.id) ?? ZERO
        if (lineDifference({ expected, receivedBefore: got, receiving: '0', tolerancePct: line.areaTolerancePct?.toString() ?? null }).complete && got.greaterThan(0)) continue
        if (expected.isZero()) continue
        const item = items.get(line.itemId)!
        const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
        result.push({
          purchaseOrderId: order.id,
          number: order.number,
          status: order.status,
          version: order.version,
          siteId: order.siteId,
          supplier: { id: order.partyId, name: parties.get(order.partyId)?.legalName ?? '' },
          purchaseOrderLineId: line.id,
          seq: line.seq,
          item: { id: item.id, code: item.code, name: item.name, tracking: item.tracking, baseUom: item.baseUom },
          colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
          quantity: quantityText(line.quantity.toString()),
          uom: line.uom,
          baseQuantity: quantityText(line.baseQuantity.toString()),
          expected: quantityText(expected),
          received: quantityText(got),
          open: quantityText(Dec.max(ZERO, expected.minus(got))),
          tolerancePct: line.areaTolerancePct === null ? null : line.areaTolerancePct.toString(),
          estimatedHides: line.estimatedHides,
          oneDyeBatch: line.oneDyeBatch,
          requiresCrViTest: line.requiresCrViTest,
          needDate: businessDate(line.needDate, 'UTC'),
        })
      }
    }
    return { lines: result }
  })
}
