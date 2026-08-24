'use client'
import { type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { Kbd } from './Kbd'

// Utility: minimal cn without importing from app layer. Kept for the caller's
// optional `className`; every state (hover / pressed / disabled) is CSS, keyed off
// :hover, [aria-pressed] and :disabled so the visual cannot drift from the a11y tree.
function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

// ── ToolbarButton ──────────────────────────────────────────────────────────

export interface ToolbarButtonProps {
  icon: ReactNode
  /** aria-label + default tooltip heading */
  label: string
  /** tooltip body text */
  description?: string
  /** keyboard shortcut shown in tooltip, e.g. '⌘F' */
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  /** pressed / highlighted state */
  active?: boolean
  /** blue count badge top-right, capped at 99+ */
  badge?: number
  className?: string
  /** override auto-generated tooltip content */
  tooltipContent?: ReactNode
}

export function ToolbarButton({
  icon,
  label,
  description,
  shortcut,
  onClick,
  disabled,
  active,
  badge,
  className,
  tooltipContent,
}: ToolbarButtonProps) {
  const autoTooltip: ReactNode =
    tooltipContent ?? (
      <div className="h10-ds-tbtn-tip">
        <div className="h10-ds-tbtn-tip-head">
          <span className="h10-ds-tbtn-tip-label">{label}</span>
          {shortcut && <Kbd className="h10-ds-tbtn-kbd">{shortcut}</Kbd>}
        </div>
        {description && (
          <span className="h10-ds-tbtn-tip-desc">{description}</span>
        )}
      </div>
    )

  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      className={cx('h10-ds-tbtn', className)}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span
          aria-hidden
          className="h10-ds-tbtn-badge"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )

  return <Tooltip label={autoTooltip} className="h10-ds-tooltip--light">{btn}</Tooltip>
}

// ── ToolbarDivider ─────────────────────────────────────────────────────────

/** 1px vertical separator for use between toolbar button groups. */
export function ToolbarDivider() {
  return (
    <div
      aria-hidden
      className="h10-ds-tdivider"
    />
  )
}
