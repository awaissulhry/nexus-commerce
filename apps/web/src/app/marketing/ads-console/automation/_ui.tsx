'use client'

/** Shared loading shimmer for automation data tables — a professional skeleton
 * state instead of a bare "Loading…" cell. */

/**
 * The loading state for a DS `DataGrid`.
 *
 * `TableSkel` below emits `<tr>`/`<td>` and cannot be used here: `DataGrid` renders `emptyState`
 * INSIDE a single `<td colSpan>`, and it has no `loading` prop at all (checked against the .tsx —
 * its .d.ts is stale and lists neither this nor `renderExpanded`). So the skeleton becomes a
 * stack of bars rather than a grid of cells. It reuses `.az-skel`, which is unscoped and
 * therefore survives the move out of `.az-table`.
 */
export function GridSkel({ rows = 6 }: { rows?: number }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
      {Array.from({ length: rows }).map((_, r) => (
        <span key={r} className="az-skel" style={{ width: r === 0 ? '70%' : `${55 - (r % 3) * 8}%` }} />
      ))}
    </span>
  )
}

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
