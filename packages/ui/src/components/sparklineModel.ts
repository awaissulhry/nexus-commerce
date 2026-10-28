/**
 * The geometry and words of `Sparkline` (bid page DS lane, 2026-10-10) — pure, tested in Node.
 *
 * Promoted from the parked `rules-automation/bid/BidSpark.tsx` (BID.S2), which already said it was generic. Its two rules
 * stay:
 *  - STEP by default. A bid holds until something writes a new one; a straight line between two bids draws a gradual
 *    climb that never happened (the nightly floor-and-restore is a square wave, not a slope). `shape: 'line'` is for a
 *    value that really moves between readings (clicks a day).
 *  - Nothing to draw is a MARK, not a blank: a dotted rule and the words "No changes" (or the host's). A blank reads as
 *    "broken or loading"; a flat line would claim "steady".
 * A null keeps its slot and breaks the line: a day without a reading is not a day at the last value.
 */

export type SparkShape = 'step' | 'line'
export type SparkValue = number | null | undefined

/**
 * A fixed axis (2026-10-28): `[low, high]` the drawing always spans; either end `null` = the readings' own. A reading
 * outside it widens it, so nothing is cut off. `[0, null]` draws from zero to the highest reading: a share that moves
 * 11 → 11.2 % stays flat instead of filling the box. Without it the line spans the readings' own low and high.
 */
export type SparkDomain = readonly [low: number | null, high: number | null]

export interface SparkBox { width: number; height: number; pad: number }
export const SPARK_BOX: SparkBox = { width: 88, height: 22, pad: 2 }

export interface SparkGeometry {
  /** SVG path; empty when fewer than two readings sit next to each other. */
  path: string
  /** A reading with no neighbour on either side (drawn as a dot, so it is not lost). */
  dots: Array<{ x: number; y: number }>
  /** The last reading — drawn as a dot: it is the value in force now. */
  last: { x: number; y: number } | null
  count: number
  /** The readings' own low and high (not the axis's). */
  min: number | null
  max: number | null
}

const finite = (v: SparkValue): v is number => typeof v === 'number' && Number.isFinite(v)
const r1 = (n: number) => Math.round(n * 10) / 10

export function sparkGeometry(values: ReadonlyArray<SparkValue>, shape: SparkShape = 'step', box: SparkBox = SPARK_BOX, domain?: SparkDomain): SparkGeometry {
  const readings = values.map((v, i) => (finite(v) ? { i, v } : null))
  const known = readings.filter((r): r is { i: number; v: number } => r !== null)
  if (!known.length) return { path: '', dots: [], last: null, count: 0, min: null, max: null }
  const min = Math.min(...known.map((r) => r.v))
  const max = Math.max(...known.map((r) => r.v))
  const [axisLow, axisHigh] = domain ?? [null, null]
  const low = finite(axisLow) ? Math.min(axisLow, min) : min
  const high = finite(axisHigh) ? Math.max(axisHigh, max) : max
  const span = high - low
  const inner = { w: box.width - box.pad * 2, h: box.height - box.pad * 2 }
  const x = (i: number) => r1(box.pad + (values.length === 1 ? inner.w / 2 : (i / (values.length - 1)) * inner.w))
  const y = (v: number) => r1(span === 0 ? box.height / 2 : box.height - box.pad - ((v - low) / span) * inner.h)

  const parts: string[] = []
  const dots: Array<{ x: number; y: number }> = []
  for (let i = 0; i < readings.length; i += 1) {
    const here = readings[i]
    if (!here) continue
    const before = i > 0 ? readings[i - 1] : null
    const after = i < readings.length - 1 ? readings[i + 1] : null
    if (!before) {
      if (after) parts.push(`M ${x(here.i)} ${y(here.v)}`)
      else dots.push({ x: x(here.i), y: y(here.v) })
      continue
    }
    // Step-after: hold the previous value until the moment the new one was set, then move.
    if (shape === 'step') parts.push(`L ${x(here.i)} ${y(before.v)}`)
    if (shape === 'line' || here.v !== before.v) parts.push(`L ${x(here.i)} ${y(here.v)}`)
  }
  const lastReading = known[known.length - 1]
  return { path: parts.join(' '), dots, last: { x: x(lastReading.i), y: y(lastReading.v) }, count: known.length, min, max }
}

/**
 * The accessible name and hover line: "Bid, 14 days: 6 readings, low 0.10, high 0.40, now 0.30". With nothing to draw it
 * is the host's empty words ("No changes"), never a number.
 */
export function sparkSummary(
  label: string,
  values: ReadonlyArray<SparkValue>,
  format: (n: number) => string = (n) => String(n),
  emptyLabel = 'No changes',
): string {
  return `${label}: ${sparkWords(values, format, emptyLabel)}`
}

/** The same words without the label — a grid cell's CSV, clipboard and quick-filter text. */
export function sparkWords(values: ReadonlyArray<SparkValue>, format: (n: number) => string = (n) => String(n), emptyLabel = 'No changes'): string {
  const known = values.filter(finite)
  if (!known.length) return emptyLabel
  const now = known[known.length - 1]
  if (known.length === 1) return `1 reading, ${format(now)}`
  const low = Math.min(...known), high = Math.max(...known)
  if (low === high) return `${known.length} readings, all ${format(now)}`
  return `${known.length} readings, low ${format(low)}, high ${format(high)}, now ${format(now)}`
}
