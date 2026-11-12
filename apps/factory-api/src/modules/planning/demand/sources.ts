import type { Prisma } from '@nexus/factory-db'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNED_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import { OPEN_ORDER_STATUSES } from '@nexus/factory-domain/planning/milestones/rules'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { mergedCells, openParts, type DemandKind, type DemandPiece } from '@nexus/factory-domain/planning/demand/rules'
import { effectiveStrategy, strategySummary, type ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import { cellsOf, type SampleKind } from '@nexus/factory-domain/sales/samples/rules'
import { dayOf, type Reader, type SiteRow } from '../store'

/**
 * What a site's demand is made of (B-W2b-319; see factory-domain planning/demand/rules.ts for the layers), read in one client, one
 * query after another. Every source is of the site's company; a source that names a customer is kept only when the caller plans
 * for that customer too (planning.view over the company, site and party). Where a source has no making site yet (an order line, a
 * quote, a round with no work order) it belongs to the site when the site is its company's only ACTIVE plant, as MRP places it
 * (planning/store.ts readDemand); else it is counted in `unplaced`, never here.
 *
 *   order lines     SIZE_GRID and MADE_TO_MEASURE lines of CONFIRMED, IN_PRODUCTION, READY and PARTLY_SHIPPED orders, not closed
 *                   short: what is still to ship (shipments SHIPPED or DELIVERED left), by delivery schedule; a replacement order of a
 *                   return (ReturnAuthorisation.replacementOrderId) is REMAKES demand, never ORDERS
 *   quote lines     of SENT quotes whose current version is SENT and valid today; by the line's deliveries, else the version's
 *                   promise date
 *   sample rounds   REQUESTED and IN_MAKING: the round's cells by its due day; at the site of its work orders when it has some
 *   rework          OPEN and IN_PROGRESS rework orders of the site: garments sent back to an operation, by the work order's due day
 *   recuts          OPEN RECUT replacements of the site: garments (or a part) cut again, by the work order's due day
 *   return remakes  return lines of the site decided REMAKE, while the return is open: by the day it was decided
 */

export interface DemandSource extends DemandPiece {
  readonly key: string
  readonly status: string
  readonly source: { readonly recordType: string; readonly recordId: string; readonly number: string; readonly line: number | null }
  readonly origin: { readonly recordType: string; readonly recordId: string; readonly number: string } | null
  readonly workOrder: { readonly id: string; readonly number: string } | null
  readonly partyId: string | null
  readonly sampleKind: SampleKind | null
  readonly part: string | null
  readonly validUntil: BusinessDate | null
}

export interface DemandRead {
  readonly sources: DemandSource[]
  readonly unplaced: { orderLines: number; quoteLines: number; sampleRounds: number }
}

const LEFT_SHIPMENTS = ['SHIPPED', 'DELIVERED'] as const
const OPEN_RETURNS = ['AUTHORISED', 'RECEIVED', 'INSPECTED'] as const
const day = (value: Date | null | undefined): BusinessDate | null => (value ? dayOf(value) : null)
const keyOf = (kind: DemandKind, sourceId: string, colourwayId: string | null, size: string | null, date: BusinessDate | null): string => `${kind}:${sourceId}:${colourwayId ?? '-'}:${size ?? '-'}:${date ?? '-'}`

const sizeQuantitiesOf = (value: Prisma.JsonValue | null): Record<string, number> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const [size, quantity] of Object.entries(value)) if (typeof quantity === 'number') out[size] = quantity
  return out
}

/** Whether the site is its company's only ACTIVE plant: then sources with no making site are its own. */
export async function onlyPlantOf(db: Reader, site: SiteRow): Promise<boolean> {
  const plants = await db.site.count({ where: { companyId: site.companyId, kind: 'PLANT', status: 'ACTIVE' } })
  return plants === 1 && site.kind === 'PLANT' && site.status === 'ACTIVE'
}

