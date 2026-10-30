import type { FactoryClient, Prisma, Uom } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { partOf } from '@nexus/factory-domain/production/cutting/rules'
import { scrapByLot, type ScrapEntry, type ScrapShare } from '@nexus/factory-domain/production/scrap/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * Scrap and its replacement, the reads (B-W2a-13; MES-129, MES-130): replacement requests and their views, and what
 * leather a scrapped garment held, per lot and hide (factory-domain production/scrap/rules `scrapByLot`), with the cost
 * its hide's issue to the work order was valued at. Every read names its columns, selects no relation and runs as the
 * caller (office).
 */

export type Reader = FactoryClient | CommandTx

const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

export const REPLACEMENT_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  kind: true,
  quantity: true,
  part: true,
  sourceScanId: true,
  reworkOrderId: true,
  recordType: true,
  recordId: true,
  reason: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  decisionNote: true,
  cutLogId: true,
  doneAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ReplacementRequestSelect
export type ReplacementRow = Prisma.ReplacementRequestGetPayload<{ select: typeof REPLACEMENT_COLUMNS }>

export async function readReplacement(db: Reader, replacementId: string): Promise<ReplacementRow | null> {
  if (!isUuid(replacementId)) return null
  return db.replacementRequest.findUnique({ where: { id: replacementId }, select: REPLACEMENT_COLUMNS })
}

export async function lockReplacement(tx: CommandTx, replacementId: string): Promise<ReplacementRow | null> {
  if (!isUuid(replacementId)) return null
  await tx.$queryRaw`SELECT "id" FROM "ReplacementRequest" WHERE "id" = ${replacementId}::uuid FOR UPDATE`
  return readReplacement(tx, replacementId)
}

/** The cells of work orders with their colourway code and quantity. */
export async function readCellLabels(db: Reader, cellIds: readonly string[]) {
  const cells = cellIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { id: { in: [...cellIds] } }, select: { id: true, workOrderId: true, colourwayId: true, size: true, quantity: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return new Map(cells.map((cell) => [cell.id, { id: cell.id, workOrderId: cell.workOrderId, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size, quantity: cell.quantity }]))
}

export async function replacementViews(db: Reader, rows: readonly ReplacementRow[]) {
  if (rows.length === 0) return []
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true } })).map((row) => [row.id, row]))
  const cells = await readCellLabels(db, unique(rows.map((row) => row.workOrderSizeId)))
  const users = new Map((await db.user.findMany({ where: { id: { in: unique(rows.flatMap((row) => [row.createdById, row.decidedById])) } }, select: { id: true, displayName: true } })).map((row) => [row.id, { id: row.id, name: row.displayName }]))
  const at = (value: Date | null) => (value ? toUtcIso(value) : null)
  return rows.map((row) => {
    const cell = cells.get(row.workOrderSizeId)
    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      workOrder: { id: row.workOrderId, number: orders.get(row.workOrderId)?.number ?? '', status: orders.get(row.workOrderId)?.status ?? 'RELEASED' },
      cell: { id: row.workOrderSizeId, colourwayCode: cell?.colourwayCode ?? '', size: cell?.size ?? '', quantity: cell?.quantity ?? 0 },
      kind: row.kind,
      quantity: row.quantity,
      part: row.part,
      sourceScanId: row.sourceScanId,
      reworkOrderId: row.reworkOrderId,
      record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
      reason: row.reason,
      status: row.status,
      decidedAt: at(row.decidedAt),
      decidedBy: row.decidedById ? (users.get(row.decidedById) ?? null) : null,
      decisionNote: row.decisionNote,
      cutLogId: row.cutLogId,
      doneAt: at(row.doneAt),
      cancelledAt: at(row.cancelledAt),
      cancelReason: row.cancelReason,
      note: row.note,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      createdBy: row.createdById ? (users.get(row.createdById) ?? null) : null,
    }
  })
}
export type ReplacementView = Awaited<ReturnType<typeof replacementViews>>[number]

// ---- the leather in scrapped garments ---------------------------------------------------------------------------------------------

