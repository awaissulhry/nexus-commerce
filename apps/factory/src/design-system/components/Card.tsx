import type { ReactNode } from 'react'

export interface CardProps {
  /** padded body (ignored when `header` is set — header layout has its own padding) */
  padded?: boolean
  /** resting card shadow */
  elevated?: boolean
  /** optional header title; renders a bordered head + padded body */
  header?: ReactNode
  /** 9.3 — sub-line under the header title. 105 call sites across the platform wanted one and
   *  had to keep a second Card implementation to get it. Ignored without `header`. */
  description?: ReactNode
  /** optional right-aligned header slot (e.g. an action button) */
  headerAction?: ReactNode
  children?: ReactNode
  className?: string
}

/** Surface container (H10 panel/`.h10-am-card` look). */
export function Card({ padded, elevated, header, description, headerAction, children, className }: CardProps) {
  const cls = ['nds-card', padded && header == null ? 'pad' : '', elevated ? 'shadow' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  if (header != null) {
    // 9.3 — `padded` now also reaches the BODY of a headed card. It previously applied only to
    // headerless cards, so a card with a header always got 16px however it was configured, and
    // a chart or table that needs to meet its own edges could not use this component. Defaults
    // to padded, and no existing caller passes both props, so nothing shifts.
    const body = ['nds-card-body', padded === false ? 'flush' : ''].filter(Boolean).join(' ')
    return (
      <div className={cls}>
        <div className={['nds-card-head', description != null ? 'stacked' : ''].filter(Boolean).join(' ')}>
          {description != null ? (
            <div className="nds-card-headmain">
              <span className="t">{header}</span>
              <span className="d">{description}</span>
            </div>
          ) : (
            <span className="t">{header}</span>
          )}
          {headerAction}
        </div>
        <div className={body}>{children}</div>
      </div>
    )
  }
  return <div className={cls}>{children}</div>
}
