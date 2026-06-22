export interface SpinnerProps {
  /** diameter in px (default 16) */
  size?: number
  className?: string
}

/** Indeterminate ring spinner (H10 `@keyframes h10spin`). */
export function Spinner({ size = 16, className }: SpinnerProps) {
  return (
    <span
      className={['h10-ds-spinner', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  )
}
