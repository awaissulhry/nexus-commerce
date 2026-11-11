import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PROGRESS_REFRESH_SECONDS, PROGRESS_STAGE_WORDS, PROGRESS_STAGES, progressOf, type ProgressView, type StageCount } from '@nexus/factory-domain/sales/portal-orders/progress'
import { scanProgressOf } from '../../production/scans/progress'
import { partnerOrder, portalReader, type PortalReader } from './access'
import { namesOf, progressShared, readLines, type PortalLine, type Reader } from './store'

/**
 * Production progress for the customer, read side (B-W2b-175, SAL-076; Owner answer C1): the counts per line and size from
 * the floor's records, read in the tenant's scope (they are the office's, never a partner's) and only for an order of the
 * customer's that the partner read found first, while its PortalSettings.progressShared is on (the caller checks it on
 * every request, so switching it off hides the counts at once). Sums only: no worker, no station, no line of the floor.
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
}

const kept = new Map<string, ProgressAnswer>()

/** Test only: forget what was counted. */
export function forgetProgress(): void {
  kept.clear()
}

/** The counts per line and size of one order, read now. */
export async function readStageCounts(db: Reader, orderId: string, lines: readonly PortalLine[]): Promise<StageCount[]> {
  const lineIds = lines.map((line) => line.id)
  if (lineIds.length === 0) return []
  const cells = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } }, select: { id: true, workOrderId: true, salesOrderLineId: true, size: true } })
  const workOrders = cells.length > 0 ? await db.workOrder.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.workOrderId))] }, status: { notIn: ['DRAFT', 'CANCELLED'] } }, select: { id: true, siteId: true }, orderBy: { id: 'asc' } }) : []
  const scanned = new Map<string, { bundled: number; sewn: number | null }>()
  for (const workOrder of workOrders) for (const [cellId, figures] of await scanProgressOf(db, workOrder)) scanned.set(cellId, figures)
  const cellIds = cells.map((cell) => cell.id)
  const released = cellIds.length > 0 ? await db.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const reversed = cellIds.length > 0 ? await db.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const releasedOf = new Map(released.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const reversedOf = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const shipments = await db.shipment.findMany({ where: { salesOrderId: orderId, status: { in: [...PACKED_OR_LATER] } }, select: { id: true } })
  const packed = shipments.length > 0 ? await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { shipmentId: { in: shipments.map((row) => row.id) } }, _sum: { quantity: true } }) : []

  const sizeless = new Set(lines.filter((line) => line.sizes.length === 0).map((line) => line.id))
  const sizeOf = (lineId: string, size: string): string | null => (sizeless.has(lineId) ? null : size)
  // Every size starts at nothing cut, inspected or packed (a line without a work order yet shows 0, not "unknown"); sewn has
  // a figure only where the floor scans the sewing.
  const counts: StageCount[] = lines.flatMap((line) =>
    (line.sizes.length > 0 ? line.sizes.map((entry) => entry.size as string | null) : [null]).map((size): StageCount => ({ lineId: line.id, size, cut: 0, sewn: null, inspected: 0, packed: 0 })),
  )
  for (const cell of cells) {
    // B-W2b-275: the cells of this order's lines (a SAMPLE cell may name none).
    if (cell.salesOrderLineId === null) continue
    const figures = scanned.get(cell.id)
    counts.push({
      lineId: cell.salesOrderLineId,
      size: sizeOf(cell.salesOrderLineId, cell.size),
      cut: figures ? figures.bundled : null,
      sewn: figures ? figures.sewn : null,
      inspected: (releasedOf.get(cell.id) ?? 0) - (reversedOf.get(cell.id) ?? 0),
      packed: null,
    })
  }
  for (const row of packed) counts.push({ lineId: row.salesOrderLineId, size: sizeOf(row.salesOrderLineId, row.size), cut: null, sewn: null, inspected: null, packed: row._sum.quantity ?? 0 })
  return counts
}

/** The order's progress: kept for a minute, else read now with `read` (the tenant's scope) and kept. */
export async function orderProgressFor(key: string, now: Date, lines: readonly PortalLine[], read: () => Promise<StageCount[]>): Promise<ProgressAnswer> {
  const known = kept.get(key)
  if (known && now.getTime() - known.computedAt.getTime() < PROGRESS_REFRESH_SECONDS * 1000 && now.getTime() >= known.computedAt.getTime()) return known
  const counts = await read()
  const answer: ProgressAnswer = {
    computedAt: now,
    view: progressOf(
      lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })) })),
      counts,
    ),
  }
  kept.delete(key)
  kept.set(key, answer)
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!)
  return answer
}

/** The order's progress for this reader (the kept counts, or read now in the tenant's scope). */
export function progressFor(reader: PortalReader, orderId: string, lines: readonly PortalLine[], now: Date): Promise<ProgressAnswer> {
  return orderProgressFor(`${reader.session.tenantId}:${orderId}`, now, lines, () => reader.inTenant((client) => readStageCounts(client, orderId, lines)))
}

export async function orderProgressView(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  if (!(await reader.inTenant((client) => progressShared(client, reader.session.partyId)))) throw new NotFoundError('Production progress is not shared for this account.')
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
