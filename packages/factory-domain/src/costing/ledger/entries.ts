import type { Decimal } from 'decimal.js'
import { fromMinorUnits, toMinorUnits } from '../../core/money'
import { businessDate, type BusinessDate } from '../../core/time'
import { COST_SCALE, decimalOf, decimalText, QUANTITY_SCALE, roundTo } from '../../product/units/units'

/**
 * The work-order cost ledger (B-W2a-21; FIN-026, FIN-027, FIN-038; design finance.costing "Cost ledger"), pure: what one
 * valuation event of a work order posts. factory-db's WorkOrderCostEntry keeps the entries, append-only for every login
 * (the …_money_w2a_guards triggers); apps/factory-api's modules/costing/actual posts them, one entry per source event,
 * with the event's key, so a repeat never posts twice.
 *
 *   MATERIAL     an ISSUE to the work order (+ its base quantity, + the issue's stock value) or a RETURN from it (−, −)
 *   SCRAP        a SCRAP move of the work order's material from stock: + its stock value (the work order bears the loss);
 *                garments scrapped at an operation (a scan) or in a rework: a record of the loss, amount 0 — their
 *                material was charged at the issue — with the leather's area and its value per base unit at the issue
 *   LABOUR       a standing scan's good garments × the operation's standard minutes, at the cost per minute of its kind of
 *                work centre in force that day ÷ (planned efficiency ÷ 100): per work order, never per person
 *   COMPLETION   garments into finished goods (a PRODUCTION_RECEIPT): − its stock value (the value leaves the work order)
 *   OVERHEAD     applied with a MATERIAL, stock SCRAP or LABOUR entry at the company's overhead % (when above 0)
 *   SUBCONTRACT  posted by the subcontracting steps (B-W2a-25, B-W2a-62) through the same writer
 *   ADJUSTMENT   a correction in words (not posted here)
 * A mistake, a stock move reversed, a scan undone or corrected: a reversal (the same kind, the opposite amount and
 * quantity, a reason), never an edit. Amounts are minor units of the company's currency, one rounding each.
 */

export const COST_ENTRY_KINDS = ['MATERIAL', 'SCRAP', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'COMPLETION', 'ADJUSTMENT'] as const
export type CostEntryKind = (typeof COST_ENTRY_KINDS)[number]

/** The costing method of a company (c.c. art. 2426): the accountant's choice; UNDECIDED until it is given. */
export const COSTING_METHODS = ['UNDECIDED', 'STANDARD', 'MOVING_AVERAGE', 'FIFO'] as const
export type CostingMethod = (typeof COSTING_METHODS)[number]
export const DECIDED_METHODS = ['STANDARD', 'MOVING_AVERAGE', 'FIFO'] as const

/** An entry under UNDECIDED is provisional: computed, never relied on, until the accountant chooses the method. */
export const isProvisional = (method: CostingMethod): boolean => method === 'UNDECIDED'

/** The method in words, for the screens (the costing method's card and every cost read). */
export function methodWords(method: CostingMethod, lockedAt: BusinessDate | null): string {
  if (method === 'UNDECIDED') {
    return 'The costing method is not chosen yet (the accountant decides: standard, moving average or FIFO). Every cost here is provisional and is not relied on until then.'
  }
  const name = { STANDARD: 'standard cost', MOVING_AVERAGE: 'moving average', FIFO: 'FIFO' }[method]
  return lockedAt === null
    ? `The costing method is ${name}. It locks with the first cost entry posted under it.`
    : `The costing method is ${name}, locked since ${lockedAt}: cost entries rely on it, and changing it would revalue them.`
}

/** The keys: one entry per source event (the unique key of the ledger). */
export const entryKeys = {
  move: (moveId: string) => `move:${moveId}`,
  scan: (scanId: string) => `scan:${scanId}`,
  scanScrap: (scanId: string, itemId: string) => `scan-scrap:${scanId}:${itemId}`,
  reworkScrap: (reworkId: string, itemId: string) => `rework-scrap:${reworkId}:${itemId}`,
  overhead: (entryId: string) => `overhead:${entryId}`,
  reversal: (entryId: string) => `reverse:${entryId}`,
} as const

