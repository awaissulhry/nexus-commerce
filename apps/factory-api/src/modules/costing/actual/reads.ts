import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { fromMinorUnits, toMinorUnits } from '@nexus/factory-domain/core/money'
import { pickRate, type LabourRate } from '@nexus/factory-domain/costing/inputs'
import type { LedgerEntryView, LedgerQuery, WorkOrderCostRowView, WorkOrderCostsQuery, WorkOrderCostView } from '@nexus/factory-domain/costing/ledger/contracts'
import { isProvisional, methodWords, perMinuteOf, type CostingMethod } from '@nexus/factory-domain/costing/ledger/entries'
import {
  actualOf,
  biggestReason,
  bridgeOf,
  estimateOf,
  isOver,
  minorParts,
  perGarment,
  standardOfCells,
  variancePct,
  type Actual,
  type EntryFacts,
  type Estimate,
  type MinorParts,
} from '@nexus/factory-domain/costing/ledger/variance'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalOf, decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf } from '../../product/materials/store'
import { methodInForce } from '../method/method'
import { planCosts } from './post'
import {
  ENTRY_COLUMNS,
  entryFacts,
  frozenStandards,
  overheadPctOf,
  ratesOf,
  readEntries,
  readWorkOrders,
  romeDay,
  standardFor,
  unique,
  type CostedWorkOrder,
  type EntryFactsRow,
  type FrozenStandard,
  type Reader,
} from './store'
import { ledgerViews } from './views'

/**
 * Estimated vs actual and the cost ledger, read (B-W2a-21; FIN-026, FIN-027, FIN-033, FIN-038; design finance.costing
 * "Cost at a glance", "Work orders: standard vs actual", "WO — cost", "Cost ledger"; production.workorders "Labour &
 * cost"). costing.view over the work order's company and site; every figure money.cost (dropped without the cost grain:
 * the rows still say the basis, the biggest reason, whether it is over and what waits). Computed on read from the ledger
 * (factory-domain costing/ledger/variance): the standard of each cell's finished item, the estimate at release, the
 * entries so far. Never per person.
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const
const OPEN_STATUSES = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED'] as const
const FINAL = new Set(['COMPLETED', 'CLOSED'])

interface CellFacts {
  readonly id: string
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
  readonly itemId: string | null
  readonly standard: FrozenStandard | null
}

/** Everything one work order's cost is computed from. */
interface CostFacts {
  readonly workOrder: CostedWorkOrder
  readonly style: { readonly id: string; readonly code: string; readonly name: string }
  readonly cells: readonly CellFacts[]
  readonly pieces: number
  readonly estimate: Estimate
  readonly entries: readonly EntryFactsRow[]
  /** The entries as the variance reads them (a standard read for an entry posted before one existed). */
  readonly variance: readonly EntryFacts[]
  readonly method: CostingMethod
  readonly methodLockedAt: Date | null
  readonly materials: ReadonlyMap<string, { readonly planned: string; readonly unitCost: string | null }>
  /** The frozen standard per base unit of each item it names, today (null: none). */
  readonly itemStandards: ReadonlyMap<string, string | null>
  readonly operations: readonly { readonly id: string; readonly seq: number; readonly code: string; readonly name: string; readonly workCentreKind: LabourRate['workCentreKind']; readonly plannedMinutes: string; readonly perMinute: string | null }[]
}

