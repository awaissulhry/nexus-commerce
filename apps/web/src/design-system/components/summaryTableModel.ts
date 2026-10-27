/**
 * SummaryTable's class and per-column alignment (2026-10-26), kept out of the .tsx so node-only vitest can hold them.
 * PURE.
 */
export type SummaryTableDensity = 'compact' | 'roomy'
export type SummaryTableAlign = 'left' | 'right'

/** The table's class: `nds-summary-table`, plus `roomy` and `stack-phone` when asked. Default = today's class alone. */
export function summaryTableClass(opts: { density?: SummaryTableDensity; stackOnPhone?: boolean }): string {
  return `nds-summary-table${opts.density === 'roomy' ? ' roomy' : ''}${opts.stackOnPhone ? ' stack-phone' : ''}`
}

/**
 * A column's stated alignment, or `undefined` when the caller left it to the default rule (the last column right, every
 * other left — drawn by the stylesheet, so a table with no `align` renders exactly as before).
 */
export function summaryCellAlign(align: ReadonlyArray<SummaryTableAlign | undefined> | undefined, index: number): SummaryTableAlign | undefined {
  return align?.[index] ?? undefined
}
