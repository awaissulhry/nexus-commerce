'use client'

/**
 * ToolbarButton — the DS's icon button, filed from the TB top-bar gap.
 *
 * `.nds-tbtn` has existed in primitives.css since the grid toolbar work, but no component owned
 * it, so every consumer hand-rolled `<button className="nds-tbtn">`. That is what the
 * raw-primitive ratchet exists to stop: a hand-rolled control arrives with none of the
 * accessibility the DS carries, and the sweep that produced that ratchet found unlabelled icon
 * buttons at 1.89:1.
 *
 * `label` is REQUIRED and becomes both `aria-label` and the tooltip. An icon button has no
 * accessible name otherwise, and making it optional is exactly how the unlabelled ones happened.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface ToolbarButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  /** The icon. Sized by the caller — the DS does not second-guess a 14px vs 16px glyph. */
  icon: ReactNode
  /** Accessible name AND tooltip. Required: an icon alone names nothing. */
  label: string
  /** Count badge (notifications). Omitted or 0 renders nothing rather than a "0" pill. */
  badge?: number
  className?: string
}

export function ToolbarButton({ icon, label, badge, className, ...rest }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`nds-tbtn${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span className="nds-tbtn-badge" aria-hidden="true">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}
