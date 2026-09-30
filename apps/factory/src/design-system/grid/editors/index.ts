/**
 * GDS — editors. AG's own number editor, configured once; AG's rich select as the select editor; and
 * the per-cell server round-trip state the ads bid/budget cells need.
 */
import type { ColDef } from 'ag-grid-community'
import { scalarValueEditor } from './FormulaCellEditor'

export interface NumericEditorOptions {
  min?: number
  max?: number
  step?: number
  /** Decimal places; `0` for whole units (stock), `2` for money. */
  precision?: number
}

/**
 * AG's number editor, the way the inventory editor configured it: no stepper buttons (they are
 * 16px targets nobody hits), whole units by default, a floor at zero.
 */
export const numericEditor = (opts: NumericEditorOptions = {}): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorParams'> => ({
  editable: true,
  cellEditor: 'agNumberCellEditor',
  cellEditorParams: { min: opts.min ?? 0, max: opts.max, step: opts.step ?? 1, precision: opts.precision ?? 0, showStepperButtons: false },
})

/**
 * R-63 (A-42 step 1, 2026-09-24) — a free-text column opens the ONE value editor (formulas off), the same popup the studio
 * sheets open for text, not AG's inline `agTextCellEditor`. Its consumer today is the Variants page's channel projection.
 */
export const textEditor = (): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorPopup' | 'cellEditorParams' | 'suppressKeyboardEvent'> => ({
  editable: true,
  ...scalarValueEditor('text'),
})

export { selectEditor, SelectChevron, openCellEditor, SELECT_CELL_CLASS, SELECT_CLEAR_LABEL, type SelectEditorParams } from './SelectCellEditor'
/* Exported so a host can name it as the FALLBACK editor beside `formulaSelector` — `=` opens the
   formula editor on a closed list, anything else opens this one (#775). */
export { SelectPanelEditor, type SelectPanelEditorParams } from './SelectPanelEditor'
export { CellSaveTracker, roundTripClassRules, saveCell, saveNote, SAVED_FADE_MS, type CellSaveState, type CellSaveEntry, type SaveOutcome } from './roundTrip'
export { longTextEditor, textLimitFor, NO_TEXT_LIMIT, sheetClassRules, selectValidation, lengthValidation, lengthCapOf, evaluateLengthCaps, matchPasteToHeaders, sheetPasteProcessor, type CellValidity, type LengthCaps, type LengthReading, type SheetValidation } from './sheet'
// PES.2 — the ONE decision about whether a grid change should be written (rulings #53, #63).
export { writeGate, NON_EDIT_SOURCES, type WriteGateInput, type WriteGateVerdict } from './writeGate'
// PES.2 — the sheet's ONE write path: per-row version, per-row batching, per-cell outcomes.
export { SheetWriter, DEFAULT_SHEET_FLUSH_MS, type ReadBackSnapshot, type SheetWriteCell, type SheetWriteRequest, type SheetWriteResult, type SheetWriterOptions } from './sheetWriter'
export { variationThemeChange, variationThemeWrite, type VariationThemeChange, type VariationThemeChangeKind, type VariationThemeWrite, type VariationThemeWriteFacts } from './sheetWriter'

