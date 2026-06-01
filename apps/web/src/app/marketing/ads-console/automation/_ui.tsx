'use client'

/** Shared loading shimmer for automation data tables — a professional skeleton
 * state instead of a bare "Loading…" cell. */

export function TableSkel({ rows = 7, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c}><span className="az-skel" style={{ width: c === 0 ? '70%' : '55%' }} /></td>
          ))}
        </tr>
      ))}
    </>
  )
}
