/**
 * Listing readiness — the grid's Server-Side Row Model datasource, the Products page's shape (`productsDatasource.ts`).
 *
 * TOP LEVEL   `GET /api/catalog-transfer/readiness/families` — one row per family root or single product, worst
 *             first. One AG block is one API page (`cacheBlockSize = pageSize`, 50 / 100 / 200).
 * OPEN FAMILY `GET …/families/:rootId/members?limit=11&offset=0` (10 variations + the parent's own listing), then the family footer row (a sentinel AG lays out
 *             full width), which closes the block so AG never asks for more: "View all 40" opens the family's page.
 * FAMILY PAGE `?parent=<rootId>`: the members endpoint IS the top level, flat, paged with `limit` + `offset`.
 *
 * Stateless apart from a request counter: a refresh is `api.refreshServerSide(...)` and AG re-asks.
 *
 * Step 4: a header click (the server's order) and a column filter reach the request through AG's own `sortModel` and
 * `filterModel` (`listingColumns.ts` `requestQuery`): AG starts the read before the page hears of the click.
 */
import type { ReadinessFamiliesPage, ReadinessMembersPage } from '@nexus/shared/listing-readiness'
import type { GridFilterModel } from '@nexus/shared/products-grid'
import type { IServerSideDatasource, IServerSideGetRowsParams } from '@/design-system/grid'

import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import { familiesParams, membersParams, MEMBER_PREVIEW_LIMIT, pageOfBlock, type ReadinessPageQuery } from './readinessQuery'
import { familyPreview, type ReadinessGridRow } from './readinessRows'
import type { SortEntry } from './listingColumns'

export type ReadinessTopLevel = { kind: 'families'; page: ReadinessFamiliesPage } | { kind: 'members'; page: ReadinessMembersPage }

/** The grid's sort and filters as one request carries them. */
export interface ReadinessGridModels { sortModel: readonly SortEntry[]; filterModel: GridFilterModel }

export interface ReadinessDatasourceOptions {
  /**
   * Read at request time, so a filter change followed by a refresh sends the new filters. `grid`: this request's own
   * sort and filters (AG's), which the page merges in where their columns exist.
   */
  getQuery: (grid: ReadinessGridModels) => ReadinessPageQuery
  /** A top-level read started (the live pill says "Updating…"). */
  onRequest?: () => void
  /** The latest top-level answer: the header, the tiles, the toolbar count and the chip labels read it. */
  onTopLevel: (top: ReadinessTopLevel) => void
  /** A read failed. AG shows its failed block; the page has to know too, or it waits for ever. */
  onError: (message: string) => void
}

const ROOT = 'catalog-transfer/readiness/families'
const membersPath = (rootId: string) => `${ROOT}/${encodeURIComponent(rootId)}/members`

export function createReadinessDatasource({ getQuery, onRequest, onTopLevel, onError }: ReadinessDatasourceOptions): IServerSideDatasource<ReadinessGridRow> {
  let rootRequest = 0
  return {
    getRows: async (params: IServerSideGetRowsParams<ReadinessGridRow>) => {
      const { request } = params
      const query = getQuery({
        sortModel: (request.sortModel ?? []).map((e) => ({ colId: e.colId, sort: e.sort === 'desc' ? 'desc' : 'asc' })),
        filterModel: (request.filterModel ?? {}) as GridFilterModel,
      })
      const groupKeys = request.groupKeys ?? []
      const isRoot = groupKeys.length === 0
      const version = isRoot ? ++rootRequest : null
      if (isRoot) onRequest?.()
      const startRow = request.startRow ?? 0
      const endRow = request.endRow ?? startRow + query.pageSize
      try {
        if (isRoot && query.parent) {
          // One family's own page: its members, flat, paged by the pager.
          const page = await transferApi<ReadinessMembersPage>(`${membersPath(query.parent)}?${membersParams(query, endRow - startRow, startRow)}`)
          if (version === rootRequest) onTopLevel({ kind: 'members', page })
          params.success({ rowData: page.rows, rowCount: page.total })
          return
        }
        if (isRoot) {
          const block = pageOfBlock(startRow, endRow, query.pageSize)
          const page = await transferApi<ReadinessFamiliesPage>(`${ROOT}?${familiesParams(query, block.page, block.pageSize)}`)
          // The answer lands BEFORE the rows, so the chip labels and the destinations order are current when cells draw.
          if (version === rootRequest) onTopLevel({ kind: 'families', page })
          params.success({ rowData: page.rows.slice(block.skip, block.skip + block.take), rowCount: page.total })
          return
        }
        // An open family: the capped preview, then the footer that closes the block.
        const rootId = String(groupKeys[groupKeys.length - 1])
        // One more than the preview: the parent's own listing comes first and must not cost a variation.
        const members = await transferApi<ReadinessMembersPage>(`${membersPath(rootId)}?${membersParams(query, MEMBER_PREVIEW_LIMIT + 1, 0)}`)
        const rows = familyPreview(rootId, members, MEMBER_PREVIEW_LIMIT)
        params.success({ rowData: rows, rowCount: rows.length })
      } catch (error) {
        // Reported twice on purpose: to AG (its failed-block state) and to the page (the live pill, the error card).
        if (!isRoot || version === rootRequest) onError(error instanceof Error ? error.message : String(error))
        params.fail()
      }
    },
  }
}
