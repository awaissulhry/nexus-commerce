import { certificateGate } from '@nexus/factory-domain/compliance/cert-gate/gate'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { usabilityOf } from '@nexus/factory-domain/planning/usable'
import { COMMITTED_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import {
  batchCheck,
  bomCheck,
  cellsCheck,
  certificateCheck,
  depositCheck,
  labelCheck,
  materialLines,
  releaseChecklist,
  revisionCheck,
  workCentreCheck,
  type CellGate,
  type DepositFacts,
  type DepositStatus,
  type MaterialFacts as MaterialNeedFacts,
  type MaterialLine,
  type ReleaseChecklist,
} from '@nexus/factory-domain/production/work-orders/release'
import { planMaterials, planOperations, type BomGap, type MissingWorkCentre, type PlannedMaterial, type PlannedOperation, type SpecCell } from '@nexus/factory-domain/production/work-orders/spec'
import { repairNotRequired, repairWorkCentreCheck } from '@nexus/factory-domain/production/work-orders/repair'
// B-W2a-46 (MES-004): the release's W2a blockers, holds and the plan's readiness.
import { holdsCheck, materialReadinessCheck } from '@nexus/factory-domain/production/work-orders/blockers'
import { materialReadinessOf, readReleaseBlockers, type PlanCache, type ReleaseBlockerFacts } from './release/blockers'
import { ORDER_DEPOSIT_ONLY } from '../../sales/deposits/deposits'
import type { UnusableReason } from '@nexus/factory-domain/planning/usable'
import { decimalOf, decimalText } from '@nexus/factory-domain/product/units/units'
import { ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { gateRequestFor } from '../../compliance/certificates/gate'
import { lotFactsOf, readLots, readStock } from '../../planning/store'
import { readLines, readMaterials, type LineRecord, type MaterialFacts } from '../../product/bom/store'
import { readSteps, type StepRecord } from '../../product/routing/read'
import {
  cellLabel,
  dayOf,
  dec,
  hasSeries,
  readCells,
  readLabel,
  readOrders,
  readReleasedRevision,
  readRevision,
  SITE_COLUMNS,
  STYLE_COLUMNS,
  type CellRow,
  type Header,
  type LabelRow,
  type OrderRow,
  type Reader,
  type RevisionRow,
  type SiteRow,
  type StyleRow,
} from './store'

/**
 * What the record, the release check and the release read about a work order (B-W1-38), with one reader: a scoped
 * client for the screens, the release command's transaction for the release (so the check and the write see the same
 * rows). Queries run one after another (one connection runs one query at a time).
 */

// ---- the work order and its spec ------------------------------------------------------------------------------------

export interface Basics {
  readonly workOrder: Header
  readonly style: StyleRow
  readonly site: SiteRow
  readonly cells: CellRow[]
  readonly orders: OrderRow[]
  readonly revision: RevisionRow | null
  readonly label: LabelRow | null
}

export async function readBasics(db: Reader, workOrder: Header): Promise<Basics> {
  const style = await db.style.findUniqueOrThrow({ where: { id: workOrder.styleId }, select: STYLE_COLUMNS })
  const site = await db.site.findUniqueOrThrow({ where: { id: workOrder.siteId }, select: SITE_COLUMNS })
  const cells = await readCells(db, workOrder.id, style.sizes)
  const orders = await readOrders(db, cells.map((cell) => cell.salesOrderId))
  const revision = await readRevision(db, workOrder.styleRevisionId)
  // A released work order carries its frozen label template; a draft shows its revision's.
  const label = await readLabel(db, workOrder.labelTemplateId ?? revision?.labelTemplateId ?? null)
  return { workOrder, style, site, cells, orders, revision, label }
}

export interface WorkCentreRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: PlannedOperation['workCentreKind']
  readonly status: string
}

/** The revision's routing, BOM and materials, and the site's work centres: what the spec is built from. */
export interface SpecParts {
  readonly steps: StepRecord[]
  readonly lines: LineRecord[]
  readonly materials: Map<string, MaterialFacts>
  readonly itemColours: Map<string, { id: string; itemId: string; code: string; name: string }>
  readonly centres: WorkCentreRow[]
}

export async function readSpecParts(db: Reader, revisionId: string | null, siteId: string, extraItemIds: readonly string[] = []): Promise<SpecParts> {
  const steps = revisionId ? await readSteps(db, revisionId) : []
  const lines = revisionId ? await readLines(db, revisionId) : []
  const { materials, colours } = await readMaterials(db, [...lines.map((line) => line.itemId), ...extraItemIds])
  const centres = await db.workCentre.findMany({ where: { siteId }, select: { id: true, code: true, name: true, kind: true, status: true }, orderBy: { code: 'asc' } })
  return { steps, lines, materials, itemColours: colours, centres }
}

export const specCellsOf = (cells: readonly CellRow[]): SpecCell[] =>
  cells.map((cell) => ({ id: cell.id, colourwayId: cell.colourwayId, colourwayCode: cell.colourwayCode, size: cell.size, quantity: cell.quantity }))

/** The frozen spec the release would write now: operations at the site's work centres, BOM line × cell. */
export interface SpecPlan {
  readonly operations: PlannedOperation[]
  readonly missing: MissingWorkCentre[]
  readonly materials: PlannedMaterial[]
  readonly gaps: BomGap[]
}

export function planSpec(parts: SpecParts, cells: readonly CellRow[]): SpecPlan {
  const { operations, missing } = planOperations(parts.steps, parts.centres)
  const { materials, gaps } = planMaterials(
    parts.lines,
    specCellsOf(cells),
    (itemId) => parts.materials.get(itemId)?.units,
    (itemId) => parts.materials.get(itemId)?.code ?? itemId,
  )
  return { operations, missing, materials, gaps }
}

// ---- material: needed, issued, usable, promised -------------------------------------------------------------------------

const keyOf = (itemId: string, itemColourId: string | null): string => `${itemId}|${itemColourId ?? '-'}`

/** Net issued per work order, material and colour: moves out of a location to the work order, less moves back. */
export async function readIssued(db: Reader, siteId: string, workOrderIds: readonly string[]): Promise<Map<string, Decimal>> {
  const net = new Map<string, Decimal>()
  if (workOrderIds.length === 0) return net
  const by = ['workOrderId', 'itemId', 'itemColourId'] as const
  const out = await db.stockMove.groupBy({ by: [...by], where: { siteId, workOrderId: { in: [...workOrderIds] }, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: [...by], where: { siteId, workOrderId: { in: [...workOrderIds] }, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const add = (row: (typeof out)[number], sign: 1 | -1) => {
    const key = `${row.workOrderId}|${keyOf(row.itemId, row.itemColourId)}`
    const quantity = dec(row._sum.baseQuantity)
    net.set(key, (net.get(key) ?? ZERO).plus(sign === 1 ? quantity : quantity.negated()))
  }
  for (const row of out) add(row, 1)
  for (const row of back) add(row, -1)
  return net
}

/**
 * For each material and colour the work order plans: planned, already issued to it, usable on hand at the site, held
 * there (not usable, per reason), and still to issue to the site's other released work orders.
 */
export async function readMaterialNeeds(db: Reader, workOrder: Pick<Header, 'id' | 'siteId'>, planned: readonly PlannedMaterial[], parts: SpecParts): Promise<MaterialNeedFacts[]> {
  const plannedBy = new Map<string, { itemId: string; itemColourId: string | null; baseUom: string; quantity: Decimal }>()
  for (const row of planned) {
    const key = keyOf(row.itemId, row.itemColourId)
    const entry = plannedBy.get(key) ?? { itemId: row.itemId, itemColourId: row.itemColourId, baseUom: row.baseUom, quantity: ZERO }
    plannedBy.set(key, { ...entry, quantity: entry.quantity.plus(row.baseQuantity) })
  }
  if (plannedBy.size === 0) return []
  const itemIds = [...new Set([...plannedBy.values()].map((entry) => entry.itemId))]

  const issued = await readIssued(db, workOrder.siteId, [workOrder.id])
  const stock = await readStock(db, workOrder.siteId, itemIds)
  const lots = new Map((await readLots(db, stock.flatMap((row) => (row.lotId ? [row.lotId] : [])))).map((lot) => [lot.id, lot]))
  const usable = new Map<string, Decimal>()
  const held = new Map<string, Map<UnusableReason, Decimal>>()
  for (const row of stock) {
    const key = keyOf(row.itemId, row.itemColourId)
    const lot = row.lotId ? lots.get(row.lotId) : undefined
    const usability = usabilityOf(lot ? lotFactsOf(lot) : null)
    if (usability.usable) usable.set(key, (usable.get(key) ?? ZERO).plus(row.quantity))
    else {
      const reasons = held.get(key) ?? new Map<UnusableReason, Decimal>()
      reasons.set(usability.reason, (reasons.get(usability.reason) ?? ZERO).plus(row.quantity))
      held.set(key, reasons)
    }
  }

  // The site's other released work orders: what each still needs of these materials (planned less issued, from 0).
  const others = await db.workOrderMaterial.groupBy({
    by: ['workOrderId', 'itemId', 'itemColourId'],
    where: { siteId: workOrder.siteId, itemId: { in: itemIds }, workOrderId: { not: workOrder.id }, workOrder: { status: { in: [...COMMITTED_STATUSES] } } },
    _sum: { baseQuantity: true },
  })
  const othersIssued = await readIssued(db, workOrder.siteId, [...new Set(others.map((row) => row.workOrderId))])
  const committed = new Map<string, Decimal>()
  for (const row of others) {
    const key = keyOf(row.itemId, row.itemColourId)
    const still = dec(row._sum.baseQuantity).minus(othersIssued.get(`${row.workOrderId}|${key}`) ?? ZERO)
    if (still.gt(0)) committed.set(key, (committed.get(key) ?? ZERO).plus(still))
  }

  return [...plannedBy.entries()].map(([key, entry]) => {
    const material = parts.materials.get(entry.itemId)
    const colour = entry.itemColourId ? parts.itemColours.get(entry.itemColourId) : undefined
    return {
      itemId: entry.itemId,
      itemColourId: entry.itemColourId,
      label: `${material?.code ?? entry.itemId}${colour ? ` ${colour.code}` : ''}`,
      baseUom: entry.baseUom,
      planned: decimalText(entry.quantity),
      issued: decimalText(issued.get(`${workOrder.id}|${key}`) ?? ZERO),
      usable: decimalText(usable.get(key) ?? ZERO),
      committed: decimalText(committed.get(key) ?? ZERO),
      held: [...(held.get(key) ?? new Map<UnusableReason, Decimal>()).entries()].map(([reason, quantity]) => ({ reason, quantity: decimalText(quantity) })),
    }
  })
}

// ---- certificate and deposit --------------------------------------------------------------------------------------------

/** The certificate gate for every cell on the day (one read of the style's coverages, then the domain gate per cell). */
export async function readGates(db: Reader, styleId: string, cells: readonly CellRow[], date: BusinessDate): Promise<CellGate[]> {
  if (cells.length === 0) return []
  const first = cells[0]!
  const { request } = await gateRequestFor(db, { styleId, colourwayId: first.colourwayId, size: first.size }, date)
  return cells.map((cell) => {
    const result = certificateGate({ ...request, colourwayId: cell.colourwayId, size: cell.size })
    return {
      cellId: cell.id,
      label: cellLabel(cell),
      outcome: result.outcome,
      certificateNumber: result.outcome === 'covered' ? result.certificate.number : null,
      validTo: result.outcome === 'covered' ? result.certificate.validTo : null,
      reasons: result.outcome === 'refused' ? result.reasons.map((reason) => reason.message) : [],
      message: result.outcome === 'not_required' ? result.message : null,
    }
  })
}

/**
 * Each order's deposit requests: by the order, or by the accepted version it was made from (before the order existed).
 * The deposit's only (B-W2a-F2: a before-shipping step's own request is the balance paid before the goods leave, which
 * production does not wait for).
 */
export async function readDeposits(db: Reader, orders: readonly OrderRow[]): Promise<DepositFacts[]> {
  if (orders.length === 0) return []
  const versionIds = orders.flatMap((order) => (order.quoteVersionId ? [order.quoteVersionId] : []))
  const requests = await db.depositRequest.findMany({
    where: { AND: [{ OR: [{ orderId: { in: orders.map((order) => order.id) } }, ...(versionIds.length > 0 ? [{ quoteVersionId: { in: versionIds } }] : [])] }, ORDER_DEPOSIT_ONLY] },
    select: { id: true, orderId: true, quoteVersionId: true, status: true, dueDate: true },
    orderBy: { dueDate: 'asc' },
  })
  return orders.map((order) => ({
    orderId: order.id,
    orderNumber: order.number,
    depositRequired: order.depositRequired,
    requests: requests
      .filter((request) => request.orderId === order.id || (request.orderId === null && order.quoteVersionId !== null && request.quoteVersionId === order.quoteVersionId))
      .map((request) => ({ status: request.status as DepositStatus, dueDate: dayOf(request.dueDate) })),
  }))
}

// ---- the release check --------------------------------------------------------------------------------------------------

export interface ReleaseFacts extends Basics {
  readonly current: RevisionRow | null
  readonly parts: SpecParts
  readonly spec: SpecPlan
  readonly gates: CellGate[]
  readonly deposits: DepositFacts[]
  readonly material: MaterialLine[]
  readonly batchSeries: boolean
  /** B-W2a-46: the holds naming the work order and the plan's readiness (./release/blockers). */
  readonly blockers: ReleaseBlockerFacts
}

/**
 * A repair DRAFT's spec (B-W2a-12, MES-019): the steps stored on it when it was made (./repairs), at the work centres they
 * name, and no material. The release freezes them as they are.
 */
export async function repairSpecOf(db: Reader, workOrderId: string, parts: SpecParts): Promise<SpecPlan> {
  const rows = await db.workOrderOperation.findMany({
    where: { workOrderId },
    select: { seq: true, routingSeq: true, code: true, name: true, standardMinutes: true, scanRequired: true, workCentreId: true },
    orderBy: { seq: 'asc' },
  })
  const centreOf = new Map(parts.centres.map((centre) => [centre.id, centre]))
  const stepOf = new Map(parts.steps.map((step) => [step.seq, step]))
  const operations: PlannedOperation[] = rows.map((row) => ({
    seq: row.seq,
    routingSeq: row.routingSeq,
    stepId: stepOf.get(row.routingSeq)?.id ?? '',
    code: row.code,
    name: row.name,
    standardMinutes: decimalText(row.standardMinutes.toString()),
    scanRequired: row.scanRequired,
    // The site's work centres are read whatever their status, so the operation's own is always there.
    workCentreKind: centreOf.get(row.workCentreId)!.kind,
    workCentreId: row.workCentreId,
    workCentreCode: centreOf.get(row.workCentreId)?.code ?? null,
  }))
  return { operations, missing: [], materials: [], gaps: [] }
}

/**
 * Everything the release check reads, for a DRAFT, on the day `date`. B-W2a-46: `plans` shares a site's live plan between
 * many drafts; the plan's readiness is read when a material is short (it decides MATERIAL then), always for the record,
 * never for a reader of many drafts that cannot afford a site netting each (Today's held source: W1's material check).
 */
export async function readReleaseFacts(db: Reader, basics: Basics, date: BusinessDate, plans?: PlanCache, readiness: 'always' | 'whenShort' | 'never' = 'whenShort'): Promise<ReleaseFacts> {
  const { workOrder, style, cells, orders, revision } = basics
  const current = await readReleasedRevision(db, style.id)
  const parts = await readSpecParts(db, revision?.styleId === style.id ? revision.id : null, workOrder.siteId)
  if (workOrder.kind === 'REPAIR') {
    // B-W2a-12: a repair checks no certificate, deposit, BOM or material (factory-domain production/work-orders/repair).
    const spec = await repairSpecOf(db, workOrder.id, parts)
    const batchSeries = await hasSeries(db, workOrder.companyId, 'BATCH')
    return { ...basics, current, parts, spec, gates: [], deposits: [], material: [], batchSeries, blockers: await readReleaseBlockers(db, workOrder, date, { cache: plans, readiness: 'whenShort', short: false }) }
  }
  const spec = planSpec(parts, cells)
  const gates = await readGates(db, style.id, cells, date)
  const deposits = await readDeposits(db, orders)
  const material = materialLines(await readMaterialNeeds(db, workOrder, spec.materials, parts))
  const batchSeries = await hasSeries(db, workOrder.companyId, 'BATCH')
  const short = material.some((line) => decimalOf(line.short).gt(0))
  const blockers = await readReleaseBlockers(db, workOrder, date, { cache: plans, readiness, short })
  return { ...basics, current, parts, spec, gates, deposits, material, batchSeries, blockers }
}

/** THE release check: the record's checklist and the release's refusal are this one answer. */
export function checklistOf(facts: ReleaseFacts, override: { readonly reason: string } | null): ReleaseChecklist {
  const { style, site, cells, revision, label, current, parts, spec } = facts
  if (facts.workOrder.kind === 'REPAIR') {
    // B-W2a-12 (MES-019): a repair's own answers; its steps at active work centres of the site.
    const centreOf = new Map(parts.centres.map((centre) => [centre.id, centre]))
    return releaseChecklist([
      revisionCheck(style.id, revision, current),
      labelCheck(revision, revision?.labelTemplateId ? label : null),
      repairNotRequired('CERTIFICATE'),
      repairWorkCentreCheck(
        site.code,
        spec.operations.map((op) => ({ seq: op.seq, code: op.code, name: op.name, workCentreKind: op.workCentreKind, workCentreCode: op.workCentreCode, workCentreStatus: op.workCentreId ? (centreOf.get(op.workCentreId)?.status ?? null) : null })),
      ),
      repairNotRequired('BOM'),
      cellsCheck(cells.map((cell) => ({ id: cell.id, label: cellLabel(cell), inRange: style.sizes.includes(cell.size) }))),
      repairNotRequired('DEPOSIT'),
      repairNotRequired('MATERIAL'),
      batchCheck(facts.batchSeries),
      holdsCheck(facts.workOrder.number, facts.blockers.holds),
    ])
  }
  return releaseChecklist([
    revisionCheck(style.id, revision, current),
    labelCheck(revision, revision?.labelTemplateId ? label : null),
    certificateCheck(facts.gates),
    workCentreCheck(site.code, parts.steps.length, spec.missing),
    bomCheck(revision, spec.gaps),
    cellsCheck(cells.map((cell) => ({ id: cell.id, label: cellLabel(cell), inRange: style.sizes.includes(cell.size) }))),
    depositCheck(facts.deposits),
    materialReadinessCheck(facts.material, materialReadinessOf(facts.blockers.readiness), override),
    batchCheck(facts.batchSeries),
    holdsCheck(facts.workOrder.number, facts.blockers.holds),
  ])
}
