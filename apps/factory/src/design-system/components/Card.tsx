import type { HTMLAttributes, ReactNode } from 'react'

// HTMLElement, not HTMLDivElement: the root is a <div> OR a <button> depending on `onClick`, and
// div-specific attributes do not spread onto a button. This is the set common to both, which is
// what a caller actually wants here — title, aria-*, data-*, id, style.
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'> {
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
  /**
   * Makes the whole card a `<button>` — a KPI tile that filters a chart, a card that scrolls to
   * its section. Four surfaces hand-rolled this because `Card` was not interactive and `Button`
   * is not a card (`.hl-tile`, `.rpt-kpi` and two more).
   *
   * ⚠️ A card with an interactive `headerAction` must NOT also take `onClick` — a button inside
   * a button is invalid HTML and browsers resolve it unpredictably. Put the click on the action
   * or on the card, never both.
   */
  onClick?: () => void
  /** engaged state for a tile that toggles something; emits `aria-pressed`. Needs `onClick`. */
  pressed?: boolean
  children?: ReactNode
  className?: string
}

/** Surface container (H10 panel/`.h10-am-card` look). */
export function Card({ padded, elevated, header, description, headerAction, onClick, pressed, children, className, ...rest }: CardProps) {
  const cls = ['nds-card', onClick ? 'btn' : '', padded && header == null ? 'pad' : '', elevated ? 'shadow' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  const Root = onClick ? 'button' : 'div'
  const rootProps = onClick
    ? { type: 'button' as const, onClick, ...(pressed !== undefined ? { 'aria-pressed': pressed } : {}) }
    : {}
  if (header != null) {
    // 9.3 — `padded` now also reaches the BODY of a headed card. It previously applied only to
    // headerless cards, so a card with a header always got 16px however it was configured, and
    // a chart or table that needs to meet its own edges could not use this component. Defaults
    // to padded, and no existing caller passes both props, so nothing shifts.
    const body = ['nds-card-body', padded === false ? 'flush' : ''].filter(Boolean).join(' ')
    return (
      <Root className={cls} {...rootProps} {...rest}>
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
      </Root>
    )
  }
  return (
    <Root className={cls} {...rootProps} {...rest}>
      {children}
    </Root>
  )
}
