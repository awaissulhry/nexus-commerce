import type { ReactNode } from 'react'

export interface TooltipProps {
  /** tooltip text/content shown above the trigger on hover/focus */
  label: ReactNode
  className?: string
  children: ReactNode
}

/**
 * Lightweight CSS hover/focus tooltip (H10 `.h10-tip` look: dark bubble +
 * arrow). For the adaptive portal-positioned info tooltip see the Phase 4
 * InfoTip component. Wrap a focusable trigger so keyboard users get it too.
 */
export function Tooltip({ label, className, children }: TooltipProps) {
  return (
    <span className={`h10-ds-tooltip${className ? ` ${className}` : ''}`}>
      {children}
      <span className="tip" role="tooltip">
        {label}
      </span>
    </span>
  )
}
