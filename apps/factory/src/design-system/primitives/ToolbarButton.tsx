'use client'
import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { Kbd } from './Kbd'

// Utility: minimal cn without importing from app layer. Kept for the caller's
// optional `className`; every state (hover / pressed / disabled) is CSS, keyed off
// :hover, [aria-pressed] and :disabled so the visual cannot drift from the a11y tree.
function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

// ── ToolbarButton ──────────────────────────────────────────────────────────

export interface ToolbarButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'onClick'> {
  icon: ReactNode
  /** aria-label + default tooltip heading */
  label: string
  /** tooltip body text */
  description?: string
  /** keyboard shortcut shown in tooltip, e.g. '⌘F' */
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  /**
   * Pressed / highlighted state, emitted as `aria-pressed`.
   *
   * SUPPRESSED when the caller passes `aria-expanded`. An icon button that opens a panel is a
   * DISCLOSURE, not a toggle, and a control announcing both roles at once is worse than one
   * announcing neither. This used to be hard-coded, so every expander converted to this component
   * silently lost its disclosure semantics — pass `aria-expanded` and it does the right thing.
   */
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
  /**
   * `bare` (default) is the existing look: no border, no fill, 28x28, `--nds-text-2`.
   * `boxed` adds the surface + border the ads console hand-rolls three ways (`.az-iconbtn` 34px,
   * `.h10-sug-iconbtn` and `.rec-iconbtn` 28px). Measured 2026-08-25 — the DS had no boxed
   * icon button, which is why three pages each invented one.
   */
  variant?: 'bare' | 'boxed'
  /** `sm` is 24x24 rather than 28x28, for a dense action column. */
  size?: 'md' | 'sm'
  /**
   * `danger` turns the HOVER red. For a button whose only cue that it destroys something is that
   * colour — `.del`, `.mbrm`, `.strm`. Their wash measured 5.94:1; the DS note-error pair is
   * 9.23:1.
   */
  tone?: 'neutral' | 'danger'
  /**
   * Wrap in a `Tooltip`. Default true, matching every existing call site.
   *
   * Pass `false` for an icon button whose meaning is already obvious (a `x` close, a `-` remove).
   * `Tooltip` renders a real `display: inline-flex` wrapper element, so adding one around a
   * button that is a flex child or absolutely positioned can move it — and the 43 `.x`/`.rm`
   * buttons in the ads console are exactly that. The `label` is still required and still becomes
   * the `aria-label`: opting out of the bubble never opts out of the accessible name.
   */
  tooltip?: boolean
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
  variant = 'bare',
  size = 'md',
  tone = 'neutral',
  tooltip = true,
  ...rest
}: ToolbarButtonProps) {
  const isDisclosure = rest['aria-expanded'] !== undefined
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
      {...(active !== undefined && !isDisclosure ? { 'aria-pressed': active } : {})}
      className={cx('nds-tbtn', variant === 'boxed' && 'boxed', size === 'sm' && 'sm', tone === 'danger' && 'danger', className)}
      {...rest}
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

  if (!tooltip) return btn
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