/** The facts of many work orders at once (a page, or every one in scope for the tiles). */
export async function costFactsOf(db: Reader, workOrders: readonly CostedWorkOrder[], now: Date): Promise<CostFacts[]> {
  if (workOrders.length === 0) return []
  const ids = workOrders.map((row) => row.id)
  const companyIds = unique(workOrders.map((row) => row.companyId))
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(workOrders.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true, styleId: true, colourwayId: true, size: true, quantity: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const variants = await db.variant.findMany({ where: { styleId: { in: unique(cells.map((cell) => cell.styleId)) } }, select: { id: true, styleId: true, colourwayId: true, size: true } })
  const variantOf = new Map(variants.map((row) => [`${row.styleId}|${row.colourwayId}|${row.size}`, row.id]))
  const finished = new Map((await db.item.findMany({ where: { variantId: { in: variants.map((row) => row.id) } }, select: { id: true, variantId: true } })).map((row) => [row.variantId!, row.id]))
  const planned = await db.workOrderMaterial.findMany({ where: { workOrderId: { in: ids } }, select: { workOrderId: true, itemId: true, baseQuantity: true } })
  const materialItems = new Map((await db.item.findMany({ where: { id: { in: unique(planned.map((row) => row.itemId)) } }, select: { id: true, standardCost: true, currency: true } })).map((row) => [row.id, row]))
  const operations = await db.workOrderOperation.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true, seq: true, code: true, name: true, standardMinutes: true, workCentreId: true }, orderBy: { seq: 'asc' } })
  const centres = new Map((await db.workCentre.findMany({ where: { id: { in: unique(operations.map((row) => row.workCentreId)) } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind]))
  const entries = (await readEntries(db, ids)).map(entryFacts)
  const standards = await frozenStandards(db, companyIds, unique([...finished.values(), ...planned.map((row) => row.itemId), ...entries.map((entry) => entry.itemId)]))
  const rates = new Map<string, LabourRate[]>()
  const overheads = new Map<string, string | null>()
  const methods = new Map<string, Awaited<ReturnType<typeof methodInForce>>>()
  for (const companyId of companyIds) {
    rates.set(companyId, await ratesOf(db, companyId))
    overheads.set(companyId, await overheadPctOf(db, companyId))
    methods.set(companyId, await methodInForce(db, companyId))
  }
  const today = romeDay(now)

  return workOrders.map((workOrder) => {
    const releaseDay = romeDay(workOrder.releasedAt ?? workOrder.createdAt)
    const currency = workOrder.currency
    const myCells: CellFacts[] = cells
      .filter((cell) => cell.workOrderId === workOrder.id)
      .map((cell) => {
        const variantId = variantOf.get(`${cell.styleId}|${cell.colourwayId}|${cell.size}`)
        const itemId = variantId ? (finished.get(variantId) ?? null) : null
        const standard = standardFor(standards, workOrder.companyId, itemId, releaseDay, currency) ?? standardFor(standards, workOrder.companyId, itemId, today, currency)
        return { id: cell.id, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size, quantity: cell.quantity, itemId, standard }
      })
    const pieces = myCells.reduce((sum, cell) => sum + cell.quantity, 0)
    // The estimate at release: the frozen need × each material's standard of that day (else its purchase standard).
    const need = new Map<string, ReturnType<typeof decimalOf>>()
    for (const row of planned.filter((row) => row.workOrderId === workOrder.id)) need.set(row.itemId, (need.get(row.itemId) ?? decimalOf('0')).plus(decimalOf(row.baseQuantity.toString())))
    const materials = new Map<string, { planned: string; unitCost: string | null }>()
    for (const [itemId, quantity] of need) {
      const item = materialItems.get(itemId)
      const frozen = standardFor(standards, workOrder.companyId, itemId, releaseDay, currency)
      const unitCost = frozen?.unitCost ?? (item?.standardCost !== null && item?.standardCost !== undefined && item.currency === currency ? decimalText(item.standardCost.toString()) : null)
      materials.set(itemId, { planned: decimalText(quantity), unitCost })
    }
    const myOperations = operations
      .filter((row) => row.workOrderId === workOrder.id)
      .map((row) => {
        const kind = centres.get(row.workCentreId)!
        const rate = pickRate(rates.get(workOrder.companyId) ?? [], kind, workOrder.companyId, releaseDay)
        const perMinute = rate && rate.currency === currency ? perMinuteOf(rate) : null
        return { id: row.id, seq: row.seq, code: row.code, name: row.name, workCentreKind: kind, plannedMinutes: decimalText(decimalOf(row.standardMinutes.toString()).times(pieces)), perMinute }
      })
    const estimate = estimateOf({
      materials: [...materials.entries()].map(([itemId, row]) => ({ itemId, baseQuantity: row.planned, unitCost: row.unitCost })),
      operations: myOperations.map((row) => ({ operationId: row.id, minutes: row.plannedMinutes, perMinute: row.perMinute })),
      overheadPct: overheads.get(workOrder.companyId) ?? null,
    })
    const mine = entries.filter((entry) => entry.workOrderId === workOrder.id)
    // A MATERIAL entry posted before its material had a frozen standard is compared with the one of its day now (a frozen
    // standard never changes); a reversal with what its original was compared with.
    const resolved = new Map<string, string | null>()
    for (const entry of mine.filter((row) => row.reversalOfId === null)) {
      resolved.set(entry.id, entry.standardUnitCost ?? standardFor(standards, workOrder.companyId, entry.itemId, romeDay(entry.occurredAt), currency)?.unitCost ?? null)
    }
    const variance: EntryFacts[] = mine.map((entry) => ({
      kind: entry.kind,
      amount: entry.amount,
      quantity: entry.quantity,
      unitCost: entry.unitCost,
      standardUnitCost: entry.reversalOfId ? (resolved.get(entry.reversalOfId) ?? entry.standardUnitCost) : (resolved.get(entry.id) ?? null),
      scrapRecord: entry.kind === 'SCRAP' && entry.amount === 0,
    }))
    const method = methods.get(workOrder.companyId)!
    const itemStandards = new Map(unique([...materials.keys(), ...mine.map((entry) => entry.itemId)]).map((itemId) => [itemId, standardFor(standards, workOrder.companyId, itemId, today, currency)?.unitCost ?? null]))
    return {
      workOrder,
      style: styles.get(workOrder.styleId) ?? { id: workOrder.styleId, code: '', name: '' },
      cells: myCells,
      pieces,
      estimate,
      entries: mine,
      variance,
      method: method.method,
      methodLockedAt: method.row?.methodLockedAt ?? null,
      materials,
      itemStandards,
      operations: myOperations,
    }
  })
}

interface Computed {
  readonly facts: CostFacts
  readonly standard: MinorParts | null
  readonly estimate: MinorParts
  readonly actual: Actual
  readonly basis: 'STANDARD' | 'ESTIMATE' | null
  readonly basisParts: MinorParts | null
  readonly variance: number | null
}

function compute(facts: CostFacts): Computed {
  const currency = facts.workOrder.currency
  const exactStandard = standardOfCells(facts.cells.map((cell) => ({ cellId: cell.id, quantity: cell.quantity, standard: cell.standard })))
  const standard = exactStandard ? minorParts(exactStandard, currency) : null
  const estimate = minorParts(facts.estimate.parts, currency)
  const actual = actualOf(facts.variance, currency)
  const basis = standard ? 'STANDARD' : facts.estimate.complete ? 'ESTIMATE' : null
  const basisParts = basis === 'STANDARD' ? standard : basis === 'ESTIMATE' ? estimate : null
  return { facts, standard, estimate, actual, basis, basisParts, variance: basisParts ? actual.total - basisParts.total : null }
}

function rowOf(computed: Computed): WorkOrderCostRowView {
  const { facts, standard, estimate, actual, basis, basisParts, variance } = computed
  const steps = basisParts ? bridgeOf(basisParts, actual, facts.variance, facts.workOrder.currency) : null
  return {
    workOrder: {
      id: facts.workOrder.id,
      number: facts.workOrder.number,
      status: facts.workOrder.status,
      companyId: facts.workOrder.companyId,
      siteId: facts.workOrder.siteId,
      style: facts.style,
      pieces: facts.pieces,
      releasedAt: facts.workOrder.releasedAt ? toUtcIso(facts.workOrder.releasedAt) : null,
      completedAt: facts.workOrder.completedAt ? toUtcIso(facts.workOrder.completedAt) : null,
    },
    currency: facts.workOrder.currency,
    method: facts.method,
    provisional: isProvisional(facts.method),
    basis,
    standardTotal: asMoney('cost', standard?.total ?? null),
    estimateTotal: asMoney('cost', facts.estimate.parts.material.isZero() && facts.estimate.parts.labour.isZero() ? null : estimate.total),
    estimateComplete: facts.estimate.complete,
    actualTotal: asMoney('cost', actual.total),
    movedToStock: asMoney('cost', actual.movedToStock),
    variance: asMoney('cost', variance),
    variancePct: asMoney('cost', variance === null || !basisParts ? null : variancePct(variance, basisParts.total)),
    biggestReason: steps ? biggestReason(steps) : null,
    over: variance !== null && basisParts !== null && isOver(variance, basisParts.total),
    final: FINAL.has(facts.workOrder.status),
    entries: facts.entries.length,
  }
}

const orderWhere = (caller: CommandCaller, query: Pick<WorkOrderCostsQuery, 'companyId' | 'siteId' | 'status' | 'q' | 'completedFrom' | 'completedTo'>): Prisma.WorkOrderWhereInput => {
  const actor = actorOf(contextOf(caller))
  return {
    AND: [
      scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.WorkOrderWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      { status: { in: query.status && query.status.length > 0 ? [...query.status] : [...OPEN_STATUSES] } },
      query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { batchNumber: { contains: query.q, mode: 'insensitive' } }] } : {},
      // B-W2b-22 (Z9:05): completed on these Europe/Rome days ("Closed in <month>"); the tiles then count the same work orders.
      query.completedFrom ? { completedAt: { gte: businessDayStart(query.completedFrom) } } : {},
      query.completedTo ? { completedAt: { lt: businessDayRange(query.completedTo).end } } : {},
    ],
  }
}

