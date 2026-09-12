import type { ReactNode } from 'react'

export interface SummaryTableProps {
  label: string
  columns: readonly string[]
  rows: ReadonlyArray<{ id: string; cells: readonly ReactNode[] }>
}

/** Compact, read-only comparisons inside cards and drawers. Interactive datasets use NexusGrid. */
export function SummaryTable({ label, columns, rows }: SummaryTableProps) {
  return <table className="nds-summary-table" aria-label={label}>
    <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>{row.cells.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
  </table>
}
