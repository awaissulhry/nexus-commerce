import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import type { Tone } from './tone'

export interface PillProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onClick'> {
  /** Active→success · Paused→warning · Archived→neutral · Error→danger */
  tone: Tone
  /**
   * Makes the pill a `<button>` — a status that is also the control that changes it.
   *
   * The eBay rules list hand-rolled `<button className="h10-pill ok">` with an inline
   * `border: none` to toggle PROPOSE ↔ AUTOPILOT, because a pill was a `<span>` and a `Button`
   * is not a pill. Same shape as `Card`'s `onClick`.
   */
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  /** Engaged state for a pill that toggles; emits `aria-pressed`. Needs `onClick`. */
  pressed?: boolean
  disabled?: boolean
  children: ReactNode
}

/** Status pill — matches the H10 `.h10-pill`. Becomes a button when given `onClick`. */
export function Pill({ tone, onClick, pressed, disabled, className, children, ...rest }: PillProps) {
  const cls = `nds-pill ${tone}${onClick ? ' btn' : ''}${className ? ` ${className}` : ''}`
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        disabled={disabled}
        {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {children}
      </button>
    )
  }
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  )
}
