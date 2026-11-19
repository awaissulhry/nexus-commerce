import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PROGRESS_REFRESH_SECONDS, PROGRESS_STAGE_WORDS, PROGRESS_STAGES, progressOf, type ProgressView, type StageCount } from '@nexus/factory-domain/sales/portal-orders/progress'
import { scanProgressOf } from '../../production/scans/progress'
import { partnerOrder, portalReader, type PortalReader } from './access'
import { shares } from '@nexus/factory-domain/production-brand/levels'
import { namesOf, readLines, shareLevelOf, type PortalLine, type Reader } from './store'
// B-OP-044 (order page N6, lines-derived): an order's shipments through their lines.
import { shipmentsOfOrderWhere } from '../../shipping/shipments/orders-of'

/**
 * Production progress for the customer, read side (B-W2b-175, SAL-076; Owner answer C1): the counts per line and size from
 * the floor's records, read in the tenant's scope (they are the office's, never a partner's) and only for an order of the
 * customer's that the partner read found first, while its share level shares production progress (PortalSettings.productionLevel
 * PROGRESS or more; B-PR-40: the old switch dropped) — the caller checks it on every request, so a lower level hides the counts
 * at once. Sums only: no worker, no station, no line of the floor.
 *
 *   cells      the work order cells of the order's lines (not REPAIR work orders, not CANCELLED ones)
 *   cut, sewn  production/scans WIP of each work order past its DRAFT (`bundled`, `sewn`; a held one keeps its scans)
 *   inspected  quality releases of the cells less their reversals
 *   packed     the order's shipments PACKED, SHIPPED or DELIVERED: their lines
 *
 * "Batched to at most once a minute" (design): the counts of an order are kept PROGRESS_REFRESH_SECONDS in this process,
 * so many readers of one customer and a page that refreshes cost one read a minute per order and process.
 *
 *   GET /portal/sales-orders/:orderId/progress   per line and size: ordered, cut, sewn, inspected, packed; the whole order
 *                                                and its percent; when they were counted. Not shared: 404 (the section is
 *                                                not drawn: no placeholder, no hint).
 */

const PACKED_OR_LATER = ['PACKED', 'SHIPPED', 'DELIVERED'] as const
const KEPT_MAX = 2000

export interface ProgressAnswer {
  readonly computedAt: Date
  readonly view: ProgressView
  // B-SA-030: the cells the view was folded from (the office's order read takes each work order's own share from them).
  readonly cells: CellCounts
}

const kept = new Map<string, ProgressAnswer>()

/** Test only: forget what was counted. */
export function forgetProgress(): void {
  kept.clear()
}

// ── B-SA-030 (Sales page plan P2, P16, P17): one reader of the order's own cells, shared by the portal and the office ────────────
/**
 * The lines a count reads: an order's lines with their size rows (the portal's PortalLine, the office's sales/orders LineRecord).
 */
export interface ProgressLine {
  readonly id: string
  readonly seq: number
  readonly quantity: number
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

/** One work order cell of the order's own lines, as counted (the office's order read sums each work order's own share). */
export interface CellCount {
  readonly cellId: string
  readonly workOrderId: string
  readonly lineId: string
  /** null: a made-to-measure unit (a line without sizes). */
  readonly size: string | null
  /** The cell's pieces. */
  readonly quantity: number
  /** Garments in ACTIVE whole-garment bundles; null: its work order is still a DRAFT (nothing counted yet). */
  readonly cut: number | null
  /** Garments past the sewing operation; null: not counted there (or a DRAFT). */
  readonly sewn: number | null
  /** Released by quality less the releases taken back. */
  readonly inspected: number
}

/** What one read of an order's cells finds: every own cell, and what its packed, shipped or delivered shipments carry. */
export interface CellCounts {
  readonly cells: readonly CellCount[]
  /** Per line and size (a shipment line names no cell). */
  readonly packed: readonly { readonly lineId: string; readonly size: string | null; readonly quantity: number }[]
}

/** The key the counts of an order are kept under: the portal and the office read the same minute. */
export const progressKey = (tenantId: string, orderId: string): string => `${tenantId}:${orderId}`

/** The counts per cell of one order, read now (the tenant's scope: the floor's records are the office's). */
export async function readCellCounts(db: Reader, orderId: string, lines: readonly ProgressLine[]): Promise<CellCounts> {
  const lineIds = lines.map((line) => line.id)
  if (lineIds.length === 0) return { cells: [], packed: [] }
  const cells = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } }, select: { id: true, workOrderId: true, salesOrderLineId: true, size: true, quantity: true } })
  const workOrders = cells.length > 0 ? await db.workOrder.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.workOrderId))] }, status: { notIn: ['DRAFT', 'CANCELLED'] } }, select: { id: true, siteId: true }, orderBy: { id: 'asc' } }) : []
  const scanned = new Map<string, { bundled: number; sewn: number | null }>()
  for (const workOrder of workOrders) for (const [cellId, figures] of await scanProgressOf(db, workOrder)) scanned.set(cellId, figures)
  const cellIds = cells.map((cell) => cell.id)
  const released = cellIds.length > 0 ? await db.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const reversed = cellIds.length > 0 ? await db.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const releasedOf = new Map(released.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const reversedOf = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  // B-OP-044 (order page N6): the shipments made for it or carrying its garments; only this order's own pieces count.
  const shipments = await db.shipment.findMany({ where: { ...shipmentsOfOrderWhere(orderId), status: { in: [...PACKED_OR_LATER] } }, select: { id: true } })
  const packed = shipments.length > 0 ? await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { shipmentId: { in: shipments.map((row) => row.id) }, salesOrderLine: { orderId } }, _sum: { quantity: true } }) : []

  const sizeless = new Set(lines.filter((line) => line.sizes.length === 0).map((line) => line.id))
  const sizeOf = (lineId: string, size: string): string | null => (sizeless.has(lineId) ? null : size)
  return {
    // B-W2b-275: the cells of this order's lines (a SAMPLE cell may name none).
    cells: cells.flatMap((cell): CellCount[] => {
      if (cell.salesOrderLineId === null) return []
      const figures = scanned.get(cell.id)
      return [
        {
          cellId: cell.id,
          workOrderId: cell.workOrderId,
          lineId: cell.salesOrderLineId,
          size: sizeOf(cell.salesOrderLineId, cell.size),
          quantity: cell.quantity,
          cut: figures ? figures.bundled : null,
          sewn: figures ? figures.sewn : null,
          inspected: (releasedOf.get(cell.id) ?? 0) - (reversedOf.get(cell.id) ?? 0),
        },
      ]
    }),
    packed: packed.map((row) => ({ lineId: row.salesOrderLineId, size: sizeOf(row.salesOrderLineId, row.size), quantity: row._sum.quantity ?? 0 })),
  }
}

