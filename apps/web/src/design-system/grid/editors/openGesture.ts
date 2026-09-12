/**
 * GDS — THE OPEN GESTURE. What must happen when an operator asks a cell to become editable, and
 * the one place that decides it.
 *
 * ## The defect this exists to close (P0, measured 2026-09-03)
 *
 * The Owner: *"I double-click a cell and sometimes no editor opens."* Two lanes hit it yesterday
 * and both blamed their own probes. It is neither a probe artefact nor a race — it is deterministic
 * and it is geometric.
 *
 * `SHEET_GRID_OPTIONS` enables `cellSelection: { handle: { mode: 'fill' } }`. AG then renders
 * `div.ag-fill-handle` as a **direct child of the selected `.ag-cell`**, `position: absolute;
 * bottom: -1px; right: -1px; width: 6px; height: 6px` (measured on screen: a 6×6 box flush with the
 * cell's own right and bottom edges — AG's own `rangeSelection` stylesheet). Its constructor binds
 * a listener of its own:
 *
 *     // ag-grid-enterprise, AgFillHandle.postConstruct
 *     this.addManagedElementListeners(this.getGui(), { dblclick: this.onDblClick.bind(this) })
 *     onDblClick(e) { _stopPropagationForAgGrid(e); … }   // ← the cell NEVER sees the gesture
 *
 * So a double-click whose pointer is inside that 6×6 corner is swallowed before AG's own cell
 * handler runs, and **no editor opens**. It reads as random because the handle is small, because it
 * only exists once a cell is selected — and **the first click of the double-click is what selects
 * it**, so the gesture creates its own obstacle — and because the bottom-right of a cell is exactly
 * where you aim when you want the caret after the last character.
 *
 * MEASURED, `/products/<id>/edit/studio`, master·DE, 20 reps per box, 0 abstains, with a positive
 * control asserting the pointer was over the target cell before every click:
 *
 *     dblclick · CENTRE of the cell   text 20/20 · longtext 20/20 · number 20/20 · select 20/20
 *     dblclick · CORNER (the handle)  text  0/20 · longtext  0/6  · number  0/20 · select  0/6
 *
 * (The longtext and select denominators are 6 because those two only fail on a **first**
 * interaction — the timing block where no handle pre-existed. Every kind fails there.)
 *
 * ## The second half, which is worse than a missing editor
 *
 * `onDblClick`'s remaining body builds a range from the clicked row to `_getLastRow(beans)` and
 * fills the value down it. A mis-aimed double-click is therefore a **silent, unconfirmed overwrite
 * of the whole column**. Measured on the live sheet with every non-GET aborted at the network
 * layer: one corner double-click on `basePrice` armed **20** `PATCH /api/products/bulk` calls
 * carrying `basePrice: "0"` onto twenty OTHER rows of the family; one on `name` armed two more
 * carrying that row's name onto two siblings. 176 such writes were armed across the diagnosis run
 * and every one was aborted — on a lane's machine without that block they land on the production
 * database, because local dev writes production.
 *
 * It is self-concealing: the first fill makes the rows equal, so every later double-click at the
 * same corner writes nothing and looks harmless.
 *
 * ## The rule (Owner's ruling, 2026-09-03)
 *
 * *"Every open gesture must open an editor, every time: double-click, Enter, F2, typing a
 * character, typing `=`."* A double-click inside a cell is an open gesture wherever in the cell it
 * lands, so the handle's double-click is intercepted and turned back into what the operator asked
 * for. **Drag-to-fill is untouched** — that is a `mousedown`/`mousemove` gesture on the same
 * element, it is the affordance the sheet's own footer advertises (*"a range drags with the fill
 * handle"*), and nothing here listens for it. What is removed is double-click-to-fill-down, which
 * this product advertises nowhere and which has no confirmation and no undo prompt.
 */

/** Where a fill-handle double-click actually landed, in the terms `api.startEditingCell` wants. */
export interface FillHandleHit {
  colKey: string
  rowIndex: number
  rowPinned: 'top' | 'bottom' | null
}

/**
 * The pure half: given what the DOM ancestry SAID, is this a cell we can name — and how.
 *
 * 🔴 Split out because `apps/web`'s vitest is `environment: 'node'` with no jsdom (its config says
 * so, and says the day to add one is the day a test renders a component). A hand-built fake DOM
 * would only prove my fake's `closest`, and the selectors are precisely the part a fake gets wrong:
 * AG 36 renamed three of them under this programme already (`.ag-center-cols-container` →
 * `.ag-grid-scrolling-container`, `.ag-header-container` → `.ag-header`, `.ag-floating-top` →
 * `.ag-grid-pinned-top`), and a probe that kept the old name measured an empty page and reported it
 * as a reading. So: **the validation below is unit-tested; the selectors are verified only in the
 * browser**, by `scripts/check-editor-open.mjs`, which fails if the walk names nothing.
 *
 * 🔴 `rowIndex` is a ROW INDEX, never a row id. `startEditingCell` addresses a row by index; a row
 * id passed there resolves to no node and AG returns silently (`log.warn(290)`) — which would
 * reproduce, through the fix, the exact silence the fix removes. Hence the integer check: a
 * `Number('cmokmy3a…')` is `NaN`, and `NaN` must abstain rather than travel.
 */
export function hitFromParts(parts: {
  colKey: string | null | undefined
  rowIndex: string | null | undefined
  pinned: 'top' | 'bottom' | null
}): FillHandleHit | null {
  const { colKey, rowIndex, pinned } = parts
  if (!colKey || rowIndex == null || rowIndex === '') return null
  const n = Number(rowIndex)
  if (!Number.isInteger(n) || n < 0) return null
  return { colKey, rowIndex: n, rowPinned: pinned }
}

