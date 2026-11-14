import { Dec, type Decimal } from '../../tax/decimal'

/**
 * A KPI's calculation (B-W2b-428; ANA-070 one metric layer): how the sums of its measures over one period make its value.
 * It lives in code, one per KPI (defs/), and EVERY reader uses it — the KPI library, Today's numbers, dashboards, alerts,
 * the portal and the API — through apps/factory-api modules/insights/kpis/value.ts, so the same word never gives two numbers.
 * A version of the KPI (KpiDefinition) says in words what it computes; a different calculation is a different KPI.
 *
 *   SUM       a FLOW measure summed over the period's days (orders in, pieces made)
 *   BALANCE   a BALANCE measure as it stood at the end of the period's last day that has facts (work in progress)
 *   RATIO     Σ numerator measures ÷ Σ denominator measures × scale, rounded half up to `decimals` (scrap rate, on time)
 */

export const CALC_KINDS = ['SUM', 'BALANCE', 'RATIO'] as const
export type CalcKind = (typeof CALC_KINDS)[number]

export type KpiCalc =
  | { readonly kind: 'SUM'; readonly measure: string }
  | { readonly kind: 'BALANCE'; readonly measure: string }
  | { readonly kind: 'RATIO'; readonly numerator: readonly string[]; readonly denominator: readonly string[]; readonly scale: 1 | 100; readonly decimals: number }

/** The measures a calculation reads, each once, in order. */
export function measuresOfCalc(calc: KpiCalc): string[] {
  if (calc.kind === 'RATIO') return [...new Set([...calc.numerator, ...calc.denominator])]
  return [calc.measure]
}

/**
 * The value of one period from its measures' sums, as a decimal string (a count `17`, minor units `1250000`, a percent
 * `93.5`). Null when a sum it needs is unknown (no facts, or a currency it cannot count in) or a ratio's denominator is 0.
 */
export function applyCalc(calc: KpiCalc, sums: ReadonlyMap<string, Decimal | null>): string | null {
  const sumOf = (keys: readonly string[]): Decimal | null => {
    let total = new Dec(0)
    for (const key of keys) {
      const part = sums.get(key)
      if (part === null || part === undefined) return null
      total = total.plus(part)
    }
    return total
  }
  if (calc.kind !== 'RATIO') {
    const value = sumOf([calc.measure])
    return value === null ? null : value.toString()
  }
  const numerator = sumOf(calc.numerator)
  const denominator = sumOf(calc.denominator)
  if (numerator === null || denominator === null || denominator.isZero()) return null
  return numerator.div(denominator).times(calc.scale).toDecimalPlaces(calc.decimals, Dec.ROUND_HALF_UP).toFixed(calc.decimals)
}
