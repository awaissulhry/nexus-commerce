import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { liveGarments } from '@nexus/factory-domain/production/bundles/split'
import { partOf } from '@nexus/factory-domain/production/cutting/rules'
import { OPEN_SECONDARY_STATUSES } from '@nexus/factory-domain/production/cutissue/secondary'
import { OPEN_CUT_ISSUE_STATUSES } from '@nexus/factory-domain/production/cutissue/trolley'
import type { RecutLot, RecutMaterial } from '@nexus/factory-domain/production/rework/recut'
import type { CommandTx } from '../../../core/command'
import { BUNDLE_COLUMNS, readBundle, readBundleByCode, type BundleRow } from '../bundles/store'

/**
 * The reads after the cut (B-W2b-117): the work orders, cells and bundles the recut tickets, secondary processes and trolleys
 * name, a bundle's live garments, its shade lots (genealogy), its cell's parts and materials, its open processes and the open
 * trolley it is on. Every read runs as the caller (a tablet sees its own site only); none reads money or a person.
 */

export type Reader = FactoryClient | CommandTx

export const ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  status: true,
  holdReason: true,
  dueDate: true,
  rush: true,
  priority: true,
  styleId: true,
  lineId: true,
} as const satisfies Prisma.WorkOrderSelect
export type OrderRow = Prisma.WorkOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

export async function readOrder(db: Reader, workOrderId: string): Promise<OrderRow | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: ORDER_COLUMNS })
}