/** GET /costing/work-orders: a page of work orders, standard vs actual, and the tiles over every one in scope. */
export async function workOrderCosts(caller: CommandCaller, query: WorkOrderCostsQuery) {
  const now = serverClock.now()
  const where = orderWhere(caller, query)
  return caller.withClient(async (db) => {
    const page = await readWorkOrders(db, { AND: [where, query.cursor ? { id: { lt: query.cursor } } : {}] }, query.limit + 1)
    const shown = page.slice(0, query.limit)
    const rows = (await costFactsOf(db, shown, now)).map(compute).map(rowOf)
    const tiles = await tilesOf(caller, db, where, now)
    return { rows: query.over ? rows.filter((row) => row.over) : rows, nextCursor: page.length > query.limit ? shown.at(-1)!.id : null, tiles }
  })
}

const TILE_CHUNK = 100

async function tilesOf(caller: CommandCaller, db: Reader, where: Prisma.WorkOrderWhereInput, now: Date) {
  const actor = actorOf(contextOf(caller))
  const month = romeDay(now).slice(0, 7)
  const all = await readWorkOrders(db, where)
  let overStandard = 0
  let varianceThisMonth = 0
  for (let index = 0; index < all.length; index += TILE_CHUNK) {
    for (const computed of (await costFactsOf(db, all.slice(index, index + TILE_CHUNK), now)).map(compute)) {
      if (computed.variance !== null && computed.basisParts && isOver(computed.variance, computed.basisParts.total)) overStandard += 1
      const completed = computed.facts.workOrder.completedAt
      if (computed.variance !== null && completed && romeDay(completed).slice(0, 7) === month) varianceThisMonth += computed.variance
    }
  }
  const currencies = unique(all.map((row) => row.currency))
  const stockScope = scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.StockValuationWhereInput
  const values = await db.stockValuation.groupBy({ by: ['currency'], where: stockScope, _sum: { valueAmount: true } })
  const unvaluedMoves = await db.stockMove.count({
    where: {
      AND: [
        scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.StockMoveWhereInput,
        { valuations: { none: {} } },
        { OR: [{ fromLocationId: null, toLocationId: { not: null } }, { fromLocationId: { not: null }, toLocationId: null }] },
      ],
    },
  })
  const oneCurrency = currencies.length <= 1
  return {
    overStandard: all.length === 0 ? 0 : overStandard,
    varianceThisMonth: asMoney('cost', oneCurrency ? varianceThisMonth : null),
    stockValue: asMoney('cost', values.length === 0 ? 0 : values.length === 1 ? (values[0]!._sum.valueAmount ?? 0) : null),
    unvaluedMoves,
    wipValue: asMoney('cost', null),
    currency: oneCurrency ? (currencies[0] ?? values[0]?.currency ?? null) : null,
    month,
    words: !oneCurrency || values.length > 1 ? 'The companies in view keep their costs in different currencies: choose one company to see the totals.' : null,
  }
}