/** Every source of the site's demand the caller plans for (see above). */
export async function readDemandSources(db: Reader, site: SiteRow, actor: Actor, today: BusinessDate): Promise<DemandRead> {
  const onlyPlant = await onlyPlantOf(db, site)
  const seesParty = (partyId: string | null): boolean => partyId === null || can(actor, PLANNING_VIEW, { companyId: site.companyId, siteId: site.id, partyId })
  const orders = await orderSources(db, site, onlyPlant)
  const quotes = await quoteSources(db, site, onlyPlant, today)
  const samples = await sampleSources(db, site, onlyPlant)
  const rework = await reworkSources(db, site)
  const recuts = await recutSources(db, site)
  const remakes = await returnRemakeSources(db, site)
  const sources = [...orders.sources, ...quotes.sources, ...samples.sources, ...rework, ...recuts, ...remakes].filter((source) => seesParty(source.partyId))
  return { sources, unplaced: { orderLines: orders.unplaced, quoteLines: quotes.unplaced, sampleRounds: samples.unplaced } }
}

// ---- order lines --------------------------------------------------------------------------------------------------------------

async function orderSources(db: Reader, site: SiteRow, onlyPlant: boolean): Promise<{ sources: DemandSource[]; unplaced: number }> {
  const open: Prisma.SalesOrderLineWhereInput = { companyId: site.companyId, kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] }, closedShortAt: null, order: { status: { in: [...OPEN_ORDER_STATUSES] } } }
  const unplaced = onlyPlant ? 0 : await db.salesOrderLine.count({ where: { ...open, siteId: null } })
  const lines = await db.salesOrderLine.findMany({
    where: { ...open, OR: [{ siteId: site.id }, ...(onlyPlant ? [{ siteId: null }] : [])] },
    select: {
      id: true,
      orderId: true,
      seq: true,
      kind: true,
      partyId: true,
      styleId: true,
      colourwayId: true,
      quantity: true,
      requestedDate: true,
      promiseDate: true,
      order: { select: { number: true, status: true, requestedDate: true, promiseDate: true, replacementFor: { select: { id: true, number: true }, orderBy: { number: 'asc' }, take: 1 } } },
      sizes: { select: { size: true, quantity: true }, orderBy: { size: 'asc' } },
      deliveries: { select: { deliveryDate: true, sizeQuantities: true, quantity: true }, orderBy: { deliveryDate: 'asc' } },
    },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  if (lines.length === 0) return { sources: [], unplaced }
  const shippedRows = await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: lines.map((line) => line.id) }, shipment: { status: { in: [...LEFT_SHIPMENTS] } } }, select: { salesOrderLineId: true, size: true, quantity: true } })
  const shipped = new Map<string, number>()
  for (const row of shippedRows) {
    for (const key of [`${row.salesOrderLineId}|${row.size}`, `${row.salesOrderLineId}|*`]) shipped.set(key, (shipped.get(key) ?? 0) + row.quantity)
  }
  const sources: DemandSource[] = []
  for (const line of lines) {
    const madeToMeasure = line.kind === 'MADE_TO_MEASURE'
    const replacementOf = line.order.replacementFor[0] ?? null
    const kind: DemandKind = replacementOf ? 'RETURN_REPLACEMENT' : madeToMeasure ? 'MTM_UNIT' : 'ORDER_LINE'
    const parts = openParts({
      dueDate: day(line.promiseDate ?? line.requestedDate ?? line.order.promiseDate ?? line.order.requestedDate),
      sizes: madeToMeasure
        ? [{ size: null, ordered: line.quantity, shipped: shipped.get(`${line.id}|*`) ?? 0 }]
        : line.sizes.map((size) => ({ size: size.size, ordered: size.quantity, shipped: shipped.get(`${line.id}|${size.size}`) ?? 0 })),
      deliveries: line.deliveries.map((delivery) => ({ date: dayOf(delivery.deliveryDate), sizeQuantities: sizeQuantitiesOf(delivery.sizeQuantities), quantity: delivery.quantity })),
    })
    // B-W2a-22's readDemand: the plan counts CONFIRMED and IN_PRODUCTION orders only.
    const planned = (PLANNED_ORDER_STATUSES as readonly string[]).includes(line.order.status)
    for (const part of parts) {
      sources.push({
        key: keyOf(kind, line.id, line.colourwayId, part.size, part.date),
        kind,
        sourceId: line.id,
        styleId: line.styleId,
        colourwayId: line.colourwayId,
        size: part.size,
        date: part.date,
        pieces: part.pieces,
        planned,
        status: line.order.status,
        source: { recordType: 'SalesOrder', recordId: line.orderId, number: line.order.number, line: line.seq },
        origin: replacementOf ? { recordType: 'ReturnAuthorisation', recordId: replacementOf.id, number: replacementOf.number } : null,
        workOrder: null,
        partyId: line.partyId,
        sampleKind: null,
        part: null,
        validUntil: null,
      })
    }
  }
  return { sources, unplaced }
}

