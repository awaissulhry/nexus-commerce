/**
 * GDS — the studio sheet's closed-list cell editor: AG's popup, the DS `ListboxPanel` inside it.
 *
 * ## Why a custom editor rather than `agRichSelectCellEditor` (AG.1-f, hub #461/#484)
 *
 * The Owner: *"the way we've felt drop-downs is extremely unprofessional on the grid, because it's
 * basically too long in a single cell. I want it perfectly aligned and good to the eyes."*
 *
 * Measured against D18, three of its requirements cannot be expressed through
 * `IRichCellEditorParams` at all:
 *  1. **Content-fitted width.** `valueListMaxWidth` is not a maximum — AG writes it inline as
 *     `width: 320px; max-width: 320px; min-width: 320px`, **all three pinned**. Measured live: a
 *     **7-option** list and a **268-option** list rendered at exactly the same **320×240**. That
 *     uniform 320 against a 130px cell IS the Owner's complaint.
 *  2. **Right-align when left-aligning would overflow** — no horizontal anchoring param exists.
 *  3. **Flip above only when there is no room below AND room above** — only a static
 *     `cellEditorPopupPosition: 'over' | 'under'`.
 *
 * So the geometry rules live in the DS popover, where forms already have them, and this file is the
 * AG integration that #184 deferred — one popover implementation in forms and grid, by construction.
 *
 * ## What AG gives us for free, MEASURED rather than assumed (#479)
 *
 * On `agLargeTextCellEditor` (a popup editor already on this sheet), live, never typing:
 *
 * | moment | editing cells | popup | focus in popup |
 * |---|---|---|---|
 * | on open | 1 | yes | **yes** |
 * | after Escape | **0** | gone | no |
 * | after click on another cell | **0** | gone | no |
 *
 * 🔴 So **Escape and click-outside are AG's popup wrapper, not ours** — and the click-outside
 * handler the ruling originally assigned this lane is deliberately NOT written. A second handler
 * would race AG's. `onCancel` is still wired, because it is the panel's way of saying "close without
 * changing", and it must reach `stopEditing(true)` if AG's own Escape ever does not arrive first.
 *
 * That table also refutes the reason #184 avoided this integration: a popup editor holds DOM focus
 * **outside the grid root entirely** (`popup parent: body > .ag-styled-root`) with
 * `stopEditingWhenCellsLoseFocus: true` on, and the edit survives. AG treats its own popup as part
 * of the editor.
 */
import { forwardRef, useCallback } from 'react'
import type { ICellEditorParams } from 'ag-grid-community'

import { ListboxPanel, type ListboxOption } from '../../components'
import { editorBox, roomToRightOf } from './editorBox'
import { cellValueOf, isUnchanged, panelValueOf } from './selectPanelModel'

export interface SelectPanelEditorParams extends ICellEditorParams {
  /**
   * AG 36's reactive contract — the ONLY way an editor's value reaches the grid. See `onCommit`.
   */
  onValueChange?: (value: unknown) => void
  options: ListboxOption[]
  placeholder?: string
  /** A "nothing selected" row. Absent ⇒ the list cannot be cleared from the editor. */
  emptyLabel?: string
}

