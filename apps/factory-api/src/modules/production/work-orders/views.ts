import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { daysLate, nextActions } from '@nexus/factory-domain/production/work-orders/machine'
import type { PlannedMaterial, PlannedOperation } from '@nexus/factory-domain/production/work-orders/spec'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { cutCountsOf } from '../cutting/views'
import { scanProgressOf } from '../scans/progress'
import { planSpec, readBasics, readIssued, readSpecParts, type Basics, type SpecParts } from './facts'
import { dayOrNull, type Header, type Reader } from './store'

/**
 * The work order record (A2 SCR-070; design 02 "Record: Work order"): facts, the orders and customers it makes for,
 * the size run, and the specification — for a DRAFT what the release would freeze now (from the chosen revision, the
 * site's work centres and the BOM math), from RELEASED on the frozen rows themselves — with what the ledger issued to
 * it. Progress per cell, from the release on (null for a draft, never a made-up 0): "cut" from the cut log (B-W1-40:
 * garments with every part cut from hides; null for a cell with no part cut from hides); "bundled" from the bundles
 * (B-W1-41: garments in ACTIVE bundles of whole garments; a part bundle is pieces, not garments); "sewn" and "finished" from the
 * floor's scans (B-W1-42, modules/production/scans progress.ts): the good garments of whole-garment bundles at the last
 * scanned sewing operation (SEWING or ASSEMBLY work centre; null when the routing sews nowhere) and at the final one.
 */

export const PROGRESS_NOTE =
  'Cut garments are counted from the cutting log; bundled ones are the garments in active bundles of whole garments; sewn ones are the good garments reported at the last scanned sewing operation, finished ones at the final operation (the floor scans).'

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The release as the audit row recorded it: when, by whom, and the planner's material override when there was one. */
async function releaseOf(db: Reader, workOrder: Header) {
  if (!workOrder.releasedAt) return null
  const row = await db.auditLog.findFirst({
    where: { recordType: 'WorkOrder', recordId: workOrder.id, action: 'workorders.release' },
    orderBy: { at: 'desc' },
    select: { at: true, actorId: true, after: true, reason: true },
  })
  const after = (row?.after ?? {}) as { materialOverride?: { reason?: unknown; shortages?: unknown } | null }
  const override = after.materialOverride
  return {
    at: toUtcIso(workOrder.releasedAt),
    byId: workOrder.releasedById,
    materialOverride:
      override && typeof override.reason === 'string'
        ? { reason: override.reason, byId: row?.actorId ?? workOrder.releasedById, at: toUtcIso(row?.at ?? workOrder.releasedAt), shortages: Array.isArray(override.shortages) ? override.shortages.filter((entry): entry is string => typeof entry === 'string') : [] }
        : null,
  }
}

/** The frozen rows of a released work order, in the shape the builder plans them. */
async function frozenSpec(db: Reader, workOrder: Header, parts: SpecParts): Promise<{ operations: (PlannedOperation & { id: string })[]; materials: PlannedMaterial[] }> {
  const ops = await db.workOrderOperation.findMany({
    where: { workOrderId: workOrder.id },
    select: { id: true, seq: true, routingSeq: true, code: true, name: true, standardMinutes: true, scanRequired: true, workCentreId: true },
    orderBy: { seq: 'asc' },
  })
  const rows = await db.workOrderMaterial.findMany({
    where: { workOrderId: workOrder.id },
    select: { bomLineId: true, itemId: true, itemColourId: true, workOrderSizeId: true, quantity: true, uom: true, baseQuantity: true },
    orderBy: { id: 'asc' },
  })
  const centreOf = new Map(parts.centres.map((centre) => [centre.id, centre]))
  const stepOf = new Map(parts.steps.map((step) => [step.seq, step]))
  const lineOf = new Map(parts.lines.map((line) => [line.id, line]))
  return {
    operations: ops.map((op) => ({
      id: op.id,
      seq: op.seq,
      routingSeq: op.routingSeq,
      stepId: stepOf.get(op.routingSeq)?.id ?? '',
      code: op.code,
      name: op.name,
      standardMinutes: decimalText(op.standardMinutes.toString()),
      scanRequired: op.scanRequired,
      // The site's work centres are read whatever their status, so the operation's own is always there.
      workCentreKind: centreOf.get(op.workCentreId)!.kind,
      workCentreId: op.workCentreId,
      workCentreCode: centreOf.get(op.workCentreId)?.code ?? null,
    })),
    materials: rows.map((row) => ({
      bomLineId: row.bomLineId,
      lineSeq: lineOf.get(row.bomLineId)?.seq ?? 0,
      itemId: row.itemId,
      itemColourId: row.itemColourId,
      cellId: row.workOrderSizeId,
      quantity: decimalText(row.quantity.toString()),
      uom: row.uom,
      baseQuantity: decimalText(row.baseQuantity.toString()),
      baseUom: parts.materials.get(row.itemId)?.units.baseUom ?? row.uom,
    })),
  }
}

