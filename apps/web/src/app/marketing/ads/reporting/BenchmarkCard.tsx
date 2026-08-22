'use client'

/**
 * BM.1 — one benchmarked figure: ours, the category median, and the category's top.
 *
 * Helium 10's Brand Metrics page repeats a single small component down its left
 * column — a value, a bar, "Median:" at one end and "Top:" at the other — and that
 * component IS their comparison feature. Amazon sends all three numbers on the same
 * row and we have stored every one of them since June without rendering any.
 *
 * So this is built once and used fourteen times, and it takes no `variant`, no
 * `note` and no per-caller styling prop: a second appearance of a shared component
 * that looks different is how two pages start disagreeing about what a card means.
 *
 * ── The scale is 0 → the category's top, and that is a deliberate choice ────────
 *
 * Scaling to our own value would make every card look full and say nothing. Scaling
 * to the top performer means the bar answers "how much of the achievable are we
 * taking" at a glance, and the median tick shows whether we are above or below the
 * middle of the category. On this account most bars are short, which is the honest
 * picture: add-to-carts 730 against a top of 5,176.
 *
 * ── Absence ─────────────────────────────────────────────────────────────────────
 *
 * 🔴 A missing figure renders as an em-dash and draws NO bar. Amazon omits metrics
 * it cannot compute — branded searches appear on 22 of 117 production rows — and 0
 * is a real, meaningful value for every metric here. A zero-length bar would say
 * "we scored nothing"; an absent bar says "Amazon sent nothing", which is the truth.
 * The registry deliberately drops COALESCE for the same reason.
 */
import { Info } from 'lucide-react'
import { HoverCard } from '../campaigns/FilterDropdown'

export interface BenchmarkCardProps {
  label: string
  /** Longer explanation, shown behind the (i). Omitted when the label says enough. */
  tip?: string
  /** Display strings — already formatted by the server's declared format, already an em-dash when absent. */
  value: string
  median: string
  top: string
  /** The same three as numbers, for the bar only. null where Amazon sent nothing. */
  raw: { value: number | null; median: number | null; top: number | null }
}

/** Position on a 0→top scale, as a percentage, clamped. null when it cannot be placed. */
function place(n: number | null, top: number | null): number | null {
  if (n == null || top == null || !Number.isFinite(n) || !Number.isFinite(top) || top <= 0) return null
  return Math.max(0, Math.min(100, (n / top) * 100))
}

export function BenchmarkCard({ label, tip, value, median, top, raw }: BenchmarkCardProps) {
  const fill = place(raw.value, raw.top)
  const tick = place(raw.median, raw.top)
  // Our standing against the median, stated in the bar's colour rather than only in
  // digits — the one thing an operator should be able to read without comparing two
  // numbers.
  //
  // 🔴 Equality is NEUTRAL, not ahead. Amazon returns the same engagement band
  // (0–5%) for us, the median and the top in this category, and `>=` painted that
  // a confident green — "we are doing well" where the truth is "this metric does
  // not separate anyone here". Unknown is neutral for the same reason: an absent
  // figure is not a result.
  const standing =
    raw.value == null || raw.median == null ? 'unknown'
      : raw.value > raw.median ? 'ahead'
        : raw.value < raw.median ? 'behind'
          : 'level'

  return (
    <div className="rpt-bm-card">
      <div className="rpt-bm-label">
        <span>{label}</span>
        {tip && (
          <HoverCard text={tip}>
            <Info size={12} aria-hidden />
          </HoverCard>
        )}
      </div>

      <div className="rpt-bm-value">{value}</div>

      {/* The slot is always here; the bar inside it is not. Reserving the space keeps
          every card the same height whatever its data — measured: without it the one
          card Amazon sent no figure for came out 12px shorter than its neighbours, and
          which cards those are changes with the viewport width. Drawing an empty track
          instead would read as a zero-length bar, which is the one thing an absent
          figure must not look like. */}
      <div className="rpt-bm-track">
        {fill !== null && (
          <div className={`rpt-bm-bar is-${standing}`}>
            <i className="fill" style={{ width: `${fill}%` }} />
            {tick !== null && (
              <i
                className="tick"
                style={{ left: `${tick}%` }}
                /* The tick is the median's position; the figure itself is printed
                   below, so this is decoration and must not be announced twice. */
                aria-hidden
              />
            )}
          </div>
        )}
      </div>

      <div className="rpt-bm-scale">
        <span>Median: <b>{median}</b></span>
        <span>Top: <b>{top}</b></span>
      </div>
    </div>
  )
}
