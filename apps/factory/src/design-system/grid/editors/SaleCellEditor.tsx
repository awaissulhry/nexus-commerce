'use client'

/**
 * MX.G — the `salePrice` cell editor: a price and a window (start → end) in ONE popup.
 *
 * Design §3.4: *"popup: price + start + end (the DS date inputs)"*. The DS `Input` carries the
 * price; two DS `DateField`s carry the window — the field this codebase's Wave-1 ratchet made the
 * replacement for `<input type="date">`, and one whose calendar renders INSIDE its own element
 * rather than portalling, so a click on a day stays inside AG's popup and AG does not read it as
 * "elsewhere" and stop the edit (the trap `SelectPanelEditor` documents from the other side).
 *
 * ## The AG 36 contract, measured by the editors before this one
 *
 * · The value reaches the grid ONLY through `props.onValueChange`, on every change. AG 36's
 *   `CellEditorComponentProxy` seeds its value from `params.value` and moves it only through that
 *   prop; a ref `getValue` is never read (`reference_ag36_react_editor_onvaluechange`, measured in
 *   `SelectPanelEditor.tsx`'s header on hub #762).
 * · An UNTOUCHED popup must not arm a write: `useGridCellEditor({ isCancelAfterEnd })` is the
 *   lifecycle AG 36 does read (the proxy's optional-method list), and it answers `true` until the
 *   operator has changed something — the pattern `FormulaCellEditor` and `AxesPanelEditor` use.
 * · Nothing is reported on MOUNT. Reporting the initial value would arm a write for a no-op.
 * · Enter / Tab / Esc are AG's inside a popup (`reference_ag_popup_editor_owns_keys`): Enter
 *   commits what was last reported, Esc discards. The editor does not handle them.
 *
 * ## The value is the COMPOUND
 *
 * `{ value, start, end }` — the wire's `SaleCell`, in and out. `matrixCells.ts`'s note on
 * `matrixCellValue` says why the column's value is the compound rather than the price alone: with a
 * scalar value, a dates-only change re-reads as "unchanged" and AG's own commit path drops it.
 *
 * ## Sizing
 *
 * `editorBox` with the `measure` caps (360 × 220): the mandate names a `'value'` kind that
 * `EDITOR_CAPS` does not declare, and `measure` — "a number field and a unit list side by side" — is
 * the declared kind whose box this content fits, at three 28px rows of ~150px. `editorBox.ts` is
 * not this lane's file; a fourth-kind addition would be an unclaimed edit for a box that already fits.
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import type { ICellEditorParams } from 'ag-grid-community'
import { useGridCellEditor } from 'ag-grid-react'

import { DateField } from '../../components'
import { Input } from '../../primitives'
import { isSaleEditorValue, type SaleEditorValue } from '../renderers/matrixCells'
import { editorBox, roomToRightOf } from './editorBox'

export interface SaleCellEditorParams extends ICellEditorParams {
  /** AG 36's reactive contract — the ONLY way an editor's value reaches the grid. */
  onValueChange?: (value: unknown) => void
  /** The coordinate's currency, for the price field's label. */
  currency?: string
}

const EMPTY: SaleEditorValue = { value: null, start: null, end: null }

/** A comfortable measure for three labelled rows — the ASK, which the room to the right may cut. */
const SALE_EDITOR_CONTENT = { width: 300, height: 150 } as const

export const SaleCellEditor = forwardRef<unknown, SaleCellEditorParams>(function SaleCellEditor(props, _ref) {
  const { value, column, onValueChange, currency } = props
  const initial: SaleEditorValue = isSaleEditorValue(value) ? { value: value.value, start: value.start, end: value.end } : EMPTY
  const [draft, setDraft] = useState<SaleEditorValue>(initial)
  const [text, setText] = useState(() => (initial.value == null ? '' : String(initial.value)))
  const touched = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  /* An untouched popup is a CANCEL — nothing is written and no `saving` mark is painted. */
  useGridCellEditor({ isCancelAfterEnd: () => !touched.current })

  useEffect(() => {
    const el = root.current?.querySelector<HTMLInputElement>('input')
    el?.focus()
    el?.select()
  }, [])

  const report = useCallback(
    (next: SaleEditorValue) => {
      touched.current = true
      setDraft(next)
      onValueChange?.(next)
    },
    [onValueChange],
  )

  const onPrice = (s: string) => {
    setText(s)
    const t = s.trim().replace(',', '.')
    const n = t === '' ? null : Number(t)
    report({ ...draft, value: n === null || !Number.isFinite(n) ? null : n })
  }

  const cellRect = (props as { eGridCell?: HTMLElement }).eGridCell?.getBoundingClientRect()
  const box = editorBox({
    cellWidth: cellRect?.width ?? column.getActualWidth(),
    cellHeight: cellRect?.height ?? 0,
    contentWidth: SALE_EDITOR_CONTENT.width,
    contentHeight: SALE_EDITOR_CONTENT.height,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, typeof window === 'undefined' ? 1440 : window.innerWidth) : typeof window === 'undefined' ? 1440 : window.innerWidth,
    kind: 'measure',
  })

  return (
    <div ref={root} className="nds-matrix-sale-editor" style={{ width: box.width }} role="group" aria-label="Sale price and window">
      <label className="nds-matrix-sale-field">
        <span>Sale price{currency ? ` (${currency})` : ''}</span>
        <Input size="xs" type="number" inputMode="decimal" min={0} step="0.01" value={text} onChange={(e) => onPrice(e.target.value)} aria-label="Sale price" />
      </label>
      <label className="nds-matrix-sale-field">
        <span>Starts</span>
        <DateField value={draft.start ?? ''} onChange={(iso) => report({ ...draft, start: iso || null })} ariaLabel="Sale starts" format="yyyy-mm-dd" />
      </label>
      <label className="nds-matrix-sale-field">
        <span>Ends</span>
        <DateField value={draft.end ?? ''} onChange={(iso) => report({ ...draft, end: iso || null })} ariaLabel="Sale ends" format="yyyy-mm-dd" min={draft.start ?? undefined} />
      </label>
      <p className="nds-matrix-sale-hint">Enter applies · Esc discards</p>
    </div>
  )
})
