import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, CUSTOMER, DDT, inShell, LIST_ROWS, PARTIES, PREFIX, QUEUE, QUEUE_IN_DRAFT, TILE_COUNTS, TODAY, withoutPrices, type Role } from '../../_demo/fixtures'
import { DEFERRED, DEFERRED_LATE, QUEUE_W2A, RETURN_CREDIT, RETURN_CREDITED, RETURN_ID } from '../daily/demo/fixtures'
import type { InvoicesListModel } from './list-model'
import { InvoicesListView } from './view/InvoicesListView'

/**
 * SCR-080 — Invoices (design finance.invoices) with made-up data only: the tiles, the rejected notice with SDI's deadline,
 * "Shipped, not invoiced" by customer with the suggested type and the legal deadline (in time, due soon, late), a DDT
 * already in a draft (its box held with the reason), choosing DDTs → "Invoice N DDTs", the dialog (TD01 or TD24 by the
 * rule), every invoice with its SDI and payment state, saved views from the address, Export N, the states (loading,
 * error, empty, nothing shipped, a filter that matches nothing) and the roles: Owner, Finance, Sales (read-only, prices
 * but no actions).
 */

interface ListCase {
  role: Role
  list: InvoicesListModel
}

const base = (role: Role, over: Partial<InvoicesListModel> = {}): ListCase => {
  const can = canOf(role)
  return {
    role,
    list: {
      prefix: PREFIX,
      can,
      today: TODAY,
      rows: 'all',
      query: {},
      list: { items: can.price ? LIST_ROWS : withoutPrices(LIST_ROWS), more: false, problem: null },
      tiles: TILE_COUNTS,
      queue: { value: can.price ? QUEUE : withoutPrices(QUEUE), problem: null },
      rejected: [{ id: LIST_ROWS[1]!.id, number: LIST_ROWS[1]!.number, partyName: LIST_ROWS[1]!.partyName, deadline: '2026-11-05', overdue: false }],
      asOf: '2026-10-29T09:42:00.000Z',
      live: 'live',
      updates: 0,
      notice: null,
      dialog: null,
      dialogProblem: null,
      busy: false,
      ...over,
    },
  }
}

const latePair = QUEUE.customers[1]!.ddts.map((ddt) => ddt.ddtId)

