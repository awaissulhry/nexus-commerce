import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { scoped } from '../../payments/riba/depth'
import type { CollectionsSettings } from '../../payments/riba/api'
import type { MoneyControls, RemittanceSettings } from './api'
import { approvalsCanOf } from './model'
import { ApprovalsCard, type ApprovalsModel } from './view/ApprovalsCard'

/**
 * SCR-519 — Finance › Settings › Approvals & notifications (B-W2b-425; design finance.settings sec:approvals), made-up data only:
 * what each money action asks today, who hears about what, the two mails to outside switched OFF.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = uid('1111', 1)
const CONTROLS: MoneyControls = {
  companyId: COMPANY,
  currency: 'EUR',
  actions: [
    { code: 'SUPPLIER_INVOICE', kind: null, stepUp: null, dual: { amount: 1000000, decided: false } },
    { code: 'PAYMENT_PROPOSAL', kind: null, stepUp: { action: 'payments.approve', on: true }, dual: { amount: 1000000, decided: false } },
    { code: 'MANUAL_PAYMENT', kind: null, stepUp: null, dual: null },
    { code: 'CREDIT_NOTE', kind: { code: 'CREDIT_WITHOUT_RETURN', registered: true, rules: 1, active: 0 }, stepUp: { action: 'invoices.issue', on: true }, dual: null },
    { code: 'WRITE_OFF', kind: null, stepUp: null, dual: null },
    { code: 'PRICE_OVERRIDE', kind: { code: 'PRICE_CHANGE', registered: false, rules: 0, active: 0 }, stepUp: null, dual: null },
  ],
  notifications: [
    { code: 'PAYMENT_RECEIVED', rule: 'payments.received', audience: 'CUSTOMER_FOLLOWERS_AND_ORDER_MAKERS' },
    { code: 'SDI_REJECTED', rule: 'money.sdiRejected', audience: 'ISSUER_AND_FOLLOWERS' },
    { code: 'OVERDUE', rule: 'money.overdue', audience: 'CUSTOMER_FOLLOWERS_AND_REMINDER_APPROVERS' },
    { code: 'DEPOSIT_RECEIVED', rule: 'payments.depositPaid', audience: 'ORDER_MAKER_AND_RELEASERS' },
    { code: 'RECONCILIATION_DIFFERENCE', rule: 'money.reconciliationDifference', audience: 'BANK_MATCHERS' },
  ],
}
const REMITTANCE: RemittanceSettings = { companyId: COMPANY, on: false, source: 'NONE', version: null, mayChange: false }
const COLLECTIONS: CollectionsSettings = { companyId: COMPANY, source: 'TENANT', settingsId: uid('1212', 1), version: 2, ribaOn: true, paymentNoticeToCustomerOn: false, mayChange: false }
const FINANCE = approvalsCanOf(['payables.view', 'money.cost'])

const model = (over: Partial<ApprovalsModel> = {}): ApprovalsModel => ({ can: FINANCE, controls: CONTROLS, problem: null, remittance: REMITTANCE, collections: COLLECTIONS, busy: null, switchProblem: null, notice: null, ...over })

export const designScreen = defineDesignScreen<ApprovalsModel>({
  screen: 'SCR-519',
  title: 'Finance › Settings › Approvals & notifications',
  view: ApprovalsCard,
  cases: [
    { id: 'finance', label: 'Finance · What asks a yes, who hears about what; the mails held for the Owner', model: model(), note: 'The amounts have no setting yet: read here, never edited.' },
    { id: 'owner', label: 'Owner · The two mails to outside, OFF: Turn on asks a fresh code', model: model({ remittance: { ...REMITTANCE, mayChange: true }, collections: { ...COLLECTIONS, mayChange: true } }) },
    { id: 'owner-on', label: 'Owner · Remittance mail turned on', model: model({ remittance: { ...REMITTANCE, on: true, source: 'COMPANY', version: 1, mayChange: true }, collections: { ...COLLECTIONS, mayChange: true }, notice: { key: scoped('approvals.notice.remittance.on') } }) },
    // B-W2b-GB02 (G088)
    { id: 'gb02-auto-carry-on', label: 'GB02 · Owner · Deposits carried onto the invoice by themselves: turned on', model: model({ remittance: { ...REMITTANCE, mayChange: true }, collections: { ...COLLECTIONS, depositAutoCarryOn: true, source: 'COMPANY', mayChange: true }, notice: { key: scoped('approvals.notice.autoCarry.on') } }) },
    { id: 'refused', label: 'Refused: changed meanwhile', model: model({ remittance: { ...REMITTANCE, mayChange: true }, switchProblem: { key: 'problem.write.moved' } }) },
    { id: 'no-cost', label: 'Without the cost grain: the amount is not drawn', model: model({ can: { view: true, cost: false }, controls: { ...CONTROLS, actions: CONTROLS.actions.map((action) => (action.dual ? { ...action, dual: { decided: action.dual.decided } } : action)) } }) },
    { id: 'no-right', label: 'Without payables.view', model: model({ can: { view: false, cost: false }, controls: null, remittance: null, collections: null }) },
    { id: 'loading', label: 'Loading', model: model({ controls: null, remittance: null, collections: null }) },
    { id: 'error', label: 'Could not read', model: model({ controls: null, problem: 'problem.read.unavailable' }) },
  ],
})