export async function readOrders(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, OrderRow>> {
  const ids = [...new Set(workOrderIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.workOrder.findMany({ where: { id: { in: ids } }, select: ORDER_COLUMNS })).map((row) => [row.id, row]))
}

/** The work orders' styles (code and name). */
export async function readStyles(db: Reader, styleIds: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const ids = [...new Set(styleIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.style.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
}

export interface CellWords {
  readonly id: string
  readonly workOrderId: string
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
}

/** Cells (colourway code and size) by id. */
export async function readCells(db: Reader, cellIds: readonly string[]): Promise<Map<string, CellWords>> {
  const ids = [...new Set(cellIds)]
  if (ids.length === 0) return new Map()
  const cells = await db.workOrderSize.findMany({ where: { id: { in: ids } }, select: { id: true, workOrderId: true, size: true, quantity: true, colourwayId: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return new Map(cells.map((cell) => [cell.id, { id: cell.id, workOrderId: cell.workOrderId, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size, quantity: cell.quantity }]))
}

export const cellText = (cell: Pick<CellWords, 'colourwayCode' | 'size'> | undefined): string => (cell ? `${cell.colourwayCode} ${cell.size}`.trim() : '')

/** A bundle by its id or a ticket's code (its current code, an old one, or a coupon), as the caller sees it. */
export async function findBundle(db: Reader, by: { readonly bundleId?: string | null | undefined; readonly code?: string | null | undefined }): Promise<BundleRow | null> {
  if (by.bundleId) return readBundle(db, by.bundleId)
  const code = by.code?.trim().toUpperCase()
  return code ? readBundleByCode(db, code) : null
}

export async function readBundles(db: Reader, bundleIds: readonly string[]): Promise<Map<string, BundleRow>> {
  const ids = [...new Set(bundleIds)].filter(isUuid)
  if (ids.length === 0) return new Map()
  return new Map((await db.bundle.findMany({ where: { id: { in: ids } }, select: BUNDLE_COLUMNS })).map((row) => [row.id, row]))
}

/** The garments still in each bundle: its quantity less its split-off children's that are not VOID. */
export async function liveOf(db: Reader, bundles: readonly Pick<BundleRow, 'id' | 'quantity'>[]): Promise<Map<string, number>> {
  if (bundles.length === 0) return new Map()
  const children = await db.bundle.findMany({ where: { parentBundleId: { in: bundles.map((bundle) => bundle.id) } }, select: { parentBundleId: true, quantity: true, status: true } })
  return new Map(bundles.map((bundle) => [bundle.id, liveGarments(bundle.quantity, children.filter((child) => child.parentBundleId === bundle.id))]))
}

/**
 * A cell's cut materials (its planned materials of hide- or lot-tracked items) and the parts they and the pattern name: each
 * pattern piece of the material's BOM line in the cell's size, else the BOM line's placement (or the item's code).
 */
export async function cellCutFacts(db: Reader, cellId: string, size: string): Promise<{ materials: RecutMaterial[]; parts: string[] }> {
  const rows = await db.workOrderMaterial.findMany({ where: { workOrderSizeId: cellId }, select: { itemId: true, itemColourId: true, bomLineId: true, styleRevisionId: true } })
  if (rows.length === 0) return { materials: [], parts: [] }
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.itemId))] }, tracking: { in: ['HIDE', 'LOT'] } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const cut = rows.filter((row) => items.has(row.itemId))
  const [lines, pieces] = await Promise.all([
    db.bomLine.findMany({ where: { id: { in: [...new Set(cut.map((row) => row.bomLineId))] } }, select: { id: true, placement: true } }),
    db.patternPiece.findMany({ where: { revisionId: { in: [...new Set(cut.map((row) => row.styleRevisionId))] }, bomLineId: { in: [...new Set(cut.map((row) => row.bomLineId))] } }, select: { bomLineId: true, name: true, sizes: true } }),
  ])
  const placement = new Map(lines.map((line) => [line.id, line.placement]))
  const parts = new Set<string>()
  for (const row of cut) {
    const named = pieces.filter((piece) => piece.bomLineId === row.bomLineId && (piece.sizes.length === 0 || piece.sizes.includes(size)))
    if (named.length > 0) for (const piece of named) parts.add(piece.name)
    else parts.add(partOf(placement.get(row.bomLineId), items.get(row.itemId)!.code))
  }
  const materials = [...new Map(cut.map((row) => [`${row.itemId}|${row.itemColourId ?? ''}`, { itemId: row.itemId, itemColourId: row.itemColourId }])).values()]
  return { materials, parts: [...parts].sort() }
}

const LOT_COLUMNS = { id: true, siteId: true, code: true, itemId: true, itemColourId: true, dyeBatch: true, shade: true } as const satisfies Prisma.LotSelect

export async function readLot(db: Reader, lotId: string): Promise<(RecutLot & { siteId: string }) | null> {
  if (!isUuid(lotId)) return null
  return db.lot.findUnique({ where: { id: lotId }, select: LOT_COLUMNS })
}

export async function readLots(db: Reader, lotIds: readonly string[]): Promise<Map<string, RecutLot>> {
  const ids = [...new Set(lotIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.lot.findMany({ where: { id: { in: ids } }, select: LOT_COLUMNS })).map((row) => [row.id, row]))
}

/**
 * A bundle's shade lots (its genealogy): the lots of its cut log entries (leather), and the lots of the rolls spread in the CUT
 * lays of the cut orders that cut its cell (fabric). At most 20, in that order.
 */
export async function shadeLotsOf(db: Reader, bundle: Pick<BundleRow, 'cutLogIds' | 'workOrderSizeId'>): Promise<RecutLot[]> {
  const entries = bundle.cutLogIds.length > 0 ? await db.cutLog.findMany({ where: { id: { in: bundle.cutLogIds } }, select: { lotId: true } }) : []
  const lines = await db.cutOrderLine.findMany({ where: { workOrderSizeId: bundle.workOrderSizeId }, select: { cutOrderId: true }, take: 20 })
  const lays = lines.length > 0 ? await db.lay.findMany({ where: { cutOrderId: { in: lines.map((line) => line.cutOrderId) }, status: 'CUT' }, select: { id: true } }) : []
  const rolls = lays.length > 0 ? await db.layRoll.findMany({ where: { layId: { in: lays.map((lay) => lay.id) } }, select: { roll: { select: { lotId: true } } } }) : []
  const ids = [...new Set([...entries.map((entry) => entry.lotId), ...rolls.map((row) => row.roll.lotId)])].slice(0, 20)
  const lots = await readLots(db, ids)
  return ids.flatMap((id) => (lots.has(id) ? [lots.get(id)!] : []))
}

/** The bundles' secondary processes, in their order on each bundle. */
export const PROCESS_COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  bundleId: true,
  seq: true,
  kind: true,
  place: true,
  workCentreId: true,
  subcontractOrderId: true,
  quantity: true,
  status: true,
  startedAt: true,
  doneAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.SecondaryProcessSelect
export type ProcessRow = Prisma.SecondaryProcessGetPayload<{ select: typeof PROCESS_COLUMNS }>

export async function readProcesses(db: Reader, bundleIds: readonly string[], open = false): Promise<ProcessRow[]> {
  if (bundleIds.length === 0) return []
  return db.secondaryProcess.findMany({ where: { bundleId: { in: [...new Set(bundleIds)] }, ...(open ? { status: { in: [...OPEN_SECONDARY_STATUSES] } } : {}) }, select: PROCESS_COLUMNS, orderBy: [{ bundleId: 'asc' }, { seq: 'asc' }] })
}

/**
 * The trolley each bundle is on: an open one (LOADING or SENT), and (with `received`) also one received at a line. The latest
 * per bundle.
 */
export async function trolleyOfBundles(db: Reader, bundleIds: readonly string[], received = false): Promise<Map<string, { issueId: string; trolleyCode: string; status: string }>> {
  if (bundleIds.length === 0) return new Map()
  const statuses = received ? [...OPEN_CUT_ISSUE_STATUSES, 'RECEIVED' as const] : [...OPEN_CUT_ISSUE_STATUSES]
  const rows = await db.cutIssueLine.findMany({
    where: { bundleId: { in: [...new Set(bundleIds)] }, issue: { is: { status: { in: statuses } } } },
    select: { bundleId: true, createdAt: true, issue: { select: { id: true, trolleyCode: true, status: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const found = new Map<string, { issueId: string; trolleyCode: string; status: string }>()
  for (const row of rows) if (!found.has(row.bundleId)) found.set(row.bundleId, { issueId: row.issue.id, trolleyCode: row.issue.trolleyCode, status: row.issue.status })
  return found
}

/** The work centres of a site by id (code, name, status). */
export async function readWorkCentres(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; siteId: string; code: string; name: string; status: string }>> {
  const unique = [...new Set(ids)].filter(isUuid)
  if (unique.length === 0) return new Map()
  return new Map((await db.workCentre.findMany({ where: { id: { in: unique } }, select: { id: true, siteId: true, code: true, name: true, status: true } })).map((row) => [row.id, row]))
}

/** Lines by id (code, name, status, site). */
export async function readLines(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; siteId: string; companyId: string; code: string; name: string; status: string }>> {
  const unique = [...new Set(ids)].filter(isUuid)
  if (unique.length === 0) return new Map()
  return new Map((await db.line.findMany({ where: { id: { in: unique } }, select: { id: true, siteId: true, companyId: true, code: true, name: true, status: true } })).map((row) => [row.id, row]))
}

/** The floor device's station: its work centre and its line (null: a roaming tablet). */
export async function deviceStation(db: Reader, deviceId: string): Promise<{ id: string; code: string; workCentreId: string; lineId: string | null } | null> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true } })
  if (!device?.stationId) return null
  return db.station.findUnique({ where: { id: device.stationId }, select: { id: true, code: true, workCentreId: true, lineId: true } })
}

/** The bundle's cell's work order rows, for the views of bundles. */
export function bundleBrief(bundle: BundleRow, live: number) {
  return { id: bundle.id, code: bundle.code, part: bundle.part, status: bundle.status as 'ACTIVE' | 'VOID', quantity: bundle.quantity, live }
}