const cellWords = (cell: CellFacts, day: string): string =>
  cell.itemId === null ? `${cell.colourwayCode} ${cell.size} has no finished-goods item yet: prepare and freeze its standard (Finance › Standard vs actual).` : `${cell.colourwayCode} ${cell.size} has no frozen standard on ${day}.`

/** GET /costing/work-orders/:workOrderId: the cost of one work order (the DetailModal and the Labour & cost tab). */
export async function workOrderCost(caller: CommandCaller, workOrderId: string): Promise<WorkOrderCostView> {
  const context = contextOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const workOrder = isUuid(workOrderId) ? (await readWorkOrders(db, { id: workOrderId }))[0] : undefined
    if (!workOrder || !can(actorOf(context), COSTING_VIEW, { companyId: workOrder.companyId, siteId: workOrder.siteId }) || workOrder.status === 'DRAFT') throw new NotFoundError('Work order not found.')
    const [facts] = await costFactsOf(db, [workOrder], now)
    const computed = compute(facts!)
    const row = rowOf(computed)
    const { standard, estimate, actual, basisParts } = computed
    const currency = workOrder.currency
    const money = (value: number | null) => asMoney('cost', value)
    const parts = (minor: MinorParts) => ({ material: money(minor.material)!, labour: money(minor.labour)!, subcontract: money(minor.subcontract)!, overhead: money(minor.overhead)!, total: money(minor.total)! })
    const steps = basisParts ? bridgeOf(basisParts, actual, facts!.variance, currency) : null
    const pieces = facts!.pieces

    // Materials issued: per item (planned need, issued less returned, at what), and per lot and hide.
    const materialEntries = facts!.entries.filter((entry) => entry.kind === 'MATERIAL')
    const itemIds = unique([...facts!.materials.keys(), ...materialEntries.map((entry) => entry.itemId), ...facts!.entries.map((entry) => entry.itemId)])
    const items = new Map((await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, baseUom: true } })).map((item) => [item.id, item]))
    const moves = new Map(
      (await db.stockMove.findMany({ where: { id: { in: unique(materialEntries.map((entry) => entry.stockMoveId)) } }, select: { id: true, lotId: true, hideId: true } })).map((move) => [move.id, move]),
    )
    const lots = new Map((await db.lot.findMany({ where: { id: { in: unique([...moves.values()].map((move) => move.lotId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const hides = new Map((await db.hide.findMany({ where: { id: { in: unique([...moves.values()].map((move) => move.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const materials = unique([...facts!.materials.keys(), ...materialEntries.map((entry) => entry.itemId)]).map((itemId) => {
      const mine = materialEntries.filter((entry) => entry.itemId === itemId)
      const issued = mine.reduce((sum, entry) => sum.plus(decimalOf(entry.quantity ?? '0')), decimalOf('0'))
      const amount = mine.reduce((sum, entry) => sum + entry.amount, 0)
      const byLot = new Map<string, { lotId: string | null; hideId: string | null; quantity: ReturnType<typeof decimalOf>; amount: number }>()
      for (const entry of mine) {
        const move = entry.stockMoveId ? moves.get(entry.stockMoveId) : undefined
        const key = `${move?.lotId ?? '-'}|${move?.hideId ?? '-'}`
        const row = byLot.get(key) ?? { lotId: move?.lotId ?? null, hideId: move?.hideId ?? null, quantity: decimalOf('0'), amount: 0 }
        byLot.set(key, { ...row, quantity: row.quantity.plus(decimalOf(entry.quantity ?? '0')), amount: row.amount + entry.amount })
      }
      const item = items.get(itemId)!
      const resolved = mine.find((entry) => entry.standardUnitCost !== null)?.standardUnitCost ?? facts!.itemStandards.get(itemId) ?? null
      return {
        item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom },
        plannedQuantity: facts!.materials.get(itemId)?.planned ?? null,
        issuedQuantity: decimalText(issued),
        unitCost: asMoney('cost', issued.isZero() ? null : decimalText(decimalOf(fromMinorUnits(amount, currency).toFixed()).div(issued).toDecimalPlaces(6, 4))),
        standardUnitCost: asMoney('cost', resolved),
        amount: asMoney('cost', amount),
        lots: [...byLot.values()].map((row) => ({ lotId: row.lotId, lotCode: row.lotId ? (lots.get(row.lotId) ?? null) : null, hideId: row.hideId, hideCode: row.hideId ? (hides.get(row.hideId) ?? null) : null, quantity: decimalText(row.quantity), amount: asMoney('cost', row.amount) })),
      }
    })

    // Labour per operation: planned (standard minutes × garments) and earned by the scans, never per person.
    const labourEntries = facts!.entries.filter((entry) => entry.kind === 'LABOUR')
    const scanOps = new Map((await db.operationScan.findMany({ where: { id: { in: unique(labourEntries.map((entry) => entry.operationScanId)) } }, select: { id: true, workOrderOperationId: true } })).map((row) => [row.id, row.workOrderOperationId]))
    const labour = facts!.operations.map((operation) => {
      const mine = labourEntries.filter((entry) => entry.operationScanId && scanOps.get(entry.operationScanId) === operation.id)
      const earned = mine.reduce((sum, entry) => sum.plus(decimalOf(entry.minutes ?? '0')), decimalOf('0'))
      return {
        operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, workCentreKind: operation.workCentreKind },
        plannedMinutes: operation.plannedMinutes,
        earnedMinutes: decimalText(earned),
        perMinute: asMoney('cost', mine.at(-1)?.unitCost ?? operation.perMinute),
        amount: asMoney('cost', mine.reduce((sum, entry) => sum + entry.amount, 0)),
      }
    })

    const scrapViews = await ledgerViews(db, (await db.workOrderCostEntry.findMany({ where: { workOrderId: workOrder.id, kind: 'SCRAP' }, select: ENTRY_COLUMNS, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })))
    const scrap = scrapViews.map((view) => {
      const entry = facts!.entries.find((row) => row.id === view.id)!
      const value = entry.amount !== 0 ? entry.amount : entry.quantity !== null && entry.unitCost !== null ? toMinorUnits(decimalOf(entry.quantity).times(decimalOf(entry.unitCost)).toFixed(), currency) : null
      return { entryId: view.id, event: view.event, occurredAt: view.occurredAt, item: view.item, quantity: view.quantity, value: asMoney('cost', value) }
    })

    const plan = await planCosts(db, workOrder, undefined)
    const planned = (part: keyof Omit<MinorParts, 'total'>) => (basisParts ? basisParts[part] : null)
    const actualOfPart = { material: actual.material, labour: actual.labour, subcontract: actual.subcontract, overhead: actual.overhead }
    const releaseDay = romeDay(workOrder.releasedAt ?? workOrder.createdAt)
    const words = [
      methodWords(facts!.method, facts!.methodLockedAt ? businessDate(facts!.methodLockedAt) : null),
      FINAL.has(workOrder.status) ? 'The work order is done: this is its final cost.' : 'The work order is open: the actual grows as work is reported, so labour and material read low until every garment is done.',
      computed.basis === 'STANDARD' ? 'Compared with the frozen standards of its garments.' : computed.basis === 'ESTIMATE' ? 'No frozen standard for every garment yet: compared with the estimate at release.' : 'No frozen standard and no complete estimate: there is nothing to compare the actual with yet.',
    ].join(' ')
    return {
      ...row,
      standard: standard ? parts(standard) : null,
      standardMissing: facts!.cells.filter((cell) => cell.standard === null).map((cell) => ({ cellId: cell.id, colourwayCode: cell.colourwayCode, size: cell.size, itemId: cell.itemId, words: cellWords(cell, releaseDay) })),
      estimate: { ...parts(estimate), complete: facts!.estimate.complete, missing: [...facts!.estimate.missingItems.map((id) => `${items.get(id)?.code ?? id} has no standard price on ${releaseDay}.`), ...facts!.estimate.missingOperations.map((id) => `Operation ${facts!.operations.find((row) => row.id === id)?.seq ?? ''} has no cost per minute on ${releaseDay}.`)] },
      actual: {
        material: money(actual.material)!,
        labour: money(actual.labour)!,
        subcontract: money(actual.subcontract)!,
        overhead: money(actual.overhead)!,
        adjustment: money(actual.adjustment)!,
        total: money(actual.total)!,
        movedToStock: money(actual.movedToStock)!,
        onWorkOrder: money(actual.onWorkOrder)!,
        scrapLost: money(actual.scrapLost)!,
        scrapFromStock: money(actual.scrapFromStock)!,
      },
      bridge: steps ? steps.map((step) => ({ reason: step.reason, amount: money(step.amount)! })) : null,
      parts: (['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD'] as const).map((part) => {
        const key = part.toLowerCase() as keyof typeof actualOfPart
        const plannedAmount = planned(key)
        return { part, planned: money(plannedAmount), actual: money(actualOfPart[key])!, variance: money(plannedAmount === null ? null : actualOfPart[key] - plannedAmount), perGarment: money(perGarment(actualOfPart[key], pieces)) }
      }),
      perGarment: { planned: money(basisParts ? perGarment(basisParts.total, pieces) : null), actual: money(perGarment(actual.total, pieces)) },
      materials,
      labour,
      scrap,
      waitingItems: plan.waiting,
      words,
    }
  })
}

/** GET /costing/ledger: the entries the caller may see, newest first, in pages. */
export async function ledger(caller: CommandCaller, query: LedgerQuery): Promise<{ entries: LedgerEntryView[]; nextCursor: string | null }> {
  const actor = actorOf(contextOf(caller))
  const where: Prisma.WorkOrderCostEntryWhereInput = {
    AND: [
      scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.WorkOrderCostEntryWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.kind && query.kind.length > 0 ? { kind: { in: [...query.kind] } } : {},
      query.from ? { occurredAt: { gte: businessDayStart(query.from) } } : {},
      query.to ? { occurredAt: { lt: businessDayRange(query.to).end } } : {},
      // B-W2b-22 (Z9:05): words — the work order's number, the item's code or name, the entry's reason (no person anywhere).
      query.q
        ? {
            OR: [
              { workOrder: { number: { contains: query.q, mode: 'insensitive' } } },
              { item: { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } },
              { reason: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.workOrderCostEntry.findMany({ where, select: ENTRY_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    return { entries: await ledgerViews(db, page), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}