export const SelectPanelEditor = forwardRef<unknown, SelectPanelEditorParams>(function SelectPanelEditor(props, _ref) {
  const { options, emptyLabel, value, column, stopEditing, onValueChange, parseValue } = props

  /**
   * 🔴 THE VALUE IS REPORTED WITH `onValueChange`. It used to be held in a ref for AG to read back,
   * and **AG never read it** — so this editor had never committed anything through the grid.
   *
   * The comment that stood here said "`getValue` is called synchronously by AG after
   * `stopEditing()`". That was a property this version does not have, asserted rather than measured
   * — the shape that hides best, because it describes a mechanism precisely enough to stop anyone
   * checking it.
   *
   * `ag-grid-react@36.1.0`, from its own dist: `CellEditorComponentProxy` seeds
   * `this.value = cellEditorParams.value`, its `getValue()` returns that, and only `updateValue`
   * moves it — reached through the `onValueChange` prop the proxy passes down. Its optional-method
   * copy-list is `isCancelBeforeStart · isCancelAfterEnd · focusIn · focusOut · afterGuiAttached ·
   * getValidationErrors · getValidationElement`, so **neither `getValue` nor `isPopup` can be
   * supplied by a ref or by `useGridCellEditor`**. `isPopup` therefore lives in the ColDef as
   * `cellEditorPopup: true`, which `SelectCellEditor`'s header already required for its own
   * measured reason — DS.2's ancestor walk found the panel parented to `div.ag-cell`. That was this
   * same missing wire, seen from the other end and read as a separate quirk.
   *
   * MEASURED before the fix (hub #762, XAVIA `handmade_classification`, capture armed and witnessed
   * BEFORE the interaction): picking a value on an empty select issued **no request of any kind**,
   * the cell still rendered `—`, and `Product.version` did not move.
   *
   * ⚠ Nothing was in production, so this is a rebuild defect and not an operator-facing one.
   */
  const onCommit = useCallback(
    (chosen: string) => {
      // An unchanged pick is a CANCEL, not a save. Committing it would fire `cellValueChanged` for a
      // no-op: `writeGate` would suppress the write, but the cell would still flash `saving` and
      // stamp `lastSavedAt` — a lie about having saved something.
      if (isUnchanged(value, chosen)) {
        stopEditing(true)
        return
      }
      // Tell AG, THEN stop. `updateValue` sets the proxy's value synchronously before it schedules
      // its re-render, so the value is in place by the time `stopEditing()` reads it.
      const selected = cellValueOf(chosen)
      onValueChange?.(selected !== null && parseValue ? parseValue(selected) : selected)
      stopEditing()
    },
    [value, stopEditing, onValueChange, parseValue],
  )

  const onCancel = useCallback(() => stopEditing(true), [stopEditing])

  /* The shared box. Measured from the cell's own rect where AG gives one — the column's WIDTH is not
     its POSITION, and position is what decides the room to the right. */
  const cellRect = (props as { eGridCell?: HTMLElement }).eGridCell?.getBoundingClientRect()
  const box = editorBox({
    cellWidth: cellRect?.width ?? column.getActualWidth(),
    cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, window.innerWidth) : window.innerWidth,
    kind: 'select',
  })

  return (
    <ListboxPanel
      options={options}
      value={panelValueOf(value)}
      onCommit={onCommit}
      onCancel={onCancel}
      emptyLabel={emptyLabel}
      /**
       * The anchor floor, and nothing else. DS.2's CSS resolves the rest as
       * `clamp(anchor, content, var(--nds-popover-max-w))`, so a 7-option list of short labels is
       * as narrow as its content while 268 country names reach the 320 cap — the behaviour
       * `valueListMaxWidth` could not express because it wrote one number to three properties.
       *
       * 🔴 `width: 'max-content'` is REQUIRED here and is not the same mistake as a fixed width.
       * MEASURED: without it the panel rendered **130px — exactly the cell width — for a 268-option
       * list of country names**, which is the very defect this editor replaced `agRichSelectCellEditor`
       * to fix. The cause is that the DS panel sizes to content in forms only because `Listbox`
       * positions it `fixed`, and a fixed element is shrink-to-fit; inside AG's popup it is
       * `position: static`, so a normal block fills its parent — and AG's popup wrapper is the
       * CELL's width. `max-content` restores the intended `clamp(anchor, content, 320)`: `minWidth`
       * is the floor, `max-content` the natural size, and the DS's own `max-width` the cap. It sets
       * no NUMBER, which is what separates it from `valueListMaxWidth` writing one figure to three
       * properties.
       */
      /**
       * 🔴 `maxWidth` from the SHARED sizing function (Owner's Phase 1, 2026-09-03) — the one line
       * that changed here, and it is what makes "select is unchanged" true rather than lucky.
       *
       * This editor was already the only one that never displaced, because it alone was sized
       * `clamp(cell width, content, cap)`. What it did not have was the ROOM term: its cap was the
       * DS popover's 320 regardless of how little space was left to the right, so a 268-option list
       * on a column near the window edge would have been slid sideways by AG exactly as the other
       * two were. The cap is now `min(320, roomToRight)` through `editorBox`, so the behaviour the
       * select already had by construction is now guaranteed by the same rule the others obey.
       *
       * `minWidth` + `width: 'max-content'` are untouched — see the note above for why `max-content`
       * is load-bearing and is not the fixed-width mistake it resembles.
       */
      style={{ minWidth: column.getActualWidth(), width: 'max-content', maxWidth: box.width, maxHeight: box.height }}
    />
  )
})
