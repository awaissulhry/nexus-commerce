import type { Prisma } from '@nexus/factory-db'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { replacesOwn, STATUS_WORDS, type SubstituteKind, type SubstitutionChange, type SubstitutionRefusal, type SubstitutionStatus } from '@nexus/factory-domain/inventory/substitutions/rules'
import type { AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'
import type { ItemUnits, Uom } from '@nexus/factory-domain/product/units/units'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { StockContext } from '../ledger/access'
import { sheetOf } from '../issue/kits'
import type { PickHeader, Reader } from '../issue/store'

/**
 * Substitutes with a yes (B-W2b-298; MES-139): the reads of MaterialSubstitution (B-W2b-277) and of the line facts an ask
 * needs. Every read names its columns and selects no relation (the same inside a command). No money; no person's name in a
 * list (who asked is "the office" or "the floor"; in one record, the office person's id).
 */

export const SUBSTITUTION_COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  styleRevisionId: true,
  bomLineId: true,
  fromItemId: true,
  toItemId: true,
  toItemColourId: true,
  toLotId: true,
  alternateId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  reasonCode: true,
  reason: true,
  ruleAnswer: true,
  approvalTaskId: true,
  status: true,
  requestedById: true,
  requestedByWorkerId: true,
  decidedAt: true,
  decidedById: true,
  refuseReason: true,
  issuedAt: true,
  moveIds: true,
  withdrawnAt: true,
  withdrawReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.MaterialSubstitutionSelect
export type SubstitutionRow = Prisma.MaterialSubstitutionGetPayload<{ select: typeof SUBSTITUTION_COLUMNS }>

export const kindOfRow = (row: Pick<SubstitutionRow, 'fromItemId' | 'toItemId'>): SubstituteKind => (row.fromItemId === row.toItemId ? 'OWN_MATERIAL' : 'ALTERNATE')

export async function readSubstitution(db: Reader, id: string): Promise<SubstitutionRow | null> {
  return isUuid(id) ? db.materialSubstitution.findUnique({ where: { id }, select: SUBSTITUTION_COLUMNS }) : null
}

/** The row held for this command (its status read under the lock): an ask, a decision, a withdrawal and an issue take turns. */
export async function lockSubstitution(tx: CommandTx, id: string): Promise<SubstitutionRow | null> {
  if (!isUuid(id)) return null
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM "MaterialSubstitution" WHERE id = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readSubstitution(tx, id)
}

/** A substitution refused by its rule: a 409 with `refusal/<CODE>` (the screens' words by the code). */
export class SubstitutionRefusedError extends ConflictError {
  override name = 'SubstitutionRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: SubstitutionRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

/** inventory.substitution_changed for a row as it stands now. */
export const changed = (tools: Pick<CommandTools, 'emit'>, row: SubstitutionRow, companyId: string, change: SubstitutionChange, status: string = row.status): void => {
  tools.emit({
    type: 'inventory.substitution_changed',
    subject: row.id,
    companyId,
    siteId: row.siteId,
    payload: {
      substitutionId: row.id,
      workOrderId: row.workOrderId,
      bomLineId: row.bomLineId,
      kind: row.fromItemId === row.toItemId ? 'OWN_MATERIAL' : 'ALTERNATE',
      fromItemId: row.fromItemId,
      toItemId: row.toItemId,
      toLotId: row.toLotId,
      status,
      change,
      approvalTaskId: row.approvalTaskId,
      moveIds: [...row.moveIds],
    },
  })
}

export function refuse(refusal: SubstitutionRefusal | null): void {
  if (refusal) throw new SubstitutionRefusedError(refusal)
}

const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const unique = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]

const ITEM_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  tracking: true,
  isPpeComponent: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
} as const satisfies Prisma.ItemSelect
export type SubstituteItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

export async function readItemsOf(db: Reader, ids: readonly string[]): Promise<Map<string, SubstituteItemRow>> {
  return byId(ids.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...ids] } }, select: ITEM_COLUMNS }))
}

