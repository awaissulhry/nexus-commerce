export interface ProgressBarProps {
  /** Accessible name describing the operation being measured. */
  ariaLabel?: string
  /** 0–100 (ignored when `indeterminate`). `null` = not measurable: an empty track, and `—` beside it with `showValue`. */
  value?: number | null
  indeterminate?: boolean
  /** track height in px (default 7) */
  height?: number
  className?: string
  /**
   * A COMPLETENESS reading (the sheet's progress columns, 2026-09-26): the fill takes `--nds-progress-<tone>` and its
   * 3:1 edge. The tone is the caller's, from what is missing (colour rule A, `progressTone`), never from `value` —
   * a high percentage does not mean nothing required is empty (#43, #727). Without it the bar is the brand fill, as before.
   */
  tone?: 'complete' | 'partial' | 'missing' | 'unknown'
  /**
   * Print the percentage beside the bar ("83%", or `—` when `value` is null). The bar alone cannot be read precisely,
   * and the number alone gives no sense of a row against the rows above it — a meter shows both. The bar and the
   * number are drawn from ONE rounded value, so they can never tell two stories.
   */
  showValue?: boolean
}

/** Progress track + fill (H10 `.h10-util` look). With `tone` + `showValue`: the completeness meter (bar + number). */
export function ProgressBar({ ariaLabel, value = 0, indeterminate, height = 7, className, tone, showValue }: ProgressBarProps) {
  const cls = ['nds-progress', indeterminate ? 'indet' : '', tone ? `tone-${tone}` : '', showValue ? '' : className ?? ''].filter(Boolean).join(' ')
  const measured = value !== null && Number.isFinite(value)
  const clamped = measured ? Math.max(0, Math.min(100, value)) : 0
  const pct = showValue ? Math.round(clamped) : clamped
  const bar = (
    <span
      className={cls}
      style={{ height }}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={indeterminate || !measured ? undefined : pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </span>
  )
  if (!showValue) return bar
  return (
    <span className={['nds-progress-meter', className ?? ''].filter(Boolean).join(' ')}>
      {bar}
      <span className="nds-progress-num" aria-hidden="true">{indeterminate ? '' : measured ? `${pct}%` : '—'}</span>
    </span>
  )
}
