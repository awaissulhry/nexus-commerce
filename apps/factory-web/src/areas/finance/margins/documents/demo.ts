import type { OrderDocuments } from './api'

/**
 * Made-up documents for SCR-155's design cases (B-W2b-416; FIN-053): the documents of the invented order SO-2026-1043 of the
 * invented customer "Moto Demo S.r.l." — a deposit invoice, a deferred invoice shared with another order, a credit note,
 * the work orders' cost, a shipment's cost of goods sold, a subcontract order and a supplier invoice behind the cost, the
 * freight of two shipments, two payments. Every number and figure is invented and worked out by hand. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SO_1043 = uid('1313', 1043)
const INV_DEPOSIT = uid('2121', 1)
const INV_DEFERRED = uid('2121', 2)
const CREDIT = uid('2121', 3)

/**
 * Invoiced: the deferred invoice's lines of this order 6,000.00 (of 8,400.00: it also bills SO-2026-1044's 2,400.00);
 * credited 300.00; net 5,700.00. Deposit invoice 3,600.00 (listed, not added). Paid 3,600.00 (the deposit) + 2,000.00 =
 * 5,600.00. Freight charged 45.00 + 30.00 = 75.00; the carrier charged us 38.50 for the first shipment, the second not yet.
 */
export const DOCUMENTS_1043: OrderDocuments = {
  order: { id: SO_1043, number: 'SO-2026-1043', currency: 'EUR' },
  invoices: {
    held: null,
    rows: [
      { id: INV_DEPOSIT, kind: 'DEPOSIT_INVOICE', docType: 'TD02', number: 'FT-2026-0412', status: 'DELIVERED', issueDate: '2026-10-07', currency: 'EUR', netTotal: 360000, grossTotal: 439200, forOrder: 360000, shared: false, of: null },
      { id: INV_DEFERRED, kind: 'DEFERRED_INVOICE', docType: 'TD24', number: 'FT-2026-0488', status: 'SENT', issueDate: '2026-10-28', currency: 'EUR', netTotal: 840000, grossTotal: 1024800, forOrder: 600000, shared: true, of: null },
    ],
  },
  creditNotes: {
    held: null,
    rows: [{ id: CREDIT, kind: 'CREDIT_NOTE', docType: 'TD04', number: 'NC-2026-0031', status: 'ISSUED', issueDate: '2026-10-29', currency: 'EUR', netTotal: 30000, grossTotal: 36600, forOrder: 30000, shared: false, of: { id: INV_DEFERRED, number: 'FT-2026-0488' } }],
  },
  costs: {
    held: null,
    rows: [
      { kind: 'WORK_ORDER', record: { type: 'WorkOrder', id: uid('7777', 221), number: 'WO-2026-0221' }, status: 'IN_PROGRESS', date: '2026-10-29', currency: 'EUR', amount: 316000, entries: 42, pieces: 40, ofPieces: 40, reversed: false },
      { kind: 'WORK_ORDER', record: { type: 'WorkOrder', id: uid('7777', 225), number: 'WO-2026-0225' }, status: 'IN_PROGRESS', date: '2026-10-27', currency: 'EUR', amount: 158000, entries: 17, pieces: 10, ofPieces: 20, reversed: true },
      { kind: 'COST_OF_SALES', record: { type: 'Shipment', id: uid('8181', 1), number: 'SH-2026-0301' }, status: 'DELIVERED', date: '2026-10-20', currency: 'EUR', amount: 171000, entries: 3, pieces: null, ofPieces: null, reversed: false },
      { kind: 'SUBCONTRACT_ORDER', record: { type: 'SubcontractOrder', id: uid('9191', 14), number: 'SC-2026-0014' }, status: 'RECEIVED', date: '2026-10-18', currency: 'EUR', amount: 60000, entries: 2, pieces: null, ofPieces: null, reversed: false },
      { kind: 'SUPPLIER_INVOICE', record: { type: 'SupplierInvoice', id: uid('9292', 7), number: 'FOR-118/2026' }, status: 'APPROVED', date: '2026-10-22', currency: 'EUR', amount: 60000, entries: 2, pieces: null, ofPieces: null, reversed: false },
    ],
  },
  freight: {
    held: null,
    rows: [
      { shipment: { id: uid('8181', 1), number: 'SH-2026-0301', status: 'DELIVERED' }, date: '2026-10-19', carrier: 'Corriere Demo', chargeCurrency: 'EUR', charge: 4500, costCurrency: 'EUR', cost: 3850 },
      { shipment: { id: uid('8181', 2), number: 'SH-2026-0309', status: 'SHIPPED' }, date: '2026-10-28', carrier: 'Corriere Demo', chargeCurrency: 'EUR', charge: 3000, costCurrency: null, cost: null },
    ],
  },
  payments: {
    held: null,
    rows: [
      { id: uid('3131', 1), reference: 'BON-DEMO-0042', method: 'BANK_TRANSFER', status: 'RECEIVED', receivedOn: '2026-10-09', currency: 'EUR', amount: 439200, paid: 360000, to: [{ type: 'DepositRequest', id: uid('4141', 1), number: null }], reversed: false },
      { id: uid('3131', 2), reference: 'BON-DEMO-0057', method: 'BANK_TRANSFER', status: 'RECEIVED', receivedOn: '2026-10-30', currency: 'EUR', amount: 250000, paid: 200000, to: [{ type: 'Invoice', id: INV_DEFERRED, number: 'FT-2026-0488' }], reversed: false },
    ],
  },
  totals: { invoiced: 600000, credited: 30000, net: 570000, deposits: 360000, paid: 560000, freightCharged: 7500, freightCost: 3850, otherCurrency: 0 },
  notes: ['FREIGHT_COST_MISSING', 'SHARED_INVOICE', 'SHARED_WORK_ORDER'],
}

