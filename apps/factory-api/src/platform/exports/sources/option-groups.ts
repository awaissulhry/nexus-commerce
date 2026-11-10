import type { ListGroupsQuery } from '@nexus/factory-domain/product/options/contracts'
import { OPTION_GROUP_KINDS, type OptionGroupKind } from '@nexus/factory-domain/product/options/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { listGroups } from '../../../modules/product/options/groups'
import { defineExportSource } from '../source'

/**
 * Products › Libraries › Options & rules (SCR-114, `/products/options`; B-W2b-242): the export of the option groups as the
 * screen shows them, through B-W2b-229's listGroups (product.styles.view, the groups the person sees). The address is the
 * list's own (apps/factory-web areas/products/options model.ts filtersOf + listQueryOf): `?view=active|all|archived`,
 * `?kind=` (a word that is no kind is not applied, as on the screen), `?q=`, `?outside=1` (the tile) and `?style=<id>` (the
 * Style studio's link: the groups that style offers, active offers). One read: the library holds no cursor. No money.
 */

type GroupRow = Awaited<ReturnType<typeof listGroups>>['groups'][number]
/** A group with its picks in the file's language ("0–1", "0–qualsiasi"). */
type Row = GroupRow & { readonly picksText: string }
type Query = Pick<ListGroupsQuery, 'status' | 'kind' | 'q' | 'outsideCertificate'> & { readonly style?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function rowsOf(caller: Parameters<typeof listGroups>[0], query: Query): Promise<GroupRow[]> {
  const { style, ...list } = query
  const answer = await listGroups(caller, list as ListGroupsQuery)
  if (!style) return answer.groups
  const offered = await caller.withClient((client) => client.styleOptionGroup.findMany({ where: { styleId: style, status: 'ACTIVE' }, select: { groupId: true } }))
  const ids = new Set(offered.map((offer) => offer.groupId))
  return answer.groups.filter((row) => ids.has(row.id))
}

export const optionGroups = defineExportSource<Query, Row>({
  listKey: 'products.options',
  permission: PRODUCT_STYLES_VIEW,
  query(address) {
    const view = address.get('view')
    const kind = address.get('kind') ?? ''
    const style = address.get('style')?.trim() ?? ''
    return {
      status: view === 'archived' ? 'ARCHIVED' : view === 'all' ? 'ALL' : 'ACTIVE',
      kind: (OPTION_GROUP_KINDS as readonly string[]).includes(kind) ? (kind as OptionGroupKind) : undefined,
      q: address.get('q')?.trim().slice(0, 100) || undefined,
      outsideCertificate: address.get('outside') === '1' ? true : undefined,
      style: UUID.test(style) ? style : undefined,
    }
  },
  async read(caller, query, cursor, _limit, options) {
    // One page: every group of the view (the library's read holds no cursor).
    if (cursor) return { rows: [], next: null }
    const rows = await rowsOf(caller, query)
    return { rows: rows.map((row) => ({ ...row, picksText: options?.locale === 'en' ? row.picks.en : row.picks.it })), next: null }
  },
  async count(caller, query) {
    return (await rowsOf(caller, query)).length
  },
  columns: {
    group: { value: (row) => `${row.code} · ${row.name}` },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    options: { value: (row) => row.values },
    picks: { value: (row) => row.picksText },
    styles: { value: (row) => row.styles },
    rules: { value: (row) => row.rules },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  words: {
    it: { 'kind.SINGLE': 'Una scelta', 'kind.MULTI': 'Più scelte', 'kind.FREE_TEXT': 'Testo libero', 'status.ACTIVE': 'Attivo', 'status.ARCHIVED': 'Archiviato' },
    en: { 'kind.SINGLE': 'One choice', 'kind.MULTI': 'Several choices', 'kind.FREE_TEXT': 'Typed text', 'status.ACTIVE': 'Active', 'status.ARCHIVED': 'Archived' },
  },
})
