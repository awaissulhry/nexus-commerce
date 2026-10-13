'use client'

/**
 * Applies the keyboard of a grid that READS (`readGridKeys.ts` — the rule and its tests) to one grid's element.
 *
 * Tab, Enter and Space are read in the CAPTURE phase, before AG's own handlers: AG moves the focus from header to header
 * on Tab, and a key this rule acts on must not also move AG. Esc is read on the way back up (bubble), so a control that
 * answers Esc itself (a menu button closing its menu) keeps it, and a dialog around the grid stays open.
 *
 * The focus ring is the keyboard's. AG focuses a clicked cell from script, and the browser counts a scripted focus that
 * follows a keyboard one as keyboard focus (`:focus-visible`), so a click after the arrows showed the ring (measured
 * 2026-10-13, every engine). The grid marks a press of the pointer (`data-pointer-focus`) until the next key.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { ColDef, GridApi } from 'ag-grid-community'
import { BUTTON_LIKE, CELL_CONTROL, CHECKBOX, FORM_FIELD, SELECTION_COLUMN, readGridKey, type ReadKeyAction, type ReadKeyFacts } from '../readGridKeys'

const PAGE_STOP = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
const FORM_FIELD_IN_CELL = `.ag-cell :is(${FORM_FIELD})`

const visible = (el: HTMLElement): boolean => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'

/** The page's next (or previous) place Tab would stop, outside the grid — never behind an open dialog. */
function pageStop(grid: HTMLElement, back: boolean): HTMLElement | null {
  const stops = Array.from(document.querySelectorAll<HTMLElement>(PAGE_STOP)).filter((el) =>
    el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !grid.contains(el) && !el.closest('[inert]') && visible(el))
  if (back) {
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i].compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) return stops[i]
    return null
  }
  return stops.find((el) => grid.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null
}

export function useReadGridKeys<T>(
  wrapRef: RefObject<HTMLElement | null>,
  apiRef: RefObject<GridApi<T> | null>,
  options: { reads: boolean; opensRows: boolean; defaultKeys: ColDef<T>['suppressKeyboardEvent'] },
): void {
  const latest = useRef(options)
  latest.current = options
  const { reads } = options
  useEffect(() => {
    const wrap = wrapRef.current
    if (!reads || !wrap) return
    const read = (event: KeyboardEvent): { facts: ReadKeyFacts; cell: HTMLElement | null; controls: HTMLElement[] } | null => {
      const target = event.target as HTMLElement | null
      if (!target || typeof target.closest !== 'function' || !wrap.contains(target)) return null
      const cell = target.closest<HTMLElement>('.ag-cell')
      const inCell = !!cell && wrap.contains(cell)
      const controls = inCell ? Array.from(cell.querySelectorAll<HTMLElement>(CELL_CONTROL)).filter(visible) : []
      const colId = inCell ? cell.getAttribute('col-id') : null
      const colDef = colId ? apiRef.current?.getColumn(colId)?.getColDef() : undefined
      const own = colDef?.suppressKeyboardEvent
      const facts: ReadKeyFacts = {
        key: event.key,
        shift: event.shiftKey,
        modifier: event.ctrlKey || event.metaKey || event.altKey,
        composing: event.isComposing,
        prevented: event.defaultPrevented,
        on: inCell ? (target === cell ? 'cell' : 'control') : target.closest('.ag-header') ? 'header' : 'other',
        selectionCell: colId === SELECTION_COLUMN,
        ownKeys: !!own && own !== latest.current.defaultKeys,
        controls: controls.length,
        index: controls.findIndex((c) => c === target || c.contains(target)),
        buttonLike: controls.length === 1 && controls[0].matches(BUTTON_LIKE),
        checkbox: controls.length === 1 && controls[0].matches(CHECKBOX),
        formGrid: wrap.querySelector(FORM_FIELD_IN_CELL) != null,
        opensRows: latest.current.opensRows,
      }
      return { facts, cell: inCell ? cell : null, controls }
    }
    const act = (action: ReadKeyAction, cell: HTMLElement | null, controls: HTMLElement[]): boolean => {
      switch (action.do) {
        case 'leave': {
          const stop = pageStop(wrap, action.back)
          if (!stop) return false
          stop.focus()
          return true
        }
        case 'press':
          controls[0].focus({ preventScroll: true })
          controls[0].click()
          return true
        case 'control':
          controls[action.to]?.focus({ preventScroll: true })
          return true
        case 'cell':
          cell?.focus({ preventScroll: true })
          return !!cell
        case 'open':
          // As a click on the cell: the page's row click, its guard and its selection rules all apply.
          cell?.click()
          return !!cell
      }
    }
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return
      const found = read(event)
      const action = found && readGridKey(found.facts)
      if (!found || !action || !act(action, found.cell, found.controls)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onBubble = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const found = read(event)
      const action = found && readGridKey(found.facts)
      if (!found || !action || !act(action, found.cell, found.controls)) return
      // Handled: the dialog around the grid and the page's row keys leave it alone.
      event.preventDefault()
    }
    const byPointer = () => { wrap.dataset.pointerFocus = '' }
    const byKey = () => { delete wrap.dataset.pointerFocus }
    wrap.addEventListener('pointerdown', byPointer, true)
    wrap.addEventListener('keydown', byKey, true)
    wrap.addEventListener('keydown', onCapture, true)
    wrap.addEventListener('keydown', onBubble)
    return () => {
      wrap.removeEventListener('pointerdown', byPointer, true)
      wrap.removeEventListener('keydown', byKey, true)
      wrap.removeEventListener('keydown', onCapture, true)
      wrap.removeEventListener('keydown', onBubble)
      byKey()
    }
  }, [reads, wrapRef, apiRef])
}