/** SO-2026-1050: confirmed, nothing invoiced, made, shipped or paid yet. */
export const DOCUMENTS_NONE = (orderId: string, number: string): OrderDocuments => ({
  order: { id: orderId, number, currency: 'EUR' },
  invoices: { held: null, rows: [] },
  creditNotes: { held: null, rows: [] },
  costs: { held: null, rows: [] },
  freight: { held: null, rows: [] },
  payments: { held: null, rows: [] },
  totals: { invoiced: 0, credited: 0, net: 0, deposits: 0, paid: 0, freightCharged: 0, freightCost: 0, otherCurrency: 0 },
  notes: [],
})

const PRICE = new Set(['netTotal', 'grossTotal', 'forOrder', 'charge', 'paid', 'invoiced', 'credited', 'net', 'deposits', 'freightCharged'])
const COST = new Set(['cost', 'freightCost'])

/**
 * What the API sends a person with these permissions and grains: a group without its reading permission comes back empty
 * with that permission (`held`, its totals null), every amount without its grain is dropped. `amount` is a cost on a cost
 * row and a price on a payment.
 */
export function documentsAsSeenBy(documents: OrderDocuments, permissions: readonly string[]): OrderDocuments {
  const held = new Set(permissions)
  const price = held.has('money.price')
  const cost = held.has('money.cost')
  const drop = <T extends object>(row: T, amountIsCost: boolean): T =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !((PRICE.has(key) && !price) || (COST.has(key) && !cost) || (key === 'amount' && !(amountIsCost ? cost : price))))) as T
  const group = <G extends { held: string | null; rows: readonly object[] }>(entry: G, permission: string | null, amountIsCost = false): G =>
    permission !== null && !held.has(permission) ? ({ ...entry, held: permission, rows: [] } as G) : ({ ...entry, rows: entry.rows.map((row) => drop(row, amountIsCost)) } as G)
  const seesInvoices = held.has('invoices.view')
  const seesPayments = held.has('payments.view')
  const seesShipping = held.has('shipping.view')
  const totals = documents.totals
  return {
    ...documents,
    invoices: group(documents.invoices, 'invoices.view'),
    creditNotes: group(documents.creditNotes, 'invoices.view'),
    costs: group(documents.costs, null, true),
    freight: group(documents.freight, 'shipping.view'),
    payments: group(documents.payments, 'payments.view'),
    totals: drop(
      {
        invoiced: seesInvoices ? totals.invoiced : null,
        credited: seesInvoices ? totals.credited : null,
        net: seesInvoices ? totals.net : null,
        deposits: seesInvoices ? totals.deposits : null,
        paid: seesPayments ? totals.paid : null,
        freightCharged: seesShipping ? totals.freightCharged : null,
        freightCost: seesShipping ? totals.freightCost : null,
        otherCurrency: totals.otherCurrency,
      },
      true,
    ),
    notes: documents.notes.filter((note) => (note === 'SHARED_INVOICE' || note === 'NOT_ISSUED' ? seesInvoices : note === 'FREIGHT_COST_MISSING' ? seesShipping : true)),
  }
}