/** One material share of a scrap: the lot and hide, the area (base unit), and its value when the issue was valued. */
export interface ScrapMaterial {
  readonly lotId: string
  readonly lotCode: string
  readonly hideId: string
  readonly hideCode: string
  readonly itemId: string
  readonly uom: Uom
  readonly area: string
  /** Minor units of the company's currency at the issue's unit cost; null: the issue has no value yet. */
  readonly value: number | null
  readonly currency: string | null
}

interface BundleFacts {
  readonly id: string
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly part: string | null
  readonly cutLogIds: readonly string[]
}

/**
 * Per work order, what the scrap readers need once: its planned hide-cut rows (BOM need per cell, part and material,
 * wastage included), its cells' quantities, the cut log entries and pieces of its bundles, the hides and lots, and the
 * unit cost each hide's issue to it was valued at.
 */
export async function scrapFactsOf(db: Reader, workOrderId: string, bundles: readonly BundleFacts[]) {
  const materials = await db.workOrderMaterial.findMany({ where: { workOrderId }, select: { bomLineId: true, itemId: true, itemColourId: true, workOrderSizeId: true, baseQuantity: true } })
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(materials.map((row) => row.itemId)) }, tracking: 'HIDE' }, select: { id: true, code: true, baseUom: true } })).map((row) => [row.id, row]))
  const lines = new Map((await db.bomLine.findMany({ where: { id: { in: unique(materials.map((row) => row.bomLineId)) } }, select: { id: true, placement: true } })).map((row) => [row.id, row]))
  const planned = materials.flatMap((row) => {
    const item = items.get(row.itemId)
    return item ? [{ cellId: row.workOrderSizeId, itemId: row.itemId, itemColourId: row.itemColourId, part: partOf(lines.get(row.bomLineId)?.placement, item.code), need: new Dec(row.baseQuantity.toString()) }] : []
  })
  const cells = new Map((await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, quantity: true } })).map((row) => [row.id, row.quantity]))
  const entryIds = unique(bundles.flatMap((bundle) => bundle.cutLogIds))
  const entries = new Map((entryIds.length === 0 ? [] : await db.cutLog.findMany({ where: { id: { in: entryIds } }, select: { id: true, lotId: true, hideId: true, baseAreaUsed: true } })).map((row) => [row.id, row]))
  const pieces = entryIds.length === 0 ? [] : await db.cutLogPiece.findMany({ where: { cutLogId: { in: entryIds } }, select: { cutLogId: true, workOrderSizeId: true, part: true, pieces: true } })
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique([...entries.values()].map((entry) => entry.hideId)) } }, select: { id: true, code: true, itemId: true, lotId: true } })).map((row) => [row.id, row]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique([...hides.values()].map((hide) => hide.lotId)) } }, select: { id: true, code: true, itemColourId: true } })).map((row) => [row.id, row]))
  // The unit cost of each hide's leather: its issue to the work order as valued (Σ value / Σ quantity).
  const issues = await db.stockMove.findMany({ where: { workOrderId, reason: 'ISSUE', hideId: { in: [...hides.keys()] } }, select: { id: true, hideId: true } })
  const valuations = issues.length === 0 ? [] : await db.stockValuation.findMany({ where: { moveId: { in: issues.map((move) => move.id) } }, select: { moveId: true, quantity: true, valueAmount: true, currency: true } })
  const costs = new Map<string, { quantity: Decimal; value: number; currency: string }>()
  for (const valuation of valuations) {
    const hideId = issues.find((move) => move.id === valuation.moveId)?.hideId
    if (!hideId) continue
    const row = costs.get(hideId) ?? { quantity: ZERO, value: 0, currency: valuation.currency }
    costs.set(hideId, { quantity: row.quantity.plus(new Dec(valuation.quantity.toString()).abs()), value: row.value + Math.abs(valuation.valueAmount), currency: valuation.currency })
  }
  return { planned, items, cells, entries, pieces, hides, lots, costs }
}
export type ScrapFacts = Awaited<ReturnType<typeof scrapFactsOf>>

