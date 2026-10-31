import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../_shared/hooks'
import { BANK, canOf, COMPANY, inShell, PREFIX, SETTINGS, SETTINGS_MISSING, type Role } from '../_demo/fixtures'
import { permissionsOf } from '../invoices/daily/demo/fixtures'
import { costingAbilitiesOf } from './costing/model'
import type { FinanceSettingsModel } from './settings-model'
import { METHOD_CHOSEN, METHOD_LOCKED, METHOD_UNDECIDED, TERMS } from './terms/demo/fixtures'
import { termsAbilitiesOf } from './terms/model'
import type { TermsSectionModel } from './terms/view/TermsSection'
import { FinanceSettingsView } from './view/FinanceSettingsView'

/**
 * SCR-083 — Finance settings (design finance.settings) with made-up data only: the company's tax data ready or missing,
 * the bank account (read, edited, refused, with the step-up), the SDI connection in test mode (FAKE) or missing, the
 * legal archive, the number series, the reasons without VAT with their printed wording, the deposit rules and the points
 * that wait for the accountant, the states (loading, error, no permission) and the roles: Owner, Finance, Sales.
 */

interface SettingsCase {
  role: Role
  settings: FinanceSettingsModel
}

/** B-W2a-80: the payment terms library as a role sees it (active rows). */
const termsOf = (role: Role, over: Partial<TermsSectionModel> = {}): TermsSectionModel => ({ can: termsAbilitiesOf(permissionsOf(role)), rows: 'active', terms: TERMS.filter((entry) => entry.status === 'ACTIVE'), problem: null, dialog: null, busy: false, dialogProblem: null, notice: null, ...over })
const costingOf = (role: Role, over: Partial<NonNullable<FinanceSettingsModel['costing']>> = {}): NonNullable<FinanceSettingsModel['costing']> => ({ can: costingAbilitiesOf(permissionsOf(role)), method: { value: METHOD_UNDECIDED, problem: null }, choosing: null, busy: false, problem: null, ...over })

const base = (role: Role, over: Partial<FinanceSettingsModel> = {}): SettingsCase => {
  const can = canOf(role)
  return {
    role,
    settings: {
      prefix: PREFIX,
      can,
      settings: { status: 'ready', value: SETTINGS },
      companyId: COMPANY,
      bank: can.viewBank ? { value: BANK, problem: null } : null,
      editingBank: false,
      busy: false,
      notice: null,
      bankProblem: null,
      stepUp: STEP_UP_CLOSED,
      terms: termsOf(role),
      costing: { can: costingAbilitiesOf(permissionsOf(role)), method: { value: METHOD_UNDECIDED, problem: null }, choosing: null, busy: false, problem: null },
      ...over,
    },
  }
}

function SettingsDesign({ model }: { model: SettingsCase }) {
  return inShell('/finance/settings', createElement(FinanceSettingsView, { model: model.settings }), model.role)
}

