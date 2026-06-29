import type { ReactNode } from 'react'

export interface BulkActionBarProps {
  count: number
  /** action buttons for the selection */
  children: ReactNode
  onClear?: () => void
  /** noun after the count (default "selected") */
  noun?: string
  className?: string
}

/**
 * Sticky bar for a selection (H10 `.h10-am-editbar`/bulk row). Renders nothing
 * when `count` is 0. Place at the bottom of a scroll container.
 */
export function BulkActionBar({ count, children, onClear, noun = 'selected', className }: BulkActionBarProps) {
  if (count <= 0) return null
  return (
    <div className={`h10-ds-actionbar${className ? ` ${className}` : ''}`} role="region" aria-label="Bulk actions">
      <span className="lbl">
        <b>{count}</b> {noun}
      </span>
      <span className="grow" />
      <span className="acts">
        {children}
        {onClear && (
          <button type="button" className="h10-ds-actionbar-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </span>
    </div>
  )
}
