import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { SupplierInvoice } from '../api'
import { asSeenBy, canAs, CANDIDATES, DETAIL_0350, DETAIL_0398, DETAIL_0412, DETAIL_0420, DETAIL_0501, DETAIL_DE77, DETAIL_LAB14, inShell, PREFIX, TODAY, type Role } from '../demo/fixtures'
import type { RecordTab } from '../model'
import type { SupplierInvoiceModel } from './record-model'
import { SupplierInvoiceView } from './view/SupplierInvoiceView'

/**
 * SCR-153 record — a supplier invoice (design finance.payables "Record: Supplier invoice") with made-up data only: Lines
 * (mapped with the Combobox, autosave per cell; an SDI invoice's figures never change; a typed one's line dialog; a line
 * not mapped yet; a refused mapping in words), Match (the MatchPanel: a price difference to accept with its reason, goods
 * not arrived, stale → Match again, no PO linked, a credit note), Approval (ready; "You entered this invoice, so someone
 * else approves it"; approved; reject with reason), Payment (due, terms with the IBAN masked, Mark paid with its checks,
 * paid), Activity (the record panels), and the states (loading, error, not found, no permission, changed meanwhile) and
 * roles: Finance, Buyer, Read-only (no cost grain).
 */

interface RecordCase {
  role: Role
  record: SupplierInvoiceModel
}

const panels = (title: string): RecordPanelsViewModel => {
  const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel
  return { ...conversation, record: { type: 'SupplierInvoice', id: DETAIL_0412.id, companyId: DETAIL_0412.company.id, siteId: null }, title, party: null }
}

const base = (role: Role, value: SupplierInvoice, tab: RecordTab, over: Partial<SupplierInvoiceModel> = {}): RecordCase => {
  const can = canAs(role)
  const open = value.status === 'RECEIVED' || value.status === 'DISPUTED'
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      today: TODAY,
      tab,
      invoice: { status: 'ready', value: asSeenBy(value, can) },
      candidates: can.manage && open ? { value: CANDIDATES, problem: null } : null,
      savingLine: null,
      lineProblem: null,
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      panelsPreview: panels(`${value.number} · ${value.supplier.name}`),
      ...over,
    },
  }
}

function RecordDesign({ model }: { model: RecordCase }) {
  return inShell('/finance/payables', createElement(SupplierInvoiceView, { model: model.record }), model.role)
}

