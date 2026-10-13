'use client'

/**
 * Amazon Business (step 5) — what Enter, F2 or a double-click on a B2B price or Tiers cell opens: the page's business
 * price editor (the pop-up with the rule, the discounts and the price each buyer pays). AG's own editing ends at once and
 * changes nothing; a typed character opens AG's text editor instead (`matrixColumn.ts`, `businessEditorSelector`).
 *
 * The cancel comes FIRST, then the pop-up: AG gives the focus back to the cell when its editing stops, and the pop-up must
 * be the one that ends up holding it.
 */
import { useEffect } from 'react'
import type { ICellEditorParams } from 'ag-grid-community'

export interface BusinessOpenEditorParams {
  open: (params: ICellEditorParams, anchor: HTMLElement | null) => void
}

export function BusinessOpenEditor(p: ICellEditorParams & BusinessOpenEditorParams) {
  useEffect(() => {
    const t = setTimeout(() => {
      p.api.stopEditing(true)
      p.open(p, p.eGridCell ?? null)
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [])
  return null
}

/**
 * A key that starts typing in the cell (AG's text editor with that character, or empty for Backspace and Delete), not one
 * that opens the business price editor (Enter, F2, a double-click: no key).
 */
export const typesCharacter = (eventKey: string | null | undefined): boolean =>
  !!eventKey && ((eventKey.length === 1 && eventKey !== ' ') || eventKey === 'Backspace' || eventKey === 'Delete')
