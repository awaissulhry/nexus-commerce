'use client'
import { type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { Kbd } from './Kbd'

// Utility: minimal cn without importing from app layer
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
      <div className="flex max-w-[200px] flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
            {label}
          </span>
          {shortcut && <Kbd className="text-[9px]">{shortcut}</Kbd>}
        </div>
        {description && (
          <span className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">
            {description}
          </span>
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
      className={cx(
        'relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors',
        'text-slate-600 dark:text-slate-400',
        'hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100',
        active === true &&
          'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
        disabled === true &&
          'pointer-events-none opacity-40',
        className,
      )}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-semibold leading-none text-white"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )

  return <Tooltip label={autoTooltip}>{btn}</Tooltip>
}

// ── ToolbarDivider ─────────────────────────────────────────────────────────

/** 1px vertical separator for use between toolbar button groups. */
export function ToolbarDivider() {
  return (
    <div
      aria-hidden
      className="mx-1 h-4 w-px flex-shrink-0 bg-slate-200 dark:bg-slate-700"
    />
  )
}
