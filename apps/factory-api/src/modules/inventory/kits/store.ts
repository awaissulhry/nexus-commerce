import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Reader } from '../issue/store'
import { kitOf, type KitStatus } from '../issue/kit-rules'

/**
 * Kit staging's reads (B-W2b-15; SCM-213): the kit records of some work orders (WorkOrderKit, id = the work order's) with
 * their places, and the picks' state of a work order (planned against issued per material and colour, the same sums
 * Picking & kits reads). Every read names its columns and selects no relation (the same inside a command).
 */

export interface KitFields {
  readonly location: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly checkedAt: string | null
  readonly note: string | null
  readonly version: number
}

const NO_KIT: KitFields = { location: null, checkedAt: null, note: null, version: 0 }

/** The kit record of each work order (none: not staged, not checked, version 0). */
export async function readKits(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, KitFields>> {
  const out = new Map<string, KitFields>(workOrderIds.map((id) => [id, NO_KIT]))
  if (workOrderIds.length === 0) return out
  const rows = await db.workOrderKit.findMany({ where: { workOrderId: { in: [...workOrderIds] } }, select: { workOrderId: true, stagingLocationId: true, completedAt: true, note: true, version: true } })
  const placeIds = [...new Set(rows.flatMap((row) => (row.stagingLocationId ? [row.stagingLocationId] : [])))]
  const places = new Map((placeIds.length === 0 ? [] : await db.location.findMany({ where: { id: { in: placeIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  for (const row of rows) {
    out.set(row.workOrderId, {
      location: row.stagingLocationId ? (places.get(row.stagingLocationId) ?? null) : null,
      checkedAt: row.completedAt ? toUtcIso(row.completedAt) : null,
      note: row.note,
      version: row.version,
    })
  }
  return out
}

/** The kit as Picking & kits shows it: the picks' state with the record's place, check and version. */
export const kitViewOf = (status: KitStatus, fields: KitFields = NO_KIT) => ({ status, location: fields.location, checkedAt: fields.checkedAt, version: fields.version })

const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))

/** The picks of one work order: its planned lines against what was issued (returns count back), as Picking & kits counts them. */
export async function picksOf(db: Reader, workOrderId: string): Promise<{ status: KitStatus; all: number; picked: number; short: number }> {
  const by = ['itemId', 'itemColourId'] as const
  const planned = await db.workOrderMaterial.groupBy({ by: [...by], where: { workOrderId }, _sum: { baseQuantity: true } })
  const out = await db.stockMove.groupBy({ by: [...by], where: { workOrderId, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: [...by], where: { workOrderId, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const key = (row: { itemId: string; itemColourId: string | null }) => `${row.itemId}|${row.itemColourId ?? '-'}`
  const issued = new Map<string, Decimal>()
  for (const row of out) issued.set(key(row), (issued.get(key(row)) ?? ZERO).plus(dec(row._sum.baseQuantity)))
  for (const row of back) issued.set(key(row), (issued.get(key(row)) ?? ZERO).minus(dec(row._sum.baseQuantity)))
  return kitOf(planned.map((row) => ({ planned: dec(row._sum.baseQuantity).toFixed(4), issued: (issued.get(key(row)) ?? ZERO).toFixed(4) })))
}
