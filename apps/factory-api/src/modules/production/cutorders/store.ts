import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { LengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { type PlyLine } from '@nexus/factory-domain/production/cutorders/plies'
import { LIVE_CUT_ORDER_STATUSES, perPlyLength } from '@nexus/factory-domain/production/cutorders/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * The reads and locks of cut orders (B-W2b-112): a cut order with its lines (the cells and their work orders), lays, the rolls
 * allocated or spread on them, tickets and ply sticker runs; what live cut orders already cut of a cell; what lays not yet spread
 * plan from a roll. Every read names its columns and runs as the caller (a floor device: its own site, by row-level security).
 */

export type Reader = FactoryClient | CommandTx

export const CUT_ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  kind: true,
  itemId: true,
  itemColourId: true,
  stationId: true,
  markerName: true,
  markerLength: true,
  markerUom: true,
  markerWidthCm: true,
  markerFileId: true,
  dueDate: true,
  status: true,
  releasedAt: true,
  cutAt: true,
  reconciledAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  item: { select: { id: true, code: true, name: true, tracking: true, baseUom: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  station: { select: { id: true, code: true, name: true, labelPrinterId: true } },
} as const satisfies Prisma.CutOrderSelect
export type CutOrderRow = Prisma.CutOrderGetPayload<{ select: typeof CUT_ORDER_COLUMNS }>

export async function readCutOrder(db: Reader, cutOrderId: string): Promise<CutOrderRow | null> {
  if (!isUuid(cutOrderId)) return null
  return db.cutOrder.findUnique({ where: { id: cutOrderId }, select: CUT_ORDER_COLUMNS })
}

export const LINE_COLUMNS = {
  id: true,
  cutOrderId: true,
  seq: true,
  workOrderId: true,
  workOrderSizeId: true,
  quantity: true,
  ratio: true,
  plies: true,
  version: true,
  workOrderSize: {
    select: {
      size: true,
      quantity: true,
      colourway: { select: { id: true, code: true, name: true } },
      workOrder: { select: { id: true, number: true, batchNumber: true, status: true, holdReason: true, dueDate: true, styleRevisionId: true, style: { select: { id: true, code: true, name: true } } } },
    },
  },
} as const satisfies Prisma.CutOrderLineSelect
export type LineRow = Prisma.CutOrderLineGetPayload<{ select: typeof LINE_COLUMNS }>

export async function readLines(db: Reader, cutOrderIds: readonly string[]): Promise<LineRow[]> {
  if (cutOrderIds.length === 0) return []
  return db.cutOrderLine.findMany({ where: { cutOrderId: { in: [...cutOrderIds] } }, select: LINE_COLUMNS, orderBy: [{ cutOrderId: 'asc' }, { seq: 'asc' }] })
}

export const LAY_COLUMNS = {
  id: true,
  cutOrderId: true,
  seq: true,
  plies: true,
  layLength: true,
  lengthUom: true,
  plyCountLeft: true,
  plyCountRight: true,
  checkedAt: true,
  status: true,
  cutAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
} as const satisfies Prisma.LaySelect
export type LayRow = Prisma.LayGetPayload<{ select: typeof LAY_COLUMNS }>

export async function readLays(db: Reader, cutOrderIds: readonly string[]): Promise<LayRow[]> {
  if (cutOrderIds.length === 0) return []
  return db.lay.findMany({ where: { cutOrderId: { in: [...cutOrderIds] } }, select: LAY_COLUMNS, orderBy: [{ cutOrderId: 'asc' }, { seq: 'asc' }] })
}

export const LAY_ROLL_COLUMNS = {
  id: true,
  layId: true,
  seq: true,
  rollId: true,
  plies: true,
  splices: true,
  endLoss: true,
  endReturned: true,
  version: true,
  roll: {
    select: {
      id: true,
      code: true,
      lotId: true,
      state: true,
      uom: true,
      lengthLeft: true,
      widthCm: true,
      shade: true,
      shadeGroupId: true,
      shrinkageGroup: true,
      lot: { select: { code: true } },
    },
  },
} as const satisfies Prisma.LayRollSelect
export type LayRollRow = Prisma.LayRollGetPayload<{ select: typeof LAY_ROLL_COLUMNS }>

export async function readLayRolls(db: Reader, layIds: readonly string[]): Promise<LayRollRow[]> {
  if (layIds.length === 0) return []
  return db.layRoll.findMany({ where: { layId: { in: [...layIds] } }, select: LAY_ROLL_COLUMNS, orderBy: [{ layId: 'asc' }, { seq: 'asc' }] })
}

export const TICKET_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  scanCode: true,
  kind: true,
  cutOrderId: true,
  layId: true,
  status: true,
  printedAt: true,
  startedAt: true,
  doneAt: true,
  voidedAt: true,
  voidReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.CutTicketSelect
export type TicketRow = Prisma.CutTicketGetPayload<{ select: typeof TICKET_COLUMNS }>

export async function readTickets(db: Reader, cutOrderIds: readonly string[]): Promise<TicketRow[]> {
  if (cutOrderIds.length === 0) return []
  return db.cutTicket.findMany({ where: { cutOrderId: { in: [...cutOrderIds] }, kind: 'CUT' }, select: TICKET_COLUMNS, orderBy: [{ createdAt: 'asc' }, { number: 'asc' }] })
}

export const PLY_RUN_COLUMNS = {
  id: true,
  layId: true,
  seq: true,
  firstPly: true,
  lastPly: true,
  parts: true,
  labelCount: true,
  status: true,
  printedAt: true,
  voidedAt: true,
  voidReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.PlyRunSelect
export type PlyRunRow = Prisma.PlyRunGetPayload<{ select: typeof PLY_RUN_COLUMNS }>

export async function readPlyRuns(db: Reader, layIds: readonly string[]): Promise<PlyRunRow[]> {
  if (layIds.length === 0) return []
  return db.plyRun.findMany({ where: { layId: { in: [...layIds] } }, select: PLY_RUN_COLUMNS, orderBy: [{ layId: 'asc' }, { seq: 'asc' }] })
}

/**
 * Garments live cut orders of the material (and colour) already cut of each cell, but the cut order asked: every status but
 * CANCELLED counts (a cut order cut and reconciled took its garments too).
 */
export async function garmentsElsewhere(db: Reader, material: { readonly itemId: string; readonly itemColourId: string | null }, cellIds: readonly string[], except: string | null): Promise<Map<string, number>> {
  if (cellIds.length === 0) return new Map()
  const rows = await db.cutOrderLine.groupBy({
    by: ['workOrderSizeId'],
    where: {
      workOrderSizeId: { in: [...cellIds] },
      cutOrder: { is: { itemId: material.itemId, itemColourId: material.itemColourId, status: { in: [...LIVE_CUT_ORDER_STATUSES] }, ...(except ? { id: { not: except } } : {}) } },
    },
    _sum: { quantity: true },
  })
  return new Map(rows.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
}

/**
 * Cut orders take turns per cell (a create, a re-plan, a release of cells in common): one transaction-scoped advisory lock per
 * cell, in id order, taken after the cut order's own row.
 */
export async function lockCells(tx: CommandTx, tenantId: string, cellIds: readonly string[]): Promise<void> {
  for (const cellId of [...new Set(cellIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.cut-order-cells', ${tenantId}::uuid, ${cellId}::uuid), 0))`
  }
}

/** The cells a plan names, with their work orders and the cut order's material among their planned materials. */
export async function readCells(db: Reader, cellIds: readonly string[], material: { readonly itemId: string; readonly itemColourId: string | null }) {
  if (cellIds.length === 0) return []
  return db.workOrderSize.findMany({
    where: { id: { in: [...cellIds].filter(isUuid) } },
    select: {
      id: true,
      siteId: true,
      workOrderId: true,
      size: true,
      quantity: true,
      colourway: { select: { code: true, name: true } },
      workOrder: { select: { id: true, companyId: true, siteId: true, number: true, status: true, holdReason: true } },
      materials: { where: { itemId: material.itemId, ...(material.itemColourId ? { itemColourId: material.itemColourId } : {}) }, select: { id: true }, take: 1 },
    },
  })
}

/**
 * What lays not yet spread (PLANNED, of an open cut order) plan from each roll: their plies × their cut order's marker (and the
 * allowance), in the roll's unit. `exceptLayId` leaves one lay out.
 */
export async function plannedOnRolls(db: Reader, rolls: readonly { readonly id: string; readonly uom: LengthUom }[], allowanceCm: number, exceptLayId: string | null = null): Promise<Map<string, { length: Decimal; on: { cutOrderNumber: string; laySeq: number; plies: number }[] }>> {
  const out = new Map<string, { length: Decimal; on: { cutOrderNumber: string; laySeq: number; plies: number }[] }>()
  if (rolls.length === 0) return out
  const uomOf = new Map(rolls.map((roll) => [roll.id, roll.uom]))
  const rows = await db.layRoll.findMany({
    where: { rollId: { in: rolls.map((roll) => roll.id) }, lay: { is: { status: 'PLANNED', cutOrder: { is: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS'] } } } } }, ...(exceptLayId ? { layId: { not: exceptLayId } } : {}) },
    select: { rollId: true, plies: true, lay: { select: { seq: true, cutOrder: { select: { number: true, markerLength: true, markerUom: true } } } } },
  })
  for (const row of rows) {
    const marker = row.lay.cutOrder
    const uom = uomOf.get(row.rollId)!
    const per = marker.markerLength !== null && marker.markerUom !== null ? perPlyLength({ length: marker.markerLength.toString(), uom: marker.markerUom as LengthUom }, uom, allowanceCm) : ZERO
    const entry = out.get(row.rollId) ?? { length: ZERO, on: [] }
    entry.length = entry.length.plus(per.times(row.plies))
    entry.on.push({ cutOrderNumber: marker.number, laySeq: row.lay.seq, plies: row.plies })
    out.set(row.rollId, entry)
  }
  return out
}

/** The rolls whose latest decided incoming 4-point result (B-W2b-111) is REJECTED. */
export async function rejectedRolls(db: Reader, rollIds: readonly string[]): Promise<Set<string>> {
  if (rollIds.length === 0) return new Set()
  const rows = await db.incomingRollResult.findMany({
    where: { recordType: 'FabricRoll', recordId: { in: [...rollIds] }, decision: { not: null } },
    select: { recordId: true, decision: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  })
  const latest = new Map<string, string>()
  for (const row of rows) if (row.recordId && !latest.has(row.recordId)) latest.set(row.recordId, String(row.decision))
  return new Set([...latest].filter(([, decision]) => decision === 'REJECTED').map(([rollId]) => rollId))
}

/**
 * The cut order's lines as ply stickers need them: per line its size, ratio and the pattern pieces of its work order's revision
 * cut from the cut order's material (the cell's planned BOM line of the material), for the size (B-W2b-95 PatternPiece).
 */
export async function plyLinesOf(db: Reader, order: { readonly itemId: string; readonly itemColourId: string | null }, lines: readonly LineRow[]): Promise<PlyLine[]> {
  const cellIds = lines.map((line) => line.workOrderSizeId)
  const materials = cellIds.length
    ? await db.workOrderMaterial.findMany({ where: { workOrderSizeId: { in: cellIds }, itemId: order.itemId, ...(order.itemColourId ? { itemColourId: order.itemColourId } : {}) }, select: { workOrderSizeId: true, bomLineId: true, styleRevisionId: true } })
    : []
  const revisions = [...new Set(materials.map((row) => row.styleRevisionId))]
  const pieces = revisions.length
    ? await db.patternPiece.findMany({ where: { revisionId: { in: revisions }, bomLineId: { in: [...new Set(materials.map((row) => row.bomLineId))] } }, select: { revisionId: true, bomLineId: true, name: true, quantity: true, sizes: true, seq: true }, orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }] })
    : []
  return lines.map((line) => {
    const own = materials.filter((row) => row.workOrderSizeId === line.workOrderSizeId)
    const size = line.workOrderSize.size
    const linePieces = pieces.filter((piece) => own.some((row) => row.styleRevisionId === piece.revisionId && row.bomLineId === piece.bomLineId) && (piece.sizes.length === 0 || piece.sizes.includes(size)))
    return { size, ratio: line.ratio ?? 0, pieces: linePieces.map((piece) => ({ name: piece.name, quantity: piece.quantity })) }
  })
}

export const decimalText = (value: Prisma.Decimal | Decimal | null, scale = 4): string | null => (value === null ? null : new Dec(value.toString()).toFixed(scale))