const state = (status: SupplierInvoiceModel['invoice']): Partial<SupplierInvoiceModel> => ({ invoice: status })
const DE77_LINE = DETAIL_DE77.lines[0]!

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-153-record',
  title: 'Supplier invoice record: lines, match, approval, payment',
  view: RecordDesign,
  cases: [
    {
      id: 'lines',
      label: 'Lines · from SDI, each mapped to its PO line (Combobox, saved at once); figures never change',
      model: base('finance', DETAIL_0412, 'lines'),
      note: 'Net 451.50 + 15.00 = 466.50; VAT 22 % = 102.63; total 569.13.',
    },
    { id: 'lines-unmapped', label: 'Lines · a goods line with no order yet: "Mark it as an invoice without PO"', model: base('finance', DETAIL_0420, 'lines') },
    { id: 'lines-saving', label: 'Lines · a mapping being saved', model: base('finance', DETAIL_0420, 'lines', { savingLine: DETAIL_0420.lines[0]!.id }) },
    {
      id: 'lines-refused',
      label: 'Lines · a refused mapping in words (another currency or an order not sent)',
      model: base('finance', DETAIL_0420, 'lines', { lineProblem: { lineId: DETAIL_0420.lines[0]!.id, phrases: [{ key: 'problem.write.mapping' }] } }),
    },
    { id: 'lines-typed', label: 'Lines · a typed foreign invoice: change, add, remove a line', model: base('finance', DETAIL_DE77, 'lines') },
    {
      id: 'line-dialog',
      label: 'Lines · the typed line dialog',
      model: base('finance', DETAIL_DE77, 'lines', {
        dialog: { kind: 'line', lineId: DE77_LINE.id, draft: { description: DE77_LINE.description, quantity: '1', uom: 'PZ', unitPrice: '1200', net: '1200.00', vatRate: '0', vatNature: 'N2.1' } },
      }),
    },
    { id: 'without-order', label: 'Lines · "Mark it as an invoice without PO" asks first', model: base('finance', DETAIL_0420, 'lines', { dialog: { kind: 'withoutOrder' } }) },
    { id: 'lines-readonly', label: 'Lines · Read-only (no cost grain): no price or net column, no mapping', model: base('readonly', DETAIL_0412, 'lines') },
    { id: 'match', label: 'Match · price differs +0.10/FT2 → +10.50, to accept in words; Send to buyer', model: base('finance', DETAIL_0412, 'match') },
    {
      id: 'match-accept',
      label: 'Match · Accept difference with reason (the dialog)',
      model: base('finance', DETAIL_0412, 'match', { dialog: { kind: 'accept', matchId: DETAIL_0412.matches[0]!.id, note: 'Prezzo concordato al telefono (demo)' } }),
    },
    { id: 'match-buyer', label: 'Match · Send to buyer (the dialog)', model: base('finance', DETAIL_0412, 'match', { dialog: { kind: 'sendToBuyer', message: '' } }) },
    { id: 'match-waiting', label: 'Match · waiting for goods: 0 PZ of 24 received', model: base('finance', DETAIL_0501, 'match') },
    { id: 'match-stale', label: 'Match · the goods changed since: Match again', model: base('finance', DETAIL_0398, 'match') },
    { id: 'match-empty', label: 'Match · no PO linked: choose the PO or mark it without PO', model: base('finance', DETAIL_0420, 'match') },
    { id: 'match-subcontract', label: 'Match · a workshop invoice on its subcontract order (60 pieces back good)', model: base('finance', DETAIL_LAB14, 'match') },
    { id: 'match-nocost', label: 'Match · Read-only: quantities and words, no price', model: base('readonly', DETAIL_0412, 'match') },
    { id: 'match-buyer-role', label: 'Match · Buyer: accepts the difference, cannot approve', model: base('buyer', DETAIL_0412, 'match') },
    { id: 'approval-ready', label: 'Approval · ready: matched, nothing left to accept (a approves)', model: base('finance', DETAIL_0398, 'approval') },
    { id: 'approval-own', label: 'Approval · "You entered this invoice, so someone else approves it" (held)', model: base('finance', DETAIL_DE77, 'approval') },
    { id: 'approval-differences', label: 'Approval · a difference waits to be accepted', model: base('finance', DETAIL_0412, 'approval') },
    { id: 'approval-dialog', label: 'Approval · Approve (the dialog)', model: base('finance', DETAIL_0398, 'approval', { dialog: { kind: 'approve', note: '' } }) },
    { id: 'approval-reject', label: 'Approval · Reject with reason (the dialog)', model: base('finance', DETAIL_0412, 'approval', { dialog: { kind: 'dispute', reason: '' } }) },
    {
      id: 'approval-refused',
      label: 'Approval · the API refused (someone accepted meanwhile? a difference left) in words',
      model: base('finance', DETAIL_0398, 'approval', { dialog: { kind: 'approve', note: '' }, dialogProblem: [{ key: 'refusal.DIFFERENCES' }] }),
    },
    { id: 'approval-approved', label: 'Approval · approved by a colleague; Withdraw approval', model: base('finance', DETAIL_LAB14, 'approval') },
    { id: 'payment', label: 'Payment · approved, due 1 Nov: Mark paid; IBAN masked', model: base('finance', DETAIL_LAB14, 'payment') },
    {
      id: 'payment-dialog',
      label: 'Payment · Mark paid (the dialog, the reference still missing)',
      model: base('finance', DETAIL_LAB14, 'payment', { dialog: { kind: 'pay', paidOn: TODAY, paymentRef: '' } }),
    },
    { id: 'payment-held', label: 'Payment · not approved yet: Mark paid held with the reason', model: base('finance', DETAIL_0412, 'payment') },
    { id: 'payment-paid', label: 'Payment · paid on 15 Oct with the bank reference', model: base('finance', DETAIL_0350, 'payment') },
    { id: 'activity', label: 'Activity · the record panels', model: base('finance', DETAIL_0412, 'activity') },
    { id: 'dock', label: 'The thread beside the tabs (⌘J)', model: base('finance', DETAIL_0412, 'match', { dockOpen: true }) },
    { id: 'notice', label: 'A write done: Approved', model: base('finance', DETAIL_LAB14, 'approval', { notice: { tone: 'success', phrases: [{ key: 'notice.approved' }] } }) },
    { id: 'changed', label: 'Changed by someone else while a dialog was open: Read again', model: base('finance', DETAIL_0412, 'match', { changed: { at: '2026-10-30T08:45:00.000Z' } }) },
    { id: 'loading', label: 'Loading', model: base('finance', DETAIL_0412, 'lines', state({ status: 'loading' })) },
    { id: 'error', label: "Couldn't load the invoice: Try again", model: base('finance', DETAIL_0412, 'lines', state({ status: 'error', problem: 'problem.read.unavailable' })) },
    { id: 'not-found', label: 'Not found (or another company or supplier)', model: base('finance', DETAIL_0412, 'lines', state({ status: 'not_found' })) },
    { id: 'no-permission', label: 'Warehouse · no payables.view', model: base('warehouse', DETAIL_0412, 'lines') },
  ],
})
