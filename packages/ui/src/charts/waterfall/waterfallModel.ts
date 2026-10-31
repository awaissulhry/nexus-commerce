/**
 * The rules of `Waterfall` (B-W2b-09; design "Waterfall": products.styles, sales.orders, sales.quotes; B-W2a-72 composed
 * it) — pure, tested in Node.
 *
 * Signed steps from a start to a result: a price (base → list → options → quantity break → manual → net) or a cost
 * (materials → labour → overhead → … → cost → margin → price). A `start` sets the running total, a `step` adds its signed
 * amount, a `total` shows the running total so far (a subtotal or the result) — its own `amount`, when given, is what
 * the server says, and a difference from the running total is reported (`mismatch`), never hidden. Every bar sits on one
 * scale that includes 0, so a loss shows below it.
 */
export type WaterfallKind = 'start' | 'step' | 'total'
/** Which way is good: a price or a margin rises well (`up`); a cost falls well (`down`); `none` draws both neutral. */
export type WaterfallGood = 'up' | 'down' | 'none'
export type WaterfallTone = 'up-good' | 'up-bad' | 'down-good' | 'down-bad' | 'neutral' | 'total'

export interface WaterfallStepInput {
  id: string
  kind: WaterfallKind
  /** start: the opening value; step: the signed change; total: the server's value (optional, checked). */
  amount?: number | null
}

export interface WaterfallBar {
  id: string
  kind: WaterfallKind
  /** The running total before and after this bar. */
  from: number
  to: number
  /** The signed change (steps) or the value (start, total). */
  amount: number
  tone: WaterfallTone
  /** Bar position on the scale, 0–100. */
  left: number
  width: number
  /** A total whose given amount differs from the running total (by more than a cent). */
  mismatch: number | null
}

export interface WaterfallView {
  bars: WaterfallBar[]
  min: number
  max: number
  /** Where 0 sits, 0–100. */
  zero: number
  /** The last running total. */
  result: number
}

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/** The smallest bar still drawn (a zero step shows as a hairline, not nothing). */
export const WATERFALL_MIN_WIDTH = 0.6

export function waterfallView(steps: readonly WaterfallStepInput[], good: WaterfallGood = 'up'): WaterfallView {
  let running = 0
  const raw = steps.map((step) => {
    const from = running
    if (step.kind === 'start') {
      running = finite(step.amount) ? step.amount : 0
      return { step, from: 0, to: running, amount: running, mismatch: null as number | null }
    }
    if (step.kind === 'step') {
      const change = finite(step.amount) ? step.amount : 0
      running = from + change
      return { step, from, to: running, amount: change, mismatch: null }
    }
    const given = finite(step.amount) ? step.amount : null
    const mismatch = given !== null && Math.abs(given - running) > 0.005 ? given - running : null
    return { step, from: 0, to: running, amount: running, mismatch }
  })
  const values = raw.flatMap((bar) => [bar.from, bar.to])
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const span = max - min || 1
  const at = (n: number) => ((n - min) / span) * 100
  const bars: WaterfallBar[] = raw.map(({ step, from, to, amount, mismatch }) => {
    const left = at(Math.min(from, to))
    const width = Math.max(WATERFALL_MIN_WIDTH, at(Math.max(from, to)) - left)
    let tone: WaterfallTone = 'total'
    if (step.kind === 'step') {
      if (good === 'none' || amount === 0) tone = 'neutral'
      else if (amount > 0) tone = good === 'up' ? 'up-good' : 'up-bad'
      else tone = good === 'up' ? 'down-bad' : 'down-good'
    }
    return { id: step.id, kind: step.kind, from, to, amount, tone, left: Math.min(left, 100 - width), width, mismatch }
  })
  return { bars, min, max, zero: at(0), result: running }
}
