import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PARTIES, PREFIX, type Role } from '../../_demo/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { InvoiceRecordView } from '../record/view/InvoiceRecordView'
import { DEMO, NOW_DAY, permissionsOf } from '../test-mode/demo/fixtures'
import type { CustomerOption, Declaration, InvoiceIntent } from './api'
import { emptyAddDraft, intentAbilitiesOf, letGoHeld, nameHeld, namedWords, type IntentAbilities } from './model'
import { DeclarationPickView, type DeclarationPickModel } from './view/DeclarationPickView'
import { DeclarationsDialog, type DeclarationsModel } from './view/DeclarationsDialog'

/**
 * SCR-441-intent — Declarations of intent (B-W2b-GB02, G152; FIN-100; B-W2b-417's gap "declarations of intent have no screen"),
 * made-up data only: the company's declarations of 2026 — one checked and partly used, one not checked yet, one used up —
 * and one of 2025 revoked; a declaration opened with the invoices resting on it and a credit note that gave some back;
 * "Check" with the receipt (none chosen: held; chosen), "Revoke" with why, "Add declaration" (a protocol typed wrong: said
 * in words), the switch off (what waits for the accountant), a refusal in words, Sales (every verb held with why), no price
 * grain (no amounts), empty, loading and a failed read; and in a draft's Before you issue the declaration it rests on (Let it
 * go), the customer's declarations to name one, naming held while the switch is off, a refused naming. Every protocol,
 * customer and amount is invented.
 */

const did = (n: number) => `0190f0e2-9191-7000-8000-${String(n).padStart(12, '0')}`
const iid = (n: number) => `0190f0e2-8181-7000-8000-${String(n).padStart(12, '0')}`

const declaration = (n: number, over: Partial<Declaration>): Declaration => ({
  id: did(n),
  version: 2,
  companyId: DEMO.id,
  partyId: PARTIES[0].id,
  party: { code: PARTIES[0].code, legalName: PARTIES[0].name },
  protocolNumber: `26000000000000${String(n).padStart(3, '0')}-000001`,
  protocolDate: '2026-01-20',
  year: 2026,
  amount: 5_000_000,
  usedAmount: 0,
  leftAmount: 5_000_000,
  state: 'UNCHECKED',
  checkedAt: null,
  checkedById: null,
  receiptFileId: null,
  revokedAt: null,
  revokeReason: null,
  invoices: [],
  ...over,
})

const CHECKED = declaration(1, {
  state: 'CHECKED',
  usedAmount: 1_843_200,
  leftAmount: 3_156_800,
  checkedAt: '2026-01-22T09:30:00.000Z',
  receiptFileId: '0190f0e2-9292-7000-8000-000000000001',
  invoices: [
    { id: iid(41), docType: 'TD01', number: 'FT-2026-00041', issueDate: '2026-03-12', intentAmount: 1_212_000 },
    { id: iid(57), docType: 'TD24', number: 'FT-2026-00057', issueDate: '2026-06-15', intentAmount: 744_000 },
    { id: iid(60), docType: 'TD04', number: 'FT-2026-00060', issueDate: '2026-06-20', intentAmount: -112_800 },
  ],
})
const UNCHECKED = declaration(2, { partyId: PARTIES[1].id, party: { code: PARTIES[1].code, legalName: PARTIES[1].name }, protocolDate: '2026-11-10', amount: 1_200_000, leftAmount: 1_200_000 })
const USED_UP = declaration(3, {
  partyId: PARTIES[2].id,
  party: { code: PARTIES[2].code, legalName: PARTIES[2].name },
  protocolDate: '2026-02-03',
  state: 'USED_UP',
  amount: 800_000,
  usedAmount: 800_000,
  leftAmount: 0,
  checkedAt: '2026-02-04T10:00:00.000Z',
  receiptFileId: '0190f0e2-9292-7000-8000-000000000003',
  invoices: [{ id: iid(48), docType: 'TD01', number: 'FT-2026-00048', issueDate: '2026-04-30', intentAmount: 800_000 }],
})
const REVOKED = declaration(4, {
  protocolNumber: '25000000000000004-000001',
  protocolDate: '2025-01-15',
  year: 2025,
  state: 'REVOKED',
  amount: 3_000_000,
  usedAmount: 0,
  leftAmount: 3_000_000,
  revokedAt: '2025-03-02T11:00:00.000Z',
  revokeReason: 'The customer sent a new declaration with a higher amount.',
})
const YEAR_2026 = [UNCHECKED, USED_UP, CHECKED]

