import { businessDate } from '@nexus/factory-domain/core/time'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { addDays, QUOTE_STATUSES, type QuoteStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import { serverClock } from '../../../core/time'
import { listQuotes, type ListQuotesQuery } from '../../../modules/sales/quotes/quotes'
import { defineExportSource } from '../source'

/**
 * Sales › Quotes (SCR-034, `/sales/quotes`): the export of the list as the screen shows it. The address is the list's
 * own (apps/factory-web areas/sales/quotes/list QuotesPage filtersOf): `?status=…`, `?mine=1` (the quotes the person
 * made), `?expiring=1` (only with `status=SENT`: valid until at most 7 days from today, not past — the screen keeps
 * these rows of each page itself, so does the read here) and `?q=` (number or customer reference); nothing: every
 * quote, newest first. Read through the module's listQuotes (quotes.view, its companies and customers). Net and total
 * are the price grain, the margin % the margin grain: each absent from the file without its grain.
 */

type Row = Awaited<ReturnType<typeof listQuotes>>['quotes'][number]
type Query = Omit<ListQuotesQuery, 'cursor' | 'limit'> & { readonly expiring: boolean }

const isStatus = (value: string | null): value is QuoteStatus => value !== null && (QUOTE_STATUSES as readonly string[]).includes(value)

/** Sent and valid until today + 7 days at most, not past (web model.ts isExpiring). */
function isExpiring(row: Row, today: string): boolean {
  if (row.status !== 'SENT' || !row.validUntil) return false
  return row.validUntil >= today && row.validUntil <= addDays(today, 7)
}

export const quotes = defineExportSource<Query, Row>({
  listKey: 'sales.quotes',
  permission: QUOTES_VIEW,
  query(address) {
    const status = address.get('status')
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return {
      ...(isStatus(status) ? { status } : {}),
      ...(address.get('mine') === '1' ? { mine: 'true' as const } : {}),
      expiring: address.get('expiring') === '1' && status === 'SENT',
      q,
    }
  },
  async read(caller, query, cursor, limit) {
    const { expiring, ...filters } = query
    const page = await listQuotes(caller, { ...filters, cursor: cursor ?? undefined, limit })
    const today = businessDate(serverClock.now())
    return { rows: expiring ? page.quotes.filter((row) => isExpiring(row, today)) : page.quotes, next: page.nextCursor }
  },
  columns: {
    number: { value: (row, words) => `${row.number} ${words('versionChip').replace('{revision}', String(row.revision))}` },
    customer: { value: (row, words) => (row.customerRef ? `${row.partyName} · ${words('ref').replace('{ref}', row.customerRef)}` : row.partyName) },
    status: { value: (row, words) => words(`status.${row.status}`) },
    units: { value: (row) => row.units },
    net: { grain: 'price', value: (row) => ({ minor: Number(row.netAmount), currency: row.currency }) },
    gross: { grain: 'price', value: (row) => ({ minor: Number(row.grossAmount), currency: row.currency }) },
    margin: { grain: 'margin', value: (row) => (row.marginPct === null ? null : { decimal: String(row.marginPct) }) },
    approval: { value: (row, words) => (row.approval ? words(`approvalStatus.${row.approval}`) : null) },
    valid: { value: (row) => (row.validUntil ? { day: row.validUntil } : null) },
    updated: { value: (row) => ({ at: row.updatedAt }) },
  },
  words: {
    it: {
      versionChip: 'v{revision}',
      ref: 'Rif. {ref}',
      'status.DRAFT': 'Bozza',
      'status.PENDING_APPROVAL': 'In attesa di approvazione',
      'status.APPROVED': 'Approvato',
      'status.SENT': 'Inviato',
      'status.ACCEPTED': 'Accettato',
      'status.DECLINED': 'Rifiutato',
      'status.EXPIRED': 'Scaduto',
      'status.SUPERSEDED': 'Sostituito',
      'status.CANCELLED': 'Annullato',
      'approvalStatus.PENDING': 'In attesa',
      'approvalStatus.APPROVED': 'Approvata',
      'approvalStatus.REJECTED': 'Rifiutata',
      'approvalStatus.WITHDRAWN': 'Ritirata',
    },
    en: {
      versionChip: 'v{revision}',
      ref: 'Ref. {ref}',
      'status.DRAFT': 'Draft',
      'status.PENDING_APPROVAL': 'Waiting for approval',
      'status.APPROVED': 'Approved',
      'status.SENT': 'Sent',
      'status.ACCEPTED': 'Accepted',
      'status.DECLINED': 'Declined',
      'status.EXPIRED': 'Expired',
      'status.SUPERSEDED': 'Replaced',
      'status.CANCELLED': 'Cancelled',
      'approvalStatus.PENDING': 'Waiting',
      'approvalStatus.APPROVED': 'Approved',
      'approvalStatus.REJECTED': 'Rejected',
      'approvalStatus.WITHDRAWN': 'Withdrawn',
    },
  },
})