/** Shares of `scrapped` pieces over entries at each entry's own area per piece (area used / pieces cut), four places. */
function byPieces(facts: ScrapFacts, scrapped: number, entries: readonly ScrapEntry[]): ScrapShare[] {
  const total = entries.reduce((sum, entry) => sum + entry.garments, 0)
  if (scrapped <= 0 || total <= 0) return []
  const byHide = new Map<string, { lotId: string; hideId: string; area: Decimal }>()
  for (const entry of entries) {
    const cut = facts.pieces.filter((piece) => piece.cutLogId === entry.cutLogId).reduce((sum, piece) => sum + piece.pieces, 0)
    const used = facts.entries.get(entry.cutLogId)?.baseAreaUsed
    if (cut <= 0 || !used || entry.garments <= 0) continue
    const area = new Dec(used.toString()).div(cut).times(scrapped).times(entry.garments).div(total)
    const row = byHide.get(entry.hideId) ?? { lotId: entry.lotId, hideId: entry.hideId, area: ZERO }
    byHide.set(entry.hideId, { ...row, area: row.area.plus(area) })
  }
  return [...byHide.values()].map((row) => ({ lotId: row.lotId, hideId: row.hideId, area: row.area.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4) }))
}

/** The leather `scrapped` garments of the bundle held, per lot and hide, with values (cost) when the issues were valued. */
export function scrapMaterials(facts: ScrapFacts, bundle: BundleFacts, scrapped: number): ScrapMaterial[] {
  const cellQuantity = facts.cells.get(bundle.workOrderSizeId) ?? 0
  if (scrapped <= 0 || cellQuantity < 1) return []
  // Per material (the hide's item and the lot's colour), the entries of the bundle and the garments each cut for the cell.
  const groups = new Map<string, { itemId: string; itemColourId: string | null; entries: ScrapEntry[] }>()
  for (const entryId of bundle.cutLogIds) {
    const entry = facts.entries.get(entryId)
    const hide = entry ? facts.hides.get(entry.hideId) : undefined
    if (!entry || !hide) continue
    const colour = facts.lots.get(entry.lotId)?.itemColourId ?? null
    const parts = [...new Set(facts.planned.filter((row) => row.cellId === bundle.workOrderSizeId && row.itemId === hide.itemId && row.itemColourId === colour).map((row) => row.part))]
    const ofCell = facts.pieces.filter((piece) => piece.cutLogId === entryId && piece.workOrderSizeId === bundle.workOrderSizeId)
    const named = ofCell.filter((piece) => (bundle.part === null ? parts.includes(piece.part) : piece.part === bundle.part))
    // A part bundle whose part the entry names otherwise (another spelling): the entry's pieces of the cell.
    const mine = named.length > 0 || bundle.part === null ? named : ofCell
    const count = mine.reduce((sum, piece) => sum + piece.pieces, 0)
    const garments = bundle.part === null ? (parts.length > 0 ? count / parts.length : 0) : count
    const key = `${hide.itemId}|${colour ?? '-'}`
    const group = groups.get(key) ?? { itemId: hide.itemId, itemColourId: colour, entries: [] }
    group.entries.push({ cutLogId: entryId, lotId: entry.lotId, hideId: entry.hideId, garments })
    groups.set(key, group)
  }
  const out: ScrapMaterial[] = []
  for (const group of groups.values()) {
    const rows = facts.planned.filter((row) => row.cellId === bundle.workOrderSizeId && row.itemId === group.itemId && row.itemColourId === group.itemColourId && (bundle.part === null || row.part === bundle.part))
    const perGarment = rows.length === 0 ? null : rows.reduce((sum, row) => sum.plus(row.need), ZERO).div(cellQuantity)
    // A part the BOM does not name (a part bundle under another name): the area per piece its own entries cut.
    const shares: ScrapShare[] = perGarment !== null ? scrapByLot(scrapped, group.entries, perGarment.toString()) : byPieces(facts, scrapped, group.entries)
    for (const share of shares) {
      const cost = facts.costs.get(share.hideId)
      const value = cost && cost.quantity.gt(0) ? Number.parseInt(new Dec(share.area).times(cost.value).div(cost.quantity).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10) : null
      out.push({
        lotId: share.lotId,
        lotCode: facts.lots.get(share.lotId)?.code ?? '',
        hideId: share.hideId,
        hideCode: facts.hides.get(share.hideId)?.code ?? '',
        itemId: group.itemId,
        uom: facts.items.get(group.itemId)?.baseUom ?? ('FT2' as Uom),
        area: share.area,
        value,
        currency: value === null ? null : (cost?.currency ?? null),
      })
    }
  }
  return out
}
