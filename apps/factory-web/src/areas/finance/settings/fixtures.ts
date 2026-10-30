import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../_shared/hooks'
import { BANK, canOf, COMPANY, inShell, PREFIX, SETTINGS, SETTINGS_MISSING, type Role } from '../_demo/fixtures'
import type { FinanceSettingsModel } from './settings-model'
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

const base = (role: Role, over: Partial<FinanceSettingsModel> = {}): SettingsCase => {
  const can = canOf(role)
  return {
    role,
    settings: { prefix: PREFIX, can, settings: { status: 'ready', value: SETTINGS }, companyId: COMPANY, bank: can.viewBank ? { value: BANK, problem: null } : null, editingBank: false, busy: false, notice: null, bankProblem: null, stepUp: STEP_UP_CLOSED, ...over },
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
  ],
})
