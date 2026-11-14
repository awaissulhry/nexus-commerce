import type { Prisma } from '@nexus/factory-db'
import type { CloseRecordView, SplitView } from '@nexus/factory-domain/costing/close/contracts'
import { beyondOf, CLOSE_REASON_WORDS, mayUndo, undoUntil, type CloseFigures, type CloseReason } from '@nexus/factory-domain/costing/close/rules'
import { VARIANCE_CATEGORY_WORDS, type Split, type VarianceCategory } from '@nexus/factory-domain/costing/variances/split'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { peopleNames } from '../../accounting/store'
import { textOrNull, unique, type Reader } from '../actual/store'

/**
 * The close's rows as the API answers them (B-W2b-411): a close record (its figures, the tolerance, which figures were
 * beyond it, the reason in words, who closed, undid or reopened it — office users, inside the one record — whether its
 * cost is settled and whether the caller may still undo or reopen it), and a variance split's lines with their materials.
 * Every amount money.cost. Reads only.
 */

export const CLOSE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  plannedQuantity: true,
  actualQuantity: true,
  plannedScrapQuantity: true,
  scrapQuantity: true,
  plannedMaterialCost: true,
  actualMaterialCost: true,
  plannedMinutes: true,
  actualMinutes: true,
  currency: true,
  tolerancePct: true,
  reasonCode: true,
  reasonNote: true,
  closedAt: true,
  closedById: true,
  undoneAt: true,
  undoneById: true,
  reopenReason: true,
  version: true,
} as const satisfies Prisma.WorkOrderCloseSelect
export type CloseRow = Prisma.WorkOrderCloseGetPayload<{ select: typeof CLOSE_COLUMNS }>

export const VARIANCE_COLUMNS = {
  id: true,
  closeId: true,
  workOrderId: true,
  companyId: true,
  siteId: true,
  category: true,
  itemId: true,
  standardQuantity: true,
  actualQuantity: true,
  standardUnitCost: true,
  actualUnitCost: true,
  amount: true,
  currency: true,
  note: true,
} as const satisfies Prisma.WorkOrderVarianceSelect
export type VarianceRow = Prisma.WorkOrderVarianceGetPayload<{ select: typeof VARIANCE_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())

export const figuresOf = (row: CloseRow): CloseFigures => ({
  plannedQuantity: row.plannedQuantity,
  actualQuantity: row.actualQuantity,
  plannedScrapQuantity: row.plannedScrapQuantity,
  scrapQuantity: row.scrapQuantity,
  plannedMaterialCost: row.plannedMaterialCost,
  actualMaterialCost: row.actualMaterialCost,
  plannedMinutes: text(row.plannedMinutes),
  actualMinutes: text(row.actualMinutes),
})

export const figuresView = (figures: CloseFigures, currency: string) => ({
  ...figures,
  plannedMaterialCost: asMoney('cost', figures.plannedMaterialCost),
  actualMaterialCost: asMoney('cost', figures.actualMaterialCost),
  currency,
})

export async function itemsOf(db: Reader, ids: readonly (string | null)[]) {
  const wanted = unique(ids)
  if (wanted.length === 0) return new Map<string, { id: string; code: string; name: string; baseUom: string }>()
  return new Map((await db.item.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, name: true, baseUom: true } })).map((item) => [item.id, item]))
}
type Items = Awaited<ReturnType<typeof itemsOf>>

const itemView = (items: Items, itemId: string | null) => {
  const item = itemId ? items.get(itemId) : undefined
  return item ? { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom as never } : null
}

/** The close's live CLOSE entries (not reversed): a close with one is settled. */
export async function settledCloses(db: Reader, closeIds: readonly string[]): Promise<Set<string>> {
  if (closeIds.length === 0) return new Set()
  const rows = await db.workOrderCostEntry.findMany({ where: { kind: 'CLOSE', sourceType: 'WorkOrderClose', sourceId: { in: [...closeIds] }, reversalOfId: null }, select: { id: true, sourceId: true } })
  const reversed = new Set((await db.workOrderCostEntry.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId))
  return new Set(rows.filter((row) => !reversed.has(row.id)).map((row) => row.sourceId!))
}