const CUSTOMERS: CustomerOption[] = PARTIES.map((party) => ({ id: party.id, code: party.code, legalName: party.name, companyId: DEMO.id }))

const noPrice = (can: IntentAbilities): IntentAbilities => ({ ...can, price: false })
const strip = (row: Declaration): Declaration => {
  const { amount: _a, usedAmount: _u, leftAmount: _l, ...rest } = row
  return { ...rest, invoices: row.invoices.map(({ intentAmount: _i, ...invoice }) => invoice) }
}

type IntentCase = { role: Role; kind: 'list'; list: DeclarationsModel } | { role: Role; kind: 'pick'; pick: DeclarationPickModel }

const list = (role: Role, over: Partial<DeclarationsModel> = {}): IntentCase => ({
  role,
  kind: 'list',
  list: { can: intentAbilitiesOf(permissionsOf(role)), prefix: PREFIX, today: NOW_DAY, switchOn: true, year: 2026, years: [2025, 2026, 2027], state: 'ALL', list: { value: YEAR_2026, problem: null }, selectedId: null, form: null, busy: false, problem: null, notice: null, ...over },
})

const INTENT_NAMED: InvoiceIntent = {
  invoiceId: iid(70),
  status: 'DRAFT',
  switches: { declarationsOfIntentOn: true },
  declarationOfIntent: { id: CHECKED.id, protocolNumber: CHECKED.protocolNumber, protocolDate: CHECKED.protocolDate, year: 2026, state: 'CHECKED', amount: 5_000_000, usedAmount: 1_843_200, thisAmount: 436_800 },
  declarationCandidates: [
    { id: CHECKED.id, protocolNumber: CHECKED.protocolNumber, year: 2026, state: 'CHECKED' },
    { id: did(5), protocolNumber: '26000000000000005-000001', year: 2026, state: 'UNCHECKED' },
  ],
}
const INTENT_NONE: InvoiceIntent = { ...INTENT_NAMED, declarationOfIntent: null }

const pick = (role: Role, intent: InvoiceIntent | null, over: Partial<DeclarationPickModel> = {}): IntentCase => {
  const can = intentAbilitiesOf(permissionsOf(role))
  const named = intent?.declarationOfIntent ?? null
  const picked = over.picked ?? null
  return {
    role,
    kind: 'pick',
    pick: {
      intent,
      readProblem: null,
      named: named ? namedWords(named, can.price ? '4.368,00 €' : null) : null,
      picked,
      nameHeld: nameHeld({ can, switchOn: intent?.switches.declarationsOfIntentOn ?? false, picked, named: named?.id ?? null, busy: false }),
      letGoHeld: letGoHeld(can, false),
      busy: false,
      problem: null,
      ...over,
    },
  }
}

function IntentDesign({ model }: { model: IntentCase }) {
  if (model.kind === 'list') return inShell('/finance/invoices', createElement(DeclarationsDialog, { model: model.list }), model.role)
  const record = recordScreen.cases.find((item) => item.id === 'draft-checks-fail')!.model.record
  return inShell('/finance/invoices/draft', createElement(InvoiceRecordView, { model: record, depth: { precheck: createElement(DeclarationPickView, { model: model.pick }) } }), model.role)
}

