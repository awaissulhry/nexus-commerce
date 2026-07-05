export interface ProgressBarProps {
  /** 0–100 (ignored when `indeterminate`) */
  value?: number
  indeterminate?: boolean
  /** track height in px (default 7) */
  height?: number
  className?: string
}

/** Progress track + fill (H10 `.h10-util` look). */
export function ProgressBar({ value = 0, indeterminate, height = 7, className }: ProgressBarProps) {
  const cls = ['h10-ds-progress', indeterminate ? 'indet' : '', className ?? ''].filter(Boolean).join(' ')
  const pct = Math.max(0, Math.min(100, value))
  return (
    <span
      className={cls}
      style={{ height }}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </span>
  )
}
