'use client'

/**
 * GDS — where a grid lives.
 *
 * `GridCard` — a PAGE host: the DS grid card (toolbar strip → grid → pager), the grid is
 * `autoHeight` and the page scrolls (decision 4). The card is a size container, so a toolbar's
 * selection cluster can adapt to the card's width with a container query instead of wrapping.
 *
 * `GridPanel` — a MODAL / DRAWER host: the same card, but the grid inside is bounded (the caller
 * passes `height`), because a dialog cannot hand scrolling to the page. The inventory editor is
 * the reference: strip → header → rows → totals row → footer strip, capped at 480.
 *
 * The grid itself never knows which host it is in — the card only removes the grid's own frame
 * (`grid.css`, `.nds-gridcard .nds-ag-wrap .ag-root-wrapper`).
 */
import { memo, type ReactNode } from 'react'

export interface GridCardProps {
  /** The `GridToolbar` (or nothing). */
  toolbar?: ReactNode
  children: ReactNode
  /** `GridPager` on a page, `GridFooterStrip` in an editor. */
  footer?: ReactNode
  className?: string
}

export const GridCard = memo(function GridCard({ toolbar, children, footer, className }: GridCardProps) {
  return (
    <div className={['nds-gridcard', 'nds-grid-card', className].filter(Boolean).join(' ')}>
      {toolbar}
      {children}
      {footer}
    </div>
  )
})

export const GridPanel = memo(function GridPanel({ toolbar, children, footer, className }: GridCardProps) {
  return (
    <div className={['nds-gridcard', 'nds-grid-panel', className].filter(Boolean).join(' ')}>
      {toolbar}
      {children}
      {footer}
    </div>
  )
})
