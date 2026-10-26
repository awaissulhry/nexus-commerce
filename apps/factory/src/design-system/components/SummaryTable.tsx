import type { ReactNode } from 'react'
import { summaryCellAlign, summaryTableClass, type SummaryTableAlign, type SummaryTableDensity } from './summaryTableModel'

export type { SummaryTableAlign, SummaryTableDensity } from './summaryTableModel'

export interface SummaryTableProps {
  label: string
  columns: readonly string[]
  rows: ReadonlyArray<{ id: string; cells: readonly ReactNode[] }>
  /**
   * `compact` (default, 24px rows) or `roomy` (2026-10-26): 44px rows, for a table whose rows carry buttons (Undo, Open).
   */
  density?: SummaryTableDensity
  /**
   * Each column's alignment, by index (2026-10-26). A column left `undefined` keeps the default rule: the last column
   * right, every other left. Passing it for the last column overrides that rule.
   */
  align?: ReadonlyArray<SummaryTableAlign | undefined>
  /**
   * Below 760px each row becomes a stacked block, each cell on its own line with its column's label before it, so nothing
   * scrolls sideways (2026-10-26). Default false: the table keeps its columns.
   */
  stackOnPhone?: boolean
  /**
   * Each column's width, by index (2026-10-26), as a CSS width ("40%", "120px"). The table is `table-layout: fixed`, so
   * without widths every column gets an equal share and a long first column (a campaign › ad group path) is cut short.
   * A column left `undefined` shares what is left. Ignored by the stacked phone form.
   */
  widths?: ReadonlyArray<string | undefined>
}

/**
 * Compact, read-only comparisons inside cards and drawers. Interactive datasets use NexusGrid.
 * A muted second line inside a cell: `<span className="nds-summary-sub">…</span>`.
 */
export function SummaryTable({ label, columns, rows, density, align, stackOnPhone, widths }: SummaryTableProps) {
  const cls = summaryTableClass({ density, stackOnPhone })
  const alignOf = (index: number) => summaryCellAlign(align, index)
  return <table className={cls} aria-label={label}>
    {widths?.some(Boolean) && <colgroup>{columns.map((column, index) => <col key={`${index}:${column}`} style={widths[index] ? { width: widths[index] } : undefined} />)}</colgroup>}
    <thead><tr>{columns.map((column, index) => <th key={column} scope="col" data-align={alignOf(index)}>{column}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>{row.cells.map((cell, index) =>
      <td key={index} data-align={alignOf(index)} data-label={stackOnPhone ? columns[index] : undefined}>{cell}</td>)}</tr>)}</tbody>
  </table>
}