/** The counts per line and size folded from the cells (what the portal has always answered). */
export function stageCountsOf(lines: readonly ProgressLine[], read: CellCounts): StageCount[] {
  // Every size starts at nothing cut, inspected or packed (a line without a work order yet shows 0, not "unknown"); sewn has
  // a figure only where the floor scans the sewing.
  const counts: StageCount[] = lines.flatMap((line) =>
    (line.sizes.length > 0 ? line.sizes.map((entry) => entry.size as string | null) : [null]).map((size): StageCount => ({ lineId: line.id, size, cut: 0, sewn: null, inspected: 0, packed: 0 })),
  )
  for (const cell of read.cells) counts.push({ lineId: cell.lineId, size: cell.size, cut: cell.cut, sewn: cell.sewn, inspected: cell.inspected, packed: null })
  for (const row of read.packed) counts.push({ lineId: row.lineId, size: row.size, cut: null, sewn: null, inspected: null, packed: row.quantity })
  return counts
}
// ── end B-SA-030 ──

/** The counts per line and size of one order, read now (B-SA-030: the fold of readCellCounts). */
export async function readStageCounts(db: Reader, orderId: string, lines: readonly ProgressLine[]): Promise<StageCount[]> {
  return stageCountsOf(lines, await readCellCounts(db, orderId, lines))
}

/** The order's progress: kept for a minute, else read now with `read` (the tenant's scope) and kept. */
export async function orderProgressFor(key: string, now: Date, lines: readonly ProgressLine[], read: () => Promise<CellCounts>): Promise<ProgressAnswer> {
  const known = kept.get(key)
  if (known && now.getTime() - known.computedAt.getTime() < PROGRESS_REFRESH_SECONDS * 1000 && now.getTime() >= known.computedAt.getTime()) return known
  const cells = await read()
  const answer: ProgressAnswer = {
    computedAt: now,
    view: progressOf(
      lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })) })),
      stageCountsOf(lines, cells),
    ),
    cells,
  }
  kept.delete(key)
  kept.set(key, answer)
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!)
  return answer
}

/** The order's progress for this reader (the kept counts, or read now in the tenant's scope). */
export function progressFor(reader: PortalReader, orderId: string, lines: readonly PortalLine[], now: Date): Promise<ProgressAnswer> {
  return orderProgressFor(progressKey(reader.session.tenantId, orderId), now, lines, () => reader.inTenant((client) => readCellCounts(client, orderId, lines)))
}

// B-SA-030: the office's order read (sales/orders/production-read.ts) keeps its counts under the same key: one read a minute per
// order and process, whoever asks. Read with the office's scoped client, AFTER the order was checked with orders.view.
export function officeProgressFor(db: Reader, tenantId: string, orderId: string, lines: readonly ProgressLine[], now: Date): Promise<ProgressAnswer> {
  return orderProgressFor(progressKey(tenantId, orderId), now, lines, () => readCellCounts(db, orderId, lines))
}

export async function orderProgressView(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  if (!shares(await reader.inTenant((client) => shareLevelOf(client, reader.session.partyId)), 'progress')) throw new NotFoundError('Production progress is not shared for this account.')
  const lines = await request.withClient((client) => readLines(client, [order.id]))
  const answer = await progressFor(reader, order.id, lines, now)
  const names = await reader.inTenant((client) => namesOf(client, [...new Set(lines.map((line) => line.styleId))], [...new Set(lines.map((line) => line.colourwayId))]))
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  return {
    asOf: toUtcIso(answer.computedAt),
    refreshSeconds: PROGRESS_REFRESH_SECONDS,
    stages: PROGRESS_STAGES.map((key) => ({ key, words: PROGRESS_STAGE_WORDS[key] })),
    lines: answer.view.lines.map((view) => {
      const line = lineOf.get(view.lineId)
      const style = line ? names.styles.get(line.styleId) : undefined
      const colourway = line ? names.colourways.get(line.colourwayId) : undefined
      return { ...view, sizes: [...view.sizes], style: style ? { code: style.code, name: style.name } : null, colourway: colourway ? { code: colourway.code, name: colourway.name } : null }
    }),
    whole: answer.view.whole,
    percent: answer.view.percent,
  }
}
