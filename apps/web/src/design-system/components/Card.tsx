import type { ReactNode } from 'react'

export interface CardProps {
  /** padded body (ignored when `header` is set — header layout has its own padding) */
  padded?: boolean
  /** resting card shadow */
  elevated?: boolean
  /** optional header title; renders a bordered head + padded body */
  header?: ReactNode
  /** optional right-aligned header slot (e.g. an action button) */
  headerAction?: ReactNode
  children?: ReactNode
  className?: string
}

/** Surface container (H10 panel/`.h10-am-card` look). */
export function Card({ padded, elevated, header, headerAction, children, className }: CardProps) {
  const cls = ['h10-ds-card', padded && header == null ? 'pad' : '', elevated ? 'shadow' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  if (header != null) {
    return (
      <div className={cls}>
        <div className="h10-ds-card-head">
          <span className="t">{header}</span>
          {headerAction}
        </div>
        <div className="h10-ds-card-body">{children}</div>
      </div>
    )
  }
  return <div className={cls}>{children}</div>
}
