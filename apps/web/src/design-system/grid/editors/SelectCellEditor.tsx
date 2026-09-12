'use client'

/**
 * GDS — the sheet's select editor: the DS `ListboxPanel`, mounted inside AG's popup.
 *
 *   { ...selectEditor([{ value: 'PK', label: 'Pakistan' }, …]) }
 *
 * ── HISTORY, AND A MISDIAGNOSIS WORTH KEEPING (AG.1, rulings #184 then #461/#484) ────────────
 *
 * This file has been three things. It began as the DS `Listbox` mounted as a cell editor with
 * `cellEditorPopup: false`, and it **could not be opened at all** — measured with focus listeners
 * and a `MutationObserver`, ms timestamps:
 *
 *     510012  listbox-added   parent: BODY        ← the panel portals OUTSIDE the grid
 *     510012  cellEditingStopped                  ← AG tears the editor down
 *
 * 🔴 **The trace was right and the conclusion drawn from it was wrong.** It was read as *the DS
 * `Listbox` is incompatible with AG's cell-editing focus model*, and #184 replaced it with
 * `agRichSelectCellEditor` on that basis. The real cause was narrower: **an editor that portals
 * outside the grid must be DECLARED a popup**, or AG does not know the portal belongs to it and
 * `stopEditingWhenCellsLoseFocus` correctly stops the edit. One flag, not one component.
 *
 * Measured 2026-09-02 on the editor that replaced it: with `cellEditorPopup: true`, a popup editor
 * holds DOM focus **outside the grid root entirely** (`popup parent: body > .ag-styled-root`) with
 * `stopEditingWhenCellsLoseFocus: true` on, and the edit survives — `editing: 1`, focus in the
 * panel. AG treats its own popup as part of the editor. The same is true of `agLargeTextCellEditor`,
 * which has been doing exactly this on the longtext columns of this sheet the whole time.
 *
 * The rich select then failed the Owner's #461 ruling for a reason no flag could fix:
 * `valueListMaxWidth` is **not a maximum** — AG writes it inline as `width`, `min-width` AND
 * `max-width` pinned to one value, so a **7-option** list and a **268-option** list both rendered
 * at exactly **320×240** against a 130px cell. That uniform width IS the complaint
 * (*"too long in a single cell"*). Two further D18 rules — right-align on overflow, and flip above
 * only when there is room — have no `IRichCellEditorParams` at all.
 *
 * So the geometry lives in the DS popover, where forms already have it, and `SelectPanelEditor` is
 * the AG integration #184 deferred. One popover implementation in forms and grid, by construction.
 * Measured after the change: **132px for 7 short options, 320px for 268 country names** —
 * `clamp(anchor, content, 320)`, which is what was asked for.
 *
 * ⚠ `RichSelectModule` stays registered, but **no longer for this file** — `/design/grid-lab`'s
 * feature catalogue (`GridModuleCatalog`, `GridFeatureLab`) still mounts `agRichSelectCellEditor`
 * directly. If those go, the module can go with them.
 */import { ChevronDown } from 'lucide-react'
import type { ColDef } from 'ag-grid-community'

import type { ListboxOption } from '../../components'
import { SelectPanelEditor } from './SelectPanelEditor'

export interface SelectEditorParams {
  options: ListboxOption[]
  placeholder?: string
}

/**
 * The `ColDef` fragment: editable, AG's rich select, its options.
 *
 * 🔴 The column's VALUE is the code (`'PK'`), the operator reads the label (`'Pakistan'`), and
 * `formatValue` is the only thing that bridges them — it drives the closed display, every row of
 * the open list, AND what `searchType` matches against, so typing "Pak" finds a value spelled
 * "PK". Losing it would leave an operator picking country codes out of a list of 268.
 *
 * `cellEditorPopup` is deliberately NOT set: the rich select declares `isPopup()` itself, and
 * pinning it here would override the editor's own answer. Popups parent to `document.body`
 * (`NexusGrid`'s `popupParent`), so the list is clamped to the window rather than to a grid box
 * that can run past the fold.
 */