/** Planned materials per material and colour, with the BOM lines and cells behind each and what the ledger issued. */
function materialsView(planned: readonly PlannedMaterial[], parts: SpecParts, issued: ReadonlyMap<string, Decimal>, workOrderId: string) {
  const groups = new Map<string, PlannedMaterial[]>()
  for (const row of planned) {
    const key = `${row.itemId}|${row.itemColourId ?? '-'}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const placementOf = new Map(parts.lines.map((line) => [line.id, line.placement]))
  return [...groups.entries()]
    .map(([key, rows]) => {
      const first = rows[0]!
      const material = parts.materials.get(first.itemId)
      const colour = first.itemColourId ? parts.itemColours.get(first.itemColourId) : undefined
      const plannedBase = rows.reduce<Decimal>((sum, row) => sum.plus(row.baseQuantity), ZERO)
      const issuedBase = issued.get(`${workOrderId}|${key}`) ?? ZERO
      const lines = new Map<string, { bomLineId: string; lineSeq: number; placement: string | null; uom: string; quantity: Decimal }>()
      for (const row of rows) {
        const entry = lines.get(row.bomLineId) ?? { bomLineId: row.bomLineId, lineSeq: row.lineSeq, placement: placementOf.get(row.bomLineId) ?? null, uom: row.uom, quantity: ZERO }
        lines.set(row.bomLineId, { ...entry, quantity: entry.quantity.plus(row.quantity) })
      }
      const cells = new Map<string, Decimal>()
      for (const row of rows) cells.set(row.cellId, (cells.get(row.cellId) ?? ZERO).plus(row.baseQuantity))
      return {
        itemId: first.itemId,
        itemCode: material?.code ?? '',
        itemName: material?.name ?? '',
        itemColourId: first.itemColourId,
        colourCode: colour?.code ?? null,
        baseUom: first.baseUom,
        planned: decimalText(plannedBase),
        issued: decimalText(issuedBase),
        balance: decimalText(plannedBase.minus(issuedBase)),
        lines: [...lines.values()].sort((a, b) => a.lineSeq - b.lineSeq).map((line) => ({ ...line, quantity: decimalText(line.quantity) })),
        cells: [...cells.entries()].map(([cellId, baseQuantity]) => ({ cellId, baseQuantity: decimalText(baseQuantity) })),
        firstSeq: Math.min(...rows.map((row) => row.lineSeq)),
      }
    })
    .sort((a, b) => a.firstSeq - b.firstSeq || (a.colourCode ?? '').localeCompare(b.colourCode ?? ''))
    .map(({ firstSeq: _first, ...rest }) => rest)
}

/** A work order's progress summed over its cells, as the list shows it (SCR-069 "Progress"). */
export interface ProgressTotals {
  readonly cut: number | null
  readonly bundled: number | null
  readonly sewn: number | null
  readonly finished: number | null
}

/** A sum that stays null when no cell counts the step (a cell with no part cut from hides, a routing that sews nowhere). */
function sumOrNull(values: Iterable<number | null>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null) total = (total ?? 0) + value
  return total
}

/**
 * The list's progress of one work order (SCR-069): the record's cells' cut, bundled, sewn and finished garments, summed;
 * null for a draft (nothing is frozen to count against, never a made-up 0). The same counts as the record (cutCountsOf,
 * scanProgressOf), so the list and the record never disagree.
 */
export async function progressTotalsOf(db: Reader, workOrder: Pick<Header, 'id' | 'siteId' | 'styleId' | 'status'>): Promise<ProgressTotals | null> {
  if (workOrder.status === 'DRAFT') return null
  const cut = await cutCountsOf(db, workOrder.id, workOrder.styleId)
  const scanned = [...(await scanProgressOf(db, workOrder)).values()]
  return {
    cut: sumOrNull(cut.values()),
    bundled: sumOrNull(scanned.map((cell) => cell.bundled)),
    sewn: sumOrNull(scanned.map((cell) => cell.sewn)),
    finished: sumOrNull(scanned.map((cell) => cell.finished)),
  }
}

/** The record of one work order, read with one reader (a request's client, or the command's transaction). */
export async function workOrderView(db: Reader, workOrder: Header, today: BusinessDate, loaded?: Basics) {
  const basics = loaded ?? (await readBasics(db, workOrder))
  const { style, site, cells, orders, revision, label } = basics
  const frozen = workOrder.status !== 'DRAFT'
  const parts = await readSpecParts(db, revision?.id ?? null, workOrder.siteId)
  // A repair DRAFT (B-W2a-12) shows the steps stored on it, as the release will freeze them.
  const draft = frozen || workOrder.kind === 'REPAIR' ? null : planSpec(parts, cells)
  const plan = draft ? { operations: draft.operations.map((op) => ({ ...op, id: null })), materials: draft.materials } : await frozenSpec(db, workOrder, parts)
  const issued = await readIssued(db, workOrder.siteId, [workOrder.id])
  const cut = frozen ? await cutCountsOf(db, workOrder.id, workOrder.styleId) : null
  const scanned = frozen ? await scanProgressOf(db, workOrder) : null
  const pieces = cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const perGarment = plan.operations.reduce<Decimal>((sum, op) => sum.plus(op.standardMinutes), ZERO)
  const dueDate = dayOrNull(workOrder.dueDate)
  return {
    id: workOrder.id,
    number: workOrder.number,
    batchNumber: workOrder.batchNumber,
    kind: workOrder.kind,
    status: workOrder.status,
    version: workOrder.version,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    site: { id: site.id, code: site.code, name: site.name },
    style: { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory, sizes: [...style.sizes] },
    revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
    labelTemplate: label ? { id: label.id, code: label.code, revision: label.revision, status: label.status } : null,
    dueDate,
    daysLate: daysLate(workOrder.status, dueDate, today),
    priority: workOrder.priority,
    note: workOrder.note,
    release: await releaseOf(db, workOrder),
    startedAt: at(workOrder.startedAt),
    completedAt: at(workOrder.completedAt),
    closedAt: at(workOrder.closedAt),
    cancelledAt: at(workOrder.cancelledAt),
    cancelReason: workOrder.cancelReason,
    createdAt: toUtcIso(workOrder.createdAt),
    updatedAt: toUtcIso(workOrder.updatedAt),
    createdById: workOrder.createdById,
    nextActions: [...nextActions(workOrder.status)],
    // B-W2a-12 (MES-019): the repair order a REPAIR work order repairs for (wave 2 RepairOrder.workOrderId).
    repairOrder: workOrder.kind === 'REPAIR' ? await db.repairOrder.findFirst({ where: { workOrderId: workOrder.id }, select: { id: true, number: true, stage: true }, orderBy: { createdAt: 'desc' } }) : null,
    orders: orders.map((order) => ({ id: order.id, number: order.number, customerRef: order.customerRef, status: order.status, partyId: order.partyId, partyName: order.partyName, depositRequired: order.depositRequired })),
    cells: cells.map((cell) => ({
      id: cell.id,
      version: cell.version,
      colourwayId: cell.colourwayId,
      colourwayCode: cell.colourwayCode,
      colourwayName: cell.colourwayName,
      size: cell.size,
      quantity: cell.quantity,
      salesOrderLineId: cell.salesOrderLineId,
      salesOrderId: cell.salesOrderId,
      lineSeq: cell.lineSeq,
      progress: { cut: cut?.get(cell.id) ?? null, bundled: scanned?.get(cell.id)?.bundled ?? null, sewn: scanned?.get(cell.id)?.sewn ?? null, finished: scanned?.get(cell.id)?.finished ?? null },
    })),
    pieces,
    progress: { counted: frozen, note: PROGRESS_NOTE },
    spec: {
      frozen,
      frozenAt: at(workOrder.releasedAt),
      operations: plan.operations.map((op) => ({
        id: op.id,
        seq: op.seq,
        routingSeq: op.routingSeq,
        code: op.code,
        name: op.name,
        standardMinutes: op.standardMinutes,
        scanRequired: op.scanRequired,
        workCentreKind: op.workCentreKind,
        workCentreId: op.workCentreId,
        workCentreCode: op.workCentreCode,
      })),
      materials: materialsView(plan.materials, parts, issued, workOrder.id),
      standardMinutes: { perGarment: decimalText(perGarment), allPieces: decimalText(perGarment.times(new Dec(pieces))) },
    },
  }
}

export type WorkOrderView = Awaited<ReturnType<typeof workOrderView>>

