'use client'

/**
 * LF.1 — the local-first parity surface.
 *
 * A sibling of `/products/next`, bound STRICTLY to the in-browser database. There is no
 * datasource, no `productsServerContract`, no fetch on any interaction: the grid receives
 * `rowData` and every sort, filter and scroll is answered by AG's client-side row model from
 * memory. The only network call in the whole page is the one-time seed inside `useLocalCatalog`.
 *
 * ── Why NexusGrid and not AgGridReact ───────────────────────────────────────────────────────
 *
 * `scripts/check-ag-grid-import-boundary.mjs` allows AG Grid imports in exactly two places —
 * `design-system/grid/` (the engine) and `app/design/grid-lab/` (the labs). A product route
 * importing `ag-grid-react` fails the push. `NexusGrid` extends `AgGridReactProps`, so binding
 * `rowData` to the DS engine satisfies the boundary AND inherits the chrome, theming and density
 * tokens for free. The local-first experiment is about the DATA path; there was never a reason
 * to fork the render path with it.
 *
 * ── What this page is for ───────────────────────────────────────────────────────────────────
 *
 * One measurement: how long a local query takes versus the server round trip `/products/next`
 * pays. The stat strip is the deliverable, not decoration — it separates the costs that are paid
 * ONCE (opening WASM, seeding) from the one paid on EVERY interaction (the local read), because
 * only the last of those is what local-first actually buys.
 */

import { useMemo } from 'react'
import { NexusGrid, gridFilterDef, type ColDef } from '@/design-system/grid'
import { useLocalCatalog } from '@/local-first/useLocalCatalog'
import type { LocalProductRow } from '@/local-first/projection'

export function NextGenClient() {
  const { rows, status, error, stats, refresh, reseed } = useLocalCatalog()

  /*
   * Memoised — `check-grid-option-identity` (GDS §8.5) fails the push if a NexusGrid option prop
   * is a fresh reference each render, because AG re-runs the whole column model when it changes.
   */
  const columnDefs = useMemo<ColDef<LocalProductRow>[]>(
    /*
     * 🔴 `gridFilterDef`, not AG's `filter: true` / `'agNumberColumnFilter'`.
     *
     * The engine registers `CustomFilterModule` and deliberately does NOT register AG's
     * TextFilter/NumberFilter/SetFilter modules — the DS ships its own filter components so the
     * chrome matches everywhere. Naming an AG built-in throws at runtime: "Unable to use
     * colDef.filter as NumberFilterModule is not registered" (AG #200), which is how this was
     * caught — the grid rendered its rows and then put an error panel over them.
     */
    () => [
      { field: 'sku', headerName: 'SKU', minWidth: 200, ...gridFilterDef('text') },
      { field: 'name', headerName: 'Product', flex: 2, minWidth: 260, ...gridFilterDef('text') },
      { field: 'brand', headerName: 'Brand', minWidth: 130, ...gridFilterDef('text') },
      { field: 'status', headerName: 'Status', minWidth: 120, ...gridFilterDef('text') },
      {
        field: 'basePrice',
        headerName: 'Price',
        minWidth: 110,
        ...gridFilterDef('number'),
        valueFormatter: (p: { value: unknown }) =>
          p.value === null || p.value === undefined ? '—' : `€${Number(p.value).toFixed(2)}`,
      },
      { field: 'totalStock', headerName: 'Stock', minWidth: 100, ...gridFilterDef('number') },
      { field: 'productType', headerName: 'Type', minWidth: 150, ...gridFilterDef('text') },
      { field: 'updatedAt', headerName: 'Last updated', minWidth: 160 },
    ],
    [],
  )

  const defaultColDef = useMemo(
    () => ({ sortable: true, resizable: true }),
    [],
  )

  const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} ms`)

  return (
    <div className="lf-page">
      <header className="lf-head">
        <div>
          <h1 className="lf-title">Products — local-first</h1>
          <p className="lf-sub">
            Bound to the in-browser database. Sorting and filtering never touch the network.
          </p>
        </div>
        <div className="lf-actions">
          <button type="button" className="nds-btn" onClick={() => void refresh()} disabled={status !== 'ready'}>
            Re-query locally
          </button>
          <button type="button" className="nds-btn" onClick={() => void reseed()}>
            Re-seed from API
          </button>
        </div>
      </header>

      <dl className="lf-stats">
        <div><dt>Status</dt><dd>{status}{stats.fromCache && status === 'ready' ? ' (from cache)' : ''}</dd></div>
        <div><dt>Open WASM DB</dt><dd>{ms(stats.openMs)}</dd></div>
        <div><dt>Seed from API</dt><dd>{stats.fromCache ? 'skipped' : ms(stats.seedMs)}</dd></div>
        <div className="lf-hero"><dt>Local query</dt><dd>{ms(stats.queryMs)}</dd></div>
        <div><dt>Rows</dt><dd>{stats.rowCount}</dd></div>
      </dl>

      {status === 'error' && (
        <p role="alert" className="lf-error">
          {error}
          {error?.includes('401') ? ' — open the app signed in; the seed uses the API session.' : ''}
        </p>
      )}

      <div className="lf-grid">
        <NexusGrid<LocalProductRow>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          fill
        />
      </div>
    </div>
  )
}

/* Module scope, so the reference is stable across renders without a hook. */
const getRowId = (p: { data: LocalProductRow }) => p.data.id

export default NextGenClient
