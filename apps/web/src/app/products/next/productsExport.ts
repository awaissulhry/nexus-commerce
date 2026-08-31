/**
 * The products export — the QUERY, not the viewport.
 *
 * `api.exportDataAsCsv()` walks the rows AG is holding. Under the Server-Side Row Model that is
 * the loaded blocks: on any catalogue bigger than one page the file was a silent subset of what
 * the operator had filtered to, and it also carried the `FamilyFooterRow` sentinels this page
 * injects under an expanded family, because those are rows to AG.
 *
 * So the export re-asks the SERVER for the same scope the grid is showing — the same
 * `POST /api/products/grid`, the same context, filters and sort — in chunks, with the tree and any
 * row grouping flattened away (`groupKeys: []`, no `rowGroupCols`). What comes back is the
 * operator's filtered result set, whole, and the sentinels never existed on that side of the wire.
 *
 * The CAP is not a guess about the catalogue: it is the point past which holding rows in the tab
 * to build one string stops being reasonable, and the caller is told it truncated rather than
 * being handed a short file that looks complete — the very failure this replaces.
 */
import { getBackendUrl } from '@/lib/backend-url'

import { buildGridRequest, type ProductsGridContext, type ProductsGridResponse } from './productsServerContract'
import type { SortModelItem } from '@/design-system/grid'

/** Rows per request. The grid itself pages at 100; a export asks for more per round-trip. */
const CHUNK = 500

export const EXPORT_ROW_CAP = 50_000

export interface ExportFetchResult<TRow> {
  rows: TRow[]
  /** The server's own count for the query — what the file WOULD hold with no cap. */
  total: number
  /** The cap was reached: `rows` is short of `total`, and the caller must say so. */
  truncated: boolean
}

export interface ExportFetchOptions {
  context: ProductsGridContext
  sortModel: readonly SortModelItem[]
  filterModel: unknown
  /** Loaded so far / the server's total, after each chunk. */
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

export async function fetchAllRowsForExport<TRow>({
  context,
  sortModel,
  filterModel,
  onProgress,
  signal,
}: ExportFetchOptions): Promise<ExportFetchResult<TRow>> {
  const rows: TRow[] = []
  let total = 0
  let startRow = 0

  for (;;) {
    const body = buildGridRequest(context, {
      startRow,
      endRow: startRow + CHUNK,
      sortModel,
      // Flat: a family's inline preview and a grouped level are both VIEWS of this scope, and
      // neither is what "export what I filtered to" means.
      groupKeys: [],
      filterModel,
      rowGroupCols: [],
      valueCols: [],
    })

    const res = await fetch(`${getBackendUrl()}/api/products/grid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    })
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`)
    const data = (await res.json()) as ProductsGridResponse<TRow>

    const batch = data.rows ?? []
    total = data.rowCount ?? batch.length
    rows.push(...batch)
    onProgress?.(rows.length, total)

    // Three ways to be done, and the short block is the authoritative one: a server that answers
    // fewer rows than asked has no more to give, whatever its count said.
    if (batch.length < CHUNK) break
    if (rows.length >= total) break
    if (rows.length >= EXPORT_ROW_CAP) return { rows: rows.slice(0, EXPORT_ROW_CAP), total, truncated: true }

    startRow += CHUNK
  }

  return { rows, total, truncated: false }
}