const COST_ROUND = { scale: COST_SCALE, rounding: 'HALF_UP' } as const
const QUANTITY_ROUND = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' } as const
const text = (value: Decimal | string): string => decimalText(value)
const quantityText = (value: Decimal | string): string => decimalText(roundTo(value, QUANTITY_ROUND))
const costText = (value: Decimal | string): string => decimalText(roundTo(value, COST_ROUND))

/** One entry to post: the ledger row less what the writer adds (ids of the company, site, method, who, when). */
export interface EntryDraft {
  readonly id: string
  readonly kind: CostEntryKind
  readonly occurredAt: Date
  readonly itemId: string | null
  /** Base units, signed as the amount (4 places). */
  readonly quantity: string | null
  /** LABOUR: standard minutes earned (4 places). */
  readonly minutes: string | null
  /** Per base unit or per minute (6 places). */
  readonly unitCost: string | null
  readonly standardUnitCost: string | null
  readonly standardCostId: string | null
  /** Minor units: + onto the work order, − off it. */
  readonly amount: number
  readonly stockMoveId: string | null
  readonly operationScanId: string | null
  readonly subcontractOrderId: string | null
  readonly supplierInvoiceLineId: string | null
  readonly sourceType: string | null
  readonly sourceId: string | null
  readonly reversalOfId: string | null
  readonly reason: string | null
  readonly idempotencyKey: string
}

const BLANK = {
  itemId: null,
  quantity: null,
  minutes: null,
  unitCost: null,
  standardUnitCost: null,
  standardCostId: null,
  stockMoveId: null,
  operationScanId: null,
  subcontractOrderId: null,
  supplierInvoiceLineId: null,
  sourceType: null,
  sourceId: null,
  reversalOfId: null,
  reason: null,
} as const

/** A stock move of the work order as the ledger reads it, with its value (StockValuation). */
export interface ValuedMoveFacts {
  readonly id: string
  readonly reason: 'ISSUE' | 'RETURN' | 'SCRAP' | 'PRODUCTION_RECEIPT'
  readonly itemId: string
  readonly baseQuantity: string
  readonly occurredAt: Date
  /** The move's stock value: signed like its stock effect (− out of stock, + into it). */
  readonly valueAmount: number
  readonly unitCost: string
}

/** The standard it is compared with (the frozen standard of the item on the day), if any. */
export interface StandardRef {
  readonly id: string
  readonly unitCost: string
}

/**
 * The entry a valued stock move of the work order posts: MATERIAL for an issue or a return, SCRAP for material scrapped
 * from stock, COMPLETION for garments into finished goods. The amount is the opposite of the move's stock value (what
 * leaves stock comes onto the work order, and the other way round); the quantity is signed like the amount.
 */
export function moveEntry(id: string, move: ValuedMoveFacts, standard: StandardRef | null): EntryDraft {
  const base = decimalOf(move.baseQuantity)
  const kind: CostEntryKind = move.reason === 'ISSUE' || move.reason === 'RETURN' ? 'MATERIAL' : move.reason === 'SCRAP' ? 'SCRAP' : 'COMPLETION'
  const into = move.reason === 'RETURN' || move.reason === 'PRODUCTION_RECEIPT'
  return {
    ...BLANK,
    id,
    kind,
    occurredAt: move.occurredAt,
    itemId: move.itemId,
    quantity: quantityText(into ? base.negated() : base),
    unitCost: costText(move.unitCost),
    standardUnitCost: standard ? costText(standard.unitCost) : null,
    standardCostId: standard?.id ?? null,
    amount: move.valueAmount === 0 ? 0 : -move.valueAmount,
    stockMoveId: move.id,
    idempotencyKey: entryKeys.move(move.id),
  }
}

