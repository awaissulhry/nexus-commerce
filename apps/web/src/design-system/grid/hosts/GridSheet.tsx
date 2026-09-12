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
import { memo, useRef, type CSSProperties, type ReactNode } from 'react'

import type { GridDensityName } from '../../tokens/grid'
import { GridDensityProvider } from '../hooks/useGridDensity'
import { GridToastBoundary } from './GridToastBoundary'
import { useGridHostTop } from '../hooks/useGridHostTop'

export interface GridSheetProps {
  toolbar?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Spreadsheet rows read best compact; a page may choose otherwise. */
  density?: GridDensityName
  /**
   * Space to leave below the sheet (the page's bottom gutter). Default 8.
   *
   * 🔴 This prop is the DEFAULT, not `grid.css`'s `var(…, 8px)` fallback — the host always writes
   * the variable, so that fallback only ever applies to markup that does not use this component.
   * Changing the CSS alone moved nothing on screen, which is the invented-default shape again: a
   * fix to a default is not done until you have grepped for the default rather than the call site.
   *
   * 8, not 24: §2.2 wants 74.8% of the viewport in rows, and 16px of the last 20 in the whole §2
   * budget was sitting under a full-bleed sheet that has no bottom gutter to spend. A host inside a
   * padded shell can pass its own back.
   */
  gutter?: number
  /**
   * A fixed height instead of "the viewport below me" — for a sheet EMBEDDED in a page that keeps
   * scrolling (a lab, a wizard step). A page whose content IS the sheet leaves this unset.
   */
  height?: number | string
  className?: string
}

export const GridSheet = memo(function GridSheet({ toolbar, children, footer, density = 'compact', gutter = 8, height, className }: GridSheetProps) {
  const ref = useRef<HTMLDivElement>(null)
  const top = useGridHostTop(ref, height === undefined)

  const style = {
    ['--nds-grid-sheet-top' as string]: `${top}px`,
    ['--nds-grid-sheet-gutter' as string]: `${gutter}px`,
    ...(height !== undefined ? { height: typeof height === 'number' ? `${height}px` : height } : {}),
  } as CSSProperties
  return (
    <GridDensityProvider value={density}>
      {/* Ruling #22: a host provides the toast context, so adopting the grid never requires the
          page to remember one. See GridToastBoundary for why nesting is harmless. */}
      <GridToastBoundary>
        <div ref={ref} className={['nds-gridcard', 'nds-grid-sheet', className].filter(Boolean).join(' ')} style={style}>
          {toolbar}
          {children}
          {footer}
        </div>
      </GridToastBoundary>
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
  /**
   * 🔴 AG.1 (hub ruling #185, layout spec §7.3) — `false`, and the pair is deliberate.
   *
   * AG treats these two as one Excel-style setting, but its source reads them in different places
   * (`main.esm.mjs:29500` and `:43528`), so they are independent in practice — measured, not
   * assumed. With `enterNavigatesVertically: true` a focused cell's Enter navigates DOWN and
   * **never opens the editor**: editing could then start only by TYPING (which replaces the value
   * with the typed character), by F2 (which nobody guesses), or by double-click (which also opened
   * the record drawer until §7.3 retired that). So the sheet had no discoverable, non-destructive
   * way to edit a cell — the Owner's "editing is really complicated", measured on GALE-JACKET.
   *
   * `false` gives the spreadsheet contract the footer already advertises: **Enter on a focused cell
   * starts editing with the value intact**, and `enterNavigatesVerticallyAfterEdit` (which AG
   * checks on its own, after an edit stops) still commits and moves down. ↓/↑ remain the pure
   * navigation keys.
   *
   * Enter on a NON-editable cell is then free to mean something else, which is what lets the
   * identity cell open the record (`sku.editable === false`, so there is no competing owner).
   */
  enterNavigatesVertically: false,
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
      {/* 🔴 The hover-only refusal string is GONE (§6.2 rule 1, DS.2's filing). It read
          "{refused} refused — hover a red cell for why": a count of failed work whose REASON was
          reachable only by hovering individual cells, one at a time, with no way to see which ones.
          That is the honesty rule's exact prohibition, and it sat in the grid host — so every sheet
          inherited it, not just the studio.

          The count still shows below, next to the other tallies. The REASON and the way to act on it
          now live in the footer's note slot (`GridSheetNote kind="refusal"`), where the host's
          consumer mounts it with a required `onShow` that narrows the sheet to the affected rows.

          The COUNT stays here beside the other tallies — a bare number was never the problem, the
          instruction attached to it was. (I nearly shipped this comment claiming the count still
          rendered while having deleted it; `refused` going unused is what gave that away.) */}
      {refused > 0 && (
        <span className="nds-grid-sheet-status-refused">
          <b>{refused}</b> refused
        </span>
      )}
      <span className="nds-grid-footstrip-grow" />
      {children}
      {lastSavedAt && !saving && pending === 0 && <span className="nds-cell-muted">Saved {new Date(lastSavedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
    </div>
  )
})
