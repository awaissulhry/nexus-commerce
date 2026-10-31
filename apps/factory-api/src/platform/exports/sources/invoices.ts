import { businessDate } from '@nexus/factory-domain/core/time'
import { INVOICE_DOC_TYPES, INVOICE_STATUSES, type InvoiceDocType, type InvoiceStatus } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { listInvoices, type ListInvoicesQuery } from '../../../modules/invoicing/invoices'
import { defineExportSource } from '../source'

/**
 * Finance › Invoices (SCR-080, `/finance/invoices`), its SECOND list frame "All invoices" (list key `finance.invoices.2`;
 * the page's first frame, "Shipped, not invoiced", is ./invoices-shipped.ts): every invoice, deposit invoice and credit
 * note with its SDI and payment state, newest first, as the screen shows it. The address is the screen's
 * (apps/factory-web areas/finance/_shared model.ts queryFromAddress): `?status=` and `?docType=` in the API's own names
 * (the saved rows views drafts, atSdi, rejected, notDelivered, creditNotes, depositInvoices are these); nothing: every
 * invoice. Read through invoicing's own listInvoices (invoices.view, its companies and customers). Net, VAT, total and
 * the payment state (it is made from the amounts paid and open) are the price grain: absent from the file without it.
 */

type Row = Awaited<ReturnType<typeof listInvoices>>['invoices'][number]
type Query = Pick<ListInvoicesQuery, 'status' | 'docType'>

const isStatus = (value: string | null): value is InvoiceStatus => value !== null && (INVOICE_STATUSES as readonly string[]).includes(value)
const isDocType = (value: string | null): value is InvoiceDocType => value !== null && (INVOICE_DOC_TYPES as readonly string[]).includes(value)

/** The SDI state the screen shows for an invoice status (its sdiCodeOf). */
const SDI_CODE: Readonly<Record<InvoiceStatus, string>> = { DRAFT: 'DRAFT', ISSUED: 'NOT_SENT', SENT: 'AT_SDI', DELIVERED: 'DELIVERED', NOT_DELIVERABLE: 'NOT_DELIVERED', REJECTED: 'REJECTED', ERROR: 'ERROR' }

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** The payment column's words (the screen's payStateOf): a credit note or a deposit invoice is not collected on its own. */
function payWords(row: Row, today: string, words: (code: string) => string): string | null {
  if (row.status === 'DRAFT') return null
  if (row.docType === 'TD02') return words('pay.BY_DEPOSIT')
  if (row.docType === 'TD04') return words('pay.CREDIT')
  const open = Number(row.openAmount)
  if (!Number.isFinite(open)) return null
  if (open <= 0) return words('pay.PAID')
  if (row.dueDate && row.dueDate < today) {
    const days = daysBetween(row.dueDate, today)
    return words(`pay.OVERDUE_${days === 1 ? 'one' : 'other'}`).replace('{count}', String(days))
  }
  return words(Number(row.paidAmount) > 0 ? 'pay.PART_PAID' : 'pay.UNPAID')
}

const amount = (value: unknown, currency: string) => ({ minor: Number(value), currency })

export const invoices = defineExportSource<Query, Row>({
  listKey: 'finance.invoices.2',
  page: '/finance/invoices',
  permission: INVOICES_VIEW,
  query(address) {
    const status = address.get('status')
    const docType = address.get('docType')
    return { ...(isStatus(status) ? { status } : {}), ...(isDocType(docType) ? { docType } : {}) }
  },
  async read(caller, query, cursor, limit) {
    const page = await listInvoices(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.invoices, next: page.nextCursor }
  },
  columns: {
    number: { value: (row, words) => row.number ?? words('list.draft') },
    type: { value: (row, words) => `${words(`docType.${row.docType}`)} · ${row.docType}` },
    customer: { value: (row) => row.partyName || null },
    net: { grain: 'price', value: (row) => amount(row.netTotal, row.currency) },
    vat: { grain: 'price', value: (row) => amount(row.vatTotal, row.currency) },
    gross: { grain: 'price', value: (row) => amount(row.grossTotal, row.currency) },
    sdi: { value: (row, words) => words(`sdi.state.${SDI_CODE[row.status as InvoiceStatus] ?? 'ERROR'}`) },
    pay: { grain: 'price', value: (row, words) => payWords(row, businessDate(new Date()), words) },
    due: { value: (row) => (row.dueDate && (row.docType === 'TD01' || row.docType === 'TD24') ? { day: row.dueDate } : null) },
  },
  words: {
    it: {
      'list.draft': 'Bozza',
      'docType.TD01': 'Fattura',
      'docType.TD02': 'Fattura di acconto',
      'docType.TD04': 'Nota di credito',
      'docType.TD24': 'Fattura differita',
      'sdi.state.AT_SDI': 'Presso lo SDI',
      'sdi.state.DELIVERED': 'Consegnata',
      'sdi.state.DRAFT': 'Non ancora inviata',
      'sdi.state.ERROR': 'Invio non riuscito',
      'sdi.state.NOT_DELIVERED': 'Non consegnata',
      'sdi.state.NOT_SENT': 'Emessa, non inviata',
      'sdi.state.REJECTED': 'Scartata',
      'pay.BY_DEPOSIT': 'Pagata con l’acconto',
      'pay.CREDIT': 'Nulla da incassare',
      'pay.OVERDUE_one': 'Scaduta da {count} giorno',
      'pay.OVERDUE_other': 'Scaduta da {count} giorni',
      'pay.PAID': 'Pagata',
      'pay.PART_PAID': 'Pagata in parte',
      'pay.UNPAID': 'Da incassare',
    },
    en: {
      'list.draft': 'Draft',
      'docType.TD01': 'Invoice',
      'docType.TD02': 'Deposit invoice',
      'docType.TD04': 'Credit note',
      'docType.TD24': 'Deferred invoice',
      'sdi.state.AT_SDI': 'At SDI',
      'sdi.state.DELIVERED': 'Delivered',
      'sdi.state.DRAFT': 'Not sent yet',
      'sdi.state.ERROR': 'Send failed',
      'sdi.state.NOT_DELIVERED': 'Not delivered',
      'sdi.state.NOT_SENT': 'Issued, not sent',
      'sdi.state.REJECTED': 'Rejected',
      'pay.BY_DEPOSIT': 'Paid by its deposit',
      'pay.CREDIT': 'Nothing to collect',
      'pay.OVERDUE_one': 'Overdue {count} day',
      'pay.OVERDUE_other': 'Overdue {count} days',
      'pay.PAID': 'Paid',
      'pay.PART_PAID': 'Part paid',
      'pay.UNPAID': 'Unpaid',
    },
  },
})