function InvoicesDesign({ model }: { model: ListCase }) {
  return inShell('/finance/invoices', createElement(InvoicesListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-080',
  title: 'Invoices: where they stand, shipped not invoiced with the legal deadline, every invoice with SDI and payment',
  view: InvoicesDesign,
  cases: [
    { id: 'finance', label: 'Finance · Tiles, the rejected notice, shipped not invoiced, all invoices', model: base('finance'), note: 'Rejected first: "Fix now" opens the record on its SDI tab. The deadline per DDT: TD01 = DDT date + 12 days; TD24 = the 15th of next month.' },
    { id: 'owner', label: 'Owner · the same page', model: base('owner') },
    { id: 'sales-read-only', label: 'Sales · Prices shown, nothing to do: Invoice shipped goods held with the reason', model: base('sales') },
    { id: 'shipped-selected', label: 'Finance · Two DDTs of one customer and month chosen: Invoice 2 DDTs', model: base('finance', { shippedSelected: latePair }) },
    { id: 'shipped-two-customers', label: 'Finance · DDTs of two customers chosen: held (one invoice per customer)', model: base('finance', { shippedSelected: [DDT.id, latePair[0]!] }) },
    { id: 'shipped-in-draft', label: 'Finance · A DDT already in a draft: its box is held, the row opens the draft', model: base('finance', { queue: { value: QUEUE_IN_DRAFT, problem: null } }) },
    { id: 'dialog-td01', label: 'Finance · Invoice shipped goods: one DDT in its 12 days → immediate invoice (TD01)', model: base('finance', { dialog: { kind: 'fromDdts', ddtIds: [DDT.id], partyId: CUSTOMER.id } }) },
    { id: 'dialog-td24', label: 'Finance · Two DDTs of October → deferred invoice (TD24) by 15 November', model: base('finance', { dialog: { kind: 'fromDdts', ddtIds: latePair, partyId: PARTIES[2].id } }) },
    { id: 'dialog-pick', label: 'Finance · Invoice shipped goods from the band: pick the customer', model: base('finance', { dialog: { kind: 'fromDdts', ddtIds: [], partyId: null } }) },
    { id: 'dialog-refused', label: 'Finance · Refused: someone invoiced the DDT meanwhile (read again)', model: base('finance', { dialog: { kind: 'fromDdts', ddtIds: [DDT.id], partyId: CUSTOMER.id }, dialogProblem: { key: 'problem.write.ddts' } }) },
    { id: 'all-selected', label: 'Finance · Rows chosen: Export N (CSV)', model: base('finance', { selected: LIST_ROWS.slice(1, 4).map((row) => row.id) }) },
    { id: 'rows-rejected', label: 'Finance · Saved view Rejected (from Home › Today: ?status=REJECTED)', model: base('finance', { rows: 'rejected', query: { status: 'REJECTED' }, list: { items: LIST_ROWS.filter((row) => row.status === 'REJECTED'), more: false, problem: null } }) },
    { id: 'rows-drafts', label: 'Finance · Saved view Drafts', model: base('finance', { rows: 'drafts', query: { status: 'DRAFT' }, list: { items: LIST_ROWS.filter((row) => row.status === 'DRAFT'), more: false, problem: null } }) },
    { id: 'rows-credit', label: 'Finance · Saved view Credit notes', model: base('finance', { rows: 'creditNotes', query: { docType: 'TD04' }, list: { items: LIST_ROWS.filter((row) => row.docType === 'TD04'), more: false, problem: null } }) },
    { id: 'no-match', label: 'Finance · A saved view with nothing in it', model: base('finance', { rows: 'notDelivered', query: { status: 'NOT_DELIVERABLE' }, list: { items: [], more: false, problem: null } }) },
    { id: 'updates', label: 'Finance · Live: 2 updates wait behind Show', model: base('finance', { updates: 2 }) },
    { id: 'more', label: 'Finance · More than one page: Show more', model: base('finance', { list: { items: LIST_ROWS, more: true, problem: null } }) },
    { id: 'notice', label: 'Finance · After a write: a notice', model: base('finance', { notice: { tone: 'success', words: { key: 'notice.created' } } }) },
    { id: 'nothing-shipped', label: 'Finance · Every shipment is invoiced; no invoice is rejected', model: base('finance', { queue: { value: { asOf: TODAY, customers: [] }, problem: null }, rejected: [], tiles: { drafts: 0, atSdi: 0, rejected: 0, notDelivered: 0 } }) },
    { id: 'empty', label: 'Finance · No invoice yet', model: base('finance', { list: { items: [], more: false, problem: null }, rejected: [], tiles: { drafts: 0, atSdi: 0, rejected: 0, notDelivered: 0 } }) },
    { id: 'loading', label: 'Loading (the tiles say —, never 0)', model: base('finance', { list: { items: null, more: false, problem: null }, queue: { value: null, problem: null }, tiles: null, rejected: [], asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The reads failed (in words, Try again)', model: base('finance', { list: { items: null, more: false, problem: 'problem.read.unavailable' }, queue: { value: null, problem: 'problem.read.unavailable' }, tiles: null, rejected: [] }) },
    { id: 'keys', label: 'Finance · The keys panel (?)', model: base('finance', { helpOpen: true }) },
    // B-W2a-80: invoices every day — the deferred invoices due, the countdown by the customer's preset, freight, a return's credit notes.
    { id: 'w2a-deferred', label: 'W2a · Finance · Tile "Deferred invoices due by the 15th"; deadlines by the customer’s preset; freight', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED }), note: 'Moto Demo is invoiced per shipment (TD01, DDT date + 12 days); Squadra Fittizia once a month (TD24, the 15th of next month). Freight decided on one shipment, not yet on the other.' },
    { id: 'w2a-deferred-filter', label: 'W2a · Finance · The tile pressed: only the DDTs a deferred invoice takes', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED, shippedView: 'deferred' }) },
    { id: 'w2a-deferred-selected', label: 'W2a · Finance · Two DDTs of the monthly customer: "Create deferred invoice for 2 DDTs of …"', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED, shippedView: 'deferred', shippedSelected: latePair }) },
    { id: 'w2a-deferred-dialog', label: 'W2a · Finance · The month’s deferred invoice (row ⋯ "Deferred invoice of October 2026")', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED, dialog: { kind: 'deferred', group: DEFERRED.groups[0]! } }) },
    { id: 'w2a-deferred-refused', label: 'W2a · Finance · Refused: the month is in a draft already (said in the dialog)', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED, dialog: { kind: 'deferred', group: DEFERRED.groups[0]! }, dialogProblem: { key: 'problem.write.state' } }) },
    { id: 'w2a-deferred-late', label: 'W2a · Finance · One due in 2 days, one late from September (the tile says so)', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED_LATE }) },
    { id: 'w2a-deferred-none', label: 'W2a · Finance · The tile pressed with nothing due', model: base('finance', { queue: { value: QUEUE_W2A, problem: null }, deferred: { ...DEFERRED, counts: { groups: 0, open: 0, dueSoon: 0, late: 0 }, groups: [] }, shippedView: 'deferred' }) },
    { id: 'w2a-deferred-sales', label: 'W2a · Sales · The month’s deferred invoice held: no right to make invoices', model: base('sales', { queue: { value: QUEUE_W2A, problem: null }, deferred: DEFERRED, dialog: { kind: 'deferred', group: DEFERRED.groups[0]! } }) },
    { id: 'w2a-return-credit', label: 'W2a · Finance · Credit notes of a return (from its inspection: ?return=…): one per invoice, a line left out', model: base('finance', { dialog: { kind: 'returnCredit', returnId: RETURN_ID }, returnCredit: { value: RETURN_CREDIT, problem: null } }), note: 'Opened from Sales › Returns at /finance/invoices?return=<id>.' },
    { id: 'w2a-return-credited', label: 'W2a · Finance · The return’s credit note is drafted already: nothing left (held with why)', model: base('finance', { dialog: { kind: 'returnCredit', returnId: RETURN_ID }, returnCredit: { value: RETURN_CREDITED, problem: null } }) },
    { id: 'w2a-return-loading', label: 'W2a · Finance · Credit notes of a return: reading', model: base('finance', { dialog: { kind: 'returnCredit', returnId: RETURN_ID }, returnCredit: { value: null, problem: null } }) },
    { id: 'w2a-return-error', label: 'W2a · Finance · Credit notes of a return: the read failed', model: base('finance', { dialog: { kind: 'returnCredit', returnId: RETURN_ID }, returnCredit: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'w2a-return-sales', label: 'W2a · Sales · Credit notes of a return: read-only, held', model: base('sales', { dialog: { kind: 'returnCredit', returnId: RETURN_ID }, returnCredit: { value: RETURN_CREDIT, problem: null } }) },
    { id: 'no-permission', label: 'No permission (invoices.view over this company)', model: base('sales', { list: { items: null, more: false, problem: 'problem.read.forbidden' }, queue: { value: null, problem: 'problem.read.forbidden' }, tiles: null, rejected: [] }) },
  ],
})

