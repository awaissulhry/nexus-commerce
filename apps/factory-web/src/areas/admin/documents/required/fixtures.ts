import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, COMPANIES, inShell } from '../../shared/fixtures'
import type { Rule, RulesAnswer } from './api'
import { EMPTY_DRAFT, type RequiredModel } from './model'
import { RequiredView } from './view/RequiredView'

/**
 * SCR-014-required — Documents & numbering › Required documents (B-W2b-177; design admin.documents/sec:required, COL-048, a
 * W2b section of a W0 page) with made-up rules of the two Demo companies: the list (Blocks and On switched in place),
 * every company with its column, the switched-off rules shown, the New rule dialog (a sentence of what it asks; a second
 * rule with the same key held), ticked rules with Switch off / on N, read only (documents.view without
 * documents.required.manage), empty, reading and failed. Without documents.view the section is absent (no option).
 */

const [demo, esempio] = COMPANIES as [(typeof COMPANIES)[number], (typeof COMPANIES)[number]]
const rid = (n: number) => `0190f0e2-7b7b-7000-8000-${String(n).padStart(12, '0')}`
const rule = (n: number, over: Partial<Rule>): Rule => ({
  id: rid(n),
  companyId: demo.id,
  recordType: 'PurchaseOrder',
  category: 'SUPPLIER_CERTIFICATE',
  beforeStatus: 'CONFIRMED',
  partyRole: 'SUPPLIER',
  level: 'BLOCK',
  active: true,
  version: 1,
  createdAt: at(20, 9),
  updatedAt: at(20 + (n % 8), 9 + n),
  ...over,
})
const RULES: Rule[] = [
  rule(1, {}),
  rule(2, { category: 'DECLARATION', partyRole: null, level: 'WARN' }),
  rule(3, { recordType: 'GoodsReceipt', category: 'TEST_REPORT', beforeStatus: 'POSTED', partyRole: null, level: 'WARN' }),
  rule(4, { recordType: 'Party', category: 'QUESTIONNAIRE', beforeStatus: 'ACTIVE', level: 'WARN' }),
  rule(5, { recordType: 'Shipment', category: 'POD', beforeStatus: 'DELIVERED', partyRole: 'CUSTOMER', level: 'WARN', active: false }),
  rule(6, { companyId: esempio.id, category: 'DECLARATION', partyRole: null, level: 'WARN' }),
]
const ANSWER: RulesAnswer = {
  rules: RULES,
  recordTypes: [
    { recordType: 'PurchaseOrder', statuses: ['SENT', 'CONFIRMED', 'RECEIVED', 'CLOSED'] },
    { recordType: 'GoodsReceipt', statuses: ['POSTED'] },
    { recordType: 'ShipNotice', statuses: ['SENT', 'RECEIVED'] },
    { recordType: 'SubcontractOrder', statuses: ['ISSUED', 'RECEIVED', 'CLOSED'] },
    { recordType: 'Shipment', statuses: ['PACKED', 'SHIPPED', 'DELIVERED'] },
    { recordType: 'Party', statuses: ['ACTIVE'] },
  ],
  categories: ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION', 'QUESTIONNAIRE', 'POD', 'CMR', 'DDT_PHOTO', 'CARRIER_INVOICE', 'PROOF', 'SAMPLE_PHOTO'],
  mayChange: [demo.id, esempio.id],
}
const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName }))

const base = (over: Partial<RequiredModel> = {}): RequiredModel => ({
  companies,
  companyId: demo.id,
  read: { status: 'ready', answer: ANSWER },
  showOff: false,
  selected: [],
  dialog: null,
  saving: [],
  notice: null,
  asOf: at(29, 9, 42),
  ...over,
})

function RequiredDesign({ model }: { model: RequiredModel }) {
  const readOnly = model.read.status === 'ready' && model.read.answer.mayChange.length === 0
  return inShell('/admin/documents', createElement(RequiredView, { model }), readOnly ? ['home.view', 'numbering.view', 'documents.view'] : undefined)
}

export const designScreen = defineDesignScreen<RequiredModel>({
  screen: 'SCR-014-required',
  title: 'Documents & numbering › Required documents',
  view: RequiredDesign,
  cases: [
    { id: 'rules', label: "A company's rules: Blocks and On switched in place", model: base(), note: 'One switched-off rule is hidden; "Show switched off (1)" brings it back. A rule is never deleted.' },
    { id: 'all-companies', label: 'Every company: a Company column; New rule asks for one company', model: base({ companyId: null }) },
    { id: 'switched-off', label: 'Switched-off rules shown', model: base({ showOff: true }) },
    { id: 'selected', label: 'Two rules ticked: Switch off 2, Switch on held with the reason', model: base({ selected: [rid(1), rid(2)] }) },
    { id: 'saving', label: 'A switch being saved: its row waits', model: base({ saving: [rid(1)] }) },
    { id: 'new', label: 'New rule: a supplier certificate before a purchase order is confirmed', model: base({ companyId: esempio.id, dialog: { draft: EMPTY_DRAFT, busy: false, problem: null } }) },
    {
      id: 'new-duplicate',
      label: 'New rule: the same document and status as an active rule (held with the reason)',
      model: base({ dialog: { draft: EMPTY_DRAFT, busy: false, problem: null } }),
    },
    { id: 'new-refused', label: 'New rule: refused by the API (someone added it first)', model: base({ companyId: esempio.id, dialog: { draft: EMPTY_DRAFT, busy: false, problem: 'req.held.duplicate' } }) },
    { id: 'saved', label: 'Rule added', model: base({ notice: { key: 'req.done.created', tone: 'success' } }) },
    { id: 'read-only', label: 'Read only: documents.view without documents.required.manage', model: base({ read: { status: 'ready', answer: { ...ANSWER, mayChange: [] } } }), note: 'Blocks and On read as words; New rule is held with the reason.' },
    { id: 'empty', label: 'No rule yet', model: base({ read: { status: 'ready', answer: { ...ANSWER, rules: [] } } }) },
    { id: 'empty-off', label: 'Only switched-off rules', model: base({ read: { status: 'ready', answer: { ...ANSWER, rules: [RULES[4]!] } } }) },
    { id: 'loading', label: 'Reading the rules', model: base({ read: { status: 'loading' } }) },
    { id: 'failed', label: 'The rules could not be read', model: base({ read: { status: 'failed', problem: 'problem.unavailable' } }), note: 'Try again reads them once more; the other lists keep working.' },
  ],
})
