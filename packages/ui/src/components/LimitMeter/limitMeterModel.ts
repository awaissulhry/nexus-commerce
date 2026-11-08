/**
 * LimitMeter's rules (B-W2b-78, design part LimitMeter): a measured value against a limit, or against a nominal with a
 * ± tolerance — Cr VI in leather, pH, tear strength, a point of measure on a garment.
 *
 * - **Limit**: `rule` says which side passes. `below` (the default, the REACH wording "equal to or greater than 3 mg/kg
 *   fails"): value < limit; `atMost`: value ≤ limit; `atLeast`: value ≥ limit (a minimum, tear strength); `above`:
 *   value > limit.
 * - **Below detection**: the lab reports "< LOQ" (`belowDetection`) or a value under the limit of quantification
 *   (`loq`). It passes a maximum only when the LOQ itself is within the limit (`below`: LOQ ≤ limit); a LOQ above the
 *   limit cannot tell (`inconclusive`), and a minimum is failed by it when the LOQ is within the minimum. Without a LOQ
 *   the lab's "not detected" stands as below detection.
 * - **Tolerance**: nominal ± tolerance (or − minus / + plus). In tolerance passes; outside says how far from the nominal
 *   ("over by 1.3", "under by 0.6") — the deviation an inspector reads on a measurement sheet.
 * - **Never a free pass**: no value is `notMeasured`; a value with no limit is `noLimit` (said, never passed).
 * - Comparisons round to 1e-9 so 0.1 + 0.2 reads as 0.3.
 */

export type LimitRule = 'below' | 'atMost' | 'atLeast' | 'above'
export type LimitVerdict = 'pass' | 'fail' | 'belowDetection' | 'inconclusive' | 'notMeasured' | 'noLimit'
export type ToleranceVerdict = 'pass' | 'over' | 'under' | 'notMeasured'
/** The tone a verdict paints with (the word and the icon carry the meaning; the colour repeats it). */
export type LimitTone = 'success' | 'danger' | 'warning' | 'neutral'

const EPS = 1e-9
const fix = (n: number) => Math.round(n / EPS) * EPS
const lt = (a: number, b: number) => fix(a) < fix(b)
const le = (a: number, b: number) => fix(a) <= fix(b)

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

export interface LimitInput {
  value?: number | null
  limit?: number | null
  /** Which side of the limit passes (default `below`). */
  rule?: LimitRule
  /** The limit of quantification (detection) of the method. */
  loq?: number | null
  /** The lab reported "below the limit of quantification" with no value. */
  belowDetection?: boolean
}

/** A maximum (`below`, `atMost`) or a minimum (`atLeast`, `above`). */
export const isMaximum = (rule: LimitRule = 'below'): boolean => rule === 'below' || rule === 'atMost'

/** True when `value` passes `limit` under `rule`. */
export function passesLimit(value: number, limit: number, rule: LimitRule = 'below'): boolean {
  switch (rule) {
    case 'below':
      return lt(value, limit)
    case 'atMost':
      return le(value, limit)
    case 'atLeast':
      return le(limit, value)
    case 'above':
      return lt(limit, value)
  }
}

/** The value counts as below detection: reported so, or under the LOQ. */
export function isBelowDetection({ value, loq, belowDetection }: LimitInput): boolean {
  if (belowDetection) return true
  return isNum(value) && isNum(loq) && lt(value, loq)
}

export function limitVerdict(input: LimitInput): LimitVerdict {
  const { value, limit, rule = 'below', loq } = input
  const below = isBelowDetection(input)
  if (!below && !isNum(value)) return 'notMeasured'
  if (!isNum(limit)) return below ? 'belowDetection' : 'noLimit'
  if (below) {
    // Everything under the LOQ: it passes a maximum only when the LOQ itself would pass.
    if (!isNum(loq)) return isMaximum(rule) ? 'belowDetection' : 'inconclusive'
    if (isMaximum(rule)) return le(loq, limit) ? 'belowDetection' : 'inconclusive'
    // A minimum: a value under a LOQ that is itself within the minimum is too low.
    return le(loq, limit) ? 'fail' : 'inconclusive'
  }
  return passesLimit(value as number, limit, rule) ? 'pass' : 'fail'
}

export interface ToleranceInput {
  value?: number | null
  nominal: number
  /** ± the same both ways. */
  tolerance?: number | null
  /** Below the nominal (default `tolerance`). */
  minus?: number | null
  /** Above the nominal (default `tolerance`). */
  plus?: number | null
}

export interface ToleranceResult {
  verdict: ToleranceVerdict
  /** value − nominal (0 when not measured). */
  deviation: number
  /** The band's edges. */
  low: number
  high: number
}

export function toleranceBand({ nominal, tolerance, minus, plus }: ToleranceInput): { low: number; high: number } {
  const down = Math.abs(minus ?? tolerance ?? 0)
  const up = Math.abs(plus ?? tolerance ?? 0)
  return { low: fix(nominal - down), high: fix(nominal + up) }
}

export function toleranceResult(input: ToleranceInput): ToleranceResult {
  const { low, high } = toleranceBand(input)
  if (!isNum(input.value)) return { verdict: 'notMeasured', deviation: 0, low, high }
  const deviation = fix(input.value - input.nominal)
  const verdict: ToleranceVerdict = lt(input.value, low) ? 'under' : lt(high, input.value) ? 'over' : 'pass'
  return { verdict, deviation, low, high }
}

export const LIMIT_TONE: Record<LimitVerdict | ToleranceVerdict, LimitTone> = {
  pass: 'success',
  belowDetection: 'success',
  fail: 'danger',
  over: 'danger',
  under: 'danger',
  inconclusive: 'warning',
  notMeasured: 'neutral',
  noLimit: 'neutral',
}

/** Passes (pass, below detection within the limit, in tolerance). */
export const verdictPasses = (verdict: LimitVerdict | ToleranceVerdict): boolean => verdict === 'pass' || verdict === 'belowDetection'

/**
 * Where the bar's scale ends: a round number at least 25 % past the largest of what it draws, so the limit line is never
 * at the edge. 1, 2, 2.5 or 5 × a power of ten.
 */
export function scaleMax(...values: ReadonlyArray<number | null | undefined>): number {
  const top = Math.max(0, ...values.filter(isNum).map(Math.abs)) * 1.25
  if (top <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(top))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= top - EPS) return fix(step * power)
  return fix(10 * power)
}

/** A value's place on a scale from `min` to `max`, as a percentage clamped to 0–100. */
export function positionOn(value: number, min: number, max: number): number {
  if (!(max > min)) return 0
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
}

/** The tolerance bar's ends: the band with room either side (at least the band's width, and the value inside). */
export function toleranceScale(result: Pick<ToleranceResult, 'low' | 'high'>, nominal: number, value?: number | null): { min: number; max: number } {
  const width = Math.max(result.high - result.low, Math.abs(nominal) * 0.02, EPS * 1e6)
  let min = result.low - width
  let max = result.high + width
  if (isNum(value)) {
    min = Math.min(min, value - width * 0.25)
    max = Math.max(max, value + width * 0.25)
  }
  return { min, max }
}
