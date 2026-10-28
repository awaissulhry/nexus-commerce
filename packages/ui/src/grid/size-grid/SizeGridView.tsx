'use client'

/**
 * SizeGridView (gap G9) — the size grid to read: the editor's layout (colour rows, size columns in scale order, row
 * and column totals, the grand total) with numbers in place of inputs. For an order record, a confirmed quote and a
 * work order. Compact (the cells are text, not touch targets) and print-friendly: no scroll box, no fills and no
 * sticky column on paper, and a row never breaks across pages.
 *
 * A table: size column headers, colour row headers, the totals row in `<tfoot>`. A size the colourway is not made in
 * reads "– not offered"; a quantity of 0 reads 0 (muted). A made-to-measure line (`mtm`) shows "One made-to-measure
 * unit" and `mtmSlot` (the app's profile summary) instead of the grid.
 */
import { useId, useMemo, useRef, type ReactNode } from 'react'

import {
  formatSizeGridQuantity,
  sizeGridCell,
  sizeGridCopy,
  sizeGridTotals,
  sizeGridOffers,
  type SizeGridColour,
  type SizeGridCopy,
  type SizeGridSize,
  type SizeGridValue,
} from './sizeGridModel'
import { SizeGridFoot, SizeGridHead, SizeGridRowHead, SizeGridScroll, useOverflowX } from './sizeGridParts'
import './size-grid.css'

/** A read shows what is stored: only a negative or a non-number is brought to 0. */
const SHOWN_MAX = Number.MAX_SAFE_INTEGER

export interface SizeGridViewProps {
  /** The rows, in the order shown. */
  colours: readonly SizeGridColour[]
  /** The columns, in scale order. */
  sizes: readonly SizeGridSize[]
  value: SizeGridValue
  /** The table's name. Default "Quantities by colour and size". */
  caption?: string
  /** Show the caption above the grid. Default: for screen readers only. */
  showCaption?: boolean
  /** The line is one made-to-measure unit: `mtmSlot` is shown instead of the grid. */
  mtm?: boolean
  /** What a made-to-measure line shows: the app's measurement-profile summary. */
  mtmSlot?: ReactNode
  /** Groups the numbers (`1,248`). Default `en-GB`. */
  locale?: string
  /** The words, for another language. */
  copy?: Partial<SizeGridCopy>
  className?: string
}

export function SizeGridView({ colours, sizes, value, caption, showCaption = false, mtm = false, mtmSlot, locale, copy: copyIn, className }: SizeGridViewProps) {
  const copy = useMemo(() => sizeGridCopy(copyIn), [copyIn])
  const captionId = `${useId()}-caption`
  const scrollRef = useRef<HTMLDivElement>(null)
  const empty = !colours.length || !sizes.length
  const overflowing = useOverflowX(scrollRef, !mtm && !empty)
  const totals = useMemo(() => sizeGridTotals(value, colours, sizes, SHOWN_MAX), [value, colours, sizes])
  const fmt = (n: number) => formatSizeGridQuantity(n, locale)

  return (
    <div className={['nds-size-grid', className].filter(Boolean).join(' ')} data-mode="view">
      {mtm ? (
        <div className="nds-size-grid-mtm-body">
          <p className="nds-size-grid-mtm-title">{copy.mtmSwitch}</p>
          {mtmSlot}
        </div>
      ) : empty ? (
        <p className="nds-size-grid-note">{copy.empty}</p>
      ) : (
        <>
          {/* Shown outside the scroll box, so it never scrolls away with the sizes; the <caption> names the table. */}
          {showCaption ? (
            <p className="nds-size-grid-caption" aria-hidden>
              {caption ?? copy.caption}
            </p>
          ) : null}
          <SizeGridScroll scrollRef={scrollRef} labelledBy={captionId} focusable={overflowing}>
            <table className="nds-size-grid-table">
              <caption id={captionId} className="nds-vh">
                {caption ?? copy.caption}
              </caption>
              <SizeGridHead sizes={sizes} copy={copy} />
              <tbody>
                {colours.map((c) => (
                  <tr key={c.key}>
                    <SizeGridRowHead colour={c} />
                    {sizes.map((s) => {
                      if (!sizeGridOffers(c, s.key)) {
                        return (
                          <td key={s.key} className="nds-size-grid-num nds-size-grid-off">
                            <span aria-hidden>–</span>
                            <span className="nds-vh">{copy.notOffered}</span>
                          </td>
                        )
                      }
                      const q = sizeGridCell(value, c, s.key, SHOWN_MAX)
                      return (
                        <td key={s.key} className="nds-size-grid-num" data-zero={q === 0 ? '' : undefined}>
                          {fmt(q)}
                        </td>
                      )
                    })}
                    <td className="nds-size-grid-num nds-size-grid-total">{fmt(totals.rows[c.key] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
              <SizeGridFoot sizes={sizes} totals={totals} copy={copy} locale={locale} />
            </table>
          </SizeGridScroll>
        </>
      )}
    </div>
  )
}
