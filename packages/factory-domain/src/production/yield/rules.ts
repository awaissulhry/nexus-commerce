import { Dec, HUNDRED, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * Hide yield (B-W2a-13; MES-057, SCM-255; design production.cutting "Yield", the work order's Cutting tab "Yield"), pure:
 * how much of a hide's area became garment pieces. Read from the cut log (B-W1-40): each live entry's area used (pieces
 * and waste), the remnant it set aside, and its pattern area: the pieces' net area, the BOM's need of the sets it cut
 * without the line's wastage (a BOM line's quantity includes its wastage, the expected waste and yield of the hide).
 *
 *   areaIn     the hide's area at receipt (base unit).
 *   used       Σ area used by its live entries (the pieces and the waste around them).
 *   pattern    Σ pattern area of the pieces cut, of the entries whose pattern is known (whole sets of the cell's parts).
 *   unmatched  Σ area used by entries of single parts (no whole set): their pattern is not known, so they are left out
 *              of the yield and the waste (never counted as all pattern, which would show 100 %).
 *   remnant    Σ offcut set aside as a remnant (back to stock).
 *   waste      used − unmatched − pattern; waste % = waste / (used − unmatched).
 *   yield %    pattern / (used − unmatched): the share of the area cut from that became pieces.
 *   planned %  the style revision's planned hide yield (StyleRevision.plannedHideYieldPct) when the style sets one, else
 *              what the BOM's wastage expects: pattern / BOM need.
 * Summaries add the areas first and take the percentages of the sums (never an average of percentages). Never by
 * cutter (SCM-255 legal note; Statuto dei Lavoratori art. 4): per hide, work order, style and supplier lot only.
 */

export interface YieldEntry {
  /** Area used, in the leather's base unit. */
  readonly used: DecimalInput
  readonly remnant: DecimalInput
  /** The pieces' net area (BOM need without wastage); null when unknown (single parts): left out of the yield. */
  readonly pattern: DecimalInput | null
  /** The BOM's need of the pieces, wastage included; null when unknown. */
  readonly need: DecimalInput | null
}

export interface YieldFigures {
  readonly used: string
  /** Area used by cuts whose pattern is not known (single parts): left out of the yield and the waste. */
  readonly unmatched: string
  readonly pattern: string
  readonly remnant: string
  readonly waste: string
  /** Percent, two places; null when nothing was used. */
  readonly wastePct: string | null
  readonly yieldPct: string | null
  readonly plannedPct: string | null
  /** yield − planned, percentage points; null when either is unknown. */
  readonly variancePct: string | null
}

const area = (value: Decimal) => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
const pct = (value: Decimal | null) => (value === null ? null : value.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2))
const share = (part: Decimal, whole: Decimal): Decimal | null => (whole.isZero() ? null : part.times(HUNDRED).div(whole))

export interface YieldTotals {
  readonly used: Decimal
  readonly unmatched: Decimal
  readonly pattern: Decimal
  readonly remnant: Decimal
  readonly need: Decimal
  /** The pattern of the entries whose need is known (the planned share's numerator). */
  readonly patternWithNeed: Decimal
}

/** The sums of entries. */
export function yieldTotals(entries: readonly YieldEntry[]): YieldTotals {
  let used = ZERO
  let unmatched = ZERO
  let pattern = ZERO
  let remnant = ZERO
  let need = ZERO
  let patternWithNeed = ZERO
  for (const entry of entries) {
    const entryUsed = new Dec(entry.used)
    used = used.plus(entryUsed)
    remnant = remnant.plus(new Dec(entry.remnant))
    if (entry.pattern === null) {
      unmatched = unmatched.plus(entryUsed)
      continue
    }
    pattern = pattern.plus(Dec.min(entryUsed, new Dec(entry.pattern)))
    if (entry.need !== null) {
      need = need.plus(new Dec(entry.need))
      patternWithNeed = patternWithNeed.plus(new Dec(entry.pattern))
    }
  }
  return { used, unmatched, pattern, remnant, need, patternWithNeed }
}

/** Adds sums (a summary over hides, work orders or lots). */
export function addTotals(rows: readonly YieldTotals[]): YieldTotals {
  return rows.reduce(
    (sum, row) => ({
      used: sum.used.plus(row.used),
      unmatched: sum.unmatched.plus(row.unmatched),
      pattern: sum.pattern.plus(row.pattern),
      remnant: sum.remnant.plus(row.remnant),
      need: sum.need.plus(row.need),
      patternWithNeed: sum.patternWithNeed.plus(row.patternWithNeed),
    }),
    { used: ZERO, unmatched: ZERO, pattern: ZERO, remnant: ZERO, need: ZERO, patternWithNeed: ZERO },
  )
}

/** The figures of sums; `plannedPct` the style's planned hide yield when it has one (one style), else the BOM's. */
export function yieldFigures(totals: YieldTotals, plannedPct?: DecimalInput | null): YieldFigures {
  const matched = totals.used.minus(totals.unmatched)
  const waste = Dec.max(ZERO, matched.minus(totals.pattern))
  const actual = share(totals.pattern, matched)
  const planned = plannedPct !== undefined && plannedPct !== null ? new Dec(plannedPct) : share(totals.patternWithNeed, totals.need)
  return {
    used: area(totals.used),
    unmatched: area(totals.unmatched),
    pattern: area(totals.pattern),
    remnant: area(totals.remnant),
    waste: area(waste),
    wastePct: pct(share(waste, matched)),
    yieldPct: pct(actual),
    plannedPct: pct(planned),
    variancePct: actual !== null && planned !== null ? pct(actual.minus(planned)) : null,
  }
}

/** The net area of a BOM need: the need without the line's wastage (percent). */
export function netOfWastage(need: DecimalInput, wastagePct: DecimalInput): Decimal {
  return new Dec(need).div(new Dec(1).plus(new Dec(wastagePct).div(HUNDRED)))
}