// ---- quotes likely to win -----------------------------------------------------------------------------------------------------

async function quoteSources(db: Reader, site: SiteRow, onlyPlant: boolean, today: BusinessDate): Promise<{ sources: DemandSource[]; unplaced: number }> {
  const where: Prisma.QuoteVersionWhereInput = { status: 'SENT', validUntil: { gte: new Date(`${today}T00:00:00.000Z`) }, quote: { companyId: site.companyId, status: 'SENT' } }
  const versions = await db.quoteVersion.findMany({
    where,
    select: {
      id: true,
      quoteId: true,
      revision: true,
      validUntil: true,
      promiseDate: true,
      quote: { select: { number: true, partyId: true, currentRevision: true } },
      lines: {
        where: { kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] } },
        select: {
          id: true,
          seq: true,
          kind: true,
          styleId: true,
          colourwayId: true,
          quantity: true,
          sizes: { select: { size: true, quantity: true }, orderBy: { size: 'asc' } },
          deliveries: { select: { deliveryDate: true, sizeQuantities: true, quantity: true }, orderBy: { deliveryDate: 'asc' } },
        },
        orderBy: { seq: 'asc' },
      },
    },
    orderBy: [{ quoteId: 'asc' }, { revision: 'asc' }],
  })
  // The version the customer has: the quote's current one.
  const current = versions.filter((version) => version.revision === version.quote.currentRevision)
  if (!onlyPlant) return { sources: [], unplaced: current.reduce((sum, version) => sum + version.lines.length, 0) }
  const sources: DemandSource[] = []
  for (const version of current) {
    for (const line of version.lines) {
      const madeToMeasure = line.kind === 'MADE_TO_MEASURE'
      const parts = openParts({
        dueDate: day(version.promiseDate),
        sizes: madeToMeasure ? [{ size: null, ordered: line.quantity, shipped: 0 }] : line.sizes.map((size) => ({ size: size.size, ordered: size.quantity, shipped: 0 })),
        deliveries: line.deliveries.map((delivery) => ({ date: dayOf(delivery.deliveryDate), sizeQuantities: sizeQuantitiesOf(delivery.sizeQuantities), quantity: delivery.quantity })),
      })
      for (const part of parts) {
        sources.push({
          key: keyOf('QUOTE_LINE', line.id, line.colourwayId, part.size, part.date),
          kind: 'QUOTE_LINE',
          sourceId: line.id,
          styleId: line.styleId,
          colourwayId: line.colourwayId,
          size: part.size,
          date: part.date,
          pieces: part.pieces,
          planned: false,
          status: 'SENT',
          source: { recordType: 'Quote', recordId: version.quoteId, number: version.quote.number, line: line.seq },
          origin: null,
          workOrder: null,
          partyId: version.quote.partyId,
          sampleKind: null,
          part: null,
          validUntil: day(version.validUntil),
        })
      }
    }
  }
  return { sources, unplaced: 0 }
}

// ---- sample rounds --------------------------------------------------------------------------------------------------------------

