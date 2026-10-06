import type { ReactNode } from 'react'
import { Button } from '@/design-system/primitives'

export interface EditModeBarProps {
  /** custom message; defaults to "N unsaved change(s)" from `count` */
  message?: ReactNode
  count?: number
  onDiscard?: () => void
  onApply?: () => void
  applyLabel?: ReactNode
  busy?: boolean
  /** Hold Apply alone (a check still running, a problem to fix first); Discard stays available. */
  applyDisabled?: boolean
}

/** Sticky discard/apply bar for unsaved edits (H10 `.h10-am-editbar`). */
export function EditModeBar({ message, count, onDiscard, onApply, applyLabel = 'Apply changes', busy, applyDisabled }: EditModeBarProps) {
  const label =
    message ??
    (count != null ? (
      <>
        <b>{count}</b> unsaved {count === 1 ? 'change' : 'changes'}
      </>
    ) : (
      'Unsaved changes'
    ))
  return (
    <div className="nds-actionbar" role="region" aria-label="Edit mode">
      <span className="lbl">{label}</span>
      <span className="grow" />
      <span className="acts">
        {onDiscard && (
          <Button onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        )}
        {onApply && (
          <Button variant="primary" onClick={onApply} disabled={busy || applyDisabled}>
            {applyLabel}
          </Button>
        )}
      </span>
    </div>
  )
}
