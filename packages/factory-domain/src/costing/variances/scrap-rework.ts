import type { Decimal } from 'decimal.js'
import { toMinorUnits } from '../../core/money'
import { decimalOf, decimalText, QUANTITY_SCALE, roundTo } from '../../product/units/units'

/**
 * The cost of scrap and rework of one work order, per reason (B-W2b-411; FIN-029; design production.workorders "Labour &
 * cost", production.scrap "Scrap and rework"), pure:
 *
 *   scrapped garments   garments scrapped at an operation (the scan's scrap reason) or in a rework (the rework's reason):
 *                       how many, and the value of their material (the ledger's scrap records: the leather at the issue's
 *                       value per base unit; their material was charged at the issue)
 *   scrapped material   material scrapped from stock for the work order (its SCRAP moves, the move's reason): its value
 *   rework minutes      the garments of each DONE rework × the standard minutes of the operation it was redone at, priced
 *                       at the cost per minute of that operation's kind of work centre in force on the day it was done
 *                       (null when no rate is in force): rework time is not posted to the work order's ledger, so this is
 *                       the read's own figure (UNVERIFIED, GATE-ACCOUNTANT)
 * Never per person: per work order and reason only. Amounts are minor units of the company's currency, each rounded once.
 */

/** The reason a scrap or rework without a code is shown under. */
export const NO_REASON = 'NO_REASON'

export interface ScrapFact {
  /** SCAN: scrapped at an operation; REWORK: scrapped in a rework; STOCK: material scrapped from stock for the work order. */
  readonly source: 'SCAN' | 'REWORK' | 'STOCK'
  /** The scrap source's own id (scan, rework order, stock move): garments are counted once per source. */
  readonly sourceId: string
  readonly reasonCode: string | null
  /** Garments (SCAN, REWORK); 0 for STOCK. */
  readonly garments: number
  /** The value lost, minor units (a scrap record: base quantity × the issue's unit cost; STOCK: the entry's amount). */
  readonly value: number
}

export interface ReworkFact {
  readonly reworkId: string
  readonly reasonCode: string | null
  readonly garments: number
  /** The standard minutes per garment of the operation it was redone at. */
  readonly minutesPerGarment: string
  /** The cost per minute in force (null: none). */
  readonly perMinute: string | null
}

export interface ScrapReworkRow {
  readonly reasonCode: string
  readonly scrappedGarments: number
  readonly scrapValue: number
  readonly stockScrapValue: number
  readonly reworkGarments: number
  readonly reworkMinutes: string
  /** Null when a rework of the reason has no cost per minute in force. */
  readonly reworkCost: number | null
  /** scrapValue + stockScrapValue + reworkCost (null when the rework cost is). */
  readonly total: number | null
}

export interface ScrapRework {
  readonly rows: readonly ScrapReworkRow[]
  readonly totals: Omit<ScrapReworkRow, 'reasonCode'>
}

const minutesText = (value: Decimal): string => decimalText(roundTo(value, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }))

/** Scrap and rework per reason, the reasons in code order, and their totals. */
export function scrapAndRework(scraps: readonly ScrapFact[], reworks: readonly ReworkFact[], currency: string): ScrapRework {
  interface Acc {
    garments: Map<string, number>
    scrapValue: number
    stockScrapValue: number
    reworkGarments: number
    reworkMinutes: Decimal
    reworkCost: Decimal | null
  }
  const byReason = new Map<string, Acc>()
  const accOf = (code: string | null): Acc => {
    const key = code ?? NO_REASON
    let acc = byReason.get(key)
    if (!acc) {
      acc = { garments: new Map(), scrapValue: 0, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: decimalOf('0'), reworkCost: decimalOf('0') }
      byReason.set(key, acc)
    }
    return acc
  }
  for (const scrap of scraps) {
    const acc = accOf(scrap.reasonCode)
    if (scrap.source === 'STOCK') {
      acc.stockScrapValue += scrap.value
      continue
    }
    acc.scrapValue += scrap.value
    acc.garments.set(`${scrap.source}:${scrap.sourceId}`, scrap.garments)
  }
  for (const rework of reworks) {
    const acc = accOf(rework.reasonCode)
    const minutes = decimalOf(rework.minutesPerGarment).times(rework.garments)
    acc.reworkGarments += rework.garments
    acc.reworkMinutes = acc.reworkMinutes.plus(minutes)
    acc.reworkCost = acc.reworkCost === null || rework.perMinute === null ? (minutes.isZero() ? acc.reworkCost : null) : acc.reworkCost.plus(minutes.times(decimalOf(rework.perMinute)))
  }
  const minor = (value: Decimal): number => toMinorUnits(value.toFixed(), currency)
  const rows: ScrapReworkRow[] = [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reasonCode, acc]) => {
      const reworkCost = acc.reworkCost === null ? null : minor(acc.reworkCost)
      return {
        reasonCode,
        scrappedGarments: [...acc.garments.values()].reduce((sum, value) => sum + value, 0),
        scrapValue: acc.scrapValue,
        stockScrapValue: acc.stockScrapValue,
        reworkGarments: acc.reworkGarments,
        reworkMinutes: minutesText(acc.reworkMinutes),
        reworkCost,
        total: reworkCost === null ? null : acc.scrapValue + acc.stockScrapValue + reworkCost,
      }
    })
  const reworkCosts = rows.map((row) => row.reworkCost)
  const reworkCost = reworkCosts.some((value) => value === null) ? null : reworkCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  const scrapValue = rows.reduce((sum, row) => sum + row.scrapValue, 0)
  const stockScrapValue = rows.reduce((sum, row) => sum + row.stockScrapValue, 0)
  return {
    rows,
    totals: {
      scrappedGarments: rows.reduce((sum, row) => sum + row.scrappedGarments, 0),
      scrapValue,
      stockScrapValue,
      reworkGarments: rows.reduce((sum, row) => sum + row.reworkGarments, 0),
      reworkMinutes: minutesText(rows.reduce((sum, row) => sum.plus(decimalOf(row.reworkMinutes)), decimalOf('0'))),
      reworkCost,
      total: reworkCost === null ? null : scrapValue + stockScrapValue + reworkCost,
    },
  }
}

/** A scrap record's value: its base quantity × the issue's unit cost per base unit, minor units, rounded once (0 without one). */
export function recordValue(quantity: string | null, unitCost: string | null, currency: string): number {
  if (quantity === null || unitCost === null) return 0
  const value = toMinorUnits(decimalOf(quantity).times(decimalOf(unitCost)).toFixed(), currency)
  return value === 0 ? 0 : value
}