/**
 * D13 — the affordance a closed list wears AT REST.
 *
 * 🔴 The Owner: *"the status column… should really be a dropdown."* It already was one — the wire
 * sends `kind: 'select'` with `[ACTIVE, DRAFT, INACTIVE]` and the editor mounts AG's rich select on
 * Enter. **What was missing was any way to know that without trying it.** A closed-list cell and a
 * free-text cell rendered identically at rest, so the only way to discover the list was to guess.
 *
 * That is the same class as a disabled control that cannot explain itself: the capability existed
 * and the operator had no way to see it.
 *
 * Lives in the ENGINE, beside the editor it advertises, so a lane cannot ship a select column
 * without the affordance — and so the two can never disagree about which columns are closed lists.
 * DS.2 owns the look (`grid.css`: `.nds-cell-is-select` cursor, `.nds-ag-chev` glyph, deliberately
 * at full strength — an informative glyph is not dimmed).
 */
export const SELECT_CELL_CLASS = 'nds-cell-is-select'

/** The same lucide `ChevronDown` every other DS select uses — one glyph convention, not a new one. */
export function SelectChevron() {
  return <ChevronDown className="nds-ag-chev" size={13} strokeWidth={2} aria-hidden />
}

/**
 * 🔴 AG.1-f — this now mounts the DS `ListboxPanel` inside AG's popup, NOT `agRichSelectCellEditor`.
 *
 * Measured against D18, three requirements could not be expressed through `IRichCellEditorParams`:
 * content-fitted width, right-align-on-overflow, and a conditional flip. The width one is the
 * Owner's actual complaint — `valueListMaxWidth` is not a maximum, AG writes it inline as
 * `width / min-width / max-width` all pinned to one value, so a **7-option** list and a
 * **268-option** list both rendered at exactly **320×240** against a 130px cell. The DS popover
 * already resolves `clamp(anchor, content, 320)` and owns the placement rules, so the geometry lives
 * there and `SelectPanelEditor` is the AG integration.
 *
 * `cellEditorPopup` is still deliberately NOT set: the editor declares `isPopup()` itself, and
 * pinning it here would override the component's own answer. Popups parent to `document.body`
 * (`NexusGrid`'s `popupParent`), so the panel clamps to the window rather than to a grid box that
 * can run past the fold.
 *
 * `placeholder` is kept in the signature — every call site passes it and the DS panel will take it
 * when `ListboxPanel` grows a placeholder row; dropping the parameter would silently discard what
 * ~23 columns already say about their empty state.
 */
export const selectEditor = (
  options: ListboxOption[],
  placeholder?: string,
): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorParams' | 'cellEditorPopup' | 'cellEditorPopupPosition'> => ({
  editable: true,
  cellEditor: SelectPanelEditor,
  cellEditorParams: { options, emptyLabel: placeholder },
  /**
   * 🔴 `cellEditorPopup: true` IS REQUIRED HERE, and the component's own `isPopup()` is not enough.
   *
   * MEASURED (DS.2's ancestor walk, which is what found this): with `isPopup()` declared only on the
   * imperative handle, the panel's parent was **`div.ag-cell`** — `inline width: 130px`,
   * `display: flex`, `overflow: hidden` — not `.ag-popup`. The editor was rendering INLINE, inside a
   * box AG had sized to the column, so no width rule of any kind could have escaped it. Every
   * symptom followed from that one fact, and it presented as a CSS sizing problem two layers away.
   *
   * The reason is ordering: AG must know whether an editor is a popup **before** it mounts it, and a
   * React `forwardRef` handle does not exist until after. The old comment here said `cellEditorPopup`
   * was deliberately unset because "the rich select declares `isPopup()` itself" — true of a JS class
   * editor AG instantiates directly, and false of a React component. That comment was correct for
   * the editor it was written about and became wrong when the editor changed underneath it.
   */
  cellEditorPopup: true,
  cellEditorPopupPosition: 'under',
})