export const designScreen = defineDesignScreen<IntentCase>({
  screen: 'SCR-441-intent',
  title: 'Declarations of intent: the company’s list, a declaration with its invoices, check with the receipt, revoke, add; and the one a draft rests on',
  view: IntentDesign,
  cases: [
    { id: 'list', label: 'Finance · 2026: checked and partly used, not checked yet, used up', model: list('finance') },
    { id: 'record-checked', label: 'Finance · A checked declaration opened: its receipt, the invoices on it and a credit note that gave some back', model: list('finance', { selectedId: CHECKED.id }) },
    { id: 'record-unchecked', label: 'Finance · A declaration not checked yet opened: Check… and Revoke…', model: list('finance', { selectedId: UNCHECKED.id }) },
    { id: 'record-revoked', label: 'Finance · Every year: a revoked declaration opened (why, and it changes no more)', model: list('finance', { year: null, list: { value: [...YEAR_2026, REVOKED], problem: null }, selectedId: REVOKED.id }) },
    { id: 'check', label: 'Finance · Record the check: no receipt yet (held with why)', model: list('finance', { selectedId: UNCHECKED.id, form: { kind: 'check', file: null } }) },
    { id: 'check-chosen', label: 'Finance · Record the check: the receipt chosen', model: list('finance', { selectedId: UNCHECKED.id, form: { kind: 'check', file: { name: 'ricevuta-protocollo.pdf' } } }) },
    { id: 'check-held-scan', label: 'Finance · The receipt held by the virus check (said in words)', model: list('finance', { selectedId: UNCHECKED.id, form: { kind: 'check', file: { name: 'ricevuta-protocollo.pdf' } }, problem: { key: 'finance-intent:check.heldByScan', reload: false } }) },
    { id: 'revoke', label: 'Finance · Revoke with why', model: list('finance', { selectedId: CHECKED.id, form: { kind: 'revoke', reason: 'The customer withdrew it.' } }) },
    { id: 'revoke-short', label: 'Finance · Revoke: a reason too short (held with why)', model: list('finance', { selectedId: CHECKED.id, form: { kind: 'revoke', reason: 'no' } }) },
    {
      id: 'add',
      label: 'Finance · Add a declaration: a protocol typed wrong is said in words',
      model: list('finance', { form: { kind: 'add', draft: { ...emptyAddDraft(NOW_DAY), partyId: PARTIES[1].id, protocolNumber: '2600000-12', amount: '12.000,00' }, customers: { value: CUSTOMERS, problem: null }, fieldProblems: {} } }),
    },
    { id: 'added', label: 'Finance · Recorded (notice) and opened', model: list('finance', { selectedId: UNCHECKED.id, notice: { key: 'notice.added', params: { protocol: UNCHECKED.protocolNumber } } }) },
    { id: 'switch-off', label: 'Finance · The switch is off: what waits for the accountant', model: list('finance', { switchOn: false }) },
    { id: 'refused', label: 'Finance · Refused: revoked meanwhile (said in words)', model: list('finance', { selectedId: CHECKED.id, problem: { key: 'finance-intent:refusal.REVOKED', reload: true } }) },
    { id: 'sales', label: 'Sales · Reads the declarations; Add, Check and Revoke held with why', model: list('sales', { selectedId: UNCHECKED.id }) },
    { id: 'no-price', label: 'Without the price grain: no amounts drawn', model: list('sales', { can: noPrice(intentAbilitiesOf(permissionsOf('sales'))), list: { value: YEAR_2026.map(strip), problem: null }, selectedId: CHECKED.id }) },
    { id: 'empty', label: 'Finance · No declaration covers 2027', model: list('finance', { year: 2027, list: { value: [], problem: null } }) },
    { id: 'loading', label: 'Loading', model: list('finance', { list: { value: null, problem: null }, switchOn: null }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: list('finance', { list: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'pick-named', label: 'Finance · Before you issue: the draft rests on a checked declaration (Let it go; another one to name)', model: pick('finance', INTENT_NAMED) },
    { id: 'pick-choose', label: 'Finance · Before you issue: none named, the customer’s declarations to name one', model: pick('finance', INTENT_NONE, { picked: CHECKED.id }) },
    { id: 'pick-switch-off', label: 'Finance · Before you issue: naming waits for the accountant’s switch (held with why)', model: pick('finance', { ...INTENT_NONE, switches: { declarationsOfIntentOn: false } }, { picked: CHECKED.id }) },
    { id: 'pick-refused', label: 'Finance · Naming refused: the declaration was revoked meanwhile', model: pick('finance', INTENT_NONE, { picked: CHECKED.id, problem: { key: 'finance-intent:refusal.REVOKED', reload: true } }) },
    { id: 'pick-sales', label: 'Sales · Before you issue: Let it go and Name it held with why', model: pick('sales', INTENT_NAMED) },
    { id: 'pick-error', label: 'Before you issue: the declaration could not be read (Try again)', model: pick('finance', null, { readProblem: 'problem.read.unavailable' }) },
  ],
})
