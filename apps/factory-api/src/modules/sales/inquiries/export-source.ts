import type { IncomingListQuery, IncomingRow } from '@nexus/factory-domain/sales/incoming/contracts'
import { INCOMING_CHANGE_KINDS, INCOMING_KINDS, INCOMING_TILES, KIND_WORDS, sourceWordsOf, stateWords, type IncomingKind, type IncomingTile } from '@nexus/factory-domain/sales/incoming/rules'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { DECLINE_WORDS, INQUIRY_SOURCES, INQUIRY_STATUSES, type InquirySource, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { defineExportSource } from '../../../platform/exports/source'
// B-TH-039 (threads plan L2-G07, PR-11): the list key stays `sales.inquiries`; the file reads Sales › Incoming's one read.
import { listIncoming } from '../incoming/incoming'

/**
 * Sales › Incoming (`/sales/incoming`, the list of SCR-105; once Sales › Inquiries — the list key stays `sales.inquiries`, PR-11,
 * so saved views, Pin to Today and old export links keep working). B-TH-039: the file reads Incoming's ONE read
 * (modules/sales/incoming: requests, catalogue orders and change requests, each row checked against its own view permission over
 * its company and customer; the screen's order) and pages to the end by its cursor — no "first 200 rows" any more. The address is
 * the page's: `?tile=` (the saved rows), `?kind=`, `?status=`, `?source=`, `?party=` / `?prospect=1`, `?company=`, `?q=`. The
 * columns are the list's (kind, number, from, summary, source, products asked, quantity by size, pieces, target price, wanted
 * date, received, waiting, assigned to, status); the assignee by name, as the list says it (B-TH-016, Owner decision 4); the
 * target price only with the price grain (a request's own; the other kinds have none).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null): string | undefined => (value && UUID.test(value) ? value : undefined)
const prefixed = (prefix: string, words: Readonly<Record<string, { readonly it: string; readonly en: string }>>, locale: 'it' | 'en') => Object.fromEntries(Object.entries(words).map(([code, text]) => [`${prefix}.${code}`, text[locale]]))
const hours = (minutes: number | null): number | null => (minutes === null ? null : Math.round((minutes / 60) * 10) / 10)
/** The page's own read size (the API's most): the file asks for pages of up to this many rows. */
const PAGE = 200

/** Every state's words in a language, by `state.<kind>.<state>` (a change request's with its kind: `state.CHANGE_REQUEST.<kind>.<state>`). */
const CATALOGUE_STATES = ['SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
const CHANGE_STATES = ['OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
function stateEntries(locale: 'it' | 'en'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const state of INQUIRY_STATUSES) out[`state.REQUEST.${state}`] = stateWords('REQUEST', state)[locale]
  for (const state of CATALOGUE_STATES) out[`state.CATALOGUE_ORDER.${state}`] = stateWords('CATALOGUE_ORDER', state)[locale]
  for (const kind of INCOMING_CHANGE_KINDS) for (const state of CHANGE_STATES) out[`state.CHANGE_REQUEST.${kind}.${state}`] = stateWords('CHANGE_REQUEST', state, null, kind)[locale]
  return out
}
const wordsOf = (locale: 'it' | 'en') => ({
  ...prefixed('kind', KIND_WORDS, locale),
  ...Object.fromEntries(INQUIRY_SOURCES.map((source) => [`source.${source}`, sourceWordsOf('REQUEST', source)[locale]])),
  ...prefixed('decline', DECLINE_WORDS, locale),
  ...stateEntries(locale),
})

export const inquiries = defineExportSource<IncomingListQuery, IncomingRow>({
  listKey: 'sales.inquiries',
  permission: SALES_INQUIRIES_VIEW,
  page: '/sales/incoming',
  query(address) {
    const tile = address.get('tile') ?? ''
    const kind = address.get('kind') ?? ''
    const status = address.get('status') ?? ''
    const source = address.get('source') ?? ''
    const party = idOf(address.get('party'))
    const company = idOf(address.get('company'))
    const prospect = address.get('prospect') === '1'
    const q = (address.get('q') ?? '').trim().slice(0, 100)
    return {
      ...((INCOMING_TILES as readonly string[]).includes(tile) ? { tile: tile as IncomingTile } : {}),
      ...((INCOMING_KINDS as readonly string[]).includes(kind) ? { kind: kind as IncomingKind } : {}),
      ...((INQUIRY_STATUSES as readonly string[]).includes(status) ? { status: status as InquiryStatus } : {}),
      ...((INQUIRY_SOURCES as readonly string[]).includes(source) ? { source: source as InquirySource } : {}),
      ...(prospect ? { prospect: true } : party ? { partyId: party } : {}),
      ...(company ? { companyId: company } : {}),
      ...(q ? { q } : {}),
    }
  },
  // B-TH-039: every page of the one read, by its cursor, to the end (the tiles are not counted for a file).
  async read(caller, query, cursor, limit) {
    const answer = await listIncoming(caller, { ...query, limit: Math.min(Math.max(limit, 1), PAGE), ...(cursor ? { cursor } : {}) }, { counts: false })
    return { rows: answer.rows, next: answer.next }
  },
  async count(caller, query) {
    const answer = await listIncoming(caller, { ...query, limit: 1 })
    return answer.counts[query.tile ?? 'OPEN'] ?? 0
  },
  columns: {
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    number: { value: (row) => row.number },
    from: { value: (row) => (row.party ? `${row.party.code} · ${row.party.name}` : row.fromWords) },
    summary: { value: (row) => row.summary },
    source: { value: (row, words) => words(`source.${row.kind === 'REQUEST' && row.request ? row.request.source : 'PORTAL'}`) },
    products: { value: (row) => (row.request ? row.request.products.join(', ') : (row.catalogueOrder?.styles.join(', ') ?? '')) },
    sizes: { value: (row) => row.request?.sizes ?? '' },
    pieces: { value: (row) => row.pieces },
    targetPrice: { grain: 'price', value: (row) => (row.request && row.request.targetUnitPrice !== null ? `${row.request.targetUnitPrice} ${row.request.currency}` : null) },
    wantedDate: { value: (row) => row.wantedDate },
    received: { value: (row) => row.receivedAt },
    waitingHours: { value: (row) => hours(row.waiting.workingMinutes) },
    // B-TH-016 (Owner decision 4): the assignee by name, as the list says it.
    assignedTo: { value: (row) => row.request?.assignee?.name ?? null },
    // The kind's own state in the file's language (a request's decline with its reason, a change request's kind).
    status: {
      value: (row, words) => {
        if (row.changeRequest) return words(`state.CHANGE_REQUEST.${row.changeRequest.kind}.${row.state}`)
        const state = words(`state.${row.kind}.${row.state}`)
        return row.request?.declineReason ? `${state} · ${words(`decline.${row.request.declineReason}`)}` : state
      },
    },
  },
  words: { it: wordsOf('it'), en: wordsOf('en') },
})
