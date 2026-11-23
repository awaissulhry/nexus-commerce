import { ValidationError } from '@nexus/factory-domain/core/errors' // B-CQ-013
import { businessDate } from '@nexus/factory-domain/core/time'
import { QUOTE_GROUP_TERMS, QUOTE_SORTS, type QuoteGroupTerm, type QuoteSort } from '@nexus/factory-domain/sales/before-order/groups' // B-CQ-013
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { addDays, QUOTE_STATUSES, type QuoteStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import { serverClock } from '../../../core/time'
import { listQuotes, type ListQuotesQuery } from '../../../modules/sales/quotes/quotes'
import { defineExportSource, partyTerm } from '../source' // F-SA-224: + the customer term

/**
 * Sales › Quotes (SCR-034, `/sales/quotes`): the export of the list as the screen shows it. The address is the list's
 * own (apps/factory-web areas/sales/quotes/list QuotesPage filtersOf): `?status=…`, `?mine=1` (the quotes the person
 * made), `?expiring=1` (only with `status=SENT`: valid until at most 7 days from today, not past — the screen keeps
 * these rows of each page itself, so does the read here) and `?q=` (number or customer reference); nothing: every
 * quote, newest first. F-SA-224: `?party=` (one customer's quotes; malformed: refused). Read through the module's listQuotes (quotes.view, its companies and customers). Net and total
 * are the price grain, the margin % the margin grain: each absent from the file without its grain.
 * B-CQ-013 (customer page › Quotes & incoming): `?group=` (a before-order group of quotes, OPEN_QUOTES or LIVE) and `?sort=urgent`
 * ("Most urgent first") read into the same listQuotes — screen = file; a wrong value is refused in words, never dropped (a file of
 * more rows than the screen).
 */

type Row = Awaited<ReturnType<typeof listQuotes>>['quotes'][number]
type Query = Omit<ListQuotesQuery, 'cursor' | 'limit'> & { readonly expiring: boolean }

const isStatus = (value: string | null): value is QuoteStatus => value !== null && (QUOTE_STATUSES as readonly string[]).includes(value)

// ---- B-CQ-013: the screen's `group` and `sort` terms (a wrong one refused, never dropped).
function termOf<Term extends string>(address: URLSearchParams, name: string, terms: readonly Term[]): Term | undefined {
  const value = address.get(name)?.trim()
  if (!value) return undefined
  if (!(terms as readonly string[]).includes(value)) throw new ValidationError(`Not a ${name} of the quotes list: the file would not hold the screen's rows.`, [{ path: `query/${name}`, message: `One of ${terms.join(', ')}.` }])
  return value as Term
}
// ---- end B-CQ-013

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
    const partyId = partyTerm(address) // F-SA-224: the one customer filter (`?party=`): the file holds the screen's rows
    const group: QuoteGroupTerm | undefined = termOf(address, 'group', QUOTE_GROUP_TERMS) // B-CQ-013
    const sort: QuoteSort | undefined = termOf(address, 'sort', QUOTE_SORTS)
    return {
      ...(isStatus(status) ? { status } : {}),
      ...(partyId ? { partyId } : {}),
      ...(group ? { group } : {}),
      ...(sort ? { sort } : {}),
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
