/**
 * The rules of `BarList` (B-W2b-09; design "BarList": planning.leather, planning.reports, purchasing.reports,
 * finance.receivables, finance.margins; B-W2a-72 composed it) — pure, tested in Node.
 *
 * Labelled horizontal bars for categories (customers, suppliers, lots), on one scale from 0 to the largest value (or the
 * list's `max`). A negative value (a loss) draws to the left of a 0 line. A stacked bar (ageing buckets) splits its
 * length by its parts, in the legend's order; parts that do not add up to the value are drawn as they are and the value
 * says the truth. An unknown value draws no bar and says "—", never 0.
 */
export type BarTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface BarInput {
  id: string
  value: number | null | undefined
  /** Stacked parts by the legend's id. */
  parts?: Readonly<Record<string, number | null | undefined>>
}

export interface BarPartView {
  id: string
  value: number
  /** Share of the track, 0–100. */
  width: number
  /** Index in the legend (draws its pattern). */
  index: number
}

export interface BarView {
  id: string
  known: boolean
  value: number
  /** 0–100 of the track. */
  left: number
  width: number
  parts: BarPartView[]
}

export interface BarListView {
  bars: BarView[]
  /** Where 0 sits on the track, 0–100 (0 unless a value is negative). */
  zero: number
  max: number
  min: number
}

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

export function barListView(items: readonly BarInput[], options: { max?: number | null; keys?: readonly string[] } = {}): BarListView {
  const values = items.map((item) => item.value).filter(finite)
  const max = Math.max(finite(options.max) && options.max > 0 ? options.max : 0, ...values, 0)
  const min = Math.min(0, ...values)
  const span = max - min || 1
  const at = (n: number) => ((n - min) / span) * 100
  const zero = at(0)
  const keys = options.keys ?? []
  const bars = items.map((item): BarView => {
    if (!finite(item.value)) return { id: item.id, known: false, value: 0, left: zero, width: 0, parts: [] }
    const value = item.value
    const left = Math.min(at(value), zero)
    const width = Math.abs(at(value) - zero)
    const parts: BarPartView[] = []
    if (item.parts && keys.length > 0 && value > 0) {
      for (const [index, key] of keys.entries()) {
        const part = item.parts[key]
        if (!finite(part) || part <= 0) continue
        parts.push({ id: key, value: part, width: (part / span) * 100, index })
      }
    }
    return { id: item.id, known: true, value, left, width, parts }
  })
  return { bars, zero, max, min }
}
