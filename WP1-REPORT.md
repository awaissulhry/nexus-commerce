# WP1 — Editors and keyboard (design system) · report

Branch `claude/ultra-code-subagents-product-sheet-neormx-wp1`, based on `25725970`. Every finding was reproduced by a test
that failed on the old code before the fix went in (each commit body has the before and after counts).

## Findings

| id | outcome | commit | test | notes |
|---|---|---|---|---|
| B08 | fixed | 462eef21 | `grid/editors/MeasureEditor.vitest.test.ts` "the typed text is read as a paste reads it" | New `measureFromText` (shapeValue.ts) uses `parseShape`: "1.5 kg" → {1.5, kilograms}. Text that is still not a number is reported as typed, so the server refuses it by name. Before the fix, 6 of 10 cases failed. |
| B09 | fixed | 57d022d1 | `MeasureEditor.vitest.test.ts` "Escape in the unit list cancels"; `sheet/pickerCancel.vitest.test.ts` | Cancel paths now call `api.stopEditing(true)`. New `EditorStop` and `GridCancel` types; the editor-stop typing is fixed in the measure, list, slot-list, category and reference editors. `SelectPanelEditor.onCancel` is left alone: see "Found along the way" 1. |
| B10 | fixed | fafaa589 | `grid/editors/enterKeyOwnership.vitest.test.ts` | One behaviour for every editor kind: **Enter saves and moves down**. Each Enter either reaches the grid (AG ends the edit and moves down) or is ended by the editor with `stopEditing(false, event)`. Changed: FormulaCellEditor, SlotListEditor, and AsyncListboxPanel (it now reports Enter, like Tab). One table covers 10 editor kinds (select, measure number, measure units, list with options, free-text list, text/number/long text, bullets, category/product type, reference, eBay policy). Before the fix, 23 of 28 failed. |
| B11 | fixed | fee82ce1 | `grid/editors/ListPanelEditor.vitest.test.ts` "free-text list keeps the first typed key" | New `TagInput.initialInput`. The draft starts with the typed key and is reported on mount. "a \| b" in a draft or chip is split by the paste's rule (`splitListText`, `LIST_SEPARATOR`). |
| B12 | fixed | 2203a617 | `ListPanelEditor.vitest.test.ts` "open multi-value lists take a typed value"; `SheetControlDialogs.vitest.test.ts` guard | `shapeEditorSpec` now passes `allowCustom` from `mode`. `OptionList` gains `allowCustom` (an `Add "…"` row) and `onCustomDraft` (when nothing matches, Enter saves the typed text). A stored off-list value is shown first and labelled "current" or "current · not in the list". SetColumnDialog passes `allowCustom`. |
| B13 | fixed | fafaa589 | `enterKeyOwnership.vitest.test.ts` (eBay policy case) | `EbayPolicyEditor` is now built on `AsyncListboxPanel`: search, arrow keys, Enter, Tab, Escape, the typed first key, "Current: …" and Refresh. The drawer's `EbayPolicyInput` is unchanged. |
| B14 | fixed | fafaa589 | `enterKeyOwnership.vitest.test.ts` "Ctrl/Cmd+Enter never reaches the grid" | Ctrl/Cmd+Enter never reaches the grid. It saves only the current cell and moves down, which is what the text editor already did. The panels pass the key back as `onKeyChoice(value, end)`, and `keepGridOffEnter` handles the measure number field and the list editor. |
| B15 | fixed | c8583795 | `components/listboxPanelKeys.vitest.test.ts`, `asyncListboxPanelKeys.vitest.test.ts` | A query with no search token ("-", "&", "#") leaves the highlight where an untyped list has it, in both panels. For an open list with "&", Enter keeps the stored value; ↑ still reaches `Use "&"`. |
| B16 | fixed | d246b8c5 | `sheet/listClear.vitest.test.ts`, `pickerCancel.vitest.test.ts`, `asyncListboxPanelKeys.vitest.test.ts` "Clear" | `BOOLEAN_EDITOR_PARAMS` gives both sheets Yes, No and Clear. `AsyncListboxPanel.emptyLabel` adds a Clear row, shown even before any choices load. The label is always `SELECT_CLEAR_LABEL` (the dialog said "Empty", references said "Not set"). An Etsy category cleared stores null. Kept on purpose: the measure's "No units" row clears only the unit, and the Clear row stays aria-selected on an empty cell. |
| B18 | partial | fafaa589 | `enterKeyOwnership.vitest.test.ts` "IME composition ends nothing" | An Enter that confirms an IME composition is kept from the grid in every list and picker. Not fixed: AG starts editing only on single-character keys, so an IME key ('Process') does not open a selected cell. That behaviour is AG's. |
| B19 | fixed | 56fa6fd3 | `listboxPanelKeys.vitest.test.ts` "a searching list is announced"; SelectPanelEditor and MeasureEditor naming tests | The search field is now a combobox with `aria-controls`, `aria-activedescendant` and `aria-expanded`. The options sit in their own named listbox beside it, and ids come from `useId` when there is no `idPrefix`. Each list is named after its column. |
| B20 | partial | 63addbec | `listboxPanelKeys.vitest.test.ts` "page and end keys", `asyncListboxPanelKeys.vitest.test.ts`, `ListPanelEditor.vitest.test.ts` | PageUp and PageDown move by the rows in view (`listboxPageSize`) in every list and picker. Home and End reach the ends of a list with no search field and of the checkbox walk. Deliberate difference: inside a search field, Home and End stay caret keys, as in the WAI-ARIA editable combobox pattern. |
| B21 | partial | beb6e2e4 | `grid/editors/selectChevron.vitest.test.ts` "opens only a cell AG would edit" | `openCellEditor(api, node, key, column)` returns no opener when `column.isCellEditable(node)` is false. A locked cell then shows the passive glyph with no pointer. Not done: a click on it does not say the refusal reason. That wiring lives in `useProductSheetInteraction.ts`, outside WP1; double-click and Enter still explain. |
| B22 | fixed | 9c3fbe13 | `MeasureEditor.vitest.test.ts` "Tab to the units lands where the operator can type" | `unitsEntry`: Tab focuses the unit search field when there is one. |
| B23 | fixed | c8583795 | `listboxPanelKeys.vitest.test.ts` "an open list keeps a whole typed value" | When every typed word is a whole word of the best match, the `Use "…"` row is highlighted. A partial word still takes the best match ("Ner" → "Nero"), as the prop doc and its test require. |
| B24 | fixed (web) | f44ee402 | none (docs) | The web CHANGELOG now says FIRST. The factory CHANGELOG never had the P0 entry, so the finding's "mirrors the same wording" does not apply there. The f44ee402 commit body wrongly says both files were changed. |
| B25 | fixed | affc903b | none (generated); diff against a fresh emit is empty | Regenerated the factory `.d.ts` files, emitted from the factory copy, for the 19 modules the stack and WP1 changed. `react/jsx-runtime` is kept as spelled. See "Found along the way" 3. |