export const unitsOf = (item: SubstituteItemRow): ItemUnits => ({
  baseUom: item.baseUom as Uom,
  purchaseUom: item.purchaseUom as Uom,
  purchaseFactor: item.purchaseFactor.toString(),
  consumptionUom: item.consumptionUom as Uom,
  consumptionFactor: item.consumptionFactor.toString(),
})

/**
 * What a list and a record show of a substitution (no money, no name). `requests`: read the state of its request for a yes (the
 * office; a floor session has no grant on the approval tables and reads `approval` as the task id only).
 */
export async function substitutionViews(db: Reader, rows: readonly SubstitutionRow[], options: { readonly requests?: boolean } = {}) {
  if (rows.length === 0) return []
  const workOrders = byId(await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true, companyId: true } }))
  const lines = byId(await db.bomLine.findMany({ where: { id: { in: unique(rows.map((row) => row.bomLineId)) } }, select: { id: true, seq: true, placement: true, qty: true, uom: true } }))
  const items = await readItemsOf(db, unique(rows.flatMap((row) => [row.fromItemId, row.toItemId])))
  const colours = byId(await db.itemColour.findMany({ where: { id: { in: unique(rows.map((row) => row.toItemColourId)) } }, select: { id: true, code: true, name: true } }))
  const lots = byId(await db.lot.findMany({ where: { id: { in: unique(rows.map((row) => row.toLotId)) } }, select: { id: true, code: true, qualityStatus: true } }))
  const alternates = byId(await db.bomLineAlternate.findMany({ where: { id: { in: unique(rows.map((row) => row.alternateId)) } }, select: { id: true, priority: true, allowedWhen: true, qty: true } }))
  const taskIds = unique(rows.map((row) => row.approvalTaskId))
  const tasks = byId(taskIds.length === 0 || options.requests === false ? [] : await db.approvalTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, status: true, dueAt: true } }))
  return rows.map((row) => {
    const own = items.get(row.fromItemId)
    const substitute = items.get(row.toItemId)
    const line = lines.get(row.bomLineId)
    const alternate = row.alternateId ? alternates.get(row.alternateId) : undefined
    const kind = kindOfRow(row)
    const replaces =
      own && substitute && line
        ? replacesOwn({ kind, lineQty: line.qty.toString(), lineUom: line.uom as Uom, ownUnits: unitsOf(own), alternateQty: alternate?.qty ? alternate.qty.toString() : null, substituteUnits: unitsOf(substitute) }, row.baseQuantity.toString())
        : null
    const lot = row.toLotId ? lots.get(row.toLotId) : undefined
    const colour = row.toItemColourId ? colours.get(row.toItemColourId) : undefined
    const task = row.approvalTaskId ? tasks.get(row.approvalTaskId) : undefined
    return {
      id: row.id,
      siteId: row.siteId,
      workOrder: { id: row.workOrderId, number: workOrders.get(row.workOrderId)?.number ?? '?', status: workOrders.get(row.workOrderId)?.status ?? 'DRAFT' },
      line: { id: row.bomLineId, seq: line?.seq ?? 0, placement: line?.placement ?? null, material: { id: row.fromItemId, code: own?.code ?? '?', name: own?.name ?? '', baseUom: own?.baseUom ?? 'PCS' } },
      kind,
      substitute: {
        item: { id: row.toItemId, code: substitute?.code ?? '?', name: substitute?.name ?? '', baseUom: substitute?.baseUom ?? 'PCS', tracking: substitute?.tracking ?? 'NONE', isPpeComponent: substitute?.isPpeComponent ?? false },
        colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
        lot: lot ? { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus } : null,
        alternate: alternate ? { id: alternate.id, priority: alternate.priority, allowedWhen: alternate.allowedWhen as AlternateUse } : null,
      },
      quantity: quantityText(row.quantity.toString()),
      uom: row.uom,
      baseQuantity: quantityText(row.baseQuantity.toString()),
      /** What it stands for of the line's own material (its base unit); null when a unit does not convert. */
      replaces: replaces === null ? null : { quantity: quantityText(replaces), uom: own?.baseUom ?? 'PCS' },
      reasonCode: row.reasonCode,
      reason: row.reason,
      ruleAnswer: row.ruleAnswer as { may: boolean; held: string[]; message: string },
      status: row.status as SubstitutionStatus,
      statusWords: STATUS_WORDS[row.status as SubstitutionStatus],
      approval: task ? { taskId: task.id, status: task.status, dueAt: task.dueAt ? toUtcIso(task.dueAt) : null } : row.approvalTaskId ? { taskId: row.approvalTaskId, status: 'UNKNOWN', dueAt: null } : null,
      asked: row.requestedByWorkerId ? ('FLOOR' as const) : ('OFFICE' as const),
      decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      refuseReason: row.refuseReason,
      issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null,
      moveIds: [...row.moveIds],
      withdrawnAt: row.withdrawnAt ? toUtcIso(row.withdrawnAt) : null,
      withdrawReason: row.withdrawReason,
      note: row.note,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}
export type SubstitutionView = Awaited<ReturnType<typeof substitutionViews>>[number]

/** One BOM line of a work order as the pick list sees it: its need, what is issued, still to issue, and what no stock covers. */
export interface LineFacts {
  readonly bomLineId: string
  readonly seq: number
  readonly placement: string | null
  readonly qty: string
  readonly uom: Uom
  readonly itemId: string
  /** The colours the work order plans of the line's material (one per colourway at most). */
  readonly colourIds: readonly (string | null)[]
  readonly planned: string
  readonly issued: string
  readonly toIssue: string
  /** What neither the work order's reservations nor the free stock covers of what it still needs (the line's share). */
  readonly short: string
}

/**
 * The facts of one BOM line of a work order (null: not a line of the work order's revision): its quantity per garment, and
 * from the pick list (issue/kits sheetOf: reservations, the free stock oldest first, quality holds) what it still needs and
 * what nothing covers. A material on several lines: each line keeps its own rows; the short part is shared up to the line's.
 */
export async function lineFactsOf(db: Reader, context: StockContext, header: PickHeader, revisionId: string, bomLineId: string): Promise<LineFacts | null> {
  const line = isUuid(bomLineId) ? await db.bomLine.findFirst({ where: { id: bomLineId, revisionId }, select: { id: true, seq: true, placement: true, qty: true, uom: true, itemId: true } }) : null
  if (!line) return null
  const sheet = await sheetOf(db, context, header)
  let planned = ZERO
  let issued = ZERO
  let toIssue = ZERO
  let short = ZERO
  const colourIds: (string | null)[] = []
  for (const pick of sheet.lines) {
    const rows = pick.rows.filter((row) => row.bomLineId === line.id)
    if (rows.length === 0) continue
    colourIds.push(pick.itemColourId)
    const mine = rows.reduce((sum, row) => sum.plus(new Dec(row.toIssue)), ZERO)
    planned = planned.plus(rows.reduce((sum, row) => sum.plus(new Dec(row.planned)), ZERO))
    issued = issued.plus(rows.reduce((sum, row) => sum.plus(new Dec(row.issued)), ZERO))
    toIssue = toIssue.plus(mine)
    short = short.plus(Dec.min(mine, dec(pick.pick.short)))
  }
  return {
    bomLineId: line.id,
    seq: line.seq,
    placement: line.placement,
    qty: line.qty.toString(),
    uom: line.uom as Uom,
    itemId: line.itemId,
    colourIds,
    planned: quantityText(planned),
    issued: quantityText(issued),
    toIssue: quantityText(toIssue),
    short: quantityText(short),
  }
}

/** The work order's revision (the key of its BOM lines). */
export async function revisionOf(db: Reader, workOrderId: string): Promise<string | null> {
  return (await db.workOrder.findUnique({ where: { id: workOrderId }, select: { styleRevisionId: true } }))?.styleRevisionId ?? null
}