async function sampleSources(db: Reader, site: SiteRow, onlyPlant: boolean): Promise<{ sources: DemandSource[]; unplaced: number }> {
  const rounds = await db.sampleRound.findMany({
    where: { companyId: site.companyId, stage: { in: ['REQUESTED', 'IN_MAKING'] } },
    select: {
      id: true,
      number: true,
      styleId: true,
      kind: true,
      partyId: true,
      cells: true,
      dueDate: true,
      stage: true,
      workOrders: { where: { status: { not: 'CANCELLED' } }, select: { id: true, number: true, siteId: true }, orderBy: { number: 'asc' } },
    },
    orderBy: { number: 'asc' },
  })
  let unplaced = 0
  const sources: DemandSource[] = []
  for (const round of rounds) {
    const here = round.workOrders.filter((workOrder) => workOrder.siteId === site.id)
    if (round.workOrders.length > 0 ? here.length === 0 : !onlyPlant) {
      if (round.workOrders.length === 0) unplaced += 1
      continue
    }
    const date = day(round.dueDate)
    for (const cell of mergedCells(cellsOf(round.cells))) {
      sources.push({
        key: keyOf('SAMPLE_ROUND', round.id, cell.colourwayId, cell.size, date),
        kind: 'SAMPLE_ROUND',
        sourceId: round.id,
        styleId: round.styleId,
        colourwayId: cell.colourwayId,
        size: cell.size,
        date,
        pieces: cell.pieces,
        // B-W2b-284's gap: MRP reads order lines only, so a sample's materials are not planned.
        planned: false,
        status: round.stage,
        source: { recordType: 'SampleRound', recordId: round.id, number: round.number, line: null },
        origin: null,
        workOrder: here[0] ? { id: here[0].id, number: here[0].number } : null,
        partyId: round.partyId,
        sampleKind: round.kind,
        part: null,
        validUntil: null,
      })
    }
  }
  return { sources, unplaced }
}

// ---- rework, recuts, return remakes ---------------------------------------------------------------------------------------------

const CELL_SELECT = { colourwayId: true, size: true, partyId: true } as const satisfies Prisma.WorkOrderSizeSelect
const WORK_ORDER_SELECT = { id: true, number: true, styleId: true, dueDate: true } as const satisfies Prisma.WorkOrderSelect