// PES.2 — D16 formula editing (#730). The RULES are pure and tested; the editor is wiring over them.
export { FormulaCellEditor, FormulaGlyph, formulaCellEditorSelector, suppressFormulaKeys, scalarValueEditor, scalarValueEditorSpec, CELL_EDITING_UNDER_CLASS, type FormulaEditorParams, type FormulaWiring, type CellEditorContext, type CellHistoryEntry } from './FormulaCellEditor'
// R-47 / R-48 (A-42 step 1, 2026-09-24) — a number cell never loses its value to a stray letter; ONE key line for every editor.
export { isNumberDraft, numberStart, acceptNumberEdit, numberCommitText, NUMBER_ONLY_MESSAGE, type NumberStart } from './numberEntry'
export { EDITOR_KEY_HINT, EDITOR_KEY_HINT_FORM, EDITOR_KEY_HINT_PANEL } from './editorHint'
// Sheet pop-up rebuild P1 (2026-09-28) — a pop-up hosted outside AG's popup layer sizes itself by the same rule.
export { editorBox, roomToRightOf, EDITOR_CAPS, MIN_EDITOR_WIDTH, type EditorKind, type EditorBox } from './editorBox'
// Sheet pop-up rebuild P2 — the family behind a master variation-theme cell (values with photos, variants).
export { axisRemovalRefusal, axisValueCount, familyAxisFor, filterVariants, orderValues, valueOrderAfterDrag, type VariationFamilyAxis, type VariationFamilyLoader, type VariationFamilyState, type VariationFamilyValue, type VariationFamilyVariant, type VariationFamilyView } from './variationFamily'
export { CHANNEL_AXES_COPY, channelAxisGapHint, channelAxisOrigin, channelAxisValues, channelSetChangeHeld, ownAxisKeyFor, ownNameRefusal, remainingOwnCandidates, remainingSharedAxes, usesChannelAxesLayout, withOwnChannelAxis, withOwnSharedAxis, withSharedAxis, withoutAxis, newAttributeHeld, newAttributeDoneLine, withOwnAxisSource, freeNameRefusal, type OwnAxisSourceOption, type OwnAxisSourcesLoader, type OwnAxisSourcesState, type OwnAxisSourcesRead, type NewAttributeState, type OwnAxisAttributeResult, type OwnAxisAttributeCreator } from './channelAxes'
export { isFormulaDraft, commitValue, coerceTyped, completionToAccept, formulaAvailability, formulaEditorChoice, formulaSaveOutcome, FORMULA_BLOCKED_REASON, FORMULA_STORED_NOT_EVALUATED, type FormulaSaveResponse, type FormulaSaveOutcome, type FormulaAvailability, type FormulaEditorChoice, type CommitKind, exprOf, inStringLiteral, refTokenAt, completionsFor, applyCompletion, unknownRefs, type FormulaCandidate, type RefToken } from './formulaEditing'
export { tokenizeForDisplay, refsOf, matchBrackets, callAt, type Token, type TokenKind, type CallContext } from './formulaTokens'
export { assignRefColours, refColoursWrap, colourFor, REF_CYCLE, CYCLE_MEASURED_CONTRAST, type RefColour } from './formulaPalette'
export { previewLine, errorMarkAt, functionHint, signatureArgs, unknownRefNames, type PreviewLine, type PreviewState, type FormulaPreviewResponse, type FormulaFunctionDoc, type FunctionHint } from './formulaPreview'
// PES — the P0 of 2026-09-03: what an OPEN GESTURE must do. The fill-handle interception lives
// in `NexusGrid.tsx`; the rule and the per-kind editor-mode declaration are here, and tested.
export { fillHandleHit, EDITOR_MODE_BY_KIND, FORMULA_EDITOR_MODE, type FillHandleHit } from './openGesture'
// 2026-09-04 — what every sheet column carries, defined ONCE so master and the channel scopes cannot drift.
export { sheetValidationFor, composeSheetCellClassRules, SHEET_SHORTCUT_HINT, type SheetColumnLike } from './sheetColumn'
// AM.1 (2026-09-05) — the list and measure shapes on the grid: editors + the ColDef both builders spread.
export { ListPanelEditor, type ListPanelEditorParams } from './ListPanelEditor'
export { MeasureEditor, type MeasureEditorParams } from './MeasureEditor'
export { shapeColumnDef, shapeEditorSpec, parseShape, type ShapedColumnLike } from './shapeColumn'
export { variationThemeColumnDef } from './shapeColumn'
export {
  AxesPanel, AxesPanelEditor, AXES_EDITOR_COPY, AXES_ADD_KEYS, THEME_GROUP_ORDER, THEME_GROUP_LABEL,
  axesEditorScopeLabel, axesSectionTitle, axesAddLabel, axesFilterMatch, moveHighlight, reorderAxes, themeGroupOf,
  axesCellFromProjection, projectionDraftFromAxesCell,
  type AxesPanelProps, type AxesPanelEditorParams, type AxesEditorHost, type ThemeGroup,
  type ProjectionPageLike, type ProjectionDraftLike,
} from './AxesPanelEditor'

export { formulaTransfer, formulaFillSourceIndex } from './formulaTransfer'

export { FormulaComposer } from './FormulaComposer'
export { FormulaGuidance, formulaSuggestions, useFormulaPreview } from './formulaAssistance'

// MX.G (2026-09-13) — the Matrix page's ONE column builder, its sale editor and its writer branch.
export { matrixColumnDef, type MatrixColumnOptions } from './matrixColumn'
export { SaleCellEditor, type SaleCellEditorParams } from './SaleCellEditor'
export { matrixWrite, MATRIX_NOT_A_COLUMN, MATRIX_NO_LISTING, MATRIX_FULFILMENT_INLINE, MATRIX_UNCHANGED, type MatrixWriteColumn, type MatrixWriteDecision } from './sheetWriter'

// Step 4.3 #3 (A-52; R-55, R-56, 2026-09-24) — bullets in ONE cell: the editor (slots / list modes) and its cell, the engine
// column both sheet builders return, and the pure rules (values with holes, changed positions, the R-55 keys).
export { SlotListEditor, SlotListValue, slotListMoveFact, slotListSaveState, slotListProvenance, slotListSummary, type SlotListEditorParams, type SlotListSettings, type SlotCellLike, type SlotListValueParams } from './SlotListEditor'
export { slotListColumnDef, slotListEditable, type SlotListColumnOptions } from './slotListColumn'
export { SLOT_LIST_PREFIX, SLOT_LIST_EDITOR_CLASS, slotListKey, isSlotListKey, slotListValue, slotListChanges, moveSlot, moveByKey, listModeItems, withTrailingEmpty, listModeCommit, slotListText, bulletsEditorKey, slotPositionOf, suppressSlotListKeys, type SlotGroup, type SlotChange, type BulletsKeyAction, type KeyLike } from './slotList'
export { cellValueOf, isUnchanged, panelValueOf, typedStart, withStoredValue } from './selectPanelModel'
