import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { shippedNotInvoiced } from '../../../modules/invoicing/from-shipment/queue'
import { defineExportSource } from '../source'

/**
 * Finance › Invoices (SCR-080, `/finance/invoices`), its FIRST list frame "Shipped, not invoiced" (so the page's own list
 * key; "All invoices" below it is `finance.invoices.2`, ./invoices.ts): every DDT shipped and not invoiced yet, by
 * customer, as the screen shows it. The address is the screen's: `?shipped=deferred` (the tile's saved filter: the DDTs
 * a monthly deferred invoice takes), nothing: every DDT. Read through invoicing's own shippedNotInvoiced (invoices.view,
 * its companies and customers), which reads at most 500 DDTs (its own cap). The value and the deposit paid are the price
 * grain (absent from the file without it), in EUR as the screen shows them.
 */

type Queue = Awaited<ReturnType<typeof shippedNotInvoiced>>
type Customer = Queue['customers'][number]
type Row = Customer['ddts'][number] & { readonly customer: Customer }

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
const plural = (key: string, count: number): string => `${key}_${count === 1 ? 'one' : 'other'}`

/** The pieces a DDT still has to invoice (shipped less issued, less what sits in drafts; the screen's ddtLeft). */
function toInvoice(row: Row): number {
  let pieces = 0
  for (const line of row.lines) pieces += Math.max(0, (Number(line.notInvoiced) || 0) - (Number(line.inDraft) || 0))
  return pieces
}

/** The deadline the DDT counts down to (by the customer's preset; else its 12 days). */
const deadlineOf = (row: Row) => row.deadline ?? row.immediate

export const invoicesShipped = defineExportSource<{ readonly deferred: boolean }, Row>({
  listKey: 'finance.invoices',
  permission: INVOICES_VIEW,
  query(address) {
    return { deferred: address.get('shipped') === 'deferred' }
  },
  async read(caller, query) {
    const queue = await shippedNotInvoiced(caller, {})
    const rows: Row[] = queue.customers.flatMap((customer) => customer.ddts.map((ddt) => ({ ...ddt, customer })))
    if (!query.deferred) return { rows, next: null }
    // The tile's saved filter: the DDTs of the months a monthly deferred invoice (TD24) takes (invoicing's deferredDue rule).
    const deferred = new Set(
      queue.customers.flatMap((customer) => customer.months.filter((month) => month.suggested === 'TD24' || (month.suggested === null && customer.preset === 'TD24')).flatMap((month) => month.ddtIds)),
    )
    return { rows: rows.filter((row) => deferred.has(row.ddtId)), next: null }
  },
  columns: {
    customer: { value: (row) => row.customer.legalName },
    ddt: { value: (row, words) => `${fill(words('shipped.ddt'), { number: row.number })} · ${row.date}` },
    orders: { value: (row) => row.orders.map((order) => order.number).join(', ') },
    pieces: { value: (row) => toInvoice(row) },
    value: { grain: 'price', value: (row) => ({ minor: Number(row.valueAmount), currency: 'EUR' }) },
    deposit: { grain: 'price', value: (row) => (Number(row.depositPaidAmount) > 0 ? { minor: Number(row.depositPaidAmount), currency: 'EUR' } : null) },
    type: {
      value: (row, words) => {
        const type = deadlineOf(row).docType
        const timing = row.customer.invoiceTiming ? fill(words(`timing.${row.customer.invoiceTiming}`), { code: type }) : type
        return `${words(`shipType.${type}`)} · ${timing}`
      },
    },
    deadline: {
      value: (row, words) => {
        const deadline = deadlineOf(row)
        const state = deadline.state === 'LATE' ? fill(words(plural(`deadline.late.${deadline.docType}`, Math.abs(deadline.daysLeft))), { count: Math.abs(deadline.daysLeft) }) : fill(words(plural(`deadline.left.${deadline.docType}`, deadline.daysLeft)), { count: deadline.daysLeft })
        return `${state} · ${fill(words('shipped.dueBy'), { date: deadline.dueBy })}`
      },
    },
    /** The drafts that already hold part of the DDT (the screen links each "Open the draft"). */
    draft: { value: (row) => row.drafts.length },
  },
  words: {
    it: {
      'shipped.ddt': 'DDT {number}',
      'shipped.dueBy': 'entro il {date}',
      'shipType.TD01': 'Fattura immediata',
      'shipType.TD24': 'Fattura differita mensile',
      'timing.MONTHLY': '{code} · mensile',
      'timing.PER_SHIPMENT': '{code} · a ogni spedizione',
      'deadline.late.TD01_one': 'in ritardo di {count} giorno',
      'deadline.late.TD01_other': 'in ritardo di {count} giorni',
      'deadline.late.TD24_one': 'in ritardo di {count} giorno',
      'deadline.late.TD24_other': 'in ritardo di {count} giorni',
      'deadline.left.TD01_one': 'manca {count} giorno',
      'deadline.left.TD01_other': 'mancano {count} giorni',
      'deadline.left.TD24_one': 'manca {count} giorno',
      'deadline.left.TD24_other': 'mancano {count} giorni',
    },
    en: {
      'shipped.ddt': 'DDT {number}',
      'shipped.dueBy': 'by {date}',
      'shipType.TD01': 'Immediate invoice',
      'shipType.TD24': 'Monthly deferred invoice',
      'timing.MONTHLY': '{code} · monthly',
      'timing.PER_SHIPMENT': '{code} · per shipment',
      'deadline.late.TD01_one': '{count} day late',
      'deadline.late.TD01_other': '{count} days late',
      'deadline.late.TD24_one': '{count} day late',
      'deadline.late.TD24_other': '{count} days late',
      'deadline.left.TD01_one': '{count} day left',
      'deadline.left.TD01_other': '{count} days left',
      'deadline.left.TD24_one': '{count} day left',
      'deadline.left.TD24_other': '{count} days left',
    },
  },
})
