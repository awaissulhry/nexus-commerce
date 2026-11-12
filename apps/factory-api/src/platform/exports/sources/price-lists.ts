import { PRICE_LIST_KINDS, PRICE_LIST_STATES, type PriceListKind, type PriceListState } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { listLists, type ListListsQuery } from '../../../modules/sales/pricelists/lists'
import type { ListRowView } from '../../../modules/sales/pricelists/store'
import { defineExportSource } from '../source'

/**
 * Sales › Pricing › Price lists (SCR-106, `/sales/price-lists`; B-W2b-325, SAL-183 — the list frame's Export ▾, a gap
 * B-W2a-49 named): the lists as the screen shows them, through W2a's listLists (pricelists.view, the lists the person
 * sees). The address is the list's own (apps/factory-web areas/sales/pricelists model.ts): `?rows=active|drafts|expired|
 * all|archived`, `?soon=starting|ending`, `?kind=`, `?q=`. One read: the list holds no cursor (at most 500 lists). No
 * price: a list's prices go out as the version's file (GET /sales/price-lists/:listId/versions/:versionId/export, in the
 * price import's columns).
 */

interface Query {
  readonly list: ListListsQuery
  readonly soon: 'starting' | 'ending' | null
}

const ROWS: Readonly<Record<string, PriceListState | undefined>> = { active: 'IN_FORCE', drafts: 'DRAFT', expired: 'EXPIRED', archived: 'ARCHIVED' }

async function rowsOf(caller: Parameters<typeof listLists>[0], query: Query): Promise<ListRowView[]> {
  const answer = await listLists(caller, query.list)
  return query.soon === 'starting' ? answer.lists.filter((row) => row.startsSoon) : query.soon === 'ending' ? answer.lists.filter((row) => row.endsSoon) : answer.lists
}

const days = (row: ListRowView): string => {
  const shown = row.shownVersion
  if (!shown || (shown.validFrom === null && shown.validTo === null)) return ''
  return `${shown.validFrom ?? ''} – ${shown.validTo ?? ''}`.trim()
}

export const priceLists = defineExportSource<Query, ListRowView>({
  listKey: 'sales.price-lists',
  permission: PRICE_LISTS_VIEW,
  query(address) {
    const kind = address.get('kind') ?? ''
    const soon = address.get('soon')
    const q = address.get('q')?.trim().slice(0, 100)
    return {
      list: {
        state: ROWS[address.get('rows') ?? ''],
        kind: (PRICE_LIST_KINDS as readonly string[]).includes(kind) ? (kind as PriceListKind) : undefined,
        q: q ? q : undefined,
      },
      soon: soon === 'starting' || soon === 'ending' ? soon : null,
    }
  },
  async read(caller, query, cursor) {
    if (cursor) return { rows: [], next: null }
    return { rows: await rowsOf(caller, query), next: null }
  },
  async count(caller, query) {
    return (await rowsOf(caller, query)).length
  },
  columns: {
    name: { value: (row) => `${row.code} · ${row.name}` },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    customers: { value: (row) => row.customers },
    currency: { value: (row) => row.currency },
    validity: { value: (row) => days(row) },
    styles: { value: (row) => row.stylesPriced },
    version: { value: (row) => (row.shownVersion ? row.shownVersion.revision : null) },
    state: { value: (row, words) => words(`state.${row.state}`) },
  },
  words: {
    it: { ...Object.fromEntries(PRICE_LIST_KINDS.map((kind) => [`kind.${kind}`, { BASE: 'Base', CUSTOMER: 'Cliente', GROUP: 'Gruppo', CONTRACT: 'Contratto' }[kind]])), ...Object.fromEntries(PRICE_LIST_STATES.map((state) => [`state.${state}`, { DRAFT: 'Bozza', SCHEDULED: 'Parte più avanti', IN_FORCE: 'In vigore', EXPIRED: 'Scaduto', ARCHIVED: 'Archiviato' }[state]])) },
    en: { ...Object.fromEntries(PRICE_LIST_KINDS.map((kind) => [`kind.${kind}`, { BASE: 'Base', CUSTOMER: 'Customer', GROUP: 'Group', CONTRACT: 'Contract' }[kind]])), ...Object.fromEntries(PRICE_LIST_STATES.map((state) => [`state.${state}`, { DRAFT: 'Draft', SCHEDULED: 'Starts later', IN_FORCE: 'Active', EXPIRED: 'Expired', ARCHIVED: 'Archived' }[state]])) },
  },
})
