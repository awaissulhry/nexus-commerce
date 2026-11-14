import { Decimal } from 'decimal.js'
import type { WorkCentreKind } from '../../product/routing/operations'
import type { Uom } from '../../product/units/units'
import { decimalText } from '../../product/units/units'
import type { LineSource, SheetCategory } from '../sheet-components/components'
import { lineCost, six } from '../sheet-components/rules'

/**
 * What-if on a cost sheet version (B-W2b-420; FIN-014 "what-if (leather +10%)"), pure: the version's lines with some costs
 * moved by a percent, and the lines that read a percent of them following.
 *
 *   a change      a percent (−99.9999 to +1000) on every line of a category, on the lines of one material (not the freight
 *                 or duty on it: they follow), or on one line; the most specific wins on a line (a line before its material
 *                 before its category)
 *   plain lines   their unit cost moves by the percent (6 places, half up); the quantity stays
 *   percent lines overhead on labour, freight and duty on materials, the costing settings' overhead: their percent (moved by a
 *                 change aimed at them) of their base now — the base is what B-W2b-418 took it on: labour of the line's kind
 *                 (every kind when it names none) for an overhead rule; materials, leather, labour and the BOM's packaging
 *                 for the settings' percent; the material it names, or the materials of the kind its uplift covers, for
 *                 freight and duty. A typed percent line has no known base: it keeps its amount (only a change aimed at it
 *                 moves it, by the same ratio as its percent).
 *   sizes         a line for every size whose new figure differs by size is written once per size
 *
 * Nothing is written: the API shows the result beside the version, or saves it as a new DRAFT version.
 */

export const WHAT_IF_TARGETS = ['CATEGORY', 'ITEM', 'LINE'] as const
export type WhatIfTarget = (typeof WHAT_IF_TARGETS)[number]

export interface WhatIfChange {
  readonly target: WhatIfTarget
  readonly category?: SheetCategory | null | undefined
  readonly itemId?: string | null | undefined
  readonly lineId?: string | null | undefined
  /** A percent with up to 4 decimals, −99.9999 to 1000. */
  readonly pct: string
}

export interface WhatIfLine {
  readonly id: string
  readonly seq: number
  readonly category: SheetCategory
  readonly source: LineSource
  readonly sourceRecordType: string | null
  readonly sourceRecordId: string | null
  readonly itemId: string | null
  readonly workCentreKind: WorkCentreKind | null
  readonly label: string | null
  readonly size: string | null
  readonly quantity: string
  readonly uom: Uom | null
  readonly unitCost: string
  readonly cost: string
  readonly pct: string | null
  readonly note: string | null
}

export interface WhatIfFacts {
  readonly lines: readonly WhatIfLine[]
  readonly sizes: readonly string[]
  /** The materials a freight or duty uplift covers when its line names none (a kind's uplift over several materials). */
  readonly covers: ReadonlyMap<string, ReadonlySet<string>>
}

export interface WhatIfResultLine extends Omit<WhatIfLine, 'id'> {
  /** The version's line it comes from. */
  readonly fromId: string
  readonly before: { readonly unitCost: string; readonly cost: string; readonly pct: string | null }
  readonly changed: boolean
}

export interface WhatIfResult {
  readonly lines: WhatIfResultLine[]
  /** How many of the version's lines moved. */
  readonly changed: number
  /** The typed percent lines kept at their amount (their base is unknown). */
  readonly kept: readonly string[]
  /** Changes that reached no line, by their place in the list. */
  readonly unmatched: readonly number[]
}

export const WHAT_IF_LIMITS = Object.freeze({ minPct: '-99.9999', maxPct: '1000', changes: 20 })

/** Whether a percent is a what-if change's (−99.9999 to 1000, at most 4 decimals). */
export function whatIfPctProblem(pct: string): string | null {
  if (!/^-?\d{1,4}(\.\d{1,4})?$/.test(pct)) return 'A percent with at most 4 decimals.'
  const value = new Decimal(pct)
  if (value.lt(WHAT_IF_LIMITS.minPct) || value.gt(WHAT_IF_LIMITS.maxPct)) return 'From −99.9999 % to +1000 %.'
  if (value.isZero()) return 'A change of 0 % changes nothing.'
  return null
}

const RANK: Readonly<Record<WhatIfTarget, number>> = { LINE: 3, ITEM: 2, CATEGORY: 1 }

/** A change on a line: one line by its id; a material's own lines (never a percent line naming it); every line of a category. */
const matches = (change: WhatIfChange, line: WhatIfLine): boolean =>
  change.target === 'LINE' ? change.lineId === line.id : change.target === 'ITEM' ? line.pct === null && change.itemId !== null && change.itemId !== undefined && change.itemId === line.itemId : change.category === line.category

/** The percent change on a line: the most specific change that reaches it, or null. */
function changeOf(changes: readonly WhatIfChange[], line: WhatIfLine): WhatIfChange | null {
  let best: WhatIfChange | null = null
  for (const change of changes) if (matches(change, line) && (best === null || RANK[change.target] > RANK[best.target])) best = change
  return best
}

const isMaterialLike = (line: WhatIfLine): boolean => line.category === 'MATERIAL' || line.category === 'LEATHER' || (line.category === 'PACKAGING' && line.source === 'BOM_LINE')

