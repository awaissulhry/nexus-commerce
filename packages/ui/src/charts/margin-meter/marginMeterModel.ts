/**
 * The rules of `MarginMeter` (B-W2b-09; design "MarginMeter": products.styles, sales.orders, sales.pricelists,
 * sales.quotes; B-W2a-72 composed it) — pure, tested in Node.
 *
 * A margin % against the business's floor and target. The tone AND the words say where it is: under the floor
 * (danger), between floor and target (warning), at or above the target (success), nothing to compare with (neutral).
 * An unknown margin is "not known", never 0. The scale starts at 0 (or below, for a loss) and ends past the highest of
 * the value, the floor and the target, rounded up to a ten, so the marks never sit on the edge.
 */
import { MARGIN_METER_LABELS, type MarginMeterLabels } from './MarginMeterLabels'

export type MarginTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface MarginMeterInput {
  /** The margin in percent (18.2 = 18.2 %); null when not known. */
  value: number | null | undefined
  floor?: number | null
  target?: number | null
}

export interface MarginMeterView {
  known: boolean
  tone: MarginTone
  /** The sentence: "18.2 % — under the 20 % floor". */
  words: string
  /** The value written alone ("18.2 %"), or "—". */
  valueText: string
  /** The scale. */
  min: number
  max: number
  /** Positions on the bar, 0–100; null when not drawn. */
  fill: number | null
  /** Where 0 sits (a loss fills left of it). */
  zero: number
  floorAt: number | null
  targetAt: number | null
  floorText: string | null
  targetText: string | null
}

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/** "18.2 %" in the given language: one decimal, a no-break space before the sign. */
export function marginPercent(value: number, locale = 'en'): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} %`
}

/** The scale: from min(0, values) rounded down to ten, to max(values, 10) rounded up to the next ten with room. */
export function marginScale(values: ReadonlyArray<number | null | undefined>): { min: number; max: number } {
  const known = values.filter(finite)
  const low = Math.min(0, ...known)
  const high = Math.max(10, ...known)
  const min = low < 0 ? Math.floor(low / 10) * 10 : 0
  let max = Math.ceil(high / 10) * 10
  if (max - high < 2) max += 10
  return { min, max }
}

export function marginMeterView(
  input: MarginMeterInput,
  options: { words?: MarginMeterLabels; format?: (value: number) => string; scale?: { min: number; max: number } } = {},
): MarginMeterView {
  const words = options.words ?? MARGIN_METER_LABELS
  const format = options.format ?? ((value: number) => marginPercent(value))
  const value = finite(input.value) ? input.value : null
  const floor = finite(input.floor) ? input.floor : null
  const target = finite(input.target) ? input.target : null
  const { min, max } = options.scale ?? marginScale([value, floor, target])
  const span = max - min || 1
  const at = (n: number) => Math.max(0, Math.min(100, ((n - min) / span) * 100))
  const floorText = floor === null ? null : format(floor)
  const targetText = target === null ? null : format(target)
  const base = { min, max, zero: at(0), floorAt: floor === null ? null : at(floor), targetAt: target === null ? null : at(target), floorText, targetText }
  if (value === null) return { ...base, known: false, tone: 'neutral', words: words.unknown, valueText: '—', fill: null }
  const valueText = format(value)
  let tone: MarginTone = 'neutral'
  let sentence = words.plain(valueText)
  if (floor !== null && value < floor) {
    tone = 'danger'
    sentence = words.underFloor(valueText, floorText!)
  } else if (target !== null && value < target) {
    tone = 'warning'
    sentence = words.underTarget(valueText, targetText!)
  } else if (target !== null) {
    tone = 'success'
    sentence = words.onTarget(valueText, targetText!)
  } else if (floor !== null) {
    tone = 'success'
    sentence = words.overFloor(valueText, floorText!)
  }
  return { ...base, known: true, tone, words: sentence, valueText, fill: at(value) }
}