export const designScreen = defineDesignScreen<SettingsCase>({
  screen: 'SCR-083',
  title: 'Finance settings: company & tax, bank account, e-invoicing (SDI) in test mode, archiving, series, VAT wording, deposits, open points',
  view: SettingsDesign,
  cases: [
    { id: 'finance', label: 'Finance · Ready to invoice; SDI in test mode (FAKE)', model: base('finance'), note: 'Company data and the SDI connection are changed in Admin; the bank account here (a fresh code).' },
    { id: 'owner', label: 'Owner · Links to Admin › Companies and Connections', model: base('owner') },
    { id: 'missing', label: 'Finance · The company misses its tax regime and address; no SDI connection', model: base('finance', { settings: { status: 'ready', value: SETTINGS_MISSING } }) },
    { id: 'bank-edit', label: 'Finance · Edit the bank account', model: base('finance', { editingBank: true }) },
    { id: 'bank-wrong', label: 'Finance · An IBAN whose check digits are wrong: Save held', model: base('finance', { editingBank: true, draft: { iban: 'IT61 X054 2811 1010 0000 0123 456' } }) },
    { id: 'bank-step-up', label: 'Finance · Saving the bank account asks a fresh code', model: base('finance', { editingBank: true, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.bank', problem: null } }) },
    { id: 'bank-saved', label: 'Finance · Saved', model: base('finance', { notice: { tone: 'success', words: { key: 'notice.bankSaved' } } }) },
    { id: 'bank-none', label: 'Finance · No bank account yet', model: base('finance', { bank: { value: { ...BANK, bank: null }, problem: null } }) },
    { id: 'sales', label: 'Sales · Read-only (no bank right): the rest shown', model: base('sales') },
    { id: 'loading', label: 'Loading', model: base('finance', { settings: { status: 'loading' } }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { settings: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'no-permission', label: 'No permission (invoices.view)', model: base('sales', { settings: { status: 'forbidden' } }) },
    // B-W2a-80: the payment terms library (sec:terms) and the costing method (sec:costing, pop:method-lock).
    { id: 'w2a-terms', label: 'W2a · Finance · Payment terms: the library with instalments, deposit, early payment, customers', model: base('finance'), note: 'Terms a quote or an order names keep their rules: edit = save as new terms.' },
    { id: 'w2a-terms-all', label: 'W2a · Finance · Payment terms: every entry, an archived one; two chosen (Archive held: a customer has them)', model: base('finance', { terms: termsOf('finance', { rows: 'all', terms: TERMS, selected: [TERMS[0]!.id, TERMS[2]!.id] }) }) },
    { id: 'w2a-terms-add', label: 'W2a · Finance · Add terms: 30% on the order + 70% before shipping (the printed words live)', model: base('finance', { terms: termsOf('finance', { dialog: { mode: 'add', draft: { code: 'DEP30', name: 'Acconto 30% all’ordine, saldo prima della spedizione', nameEn: '30% deposit on order, balance before shipping', method: 'MP05', instalments: [{ sharePct: '30', from: 'ORDER', days: '7', endOfMonth: false }, { sharePct: '70', from: 'BEFORE_SHIPPING', days: '0', endOfMonth: false }], discountPct: '', discountDays: '' } } }) }) },
    { id: 'w2a-terms-total', label: 'W2a · Finance · Add terms: the shares total 90% (held with why)', model: base('finance', { terms: termsOf('finance', { dialog: { mode: 'add', draft: { code: 'BB3060', name: 'Bonifico 30/60', nameEn: '', method: 'MP05', instalments: [{ sharePct: '50', from: 'INVOICE', days: '30', endOfMonth: true }, { sharePct: '40', from: 'INVOICE', days: '60', endOfMonth: true }], discountPct: '', discountDays: '' } } }) }) },
    { id: 'w2a-terms-edit', label: 'W2a · Finance · Edit terms in use: the rules are fixed — Save as new terms', model: base('finance', { terms: termsOf('finance', { dialog: { mode: 'edit', terms: TERMS[0]! }, dialogProblem: { key: 'terms.problem.inUse', inUse: true } }) }) },
    { id: 'w2a-terms-copy', label: 'W2a · Finance · Copy as new terms (a new code)', model: base('finance', { terms: termsOf('finance', { dialog: { mode: 'copy', terms: TERMS[2]! } }) }) },
    { id: 'w2a-terms-saved', label: 'W2a · Finance · Terms added (notice)', model: base('finance', { terms: termsOf('finance', { notice: { tone: 'success', words: { key: 'terms.created', params: { code: 'DEP30' } } } }) }) },
    { id: 'w2a-terms-empty', label: 'W2a · Finance · No payment terms yet — add the ones you use', model: base('finance', { terms: termsOf('finance', { terms: [] }) }) },
    { id: 'w2a-terms-loading', label: 'W2a · Payment terms loading', model: base('finance', { terms: termsOf('finance', { terms: null }) }) },
    { id: 'w2a-terms-error', label: 'W2a · Payment terms could not be read (Try again)', model: base('finance', { terms: termsOf('finance', { terms: null, problem: 'problem.read.unavailable' }) }) },
    { id: 'w2a-terms-sales', label: 'W2a · Sales · Payment terms read-only (Add held; the dialog shows them)', model: base('sales', { terms: termsOf('sales', { dialog: { mode: 'edit', terms: TERMS[1]! } }) }) },
    { id: 'w2a-costing-choose', label: 'W2a · Finance · Costing: not decided — choosing standard, the accountant’s confirmation', model: base('finance', { costing: costingOf('finance', { choosing: 'STANDARD' }) }) },
    { id: 'w2a-costing-confirmed', label: 'W2a · Finance · Costing: confirmed with a reason, ready to save (a fresh code next)', model: base('finance', { costing: costingOf('finance', { choosing: 'FIFO', draft: { accountant: true, reason: 'Letter of the accountant, 2 October.' } }) }) },
    { id: 'w2a-costing-step-up', label: 'W2a · Finance · Costing: choosing asks a fresh code', model: base('finance', { costing: costingOf('finance', { choosing: 'STANDARD', busy: true, draft: { accountant: true } }), busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.costing', problem: null } }) },
    { id: 'w2a-costing-chosen', label: 'W2a · Finance · Costing: standard chosen, no cost posted yet (still open)', model: base('finance', { costing: costingOf('finance', { method: { value: METHOD_CHOSEN, problem: null } }) }) },
    { id: 'w2a-costing-locked', label: 'W2a · Finance · Costing locked: the choice held with its reason; "Why is it locked?" open', model: base('finance', { costing: costingOf('finance', { method: { value: METHOD_LOCKED, problem: null }, draft: { lockOpen: true } }) }) },
    { id: 'w2a-costing-refused', label: 'W2a · Finance · Costing: refused — it locked meanwhile (said in words)', model: base('finance', { costing: costingOf('finance', { choosing: 'MOVING_AVERAGE', draft: { accountant: true }, problem: { key: 'costing.problem.locked' } }) }) },
    { id: 'w2a-costing-sales', label: 'W2a · Sales · Costing read-only: the choice held (no right)', model: base('sales', { costing: costingOf('sales') }) },
    { id: 'w2a-costing-error', label: 'W2a · Costing could not be read (Try again)', model: base('finance', { costing: costingOf('finance', { method: { value: null, problem: 'problem.read.unavailable' } }) }) },
    { id: 'w2a-costing-no-right', label: 'W2a · Costing not shown to a role without costing', model: base('finance', { costing: costingOf('finance', { method: { value: null, problem: null, forbidden: true } }) }) },
  ],
})