/** The cost of one standard minute at a rate: cost per minute ÷ (planned efficiency ÷ 100), 6 places; null when unusable. */
export function perMinuteOf(rate: { readonly costPerMinute: string; readonly plannedEfficiencyPct: string }): string | null {
  const efficiency = decimalOf(rate.plannedEfficiencyPct)
  if (!efficiency.gt(0)) return null
  return costText(decimalOf(rate.costPerMinute).times(100).div(efficiency))
}

/** A scan as the ledger reads it. */
export interface ScanFacts {
  readonly id: string
  readonly goodQuantity: number
  readonly serverTime: Date
}

/** LABOUR: the scan's good garments × the operation's standard minutes, at `perMinute` (one rounding to minor units). */
export function labourEntry(id: string, scan: ScanFacts, standardMinutes: string, perMinute: string, currency: string): EntryDraft {
  const minutes = decimalOf(standardMinutes).times(scan.goodQuantity)
  return {
    ...BLANK,
    id,
    kind: 'LABOUR',
    occurredAt: scan.serverTime,
    minutes: quantityText(minutes),
    unitCost: costText(perMinute),
    amount: toMinorUnits(decimalOf(quantityText(minutes)).times(decimalOf(perMinute)).toFixed(), currency),
    operationScanId: scan.id,
    idempotencyKey: entryKeys.scan(scan.id),
  }
}

/** One material share of scrapped garments: the leather's area and its value at the issue (null: the issue has no value). */
export interface ScrapShare {
  readonly itemId: string
  readonly area: string
  readonly value: number | null
}

/**
 * The record of garments scrapped at an operation or in a rework, per material: amount 0 (the material was charged when
 * it was issued), the area lost, its value per base unit at the issue (when every share's issue was valued) and the
 * material's standard. One entry per material.
 */
export function scrapRecords(
  ids: () => string,
  shares: readonly ScrapShare[],
  base: {
    readonly occurredAt: Date
    readonly operationScanId: string
    readonly key: (itemId: string) => string
    readonly sourceType?: string
    readonly sourceId?: string
    readonly reason: string
    readonly currency: string
  },
  standardOf: (itemId: string) => StandardRef | null,
): EntryDraft[] {
  const byItem = new Map<string, { area: Decimal; value: number; valued: boolean }>()
  for (const share of shares) {
    const row = byItem.get(share.itemId) ?? { area: decimalOf('0'), value: 0, valued: true }
    byItem.set(share.itemId, { area: row.area.plus(decimalOf(share.area)), value: row.value + (share.value ?? 0), valued: row.valued && share.value !== null })
  }
  return [...byItem.entries()]
    .filter(([, row]) => row.area.gt(0))
    .map(([itemId, row]) => {
      const standard = standardOf(itemId)
      return {
        ...BLANK,
        id: ids(),
        kind: 'SCRAP' as const,
        occurredAt: base.occurredAt,
        itemId,
        quantity: quantityText(row.area),
        unitCost: row.valued ? costText(decimalOf(fromMinorUnits(row.value, base.currency).toFixed()).div(row.area)) : null,
        standardUnitCost: standard ? costText(standard.unitCost) : null,
        standardCostId: standard?.id ?? null,
        amount: 0,
        operationScanId: base.operationScanId,
        sourceType: base.sourceType ?? null,
        sourceId: base.sourceId ?? null,
        reason: base.reason,
        idempotencyKey: base.key(itemId),
      }
    })
}

/** A posted entry as the reversal needs it. */
export interface PostedEntryFacts {
  readonly id: string
  readonly kind: CostEntryKind
  readonly itemId: string | null
  readonly quantity: string | null
  readonly minutes: string | null
  readonly unitCost: string | null
  readonly standardUnitCost: string | null
  readonly standardCostId: string | null
  readonly amount: number
}

