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
  /**
   * Leading status dot, in the pill's own tone.
   *
   * For a pill reporting the health of something CONTINUOUS — a feed that is live or stalled, a
   * connection, a sync — where the dot is what the eye reads before the word. Surfaces were
   * hand-rolling a chip-plus-dot because a Pill was text-only, and a hand-rolled one keeps its
   * green while the thing it describes is broken.
   */
  dot?: boolean
  /**
   * `md` sizes the pill to sit in a TOOLBAR beside `sm` buttons (28px, pill radius) rather than
   * inside a table cell. Default `sm` is the in-cell status chip every existing consumer gets.
   */
  size?: 'sm' | 'md'
  children: ReactNode
}

/** Status pill — matches the H10 `.h10-pill`. Becomes a button when given `onClick`. */
export function Pill({ tone, onClick, pressed, disabled, dot, size, className, children, ...rest }: PillProps) {
  const cls = `nds-pill ${tone}${onClick ? ' btn' : ''}${dot ? ' has-dot' : ''}${size === 'md' ? ' md' : ''}${className ? ` ${className}` : ''}`
  const body = dot ? (
    <>
      <span className="dot" aria-hidden />
      {children}
    </>
  ) : (
    children
  )
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
        {body}
      </button>
    )
  }
  return (
    <span className={cls} {...rest}>
      {body}
    </span>
  )
}
