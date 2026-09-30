/**
 * GDS — editors. AG's own number editor, configured once; AG's rich select as the select editor; and
 * the per-cell server round-trip state the ads bid/budget cells need.
 */
import type { ColDef } from 'ag-grid-community';
export interface NumericEditorOptions {
    min?: number;
    max?: number;
    step?: number;
    /** Decimal places; `0` for whole units (stock), `2` for money. */
    precision?: number;
}
/**
 * AG's number editor, the way the inventory editor configured it: no stepper buttons (they are
 * 16px targets nobody hits), whole units by default, a floor at zero.
 */
export declare const numericEditor: (opts?: NumericEditorOptions) => Pick<ColDef, "editable" | "cellEditor" | "cellEditorParams">;
/**
 * R-63 (A-42 step 1, 2026-09-24) — a free-text column opens the ONE value editor (formulas off), the same popup the studio
 * sheets open for text, not AG's inline `agTextCellEditor`. Its consumer today is the Variants page's channel projection.
 */
export declare const textEditor: () => Pick<ColDef, "editable" | "cellEditor" | "cellEditorPopup" | "cellEditorParams" | "suppressKeyboardEvent">;
export { selectEditor, SelectChevron, openCellEditor, SELECT_CELL_CLASS, SELECT_CLEAR_LABEL, type SelectEditorParams } from './SelectCellEditor';
export { SelectPanelEditor, type SelectPanelEditorParams } from './SelectPanelEditor';
export { CellSaveTracker, roundTripClassRules, saveCell, saveNote, SAVED_FADE_MS, type CellSaveState, type CellSaveEntry, type SaveOutcome } from './roundTrip';
export { longTextEditor, textLimitFor, NO_TEXT_LIMIT, sheetClassRules, selectValidation, lengthValidation, lengthCapOf, evaluateLengthCaps, matchPasteToHeaders, sheetPasteProcessor, type CellValidity, type LengthCaps, type LengthReading, type SheetValidation } from './sheet';
export { writeGate, NON_EDIT_SOURCES, type WriteGateInput, type WriteGateVerdict } from './writeGate';
export { SheetWriter, DEFAULT_SHEET_FLUSH_MS, type ReadBackSnapshot, type SheetWriteCell, type SheetWriteRequest, type SheetWriteResult, type SheetWriterOptions } from './sheetWriter';
export { variationThemeChange, variationThemeWrite, type VariationThemeChange, type VariationThemeChangeKind, type VariationThemeWrite, type VariationThemeWriteFacts } from './sheetWriter';
export { FormulaCellEditor, FormulaGlyph, formulaCellEditorSelector, suppressFormulaKeys, scalarValueEditor, scalarValueEditorSpec, CELL_EDITING_UNDER_CLASS, type FormulaEditorParams, type FormulaWiring, type CellEditorContext, type CellHistoryEntry } from './FormulaCellEditor';
export { isNumberDraft, numberStart, acceptNumberEdit, numberCommitText, NUMBER_ONLY_MESSAGE, type NumberStart } from './numberEntry';
export { EDITOR_KEY_HINT, EDITOR_KEY_HINT_FORM, EDITOR_KEY_HINT_PANEL } from './editorHint';
export { editorBox, roomToRightOf, EDITOR_CAPS, MIN_EDITOR_WIDTH, type EditorKind, type EditorBox } from './editorBox';
export { axisRemovalRefusal, axisValueCount, familyAxisFor, filterVariants, orderValues, valueOrderAfterDrag, type VariationFamilyAxis, type VariationFamilyLoader, type VariationFamilyState, type VariationFamilyValue, type VariationFamilyVariant, type VariationFamilyView } from './variationFamily';
export { CHANNEL_AXES_COPY, channelAxisGapHint, channelAxisOrigin, channelAxisValues, channelSetChangeHeld, ownAxisKeyFor, ownNameRefusal, remainingOwnCandidates, remainingSharedAxes, usesChannelAxesLayout, withOwnChannelAxis, withOwnSharedAxis, withSharedAxis, withoutAxis, newAttributeHeld, newAttributeDoneLine, withOwnAxisSource, freeNameRefusal, type OwnAxisSourceOption, type OwnAxisSourcesLoader, type OwnAxisSourcesState, type OwnAxisSourcesRead, type NewAttributeState, type OwnAxisAttributeResult, type OwnAxisAttributeCreator } from './channelAxes';
export { isFormulaDraft, commitValue, coerceTyped, completionToAccept, formulaAvailability, formulaEditorChoice, formulaSaveOutcome, FORMULA_BLOCKED_REASON, FORMULA_STORED_NOT_EVALUATED, type FormulaSaveResponse, type FormulaSaveOutcome, type FormulaAvailability, type FormulaEditorChoice, type CommitKind, exprOf, inStringLiteral, refTokenAt, completionsFor, applyCompletion, unknownRefs, type FormulaCandidate, type RefToken } from './formulaEditing';
export { tokenizeForDisplay, refsOf, matchBrackets, callAt, type Token, type TokenKind, type CallContext } from './formulaTokens';
export { assignRefColours, refColoursWrap, colourFor, REF_CYCLE, CYCLE_MEASURED_CONTRAST, type RefColour } from './formulaPalette';
export { previewLine, errorMarkAt, functionHint, signatureArgs, unknownRefNames, type PreviewLine, type PreviewState, type FormulaPreviewResponse, type FormulaFunctionDoc, type FunctionHint } from './formulaPreview';
export { fillHandleHit, EDITOR_MODE_BY_KIND, FORMULA_EDITOR_MODE, type FillHandleHit } from './openGesture';
export { sheetValidationFor, composeSheetCellClassRules, SHEET_SHORTCUT_HINT, type SheetColumnLike } from './sheetColumn';
export { ListPanelEditor, type ListPanelEditorParams } from './ListPanelEditor';
export { MeasureEditor, type MeasureEditorParams } from './MeasureEditor';
export { shapeColumnDef, shapeEditorSpec, parseShape, type ShapedColumnLike } from './shapeColumn';
export { variationThemeColumnDef } from './shapeColumn';
export { AxesPanel, AxesPanelEditor, AXES_EDITOR_COPY, AXES_ADD_KEYS, THEME_GROUP_ORDER, THEME_GROUP_LABEL, axesEditorScopeLabel, axesSectionTitle, axesAddLabel, axesFilterMatch, moveHighlight, reorderAxes, themeGroupOf, axesCellFromProjection, projectionDraftFromAxesCell, type AxesPanelProps, type AxesPanelEditorParams, type AxesEditorHost, type ThemeGroup, type ProjectionPageLike, type ProjectionDraftLike, } from './AxesPanelEditor';
export { formulaTransfer, formulaFillSourceIndex } from './formulaTransfer';
export { FormulaComposer } from './FormulaComposer';
export { FormulaGuidance, formulaSuggestions, useFormulaPreview } from './formulaAssistance';
export { matrixColumnDef, type MatrixColumnOptions } from './matrixColumn';
export { SaleCellEditor, type SaleCellEditorParams } from './SaleCellEditor';
export { matrixWrite, MATRIX_NOT_A_COLUMN, MATRIX_NO_LISTING, MATRIX_FULFILMENT_INLINE, MATRIX_UNCHANGED, type MatrixWriteColumn, type MatrixWriteDecision } from './sheetWriter';
export { SlotListEditor, SlotListValue, slotListMoveFact, slotListSaveState, slotListProvenance, slotListSummary, type SlotListEditorParams, type SlotListSettings, type SlotCellLike, type SlotListValueParams } from './SlotListEditor';
export { slotListColumnDef, slotListEditable, type SlotListColumnOptions } from './slotListColumn';
export { SLOT_LIST_PREFIX, SLOT_LIST_EDITOR_CLASS, slotListKey, isSlotListKey, slotListValue, slotListChanges, moveSlot, moveByKey, listModeItems, withTrailingEmpty, listModeCommit, slotListText, bulletsEditorKey, slotPositionOf, suppressSlotListKeys, type SlotGroup, type SlotChange, type BulletsKeyAction, type KeyLike } from './slotList';
export { cellValueOf, isUnchanged, panelValueOf, typedStart, withStoredValue, type EditorStop, type GridCancel } from './selectPanelModel';
