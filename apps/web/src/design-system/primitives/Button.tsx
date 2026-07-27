import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `secondary` (white + border) is the base look; `primary` = blue fill; `ghost` = blue outline;
   *  `danger` = red fill for irreversible/live-write actions (call sites were hand-rolling
   *  `!bg-red-600` overrides, which drifted apart and beat every token). */
  variant?: ButtonVariant
  size?: ButtonSize
  children?: ReactNode
}

/**
 * The canonical button. Matches the H10 action button (.h10-am-btn) spec,
 * tokenized. Requires `styles/primitives.css`.
 */
export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonProps) {
  const cls = ['h10-ds-btn', variant === 'secondary' ? '' : variant, size === 'sm' ? 'sm' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  )
}