/** The numbers of the records a rework or recut came from (an NCR, a quality hold), by id. */
async function originsOf(db: Reader, refs: readonly { recordType: string | null; recordId: string | null }[]): Promise<Map<string, { recordType: string; recordId: string; number: string }>> {
  const ids = (type: string) => [...new Set(refs.flatMap((ref) => (ref.recordType === type && ref.recordId ? [ref.recordId] : [])))]
  const ncrIds = ids('Nonconformance')
  const holdIds = ids('QualityHold')
  const [ncrs, holds] = await Promise.all([
    ncrIds.length ? db.nonconformance.findMany({ where: { id: { in: ncrIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
    holdIds.length ? db.qualityHold.findMany({ where: { id: { in: holdIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
  ])
  const out = new Map<string, { recordType: string; recordId: string; number: string }>()
  for (const row of ncrs) out.set(row.id, { recordType: 'Nonconformance', recordId: row.id, number: row.number })
  for (const row of holds) if (row.number) out.set(row.id, { recordType: 'QualityHold', recordId: row.id, number: row.number })
  return out
}

async function reworkSources(db: Reader, site: SiteRow): Promise<DemandSource[]> {
  const rows = await db.reworkOrder.findMany({
    where: { siteId: site.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    select: { id: true, quantity: true, status: true, recordType: true, recordId: true, workOrder: { select: WORK_ORDER_SELECT }, workOrderSize: { select: CELL_SELECT } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const origins = await originsOf(db, rows)
  return rows.map((row) => {
    const date = day(row.workOrder.dueDate)
    return {
      key: keyOf('REWORK', row.id, row.workOrderSize.colourwayId, row.workOrderSize.size, date),
      kind: 'REWORK',
      sourceId: row.id,
      styleId: row.workOrder.styleId,
      colourwayId: row.workOrderSize.colourwayId,
      size: row.workOrderSize.size,
      date,
      pieces: row.quantity,
      planned: false,
      status: row.status,
      source: { recordType: 'ReworkOrder', recordId: row.id, number: row.workOrder.number, line: null },
      origin: row.recordId ? (origins.get(row.recordId) ?? null) : null,
      workOrder: { id: row.workOrder.id, number: row.workOrder.number },
      partyId: row.workOrderSize.partyId,
      sampleKind: null,
      part: null,
      validUntil: null,
    } satisfies DemandSource
  })
}

async function recutSources(db: Reader, site: SiteRow): Promise<DemandSource[]> {
  const rows = await db.replacementRequest.findMany({
    where: { siteId: site.id, kind: 'RECUT', status: 'OPEN' },
    select: {
      id: true,
      quantity: true,
      part: true,
      status: true,
      recordType: true,
      recordId: true,
      reworkOrder: { select: { recordType: true, recordId: true } },
      workOrder: { select: WORK_ORDER_SELECT },
      workOrderSize: { select: CELL_SELECT },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  // A recut of a rework that ended in scrap comes from the rework's NCR, when it had one.
  const refOf = (row: (typeof rows)[number]) => (row.recordId ? { recordType: row.recordType, recordId: row.recordId } : { recordType: row.reworkOrder?.recordType ?? null, recordId: row.reworkOrder?.recordId ?? null })
  const origins = await originsOf(db, rows.map(refOf))
  return rows.map((row) => {
    const date = day(row.workOrder.dueDate)
    const ref = refOf(row)
    return {
      key: keyOf('RECUT', row.id, row.workOrderSize.colourwayId, row.workOrderSize.size, date),
      kind: 'RECUT',
      sourceId: row.id,
      styleId: row.workOrder.styleId,
      colourwayId: row.workOrderSize.colourwayId,
      size: row.workOrderSize.size,
      date,
      pieces: row.quantity,
      planned: false,
      status: row.status,
      source: { recordType: 'WorkOrder', recordId: row.workOrder.id, number: row.workOrder.number, line: null },
      origin: ref.recordId ? (origins.get(ref.recordId) ?? null) : null,
      workOrder: { id: row.workOrder.id, number: row.workOrder.number },
      partyId: row.workOrderSize.partyId,
      sampleKind: null,
      part: row.part,
      validUntil: null,
    } satisfies DemandSource
  })
}

async function returnRemakeSources(db: Reader, site: SiteRow): Promise<DemandSource[]> {
  const rows = await db.returnLine.findMany({
    where: { siteId: site.id, disposition: 'REMAKE', salesOrderLineId: { not: null }, rma: { status: { in: [...OPEN_RETURNS] } } },
    select: {
      id: true,
      seq: true,
      quantity: true,
      receivedQuantity: true,
      size: true,
      decidedAt: true,
      partyId: true,
      salesOrderLine: { select: { styleId: true, colourwayId: true } },
      rma: { select: { id: true, number: true, status: true } },
    },
    orderBy: [{ returnId: 'asc' }, { seq: 'asc' }],
  })
  return rows.flatMap((row) => {
    if (!row.salesOrderLine) return []
    const date = day(row.decidedAt)
    return [
      {
        key: keyOf('RETURN_REMAKE', row.id, row.salesOrderLine.colourwayId, row.size, date),
        kind: 'RETURN_REMAKE',
        sourceId: row.id,
        styleId: row.salesOrderLine.styleId,
        colourwayId: row.salesOrderLine.colourwayId,
        size: row.size,
        date,
        pieces: row.receivedQuantity > 0 ? row.receivedQuantity : row.quantity,
        planned: false,
        status: row.rma.status,
        source: { recordType: 'ReturnAuthorisation', recordId: row.rma.id, number: row.rma.number, line: row.seq },
        origin: null,
        workOrder: null,
        partyId: row.partyId,
        sampleKind: null,
        part: null,
        validUntil: null,
      } satisfies DemandSource,
    ]
  })
}

// ---- names and strategies -------------------------------------------------------------------------------------------------------

export interface DemandNames {
  readonly styles: ReadonlyMap<string, { id: string; code: string; name: string; sizes: readonly string[] }>
  readonly colourways: ReadonlyMap<string, { id: string; code: string; name: string }>
  readonly parties: ReadonlyMap<string, { id: string; code: string; name: string }>
}

/** The styles (with their size range), colourways and customers the sources name. */
export async function namesOf(db: Reader, sources: readonly Pick<DemandSource, 'styleId' | 'colourwayId' | 'partyId'>[]): Promise<DemandNames> {
  const styleIds = [...new Set(sources.map((source) => source.styleId))]
  const colourwayIds = [...new Set(sources.flatMap((source) => (source.colourwayId ? [source.colourwayId] : [])))]
  const partyIds = [...new Set(sources.flatMap((source) => (source.partyId ? [source.partyId] : [])))]
  const styles = styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, sizes: true } }) : []
  const colourways = colourwayIds.length ? await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } }) : []
  const parties = partyIds.length ? await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : []
  return {
    styles: new Map(styles.map((row) => [row.id, row])),
    colourways: new Map(colourways.map((row) => [row.id, row])),
    parties: new Map(parties.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }])),
  }
}

/**
 * The production strategy of each style and colourway at the site (PLN-061): its SKUs' finished items, each by its every-colour
 * ItemPlanning row (no row, or no strategy: make to order). A style-colour with no finished item is made to order.
 */
export async function strategiesOf(db: Reader, siteId: string, rows: readonly { styleId: string; colourwayId: string | null }[]): Promise<Map<string, ProductionStrategy | 'MIXED'>> {
  const out = new Map<string, ProductionStrategy | 'MIXED'>()
  const pairs = rows.filter((row): row is { styleId: string; colourwayId: string } => row.colourwayId !== null)
  if (pairs.length === 0) return out
  const items = await db.item.findMany({
    where: { kind: 'FINISHED', variant: { is: { OR: pairs.map((pair) => ({ styleId: pair.styleId, colourwayId: pair.colourwayId })) } } },
    select: { id: true, variant: { select: { styleId: true, colourwayId: true } } },
  })
  const rowsAt = items.length ? await db.itemPlanning.findMany({ where: { siteId, itemId: { in: items.map((item) => item.id) }, itemColourId: null }, select: { itemId: true, strategy: true } }) : []
  const strategyOf = new Map(rowsAt.map((row) => [row.itemId, row.strategy]))
  const by = new Map<string, ProductionStrategy[]>()
  for (const item of items) {
    if (!item.variant) continue
    const key = `${item.variant.styleId}:${item.variant.colourwayId}`
    by.set(key, [...(by.get(key) ?? []), effectiveStrategy(strategyOf.get(item.id) ?? null)])
  }
  for (const pair of pairs) out.set(`${pair.styleId}:${pair.colourwayId}`, strategySummary(by.get(`${pair.styleId}:${pair.colourwayId}`) ?? []))
  return out
}

/** The permission that opens a source's record (record-links), checked over its company, site and customer. */
const OPEN_PERMISSION: Readonly<Record<string, Permission>> = Object.freeze({
  SalesOrder: ORDERS_VIEW,
  Quote: QUOTES_VIEW,
  SampleRound: SALES_SAMPLES_VIEW,
  ReworkOrder: PRODUCTION_SCRAP_VIEW,
  WorkOrder: WORKORDERS_VIEW,
  ReturnAuthorisation: SALES_RETURNS_VIEW,
})
export function mayOpen(actor: Actor, site: SiteRow, source: Pick<DemandSource, 'source' | 'partyId'>): boolean {
  const permission = OPEN_PERMISSION[source.source.recordType]
  return permission !== undefined && can(actor, permission, { companyId: site.companyId, siteId: site.id, ...(source.partyId ? { partyId: source.partyId } : {}) })
}
