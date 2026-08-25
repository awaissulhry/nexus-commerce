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
  /**
   * Where the tooltip bubble sits relative to the button. `'end'` right-aligns it, for a button
   * flush against a container edge where a centred bubble would overflow. Declared rather than
   * detected: `Tooltip` is in-flow by design, and the places this is needed (the last button of a
   * right-aligned toolbar) know it statically.
   */
  tooltipAlign?: 'center' | 'end'
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
  tooltipAlign,
}: ToolbarButtonProps) {
  const autoTooltip: ReactNode =
    tooltipContent ?? (
      <div className="nds-tbtn-tip">
        <div className="nds-tbtn-tip-head">
          <span className="nds-tbtn-tip-label">{label}</span>
          {shortcut && <Kbd className="nds-tbtn-kbd">{shortcut}</Kbd>}
        </div>
        {description && (
          <span className="nds-tbtn-tip-desc">{description}</span>
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
      className={cx('nds-tbtn', className)}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span
          aria-hidden
          className="nds-tbtn-badge"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )

  return <Tooltip label={autoTooltip} className={`nds-tooltip--light${tooltipAlign === 'end' ? ' nds-tooltip--end' : ''}`}>{btn}</Tooltip>
}

// ── ToolbarDivider ─────────────────────────────────────────────────────────

/** 1px vertical separator for use between toolbar button groups. */
export function ToolbarDivider() {
  return (
    <div
      aria-hidden
      className="nds-tdivider"
    />
  )
}
