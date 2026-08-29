'use client'

/**
 * GDS — `GridSheet`: the SHEET host (decision Q15, 2026-08-28).
 *
 * A list is a page of rows the pager selects and the page scrolls (decision 4). A SHEET is not a
 * list: an operator pastes 2,000 rows into it, fills a column down, tabs across forty attributes.
 * Nobody pastes into page 3 of 4. So this is the one page-level host that is BOUNDED and
 * VIRTUALISED: it fills the viewport below its own top edge, the grid inside scrolls both ways,
 * and every row that exists is reachable by keyboard without a pager.
 *
 *   <GridSheet toolbar={<GridToolbar … />} footer={<GridSheetStatus … />}>
 *     <NexusGrid fill {...SHEET_GRID_OPTIONS} rowData={rows} columnDefs={cols} … />
 *   </GridSheet>
 *
 * `fill` makes the grid take the sheet's remaining height; `SHEET_GRID_OPTIONS` is the editing
 * contract every sheet shares (cell focus, F2 / Enter / Tab, fill handle, clipboard, undo/redo).
 * The default density is COMPACT — a sheet is read like a spreadsheet, and the inventory editor's
 * per-cell states (`.nds-cell-is-pending` / `-saving` / `-saved` / `-refused`) are its states.
 */
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import type { GridDensityName } from '../../tokens/grid'
import { GridDensityProvider } from '../hooks/useGridDensity'

export interface GridSheetProps {
  toolbar?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Spreadsheet rows read best compact; a page may choose otherwise. */
  density?: GridDensityName
  /** Space to leave below the sheet (the page's bottom gutter). Default 24. */
  gutter?: number
  /**
   * A fixed height instead of "the viewport below me" — for a sheet EMBEDDED in a page that keeps
   * scrolling (a lab, a wizard step). A page whose content IS the sheet leaves this unset.
   */
  height?: number | string
  className?: string
}

export const GridSheet = memo(function GridSheet({ toolbar, children, footer, density = 'compact', gutter = 24, height, className }: GridSheetProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)

  // The sheet's height is "the viewport below me". Its top edge moves when the page above it
  // reflows (a KPI strip collapses, a banner appears), so it is measured, not assumed.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || height !== undefined) return
    const measure = () => setTop(Math.round(el.getBoundingClientRect().top + window.scrollY))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [height])

  const style = {
    ['--nds-grid-sheet-top' as string]: `${top}px`,
    ['--nds-grid-sheet-gutter' as string]: `${gutter}px`,
    ...(height !== undefined ? { height: typeof height === 'number' ? `${height}px` : height } : {}),
  } as CSSProperties
  return (
    <GridDensityProvider value={density}>
      <div ref={ref} className={['nds-gridcard', 'nds-grid-sheet', className].filter(Boolean).join(' ')} style={style}>
        {toolbar}
        {children}
        {footer}
      </div>
    </GridDensityProvider>
  )
})

/**
 * The editing contract of a sheet. Spread into `<NexusGrid>` — a spread is one stable object, so
 * the option-identity guard is satisfied and every sheet behaves the same:
 *   click selects a cell · typing / F2 / Enter edits · Enter commits and moves DOWN · Tab moves
 *   RIGHT · Esc reverts · a range drags with the fill handle · ⌘C / ⌘V move cells · ⌘Z / ⌘⇧Z.
 */
export const SHEET_GRID_OPTIONS = {
  suppressCellFocus: false,
  enterNavigatesVertically: true,
  enterNavigatesVerticallyAfterEdit: true,
  stopEditingWhenCellsLoseFocus: true,
  undoRedoCellEditing: true,
  undoRedoCellEditingLimit: 200,
  cellSelection: { handle: { mode: 'fill' as const } },
  suppressScrollOnNewData: true,
} as const

export interface GridSheetStatusProps {
  rows: number
  selected?: number
  /** Cells edited and not yet on the server. */
  pending?: number
  /** Cells the server refused. */
  refused?: number
  saving?: boolean
  /** ISO string of the last successful save. */
  lastSavedAt?: string | null
  children?: ReactNode
}

/** The strip under a sheet: what is on it, what is unsaved, what the server said. */
export const GridSheetStatus = memo(function GridSheetStatus({ rows, selected = 0, pending = 0, refused = 0, saving = false, lastSavedAt, children }: GridSheetStatusProps) {
  return (
    <div className="nds-grid-footstrip nds-grid-sheet-status" role="status" aria-live="polite">
      <span>
        <b>{rows.toLocaleString('en-GB')}</b> {rows === 1 ? 'row' : 'rows'}
        {selected > 0 && (
          <>
            {' · '}
            <b>{selected}</b> selected
          </>
        )}
      </span>
      {(pending > 0 || saving) && (
        <span className="nds-grid-sheet-status-pending">
          {saving ? 'Saving…' : `${pending} unsaved ${pending === 1 ? 'cell' : 'cells'}`}
        </span>
      )}
      {refused > 0 && (
        <span className="nds-grid-sheet-status-refused">
          {refused} refused — hover a red cell for why
        </span>
      )}
      <span className="nds-grid-footstrip-grow" />
      {children}
      {lastSavedAt && !saving && pending === 0 && <span className="nds-cell-muted">Saved {new Date(lastSavedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
    </div>
  )
})
