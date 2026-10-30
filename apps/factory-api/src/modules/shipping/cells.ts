import { ConflictError } from '@nexus/factory-domain/core/errors'
import { shippableProblems, type CellCount } from '@nexus/factory-domain/shipping/shipments'
import type { CommandTx } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'

/**
 * Only released garments ship (QHS-058, LOG-001, LOG-002; Reg. (EU) 2016/425 art. 8): a work order cell's lines over
 * every shipment that is not CANCELLED never pass its quality releases less their reversals. The
 * …_quality_shipping_guards triggers hold it under a transaction lock per cell (`factory.ship-cell`); a reversal takes
 * the same lock after its work order's release lock. The API takes that lock FIRST, in the triggers' order (the
 * shipment's row, locked by command()'s version bump, then the cells, sorted), reads the counts under it and answers
 * a clear 409 before the database would refuse: two packers on one cell queue on the lock, the second reads what the
 * first committed.
 */

/** The tenant a command runs in (every shipping command is an office or floor one). */
export function tenantOf(context: RequestContext): string {
  if (context.audience === 'platform') throw new ApiError('internal_error', 'A shipping command runs in a tenant.')
  return context.tenantId
}

/** Takes the shipping lock of each cell, sorted (two commands that lock several cells never wait on each other in a ring). */
export async function lockCells(tx: CommandTx, tenantId: string, cellIds: Iterable<string>): Promise<void> {
  for (const cellId of [...new Set(cellIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ship-cell', ${tenantId}::uuid, ${cellId}::uuid), 0))`
  }
}

/** Per cell: garments released, reversed, and on shipments that are not CANCELLED (0 for a cell with none). */
export async function cellCounts(tx: CommandTx, cellIds: readonly string[]): Promise<Map<string, CellCount>> {
  const ids = [...new Set(cellIds)]
  if (ids.length === 0) return new Map()
  // One query after another (B-W2a-48): a transaction's client has one connection (pg refuses concurrent queries on it).
  const released = await tx.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: ids } }, _sum: { quantity: true } })
  const reversed = await tx.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: ids } }, _sum: { quantity: true } })
  const shipped = await tx.shipmentLine.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: ids }, shipment: { status: { not: 'CANCELLED' } } }, _sum: { quantity: true } })
  const sumOf = (rows: readonly { workOrderSizeId: string; _sum: { quantity: number | null } }[]) => new Map(rows.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const r = sumOf(released)
  const v = sumOf(reversed)
  const s = sumOf(shipped)
  return new Map(ids.map((id) => [id, { released: r.get(id) ?? 0, reversed: v.get(id) ?? 0, onShipments: s.get(id) ?? 0 }]))
}

/** Only released garments ship: a 409 saying how many can, before any insert. */
export class NotReleasedError extends ConflictError {
  override name = 'NotReleasedError'
}

/**
 * Locks the cells, reads their counts and refuses (409) any cell asked for more than it can still ship. `more` maps a
 * cell to the garments the command ADDS to its lines; `labels` names a cell for the message.
 */
export async function reserveReleased(tx: CommandTx, tenantId: string, more: ReadonlyMap<string, number>, labels: ReadonlyMap<string, string>): Promise<Map<string, CellCount>> {
  await lockCells(tx, tenantId, more.keys())
  const counts = await cellCounts(tx, [...more.keys()])
  const problems = [...more.entries()]
    .filter(([, garments]) => garments > 0)
    .flatMap(([cellId, garments]) => shippableProblems({ ...counts.get(cellId)!, label: labels.get(cellId) ?? 'this cell' }, garments))
  if (problems.length > 0) throw new NotReleasedError(problems.join(' '))
  return counts
}
