'use client'

/**
 * The pieces `SizeGridEditor` and `SizeGridView` share, so the two draw one layout: the header row, the row header
 * (swatch + colour), the totals row, the issue list and the horizontal scroll area. Not exported from the barrel.
 */
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { AlertCircle, AlertTriangle } from 'lucide-react'

import { Button } from '../../primitives/Button'
import type { SizeGridColour, SizeGridCopy, SizeGridIssue, SizeGridIssueTone, SizeGridSize, SizeGridTotals } from './sizeGridModel'
import { formatSizeGridQuantity } from './sizeGridModel'

/** The colourway's own colour as a small chip. Decorative: the colour's name is the row header's text. */
export function SizeGridSwatch({ colour }: { colour: SizeGridColour }) {
  if (!colour.swatch) return null
  return <span className="nds-size-grid-swatch" style={{ background: colour.swatch }} aria-hidden />
}

/** An outline glyph per tone: identity is the shape, never only the colour. */
export function SizeGridIssueGlyph({ tone, size = 12 }: { tone: SizeGridIssueTone; size?: number }) {
  const Icon = tone === 'error' ? AlertCircle : AlertTriangle
  return <Icon size={size} aria-hidden className="nds-size-grid-glyph" />
}

export function SizeGridHead({ sizes, copy }: { sizes: readonly SizeGridSize[]; copy: SizeGridCopy }) {
  return (
    <thead>
      <tr>
        <th scope="col" className="nds-size-grid-corner">
          {copy.colourHeader}
        </th>
        {sizes.map((s) => (
          <th key={s.key} scope="col" className="nds-size-grid-colhead">
            {s.label}
          </th>
        ))}
        <th scope="col" className="nds-size-grid-colhead nds-size-grid-total">
          {copy.totalHeader}
        </th>
      </tr>
    </thead>
  )
}

export function SizeGridRowHead({ colour, describedBy, tone }: { colour: SizeGridColour; describedBy?: string; tone?: SizeGridIssueTone | null }) {
  return (
    <th scope="row" className="nds-size-grid-rowhead" aria-describedby={describedBy} data-tone={tone ?? undefined}>
      <span className="nds-size-grid-rowlabel">
        <SizeGridSwatch colour={colour} />
        <span className="nds-size-grid-rowtext">{colour.label}</span>
        {tone ? <SizeGridIssueGlyph tone={tone} /> : null}
      </span>
    </th>
  )
}

export function SizeGridFoot({ sizes, totals, copy, locale }: { sizes: readonly SizeGridSize[]; totals: SizeGridTotals; copy: SizeGridCopy; locale?: string }) {
  return (
    <tfoot>
      <tr>
        <th scope="row" className="nds-size-grid-rowhead">
          {copy.totalHeader}
        </th>
        {sizes.map((s) => (
          <td key={s.key} className="nds-size-grid-num nds-size-grid-total">
            {formatSizeGridQuantity(totals.columns[s.key] ?? 0, locale)}
          </td>
        ))}
        <td className="nds-size-grid-num nds-size-grid-total nds-size-grid-grand">{formatSizeGridQuantity(totals.grand, locale)}</td>
      </tr>
    </tfoot>
  )
}

/** One issue line as the list shows it. `onGo` (a cell that takes focus) turns the cell's name into a link-button. */
export interface SizeGridIssueLine {
  id: string
  issue: SizeGridIssue
  where: string
  onGo?: () => void
}

export function SizeGridIssueList({ lines, heading }: { lines: readonly SizeGridIssueLine[]; heading: string }) {
  if (!lines.length) return null
  return (
    <div className="nds-size-grid-issues">
      <span className="nds-vh">{heading}</span>
      <ul>
        {lines.map(({ id, issue, where, onGo }) => {
          const tone = issue.tone ?? 'error'
          return (
            <li key={id} data-tone={tone}>
              <SizeGridIssueGlyph tone={tone} size={14} />
              <span>
                {onGo ? (
                  <Button variant="link" inline onClick={onGo}>
                    {where}
                  </Button>
                ) : (
                  <span className="nds-size-grid-where">{where}</span>
                )}
                {': '}
                <span id={id}>{issue.message}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * True while the element is wider inside than outside. A scroll area that scrolls takes a Tab stop (keyboard users
 * can then scroll it); one that does not scroll takes none. `shown` re-measures when the area mounts again (the
 * made-to-measure switch hides it).
 */
export function useOverflowX(ref: RefObject<HTMLElement | null>, shown = true): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!shown || !el || typeof ResizeObserver === 'undefined') return
    const measure = () => setOver(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => ro.disconnect()
  }, [ref, shown])
  return over
}

/** The horizontal scroll area around the table: the page never scrolls sideways, the grid does. */
export function SizeGridScroll({ scrollRef, labelledBy, focusable, children }: { scrollRef: RefObject<HTMLDivElement | null>; labelledBy: string; focusable: boolean; children: ReactNode }) {
  return (
    <div ref={scrollRef} className="nds-size-grid-scroll" role="region" aria-labelledby={labelledBy} tabIndex={focusable ? 0 : undefined}>
      {children}
    </div>
  )
}
