'use client'

/**
 * GDS — the full-width row under an open product family: the count ("Showing 10 of 40 variations", or "3 variations"
 * when every one is on screen), an optional second muted line, and the action at the end ("View all 40"). Moved out of
 * /products (`app/products/next/FamilyFooter.tsx`) so Products and Listing readiness say it in the same words and draw
 * it the same way (Listing readiness rebuild, 2026-10-23).
 *
 * The host owns the data and the action; this owns the sentence and the frame. Render it from AG's
 * `fullWidthCellRenderer`, on a row `gridGeometry.footerRowH` tall; the line centres in it.
 *
 *   <FamilyFooterFrame shown={10} total={40}
 *     action={<Button asChild size="sm" variant="secondary"><a href={…}>View all 40</a></Button>} />
 *
 * Flush left, deliberately. Indenting it to line up with the child rows sounds tidier and is not: a child's content
 * sits behind the selection column, the cell padding, a chevron slot and a thumbnail, and all of them move with the
 * density tier — any such number is a constant that goes wrong at one of three densities. The family's tint already
 * says this row belongs to the rows above it. Styles: `.nds-grid-famfoot*` in `theme/grid.css`.
 */
import type { ReactNode } from 'react'

export interface FamilyFooterFrameProps {
  /** Rows of the family on screen. */
  shown: number
  /** Rows in the family. More than `shown` = capped: "Showing <shown> of <total> …". */
  total: number
  /** What the rows are, plural. Default "variations". */
  noun?: string
  /** The singular, for a family of one. Default "variation" with the default noun; pass it with your own `noun`. */
  nounOne?: string
  /** A second muted line after the count (Products: "Variation mapping · …"). */
  extra?: ReactNode
  /** Hover text of `extra`. */
  extraTitle?: string
  /** At the end of the row: the way to the whole family. */
  action?: ReactNode
}

export function FamilyFooterFrame({ shown, total, noun, nounOne, extra, extraTitle, action }: FamilyFooterFrameProps) {
  const plural = noun ?? 'variations'
  const one = nounOne ?? (noun == null ? 'variation' : noun)
  return (
    <div className="nds-grid-famfoot">
      <span className="nds-grid-famfoot-count">
        {total > shown ? (
          <>Showing <b>{shown}</b> of <b>{total}</b>{` ${plural}`}</>
        ) : (
          <><b>{total}</b> {total === 1 ? one : plural}</>
        )}
      </span>
      {extra != null && <span className="nds-grid-famfoot-count" title={extraTitle}>{extra}</span>}
      {action}
    </div>
  )
}
