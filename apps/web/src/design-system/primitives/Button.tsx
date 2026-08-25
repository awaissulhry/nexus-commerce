import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `secondary` (white + border) is the base look; `primary` = blue fill; `ghost` = blue outline;
   *  `danger` = red fill for irreversible/live-write actions (call sites were hand-rolling
   *  `!bg-red-600` overrides, which drifted apart and beat every token). */
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * Defaults to `'button'`, NOT the HTML default of `'submit'`.
   *
   * A design-system button that submits the nearest form unless told otherwise is a footgun: it
   * behaves correctly in isolation and reloads the page the day someone wraps it in a `<form>`.
   * Every call site that genuinely submits says so with `type="submit"`.
   */
  children?: ReactNode
}

/**
 * The canonical button. Matches the H10 action button (.h10-am-btn) spec,
 * tokenized. Requires `styles/primitives.css`.
 */
export function Button({ variant = 'secondary', size = 'md', type = 'button', className, children, ...rest }: ButtonProps) {
  const cls = ['nds-btn', variant === 'secondary' ? '' : variant, size === 'sm' ? 'sm' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  )
}