/**
 * The DOM half: the fill handle a gesture landed on, resolved to the cell that owns it — or `null`
 * for every other target, which is the overwhelming majority and must cost nothing.
 *
 * 🔴 It reads the DOM rather than AG's focused cell. The handle sits at the bottom-right of the
 * RANGE, which is not always the focused cell (extend a range with shift and they part company),
 * and the cell the operator's pointer is on is the one they mean. `.ag-fill-handle` is a direct
 * child of that `.ag-cell` — verified on screen, ancestry
 * `div.ag-fill-handle → div.ag-cell[col-id=name] → div.ag-grid-scrolling-cells →
 * div.ag-row[row-index=0]` — so the walk is short and unambiguous.
 *
 * The `typeof closest !== 'function'` guard is not defensive noise: this runs on EVERY double-click
 * anywhere in the grid, and an exception here would take the handler down for every gesture,
 * turning one wrong corner into a dead sheet.
 */
export function fillHandleHit(target: unknown): FillHandleHit | null {
  const el = target as { closest?: (s: string) => Element | null } | null
  if (!el || typeof el.closest !== 'function') return null
  const handle = el.closest('.ag-fill-handle')
  if (!handle) return null
  /* AG 36 renamed these containers (`ag-grid-pinned-top`, not the `ag-floating-top` every older
     example still shows). Read from the shipped bundle, not from memory. */
  return hitFromParts({
    colKey: handle.closest('.ag-cell[col-id]')?.getAttribute('col-id'),
    rowIndex: handle.closest('.ag-row[row-index]')?.getAttribute('row-index'),
    pinned: handle.closest('.ag-grid-pinned-top') ? 'top' : handle.closest('.ag-grid-pinned-bottom') ? 'bottom' : null,
  })
}

/**
 * §Ruling 2 — ONE editor mode per column kind, declared once so it cannot vary by column or by
 * mood. `inline` means the cell itself becomes the editor (Excel); `popup` means AG mounts the
 * editor in its own layer because the content cannot fit a cell.
 *
 * MEASURED, and the ruling's core sentence already holds: over 20 reps × 5 gestures × 4 kinds × 3
 * timings, every column opened the same way every time — `text` and `number` inline 20/20,
 * `longtext` `agLargeTextCellEditor` 20/20, `select` the DS listbox panel 20/20, `=` the formula
 * editor 20/20 on all four. There is no per-mood variation to remove.
 *
 * 🔴 **ONE DELIBERATE DIVERGENCE FROM THE RULING AS ENUMERATED, FLAGGED FOR THE OWNER.** The ruling
 * gives both an enumeration ("INLINE … for short text, number, select and yes/no") and a test ("a
 * POPUP only where the content cannot fit the cell"), and for `select` the two disagree. This table
 * follows the TEST and keeps `select` a popup, for two reasons that are measurements rather than
 * preferences:
 *   · `country_of_origin` carries 268 options and `condition_type` 23 — a list that cannot fit a
 *     110px cell by the ruling's own criterion;
 *   · inline is not merely worse here, it is the design the Owner already rejected. #184 mounted
 *     the DS listbox with `cellEditorPopup: false` and DS.2's ancestor walk measured its parent as
 *     `div.ag-cell` — `width: 130px; overflow: hidden` — so no width rule could escape the cell;
 *     the `agRichSelectCellEditor` that replaced it pinned every list to 320×240 whatever its
 *     length, which is the Owner's #461 complaint verbatim ("too long in a single cell … I want it
 *     perfectly aligned"). `SelectPanelEditor` in AG's popup layer, anchored under the cell, is
 *     what that ruling produced.
 * **✅ RULED BY THE OWNER, 2026-09-03: "we must keep select as a pop-up."** The question was put to
 * them with both readings and this is the answer — so `select: 'popup'` is now a DECISION on record,
 * not a lane's judgement call awaiting one. Do not flip it back on the strength of the ruling's
 * enumeration; the enumeration is the part that was superseded.
 * `boolean` follows `select` because on this system a yes/no column IS a select (see below).
 *
 * 🔴 This is a DECLARATION the gate asserts against the live grid, not a switch the grid reads.
 * The modes are set on the ColDefs (`textEditor`, `numericEditor`, `selectEditor`,
 * `longTextEditor`, `formulaCellEditorSelector`), and stating them a second time here would be two
 * sources for one answer. Stating them as an EXPECTATION that a browser check holds the real grid
 * to is a different thing: it fails when the wiring drifts, which a second copy would not.
 *
 * `boolean` is listed and is unreachable today — the sheet stringifies wire booleans into
 * two-option selects, so `kind: 'boolean'` is produced by nothing (PES.2 measured 87 of 91
 * `CategorySchema` rows carrying boolean attributes, all arriving as `kind: 'select'`; the live
 * contract read today is 96 columns — 46 text, 23 select, 18 number, 9 longtext, 0 boolean). It is
 * here so that a kind which starts arriving cannot arrive without a declared mode.
 */
export const EDITOR_MODE_BY_KIND = {
  text: 'inline',
  number: 'inline',
  select: 'popup',
  boolean: 'popup',
  longtext: 'popup',
} as const satisfies Record<string, 'inline' | 'popup'>

/**
 * The `=` editor is attached to EVERY kind (#775) and is always a popup: it carries completions, a
 * signature hint and a preview line, none of which fit a cell.
 */
export const FORMULA_EDITOR_MODE = 'popup' as const