## Files outside WP1's list (kept minimal)
- `sheet/ChannelCategoryEditor.tsx` and `sheet/ReferenceSelectEditor.tsx`: the cancel line and the editor-stop typing (B09), one `end` clause each (B14), and for the category editor `emptyLabel` plus Clear → null (B16).
- `sheet/SheetControlDialogs.tsx`: `allowCustom` on the list control (B12) and the Clear label (B16).
- `sheet/referenceOptions.ts`: the empty option's label (B16).
- `design-system/primitives/TagInput.tsx`: `initialInput` (B11). It is a DS primitive and mirrored in factory.
- `design-system/grid/editors/SlotListEditor.tsx` and `FormulaCellEditor.tsx`: the Enter contract (B10).

## Commands run
- `npm ci`, `npm run build -w @nexus/shared && npm run build -w @nexus/events`: passed.
- `cd apps/web && npx vitest run src/design-system 'src/app/products/[id]/edit/_studio'`: 347 files, 4563 passed, 13 skipped.
- `npm run typecheck -w @nexus/web` (and `npx tsc --noEmit -p apps/web` after each change): passed.
- Factory: `npm run db:generate -w @nexus/factory`, then `npx tsc --noEmit --incremental false -p apps/factory/tsconfig.json`: passed.
- `node scripts/check-ds-fork-drift.mjs --check`: no new drift (257 shared files, 250 identical, 7 differing as before).
- `node scripts/ci/run-static-gates.mjs`: 60/60 passed.
- For each finding, the fix was reverted with `git apply -R` and the new tests were run to confirm they failed without it (counts are in the commit bodies).

## Found along the way (not fixed)
1. `apps/web/src/design-system/grid/editors/SelectPanelEditor.tsx:96,108` still "cancels" with the editor's `stopEditing(true)`. That call commits the last reported value, like the B09 bug. It is harmless today because this editor reports only on Enter or Tab, and both end the edit. An existing test (`SelectPanelEditor.vitest.test.ts` "does not resave an unchanged selection") asserts that call, so it was left alone. Switching to `api.stopEditing(true)` would need that test updated.
2. `apps/web/src/design-system/grid/editors/AxesPanelEditor.tsx:1693` types `stopEditing?: (cancel?: boolean) => void`, the same misreading of AG's parameter that B09 fixed elsewhere.
3. 125 of the 194 tracked factory `.d.ts` files differ from a fresh `tsc --emitDeclarationOnly` of the factory design system (older comments, older API) for reasons that predate this stack. Web gitignores its declarations (`.gitignore:96`) while factory tracks them, so they will drift again. Consider regenerating all of them or untracking them.
4. `apps/web/src/app/products/[id]/edit/_studio/sheet/useProductSheetInteraction.ts:59-78`: a click on a locked cell's chevron (now passive) does not say why the cell is locked. Only double-click, Enter or typing does (see B21).
5. AG 36 does not start editing a selected cell on an IME key ('Process'), so with an IME active a cell cannot be opened by typing (see B18). A fix would need `onCellKeyDown` in the sheet host to start editing on `event.key === 'Process'`.
6. `apps/factory/src/design-system/CHANGELOG.md` has no entry for the product-sheet P0 list work (B24), although the P0 files are mirrored in factory.
