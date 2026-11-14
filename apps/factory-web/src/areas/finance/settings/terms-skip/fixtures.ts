import { createElement } from 'react'
import { termsSummary } from '@nexus/factory-domain/sales/terms/terms'
import { conventionWords } from '@nexus/factory-domain/money/terms/due-dates'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../../_demo/fixtures'
import { permissionsOf } from '../../invoices/test-mode/demo/fixtures'
import type { PaymentTerms } from '../terms/api'
import { TERMS } from '../terms/demo/fixtures'
import { draftOf, termsAbilitiesOf, type TermsDraft } from '../terms/model'
import { TermsSection, type TermsSectionModel } from '../terms/view/TermsSection'

/**
 * SCR-448 — Finance settings › Payment terms › skipped months and days from the end of the month (design finance.settings
 * sec:terms "skip August (W2b)"; B-W2b-417 on B-W2b-396's terms API; FIN-076), made-up data only: Ri.Ba. 60 days from the
 * end of the month with August skipped, as the library lists it and in its dialog (the words the documents print, live),
 * August and December skipped on new terms, every month ticked (held: one month stays to pay in), and Sales (read only).
 * Every code and name is invented.
 */

const conventions = { fromEndOfMonth: true, skipMonths: [8] }
const facts = { method: 'MP12', instalments: [{ sharePct: '100', from: 'INVOICE' as const, days: 60, endOfMonth: false }], earlyPaymentDiscountPct: null, earlyPaymentDays: null }
const words = (locale: 'it' | 'en') => `${termsSummary(facts, locale)} · ${conventionWords(conventions, locale)}`

const NO_AUGUST: PaymentTerms = {
  ...TERMS[2]!,
  id: '0190f0e2-6161-7000-8000-000000000009',
  code: 'RIBA60FM-NOAUG',
  name: 'Ri.Ba. 60 gg fine mese, escluso agosto',
  nameI18n: { en: 'Ri.Ba. 60 days end of month, August skipped' },
  earlyPaymentDiscountPct: null,
  earlyPaymentDays: null,
  ...conventions,
  summary: { it: words('it'), en: words('en') },
  customers: 3,
}

const LIBRARY = [...TERMS.filter((entry) => entry.status === 'ACTIVE'), NO_AUGUST]

interface SkipCase {
  role: Role
  section: TermsSectionModel
}

const base = (role: Role, over: Partial<TermsSectionModel> = {}): SkipCase => ({ role, section: { can: termsAbilitiesOf(permissionsOf(role)), rows: 'active', terms: LIBRARY, problem: null, dialog: null, busy: false, dialogProblem: null, notice: null, ...over } })

const newDraft = (over: Partial<TermsDraft>): TermsDraft => ({ ...draftOf(NO_AUGUST, 'it', true), code: 'BB30FM-XAD', name: 'Bonifico 30 gg fine mese, esclusi agosto e dicembre', nameEn: 'Bank transfer 30 days end of month, August and December skipped', method: 'MP05', instalments: [{ sharePct: '100', from: 'INVOICE', days: '30', endOfMonth: false }], ...over })

function SkipDesign({ model }: { model: SkipCase }) {
  return inShell('/finance/settings', createElement(TermsSection, { model: model.section }), model.role)
}

export const designScreen = defineDesignScreen<SkipCase>({
  screen: 'SCR-448',
  title: 'Finance settings › Payment terms: days from the end of the month and skipped months (“escluso agosto”)',
  view: SkipDesign,
  cases: [
    { id: 'library', label: 'Finance · The library: Ri.Ba. 60 days end of month, August skipped (as the documents print it)', model: base('finance') },
    { id: 'edit', label: 'Finance · Its dialog: from the end of the month, August ticked; the printed words live', model: base('finance', { dialog: { mode: 'edit', terms: NO_AUGUST } }) },
    { id: 'add', label: 'Finance · New terms: August and December skipped', model: base('finance', { dialog: { mode: 'add', draft: newDraft({ skipMonths: [8, 12] }) } }) },
    { id: 'every-month', label: 'Finance · Every month ticked: held (one month stays to pay in)', model: base('finance', { dialog: { mode: 'add', draft: newDraft({ skipMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }) } }) },
    { id: 'sales', label: 'Sales · Read only: the conventions shown, nothing to change', model: base('sales', { dialog: { mode: 'edit', terms: NO_AUGUST } }) },
  ],
})