/** An exact amount already in minor units, rounded once half up (away from zero) to a whole number. */
export const minorOf = (value: Decimal): number => {
  const rounded = Number.parseInt(roundTo(value, { scale: 0, rounding: 'HALF_UP' }).toFixed(0), 10)
  return rounded === 0 ? 0 : rounded
}

const negated = (value: string | null): string | null => (value === null ? null : text(decimalOf(value).negated()))

/** The reversal of an entry: the same kind, the opposite amount, quantity and minutes, with its reason and key. */
export function reversalEntry(
  id: string,
  entry: PostedEntryFacts,
  at: Date,
  reason: string,
  source: { readonly key: string; readonly stockMoveId?: string | null; readonly operationScanId?: string | null; readonly sourceType?: string | null; readonly sourceId?: string | null } = { key: entryKeys.reversal(entry.id) },
): EntryDraft {
  return {
    ...BLANK,
    id,
    kind: entry.kind,
    occurredAt: at,
    itemId: entry.itemId,
    quantity: negated(entry.quantity),
    minutes: negated(entry.minutes),
    unitCost: entry.unitCost,
    standardUnitCost: entry.standardUnitCost,
    standardCostId: entry.standardCostId,
    amount: entry.amount === 0 ? 0 : -entry.amount,
    stockMoveId: source.stockMoveId ?? null,
    operationScanId: source.operationScanId ?? null,
    sourceType: source.sourceType ?? null,
    sourceId: source.sourceId ?? null,
    reversalOfId: entry.id,
    reason,
    idempotencyKey: source.key,
  }
}

/** The kinds overhead is applied with (never a record of scrapped garments, a completion or an adjustment). */
export const OVERHEAD_BASE_KINDS: readonly CostEntryKind[] = ['MATERIAL', 'SCRAP', 'LABOUR']

/** OVERHEAD applied with an entry at `pct` (percent, above 0): the entry's amount × pct ÷ 100, one rounding; null when 0. */
export function overheadEntry(id: string, entry: Pick<EntryDraft, 'id' | 'kind' | 'amount' | 'occurredAt'>, pct: string): EntryDraft | null {
  if (!OVERHEAD_BASE_KINDS.includes(entry.kind) || entry.amount === 0 || !decimalOf(pct).gt(0)) return null
  const amount = minorOf(decimalOf(String(entry.amount)).times(decimalOf(pct)).div(100))
  if (amount === 0) return null
  return {
    ...BLANK,
    id,
    kind: 'OVERHEAD',
    occurredAt: entry.occurredAt,
    unitCost: costText(pct),
    amount,
    sourceType: 'WorkOrderCostEntry',
    sourceId: entry.id,
    reason: `Overhead ${decimalText(pct)} % applied`,
    idempotencyKey: entryKeys.overhead(entry.id),
  }
}

/** A period lock as the dating needs it (whole Europe/Rome days). */
export interface LockedPeriod {
  readonly periodStart: BusinessDate
  readonly periodEnd: BusinessDate
}

const lockOf = (locks: readonly LockedPeriod[], day: BusinessDate): LockedPeriod | null => locks.find((lock) => lock.periodStart <= day && day <= lock.periodEnd) ?? null

/**
 * When an entry is dated: its event's time, or now when that day is inside a locked period (a late event of a closed
 * month is posted in the open one, and says so); null when today is locked too (it waits).
 */
export function datedFor(occurredAt: Date, now: Date, locks: readonly LockedPeriod[]): { readonly at: Date; readonly note: string | null } | null {
  const lock = lockOf(locks, businessDate(occurredAt))
  if (lock === null) return { at: occurredAt, note: null }
  if (lockOf(locks, businessDate(now)) !== null) return null
  return { at: now, note: `Dated ${businessDate(now)}: ${businessDate(occurredAt)} is in the locked period ${lock.periodStart} to ${lock.periodEnd}.` }
}
