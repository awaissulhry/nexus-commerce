'use client'

import { EmptyValue } from '../grid/renderers/cells'
import { GridEmptyCellsContext, type GridEmptyCells } from '../grid/renderers/emptyCells'

/*
 * 2026-09-26 — the grid's empty-cell mode (`NexusGrid emptyCells`). `dash` is the default and the
 * metrics reading; `blank` is the editing reading the product sheet uses. A measured zero keeps its
 * dash in both. The last row is the `nds-cell-na` hatch a sheet puts on a cell that does not apply.
 */
const MODES: Array<{ mode: GridEmptyCells; note: string }> = [
  { mode: 'dash', note: 'default — a grid of numbers: "nothing measured" must look different from 0' },
  { mode: 'blank', note: 'an editing sheet: an empty cell is a value nobody entered yet; a screen reader hears "No value"' },
]

const cellBox = {
  display: 'inline-flex', minWidth: 0, width: 140, height: 28, alignItems: 'center', padding: '0 var(--nds-space-6)',
  border: '1px solid var(--nds-border-subtle)', borderRadius: 'var(--nds-radius-sm)', background: 'var(--nds-surface)',
} as const

export function EmptyCellsExample() {
  return <section id="empty-cells-example">
    <h3>Empty cells — <code>NexusGrid emptyCells</code></h3>
    <p>What an empty cell draws. The grid decides once, through context, so two cells in one grid can never disagree.</p>
    <div role="list" style={{ display: 'grid', gridTemplateColumns: '80px 160px 160px 1fr', gap: 'var(--nds-space-4) var(--nds-space-12)', alignItems: 'center', fontSize: 'var(--nds-font-size-base)' }}>
      <span /><b>empty</b><b>measured zero</b><span />
      {MODES.map(({ mode, note }) => <div role="listitem" key={mode} style={{ display: 'contents' }}>
        <code>{mode}</code>
        <GridEmptyCellsContext.Provider value={mode}>
          <span style={cellBox}><EmptyValue /></span>
          <span style={cellBox}><EmptyValue measuredZero title="No sales in 7 days" /></span>
        </GridEmptyCellsContext.Provider>
        <span style={{ color: 'var(--nds-text-muted)' }}>{note}</span>
      </div>)}
      <div role="listitem" style={{ display: 'contents' }}>
        <code>na</code>
        <span className="nds-ag-nexus" style={{ display: 'contents' }}>
          <span className="ag-cell nds-cell-na" style={{ ...cellBox, position: 'static' }} title="Belongs to each variation, not to the parent" />
        </span>
        <span />
        <span style={{ color: 'var(--nds-text-muted)' }}>does not apply to this row — the hatch; the tooltip says why</span>
      </div>
    </div>
  </section>
}
