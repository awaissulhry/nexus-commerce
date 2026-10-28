/**
 * AG merges a column's own `cellEditorParams` into the params of the editor it opens (grid params ← colDef.cellEditorParams ←
 * selector params). The studio's formula wiring depends on that order (a static `formulas: false` on the column once leaked into
 * the formula editor and turned `=` into text — 2026-09-24). Tests outside the engine reproduce the merge through THIS seam, so
 * only the engine imports AG Grid (scripts/check-ag-grid-import-boundary.mjs).
 */
export { _mergeDeep as mergeEditorParamsLikeAg } from 'ag-grid-community'