/** One close record for a caller (actorId: who asks; mayReopen: the caller holds workorders.reopen on it). */
export async function closeRecordViews(
  db: Reader,
  rows: readonly CloseRow[],
  caller: { readonly actorId: string; readonly mayManage: boolean; readonly mayReopen: boolean; readonly now: Date },
): Promise<CloseRecordView[]> {
  const names = await peopleNames(db, rows.flatMap((row) => [row.closedById, row.undoneById]))
  const settled = await settledCloses(db, rows.map((row) => row.id))
  return rows.map((row) => {
    const figures = figuresOf(row)
    const tolerancePct = text(row.tolerancePct)
    const live = row.undoneAt === null
    const undo = live && caller.mayManage && mayUndo(row, caller.actorId, caller.now)
    return {
      id: row.id,
      workOrderId: row.workOrderId,
      figures: figuresView(figures, row.currency),
      tolerancePct,
      beyond: beyondOf(figures, tolerancePct),
      reasonCode: row.reasonCode,
      reasonWords: row.reasonCode ? (CLOSE_REASON_WORDS[row.reasonCode as CloseReason] ?? null) : null,
      reasonNote: row.reasonNote,
      closedAt: toUtcIso(row.closedAt),
      closedBy: { id: row.closedById, name: names.get(row.closedById) ?? '' },
      undoneAt: row.undoneAt ? toUtcIso(row.undoneAt) : null,
      undoneBy: row.undoneById ? { id: row.undoneById, name: names.get(row.undoneById) ?? '' } : null,
      reopenReason: row.reopenReason,
      live,
      settled: settled.has(row.id),
      undoUntil: undo ? toUtcIso(undoUntil(row.closedAt)) : null,
      can: { undo, reopen: live && caller.mayReopen },
    }
  })
}

/** A written variance line as the screens read it. */
export function varianceLineOf(row: VarianceRow, items: Items) {
  return {
    id: row.id,
    category: row.category,
    categoryWords: VARIANCE_CATEGORY_WORDS[row.category as VarianceCategory],
    item: itemView(items, row.itemId),
    standardQuantity: textOrNull(row.standardQuantity),
    actualQuantity: textOrNull(row.actualQuantity),
    standardUnitCost: asMoney('cost', textOrNull(row.standardUnitCost)),
    actualUnitCost: asMoney('cost', textOrNull(row.actualUnitCost)),
    amount: asMoney('cost', row.amount),
    note: row.note,
  }
}

/** A split (written or previewed) in words and with its materials. */
export function splitViewOf(split: Split, items: Items, written: readonly { readonly id: string }[] | null = null): SplitView {
  const words =
    split.basis === null
      ? split.notSplit[0]!.words
      : `Against the ${split.basis === 'STANDARD' ? 'frozen standard' : 'estimate at release'} of the garments made. The closing entry takes off what the lines leave (hand adjustments, the value moved to stock against the standard, rounding). UNVERIFIED with the accountant (GATE-ACCOUNTANT).`
  return {
    basis: split.basis,
    lines: split.lines.map((line, index) => ({
      id: written?.[index]?.id ?? null,
      category: line.category,
      categoryWords: VARIANCE_CATEGORY_WORDS[line.category],
      item: itemView(items, line.itemId),
      standardQuantity: line.standardQuantity,
      actualQuantity: line.actualQuantity,
      standardUnitCost: asMoney('cost', line.standardUnitCost),
      actualUnitCost: asMoney('cost', line.actualUnitCost),
      amount: asMoney('cost', line.amount),
      note: line.note,
    })),
    balance: asMoney('cost', split.balance),
    explained: asMoney('cost', split.explained),
    closing: asMoney('cost', split.closing),
    notSplit: [...split.notSplit],
    words,
  }
}
