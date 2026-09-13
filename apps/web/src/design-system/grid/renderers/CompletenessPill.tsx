import { memo } from 'react'
import { readyPillTone, type RowReadinessState } from './readiness'

export interface CompletenessPillProps {
  /** 0–100. `null` renders — because there is no scorable contract. */
  pct: number | null | undefined
  /**
   * 🔴 The COLOUR comes from here, never from `pct` (ruling #43; regression found by PES.3 on
   * adoption, #727).
   *
   * The first version computed its own tone from the percentage — `100 → full, <40 → low`. That
   * reverses #43: a high percentage does not mean a listing can publish. Measured on Amazon·DE, an
   * alias in state `errors` at 84% painted neutral grey while the pill's own `aria-label` said
   * "Error" — one control making two statements about one listing.
   *
   * The percentage now drives only the bar's LENGTH and the number. `undefined` means "this ratio
   * has no readiness behind it" — master completeness — and paints neutral.
   */
  state?: RowReadinessState | null
  /** The hover sentence — what the number is a ratio OF. */
  tip?: string
}

/**
 * Readiness as a bar AND a number, pinned to the band's right edge.
 *
 * 🔴 Both, not either. The bar alone cannot be read precisely and fails anyone who cannot separate
 * its two colours; the number alone gives no sense of a row's progress against the rows above it,
 * which is the thing an operator scans a column of these for. The pair is also why this replaced a
 * 90px numeric column rather than moving it: the column could show `21%` and nothing else.
 *
 * `aria-label` carries the same sentence as the tooltip, because the bar is a graphic and the
 * percentage beside it is the only text — a screen reader gets the ratio, not a bare "21%".
 */
export const CompletenessPill = memo(function CompletenessPill({ pct, state, tip }: CompletenessPillProps) {
  const unscorable = pct == null || Number.isNaN(pct)
  /* Clamp, because this is drawn from a server ratio and a width of `-4%` or `130%` paints outside
     its own track. Rounding once here keeps the bar and the number telling the same story — a bar
     drawn from 20.6 beside a label reading 21 is a small lie that is very hard to see. */
  const value = unscorable ? null : Math.max(0, Math.min(100, Math.round(pct!)))
  const tone = readyPillTone(state)
  return (
    <span
      className={`nds-readypill nds-readypill-${tone}`}
      role="img"
      aria-label={tip ?? (value === null ? 'Readiness cannot be scored' : `${value}% complete`)}
      title={tip}
    >
      {value !== null && <span className="nds-readypill-track">
        <span className="nds-readypill-fill" style={{ width: `${value}%` }} />
      </span>}
      <span className="nds-readypill-num">{value === null ? '—' : `${value}%`}</span>
    </span>
  )
})
