/**
 * The listings readiness page → the studio at ONE field (2026-09-26, the progress columns plan step 5).
 *
 * Each issue on this page names a field. Its link opens the product's studio in that coordinate's scope with the
 * studio's own record link — `?rec=<row>&cell=<field>` — which opens the record and reveals that exact cell. The row
 * id is the studio's own rule (`studioRowId`): a channel row is `<alias or primary>:<productId>`, a shared row is the
 * product id. The link is built by the same function the sheet's progress cards use (`studioFieldHref`).
 */
import type { ListingReadinessRow } from '@nexus/shared/listing-readiness'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { studioFieldHref } from '../[id]/edit/_studio/sheet/progressColumns'
import { studioRowId } from '../[id]/edit/_studio/sheet/channel/types'

export function issueFieldHref(row: Pick<ListingReadinessRow, 'editorHref' | 'productId' | 'channel' | 'aliasKey'>, field: string, workspaceId: string | null = browserWorkspaceId()): string {
  const at = row.editorHref.indexOf('?')
  const pathname = at < 0 ? row.editorHref : row.editorHref.slice(0, at)
  const search = at < 0 ? '' : row.editorHref.slice(at)
  const params = new URLSearchParams(search)
  const channel = row.channel && row.channel !== 'SHARED' ? row.channel : null
  // Inside the current business profile: a bare `/products/…` link lands on the profile chooser when profiles are on.
  return workspaceHref(workspaceId, studioFieldHref({ pathname, search }, {
    scope: params.get('scope') ?? (channel ?? 'master'),
    market: params.get('market'),
    locale: params.get('locale'),
    accountId: params.get('account'),
    aliasId: params.get('alias'),
    rowId: channel ? studioRowId(row.aliasKey || null, row.productId) : row.productId,
    field,
  }))
}
