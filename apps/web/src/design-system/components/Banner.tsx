'use client'

/**
 * Banner — an inline, page-level status message (info / warning / error / success).
 * A soft tinted surface with a strong left accent and a variant-tinted icon, plus an
 * optional title, description, trailing action slot, and dismiss control. The console
 * was hand-rolling these ad-hoc; this is the one tokenized callout. Distinct from Toast
 * (transient, floating) — Banner is persistent and lives in the layout flow.
 * Requires `styles/components.css`.
 */
import type { ReactNode } from 'react'
import { Info, AlertTriangle, AlertCircle, CheckCircle2, X } from 'lucide-react'

export type BannerVariant = 'info' | 'warning' | 'error' | 'success'

export interface BannerProps {
  variant?: BannerVariant
  /** Bold lead line. */
  title?: ReactNode
  /** Description body — the explanatory copy under the title. */
  children?: ReactNode
  /** Override the default per-variant lucide icon. */
  icon?: ReactNode
  /** Trailing action slot (e.g. a Button or link). */
  action?: ReactNode
  /** Show a dismiss (×) control and call this when clicked. */
  onDismiss?: () => void
}

const DEFAULT_ICON: Record<BannerVariant, ReactNode> = {
  info: <Info size={18} aria-hidden />,
  warning: <AlertTriangle size={18} aria-hidden />,
  error: <AlertCircle size={18} aria-hidden />,
  success: <CheckCircle2 size={18} aria-hidden />,
}

export function Banner({ variant = 'info', title, children, icon, action, onDismiss }: BannerProps) {
  return (
    <div className={`h10-ds-banner ${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
      <span className="h10-ds-banner-icon">{icon ?? DEFAULT_ICON[variant]}</span>
      <div className="h10-ds-banner-body">
        {title && <div className="h10-ds-banner-title">{title}</div>}
        {children && <div className="h10-ds-banner-desc">{children}</div>}
      </div>
      {action && <div className="h10-ds-banner-action">{action}</div>}
      {onDismiss && (
        <button type="button" className="h10-ds-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={15} aria-hidden />
        </button>
      )}
    </div>
  )
}
