import type { InquiryListQuery } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { DECLINE_WORDS, INQUIRY_SOURCES, INQUIRY_STATUSES, INQUIRY_TILES, SOURCE_WORDS, STATUS_WORDS, type InquirySource, type InquiryStatus, type InquiryTile } from '@nexus/factory-domain/sales/inquiries/rules'
import { defineExportSource } from '../../../platform/exports/source'
import { listInquiries } from './inquiries'
import type { RowView } from './views'

/**
 * Sales › Inquiries (`/sales/inquiries`, the list of SCR-105; B-W2b-295's read): the inquiries as the list shows them, through
 * the module's own listInquiries (sales.inquiries.view over each inquiry's company and customer; the queue's order). The address
 * is the page's: `?tile=` (the API's saved filters), `?status=`, `?source=`, `?party=` / `?prospect=1`, `?q=`. The columns are
 * the list's (number, from, summary, source, products asked, quantity by size, target price, wanted date, received, waiting,
 * assigned to, status); the assignee is said as the list says it ("You" / "A colleague": no name in a list); the target price
 * only with the price grain.
 *
 * REGISTERED BY B-W2b-322 with its page (platform/exports/sources/index.ts, one line: the export test holds that every source
 * has its page under apps/factory-web); until then the list has no Export ▾.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null): string | undefined => (value && UUID.test(value) ? value : undefined)
const prefixed = (prefix: string, words: Readonly<Record<string, { readonly it: string; readonly en: string }>>, locale: 'it' | 'en') => Object.fromEntries(Object.entries(words).map(([code, text]) => [`${prefix}.${code}`, text[locale]]))
const hours = (minutes: number | null): number | null => (minutes === null ? null : Math.round((minutes / 60) * 10) / 10)

export const inquiries = defineExportSource<InquiryListQuery, RowView>({
  listKey: 'sales.inquiries',
  permission: SALES_INQUIRIES_VIEW,
  query(address) {
    const tile = address.get('tile') ?? ''
    const status = address.get('status') ?? ''
    const source = address.get('source') ?? ''
    const party = idOf(address.get('party'))
    const prospect = address.get('prospect') === '1'
    const q = (address.get('q') ?? '').trim().slice(0, 100)
    return {
      ...((INQUIRY_TILES as readonly string[]).includes(tile) ? { tile: tile as InquiryTile } : {}),
      ...((INQUIRY_STATUSES as readonly string[]).includes(status) ? { status: status as InquiryStatus } : {}),
      ...((INQUIRY_SOURCES as readonly string[]).includes(source) ? { source: source as InquirySource } : {}),
      ...(prospect ? { prospect: true } : party ? { partyId: party } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, _cursor, limit) {
    const answer = await listInquiries(caller, { ...query, limit: Math.min(Math.max(limit, 1), 200) })
    return { rows: answer.rows, next: null }
  },
  columns: {
    number: { value: (row) => row.number },
    from: { value: (row) => (row.party ? `${row.party.code} · ${row.party.name}` : row.fromWords) },
    summary: { value: (row) => row.summary },
    source: { value: (row, words) => words(`source.${row.source}`) },
    products: { value: (row) => row.products.join(', ') },
    sizes: { value: (row) => row.sizes },
    pieces: { value: (row) => row.pieces },
    targetPrice: { grain: 'price', value: (row) => (row.targetUnitPrice === null ? null : `${row.targetUnitPrice} ${row.currency}`) },
    wantedDate: { value: (row) => row.wantedDate },
    received: { value: (row) => row.receivedAt },
    waitingHours: { value: (row) => hours(row.waiting.workingMinutes) },
    assignedTo: { value: (row, words) => (row.assigneeId === null ? null : words(row.mine ? 'assignee.me' : 'assignee.other')) },
    status: { value: (row, words) => (row.declineReason ? `${words(`status.${row.status}`)} · ${words(`decline.${row.declineReason}`)}` : words(`status.${row.status}`)) },
  },
  words: {
    it: { ...prefixed('status', STATUS_WORDS, 'it'), ...prefixed('source', SOURCE_WORDS, 'it'), ...prefixed('decline', DECLINE_WORDS, 'it'), 'assignee.me': 'Tu', 'assignee.other': 'Un collega' },
    en: { ...prefixed('status', STATUS_WORDS, 'en'), ...prefixed('source', SOURCE_WORDS, 'en'), ...prefixed('decline', DECLINE_WORDS, 'en'), 'assignee.me': 'You', 'assignee.other': 'A colleague' },
  },
})
