import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, inShell, PREFIX } from '../../_demo/fixtures'
import { list, type PaymentsCase } from '../list/fixtures'
import type { PaymentsListModel } from '../list/list-model'
import { PaymentsListView } from '../list/view/PaymentsListView'
import type { RibaUnpaidItem } from '../riba/api'
import { scoped } from '../riba/depth'
import type { UnappliedPayment } from './api'

/**
 * SCR-512 — Finance › Payments: the tiles "Not placed on an invoice" and "Ri.Ba. unpaid" and their rows (B-W2b-425; design
 * finance.payments sec:tiles#1, #2), made-up data only: invented customers, references and amounts. A tile is a saved filter:
 * it shows its rows in place of the payments, on the one list frame (select, export).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const party = (n: number, name: string) => ({ id: uid('2222', n), code: `C-01${String(n).padStart(2, '0')}`, legalName: name })

const UNAPPLIED: UnappliedPayment[] = [
  { id: uid('9191', 1), party: party(1, 'Boutique Prova Srl'), receivedOn: '2026-10-22', externalRef: 'CRO-0000-ESEMPIO-11', currency: 'EUR', amount: 183004, unplacedAmount: 4, waitingDays: 7, openItems: 1, writeOffWithinTolerance: true, bankLine: { id: uid('9292', 1), bookedOn: '2026-10-22' } },
  { id: uid('9191', 2), party: party(2, 'Negozio Modello Snc'), receivedOn: '2026-10-25', externalRef: 'CRO-0000-ESEMPIO-12', currency: 'EUR', amount: 250000, unplacedAmount: 250000, waitingDays: 4, openItems: 0, writeOffWithinTolerance: false, bankLine: null },
  { id: uid('9191', 3), party: party(3, 'Pelletteria Finta Spa'), receivedOn: '2026-10-27', externalRef: 'CRO-0000-ESEMPIO-13', currency: 'EUR', amount: 98000, unplacedAmount: 18000, waitingDays: 2, openItems: 2, writeOffWithinTolerance: false, bankLine: { id: uid('9292', 2), bookedOn: '2026-10-27' } },
]
const UNPAID: RibaUnpaidItem[] = [
  { itemId: uid('4444', 2), batchId: uid('5555', 2), company: { id: uid('1111', 1), code: 'DEMO', name: 'Demo Srl' }, customer: { id: uid('2222', 2), code: 'C-0102', name: 'Negozio Modello Snc' }, invoice: { id: uid('3333', 2), number: 'FT-2026-00318' }, instalment: 2, dueDate: '2026-10-15', settledOn: '2026-10-20', amount: 120050, unpaidFee: 350, invoiceOpen: 120050, currency: 'EUR', daysSince: 9 },
]

const NOT_PLACED_TILE = { count: 3, amount: 268004, others: 0 }
const UNPAID_TILE = { count: 1, open: 120050, currency: 'EUR', others: 0 }
const base = (over: Partial<PaymentsListModel> = {}, price = true): Partial<PaymentsListModel> => ({
  notPlaced: { prefix: PREFIX, price, items: price ? UNAPPLIED : UNAPPLIED.map((row) => ({ ...row, amount: undefined, unplacedAmount: undefined })), more: false, problem: null, tile: { ...NOT_PLACED_TILE, amount: price ? NOT_PLACED_TILE.amount : null } },
  ribaUnpaid: { prefix: PREFIX, price, items: price ? UNPAID : UNPAID.map((row) => ({ ...row, amount: undefined, unpaidFee: undefined, invoiceOpen: undefined })), problem: null, tile: { ...UNPAID_TILE, open: price ? UNPAID_TILE.open : null } },
  ribaHeld: null,
  workOrders: true,
  ...over,
})

function TilesDesign({ model }: { model: PaymentsCase }) {
  return model.kind === 'list' ? inShell('/finance/payments', createElement(PaymentsListView, { model: model.list }), model.role) : null
}

export const designScreen = defineDesignScreen<PaymentsCase>({
  screen: 'SCR-512',
  title: 'Finance › Payments: Not placed on an invoice and Ri.Ba. unpaid',
  view: TilesDesign,
  cases: [
    { id: 'tiles', label: 'Finance · The tiles beside the payments', model: list('finance', base()), note: 'Not placed on an invoice = the unapplied queue; Ri.Ba. unpaid = instalments the bank sent back, invoice still open.' },
    { id: 'not-placed', label: 'Finance · Rows: Not placed on an invoice', model: list('finance', base({ rows: 'notPlaced' })), note: 'Within tolerance says a small difference may be written off on the payment.' },
    { id: 'not-placed-selected', label: 'Finance · Rows chosen: Export N (CSV)', model: list('finance', base({ rows: 'notPlaced', notPlaced: { ...base().notPlaced!, selected: [UNAPPLIED[0]!.id, UNAPPLIED[2]!.id] } })) },
    { id: 'not-placed-empty', label: 'Finance · Everything is placed', model: list('finance', base({ rows: 'notPlaced', notPlaced: { prefix: PREFIX, price: true, items: [], more: false, problem: null, tile: { count: 0, amount: 0, others: 0 } } })) },
    { id: 'not-placed-error', label: 'Could not read what is not placed', model: list('finance', base({ rows: 'notPlaced', notPlaced: { prefix: PREFIX, price: true, items: null, more: false, problem: 'problem.read.unavailable', tile: null } })) },
    { id: 'not-placed-loading', label: 'Loading', model: list('finance', base({ rows: 'notPlaced', notPlaced: { prefix: PREFIX, price: true, items: null, more: false, problem: null, tile: null } })) },
    { id: 'riba-unpaid', label: 'Finance · Rows: Ri.Ba. unpaid, with the bank\'s fee', model: list('finance', base({ rows: 'ribaUnpaid' })) },
    { id: 'riba-unpaid-empty', label: 'Finance · Nothing came back unpaid', model: list('finance', base({ rows: 'ribaUnpaid', ribaUnpaid: { prefix: PREFIX, price: true, items: [], problem: null, tile: { count: 0, open: 0, currency: 'EUR', others: 0 } } })) },
    { id: 'riba-held', label: 'Sales · Read only: the ⋯ Ri.Ba. batch waits with why', model: list('sales', base({ ribaHeld: scoped('band.ribaHeld') })), note: 'Without receivables.view the Ri.Ba. batch is held and says why.' },
    { id: 'no-price', label: 'Without the price grain: the tiles count rows', model: list('finance', base({ rows: 'notPlaced', can: { ...canOf('finance'), price: false } }, false)), note: 'No amount is drawn; the columns are not drawn.' },
  ],
})
