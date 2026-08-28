/**
 * The products grid's Server-Side Row Model datasource. A thin caller of the contract.
 *
 * AG asks for a block — `[startRow, endRow)` plus its sort model and, for a tree, the group
 * keys of the parent being expanded — and this POSTS that request, verbatim, with the page's
 * context to `/api/products/grid`. The server owns what it means; this file only knows how to
 * fetch and how to hand the answer back.
 *
 * TREE DATA UNDER SSRM
 * A product family is a parent with lazily loaded variations. AG expresses that as
 * `isServerSideGroup` (can this row expand?) + `getServerSideGroupKey` (what key names it) +
 * `request.groupKeys` (the path being expanded). When `groupKeys` is non-empty the request is for
 * one family's children, and the server answers with its capped preview (ten, in the grid's sort).
 * The footer sentinel closes that block and tells AG it is complete, so AG never asks for a second
 * page of variations the page has chosen not to show inline; the family page shows the rest.
 *
 * REFRESH
 * The datasource is stateless. The page calls `api.refreshServerSide(...)` on an invalidation
 * event and AG re-asks for whatever is on screen.
 */
import type { IServerSideDatasource, IServerSideGetRowsParams } from 'ag-grid-community'

import { getBackendUrl } from '@/lib/backend-url'
import { buildGridRequest, type ProductsGridContext, type ProductsGridResponse, type ProductsListStats } from './productsServerContract'

export type { ProductsGridContext, ProductsGridResponse, ProductsListStats } from './productsServerContract'

/**
 * The full-width row beneath an expanded family — "Showing 10 of 40 variations" and
 * the button that opens the family as a page. Appended to the preview block as a SENTINEL row,
 * so AG lays it out as a row (`isFullWidthRow`) and the page renders it. `total` is the SERVER's
 * own `rowCount` for the very query that produced the rows, so it cannot drift from them.
 */
export interface FamilyFooterRow {
  __familyFooter: true
  id: string
  parentId: string
  shown: number
  total: number
}
export const isFamilyFooter = (d: unknown): d is FamilyFooterRow =>
  !!d && typeof d === 'object' && (d as { __familyFooter?: boolean }).__familyFooter === true
export const familyFooterId = (parentId: string) => `__family_footer__${parentId}`

export interface ProductsDatasourceOptions<TRow> {
  /** Read at request time, so a filter change followed by a refresh sends the new filters. */
  getContext: () => ProductsGridContext
  /** Top-level metadata from the response — the KPI strip and the "of N" count read these. */
  onTopLevel?: (info: { total: number; stats?: ProductsListStats; response: ProductsGridResponse<TRow> }) => void
  /** The SERVER could not express something (an unmapped tag, a column it cannot order by). */
  onUnsupported?: (items: string[]) => void
  /**
   * A block failed to load. AG shows its own failed-block state, but that is a cell-level
   * signal; the PAGE has to know too, or it sits on its loading skeleton forever — which reads as
   * "still loading" on a 401 and sends the next person looking for a bug in the grid.
   */
  onError?: (message: string) => void
}

export function createProductsDatasource<TRow>({
  getContext,
  onTopLevel,
  onUnsupported,
  onError,
}: ProductsDatasourceOptions<TRow>): IServerSideDatasource<TRow> {
  return {
    getRows: async (params: IServerSideGetRowsParams<TRow>) => {
      const { request } = params
      // Under row grouping `groupKeys` is a group path, not a family; only the tree gets a footer.
      const grouped = (request.rowGroupCols?.length ?? 0) > 0
      const parentId = !grouped && request.groupKeys.length ? String(request.groupKeys[request.groupKeys.length - 1]) : null
      const body = buildGridRequest(getContext(), { startRow: request.startRow, endRow: request.endRow, sortModel: request.sortModel, groupKeys: request.groupKeys, filterModel: request.filterModel, rowGroupCols: request.rowGroupCols, valueCols: request.valueCols })

      try {
        const res = await fetch(`${getBackendUrl()}/api/products/grid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as ProductsGridResponse<TRow>
        const rowData = data.rows ?? []
        const rowCount = data.rowCount ?? rowData.length
        // Reported on every answer, an empty list included, so a note about a filter that no
        // longer applies clears the moment the request stops carrying it.
        onUnsupported?.(data.unsupported ?? [])
        // The KPI tiles read only the ROOT request: a level inside a grouping or a family
        // reports its own stats, and opening "Xavia › Active" must not show 11 of 14 products.
        if (request.groupKeys.length === 0) onTopLevel?.({ total: rowCount, stats: data.stats, response: data })
        if (parentId && rowCount > 0) {
          // The preview is capped on purpose; the footer sentinel closes the block and reports the
          // block as complete, so AG never asks for a second page of variations.
          const footer: FamilyFooterRow = { __familyFooter: true, id: familyFooterId(parentId), parentId, shown: rowData.length, total: rowCount }
          const withFooter = [...rowData, footer as unknown as TRow]
          params.success({ rowData: withFooter, rowCount: withFooter.length })
          return
        }
        params.success({ rowData, rowCount })
      } catch (err) {
        // A thrown error here would be swallowed by AG, so it is reported twice on purpose: to
        // AG (failed-block state, retried on the next scroll into range) and to the page.
        onError?.(err instanceof Error ? err.message : String(err))
        params.fail()
      }
    },
  }
}
