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
export declare const textEditor: () => Pick<ColDef, "editable" | "cellEditor">;
export { selectEditor, SelectChevron, SELECT_CELL_CLASS, type SelectEditorParams } from './SelectCellEditor';
export { SelectPanelEditor, type SelectPanelEditorParams } from './SelectPanelEditor';
export { CellSaveTracker, roundTripClassRules, saveCell, SAVED_FADE_MS, type CellSaveState, type CellSaveEntry, type SaveOutcome } from './roundTrip';
export { longTextEditor, sheetClassRules, selectValidation, lengthValidation, lengthCapOf, evaluateLengthCaps, matchPasteToHeaders, sheetPasteProcessor, type CellValidity, type LengthCaps, type LengthReading, type SheetValidation } from './sheet';
export { writeGate, NON_EDIT_SOURCES, type WriteGateInput, type WriteGateVerdict } from './writeGate';
export { SheetWriter, DEFAULT_SHEET_FLUSH_MS, type SheetWriteCell, type SheetWriteRequest, type SheetWriteResult, type SheetWriterOptions } from './sheetWriter';
export { variationThemeChange, variationThemeWrite, type VariationThemeChange, type VariationThemeChangeKind, type VariationThemeWrite, type VariationThemeWriteFacts } from './sheetWriter';
export { FormulaCellEditor, FormulaGlyph, formulaCellEditorSelector, suppressFormulaKeys, type FormulaEditorParams, type FormulaWiring } from './FormulaCellEditor';
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