/** Whether a percent line's base is known (an overhead rule's, the costing settings', an uplift's or landed cost's). */
export const hasKnownBase = (percentLine: Pick<WhatIfLine, 'category' | 'source'>): boolean =>
  (percentLine.category === 'OVERHEAD' && (percentLine.source === 'OVERHEAD_RULE' || percentLine.source === 'COSTING_SETTINGS')) ||
  ((percentLine.category === 'FREIGHT' || percentLine.category === 'DUTY') && (percentLine.source === 'UPLIFT' || percentLine.source === 'LANDED_COST'))

/** Whether `line` is in the base `percentLine` was taken on; null when the percent line's base is unknown. */
export function inBaseOf(percentLine: WhatIfLine, line: WhatIfLine, covers: ReadonlyMap<string, ReadonlySet<string>>): boolean | null {
  if (!hasKnownBase(percentLine)) return null
  if (line.pct !== null) return false
  if (percentLine.category === 'OVERHEAD' && percentLine.source === 'OVERHEAD_RULE') return line.category === 'LABOUR' && (percentLine.workCentreKind === null || line.workCentreKind === percentLine.workCentreKind)
  if (percentLine.category === 'OVERHEAD' && percentLine.source === 'COSTING_SETTINGS') return isMaterialLike(line) || line.category === 'LABOUR'
  // Freight or duty from an uplift or landed cost.
  if (!isMaterialLike(line) || line.itemId === null) return false
  if (percentLine.itemId !== null) return line.itemId === percentLine.itemId
  return covers.get(percentLine.sourceRecordId ?? '')?.has(line.itemId) ?? false
}

const applies = (line: { readonly size: string | null }, size: string): boolean => line.size === null || line.size === size
const moved = (value: string, pct: string): string => six(new Decimal(value).times(new Decimal(100).plus(pct)).dividedBy(100))

/** The version's lines with the changes applied (see the module comment). */
export function whatIf(facts: WhatIfFacts, changes: readonly WhatIfChange[]): WhatIfResult {
  const unmatched = changes.flatMap((change, index) => (facts.lines.some((line) => matches(change, line)) ? [] : [index]))
  // Plain lines first: their new unit cost (the same in every size).
  const plain = new Map<string, string>()
  for (const line of facts.lines) {
    if (line.pct !== null) continue
    const change = changeOf(changes, line)
    plain.set(line.id, change ? moved(line.unitCost, change.pct) : line.unitCost)
  }
  const costIn = (line: WhatIfLine, after: boolean): string => (after ? lineCost(line.quantity, plain.get(line.id)!) : line.cost)
  const kept: string[] = []
  const out: WhatIfResultLine[] = []
  let changedLines = 0

  for (const line of facts.lines) {
    const before = { unitCost: line.unitCost, cost: line.cost, pct: line.pct }
    const { id, ...rest } = line
    if (line.pct === null) {
      const unitCost = plain.get(id)!
      const changed = unitCost !== line.unitCost
      if (changed) changedLines += 1
      out.push({ ...rest, fromId: id, unitCost, cost: lineCost(line.quantity, unitCost), before, changed })
      continue
    }
    // A percent line: its percent (moved by a change aimed at it), of its base now, per size.
    const change = changeOf(changes, line)
    const pct = change ? decimalText(new Decimal(line.pct).times(new Decimal(100).plus(change.pct)).dividedBy(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP)) : line.pct
    const known = hasKnownBase(line)
    const sizes = line.size === null ? facts.sizes : [line.size]
    const perSize = sizes.map((size) => {
      if (!known) return pct === line.pct ? line.unitCost : six(new Decimal(line.unitCost).times(pct).dividedBy(line.pct!))
      const base = facts.lines.filter((other) => applies(other, size) && inBaseOf(line, other, facts.covers) === true)
      const was = base.reduce((sum, other) => sum.plus(costIn(other, false)), new Decimal(0))
      const now = base.reduce((sum, other) => sum.plus(costIn(other, true)), new Decimal(0))
      if (was.isZero() || (was.equals(now) && pct === line.pct)) return pct === line.pct ? line.unitCost : six(new Decimal(line.unitCost).times(pct).dividedBy(line.pct!))
      return six(now.times(pct).dividedBy(100))
    })
    if (!known && change === null) kept.push(id)
    const changed = pct !== line.pct || perSize.some((unitCost) => unitCost !== line.unitCost)
    if (changed) changedLines += 1
    if (line.size !== null || perSize.every((unitCost) => unitCost === perSize[0])) {
      const unitCost = perSize[0] ?? line.unitCost
      out.push({ ...rest, pct, fromId: id, unitCost, cost: lineCost(line.quantity, unitCost), before, changed })
    } else {
      sizes.forEach((size, index) => {
        const unitCost = perSize[index]!
        out.push({ ...rest, size, pct, fromId: id, unitCost, cost: lineCost(line.quantity, unitCost), before, changed })
      })
    }
  }
  return { lines: out, changed: changedLines, kept, unmatched }
}

/** The changes in words for a saved version's note ("What-if: leather +10 %, lining −5 %"), at most 2000 characters. */
export function whatIfNote(changes: readonly WhatIfChange[], label: (change: WhatIfChange) => string): string {
  const parts = changes.map((change) => `${label(change)} ${new Decimal(change.pct).gt(0) ? '+' : ''}${decimalText(change.pct)} %`)
  return `What-if: ${parts.join(', ')}`.slice(0, 2000)
}
