import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX, type Role } from '../../_demo/fixtures'
import { DEMO, permissionsOf, TESTING_FAKE } from '../../invoices/test-mode/demo/fixtures'
import { bannerOf } from '../../invoices/test-mode/model'
import { TestModeBannerView } from '../../invoices/test-mode/view/TestModeBannerView'
import { designScreen as payablesScreen } from '../fixtures'
import { PayablesListView } from '../view/PayablesListView'
import type { SelfInvoice, SelfInvoiceCandidate, SelfInvoices } from './api'
import { selfInvoiceAbilitiesOf } from './model'
import { SelfInvoicesSection, type SelfInvoicesModel } from './view/SelfInvoicesSection'

/**
 * SCR-445 — Finance › Payables › Self-invoices (design finance.payables sec:selfinv and page.h ⋯ "Self-invoices TD17/18/19";
 * B-W2b-417 on B-W2b-401's API; FIN-095), made-up data only: a German supplier's service (TD17) due in 3 days without its
 * draft, an Austrian supplier's goods (TD18) with its draft, a Swiss supplier's goods already in Italy (TD19) late, an issued
 * one; the accountant's switch off (the issue waits, said), Make drafts N, Create from the supplier invoice (the kind
 * suggested, mixed lines, another currency), Cancel with the reason, a refusal, the test-mode banner, the states (loading,
 * failed, none, no permission) and the roles: Finance, Sales (held with why: a purchase's amounts are the cost grain).
 * Every supplier, invoice and number is invented.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

const row = (n: number, over: Partial<SelfInvoice>): SelfInvoice => ({
  id: uid('5757', n),
  version: 1,
  companyId: DEMO.id,
  partyId: uid('6767', n),
  supplier: { code: `SUP-${n}`, legalName: 'Lederwerk Demo GmbH' },
  supplierInvoice: { id: uid('5858', n), number: `R-2026-0${n}41`, issueDate: '2026-11-03', receivedOn: '2026-11-05' },
  kind: 'TD17',
  deadline: '2026-12-15',
  deadlineState: { state: 'OPEN', daysLeft: 31 },
  status: 'PENDING',
  invoice: null,
  cancelledAt: null,
  can: { draft: true, cancel: true, issue: false },
  ...over,
})

const ROWS: SelfInvoice[] = [
  row(1, { kind: 'TD19', supplier: { code: 'SUP-3', legalName: 'Bergleder Muster AG' }, supplierInvoice: { id: uid('5858', 1), number: 'CH-77-0912', issueDate: '2026-10-02', receivedOn: '2026-10-06' }, deadline: '2026-11-15', deadlineState: { state: 'LATE', daysLeft: -1 } }),
  row(2, { kind: 'TD17', deadline: '2026-11-17', deadlineState: { state: 'DUE_SOON', daysLeft: 3 } }),
  row(3, { kind: 'TD18', supplier: { code: 'SUP-2', legalName: 'Alpen Gerberei Beispiel GmbH' }, invoice: { id: uid('8181', 61), docType: 'TD18', status: 'DRAFT', number: null, issueDate: null }, can: { draft: false, cancel: true, issue: true } }),
  row(4, { kind: 'TD17', status: 'ISSUED', deadlineState: { state: 'DONE', daysLeft: 0 }, invoice: { id: uid('8181', 62), docType: 'TD17', status: 'DELIVERED', number: 'AF-2026-0003', issueDate: '2026-11-08' }, can: { draft: false, cancel: false, issue: false } }),
]

const LIST: SelfInvoices = { companyId: DEMO.id, selfInvoices: ROWS, selfInvoicesOn: false }

const CANDIDATES: SelfInvoiceCandidate[] = [
  { supplierInvoiceId: uid('5858', 9), partyId: uid('6767', 9), supplier: { code: 'SUP-9', legalName: 'Lederwerk Demo GmbH', country: 'DE' }, number: 'R-2026-0977', issueDate: '2026-11-10', receivedOn: '2026-11-11', currency: 'EUR', suggestion: { kind: 'TD18' }, deadline: '2026-12-15', deadlineState: { state: 'OPEN', daysLeft: 31 } },
  { supplierInvoiceId: uid('5858', 10), partyId: uid('6767', 10), supplier: { code: 'SUP-10', legalName: 'Demo Hides UK Ltd', country: 'GB' }, number: 'INV-55120', issueDate: '2026-11-09', receivedOn: '2026-11-12', currency: 'GBP', suggestion: { kind: null }, deadline: '2026-12-15', deadlineState: { state: 'OPEN', daysLeft: 31 } },
]

interface SelfCase {
  role: Role
  section: SelfInvoicesModel
  inPage?: boolean
  testMode?: boolean
}

const base = (role: Role, over: Partial<SelfInvoicesModel> = {}, extra: Partial<SelfCase> = {}): SelfCase => ({
  role,
  section: { prefix: PREFIX, can: selfInvoiceAbilitiesOf(permissionsOf(role)), rows: 'all', list: { value: LIST, problem: null }, dialog: null, candidates: { value: CANDIDATES, problem: null }, draft: { supplierInvoiceId: '', kind: null, rate: '22' }, reason: '', busy: false, problem: null, notice: null, ...over },
  ...extra,
})

function SelfDesign({ model }: { model: SelfCase }) {
  const banner = model.testMode ? createElement(TestModeBannerView, { model: bannerOf([TESTING_FAKE]) }) : undefined
  const section = createElement(SelfInvoicesSection, { model: model.section, banner })
  if (!model.inPage) return inShell('/finance/payables', section, model.role)
  const page = payablesScreen.cases.find((item) => item.id === 'finance')!.model
  return inShell('/finance/payables', createElement(PayablesListView, { model: page.page, selfInvoices: section }), model.role)
}

export const designScreen = defineDesignScreen<SelfCase>({
  screen: 'SCR-445',
  title: 'Payables › Self-invoices TD17/18/19: purchases from abroad, the deadline counted down, create from the supplier invoice',
  view: SelfDesign,
  cases: [
    { id: 'finance', label: 'Finance · Four self-invoices: late, due in 3 days, a draft waiting, issued; the issue waits for the accountant', model: base('finance') },
    { id: 'in-page', label: 'Finance · The section in its place under the supplier invoices (⋯ › Self-invoices goes there)', model: base('finance', {}, { inPage: true }) },
    { id: 'test-mode', label: 'Finance · Test mode on: the banner above the list', model: base('finance', { list: { value: { ...LIST, selfInvoicesOn: true }, problem: null } }, { testMode: true }) },
    { id: 'selected', label: 'Finance · Rows chosen: Make 2 drafts (a row with its draft or issued is not selectable, why on its box)', model: base('finance', { selected: [ROWS[0]!.id, ROWS[1]!.id] }) },
    { id: 'drafted', label: 'Finance · Drafts made (notice)', model: base('finance', { notice: { tone: 'success', words: { key: 'self.drafted', params: { count: 2 } } } }) },
    { id: 'create', label: 'Finance · Create: a German supplier’s invoice, TD18 suggested, 22 %', model: base('finance', { dialog: { kind: 'create' }, draft: { supplierInvoiceId: CANDIDATES[0]!.supplierInvoiceId, kind: 'TD18', rate: '22' } }) },
    { id: 'create-mixed', label: 'Finance · Create: mixed lines in GBP — pick the kind (held until picked)', model: base('finance', { dialog: { kind: 'create' }, draft: { supplierInvoiceId: CANDIDATES[1]!.supplierInvoiceId, kind: null, rate: '22' } }) },
    { id: 'create-refused', label: 'Finance · Refused: no exchange rate of the invoice’s day (said in the dialog)', model: base('finance', { dialog: { kind: 'create' }, draft: { supplierInvoiceId: CANDIDATES[1]!.supplierInvoiceId, kind: 'TD17', rate: '22' }, problem: { key: 'finance-invoices-depth:refusal.NO_RATE', reload: false } }) },
    { id: 'create-none', label: 'Finance · Create: every foreign purchase has its self-invoice', model: base('finance', { dialog: { kind: 'create' }, candidates: { value: [], problem: null } }) },
    { id: 'cancel', label: 'Finance · Cancel the TD18 with its draft: the reason', model: base('finance', { dialog: { kind: 'cancel', row: ROWS[2]! }, reason: 'Fattura del fornitore sostituita da una nuova' }) },
    { id: 'sales', label: 'Sales · Read only: Create, Make draft and Cancel held with why', model: base('sales') },
    { id: 'empty', label: 'No foreign purchases need a self-invoice', model: base('finance', { list: { value: { ...LIST, selfInvoices: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: base('finance', { list: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { list: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'no-permission', label: 'No permission (invoices.view)', model: base('finance', { can: { view: false, payables: true, manage: false, cost: false, issue: false } }) },
  ],
})
