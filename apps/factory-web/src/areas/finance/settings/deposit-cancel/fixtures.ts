import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../../_demo/fixtures'
import { DEMO, permissionsOf } from '../../invoices/test-mode/demo/fixtures'
import { designScreen as settingsScreen } from '../fixtures'
import { FinanceSettingsView } from '../view/FinanceSettingsView'
import type { DepositRule, DepositRules } from './api'
import { emptyRule, ruleAbilitiesOf, ruleDraftOf } from './model'
import { DepositRulesCard, type DepositRulesModel } from './view/DepositRulesCard'

/**
 * SCR-449 — Finance settings › Deposits › Refund on cancellation (design finance.settings sec:deposits "refund on
 * cancellation (W2b)"; B-W2b-417 on B-W2b-396's API; FIN-080), made-up data only: the company's rules — an advance paid back
 * when the customer cancels, 20 % of a caparra kept on a made-to-measure order, twice the caparra back when we cancel, an
 * archived one —, adding one, changing one, a rule the database would refuse (twice back for the customer: held with why),
 * archiving, a second active rule refused, the states and the roles: Finance, Sales (read only). Every rule is invented.
 */

const uid = (n: number) => `0190f0e2-7676-7000-8000-${String(n).padStart(12, '0')}`
const rule = (n: number, over: Partial<DepositRule>): DepositRule => ({ id: uid(n), version: 1, companyId: DEMO.id, depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: null, refundRule: 'REFUND_ALL', keepPct: '0.0000', documentKind: 'CREDIT_NOTE', note: null, status: 'ACTIVE', ...over })

const RULES: DepositRule[] = [
  rule(1, {}),
  rule(2, { depositKind: 'CAPARRA', madeToMeasure: true, refundRule: 'KEEP_PERCENT', keepPct: '20.0000', note: 'Clausola 7 del preventivo su misura' }),
  rule(3, { depositKind: 'CAPARRA', cancelledBy: 'COMPANY', refundRule: 'REFUND_DOUBLE' }),
  rule(4, { depositKind: 'CAPARRA_PENITENZIALE', refundRule: 'KEEP_PERCENT', keepPct: '100.0000', documentKind: 'NONE', status: 'ARCHIVED' }),
]
const LIST: DepositRules = { companyId: DEMO.id, rules: RULES, mayManage: true }

interface RuleCase {
  role: Role
  card: DepositRulesModel
  inPage?: boolean
}

const base = (role: Role, over: Partial<DepositRulesModel> = {}, inPage = false): RuleCase => ({
  role,
  inPage,
  card: { can: ruleAbilitiesOf(permissionsOf(role)), rows: 'all', list: { value: LIST, problem: null }, dialog: null, draft: emptyRule(), busy: false, problem: null, notice: null, ...over },
})

function RuleDesign({ model }: { model: RuleCase }) {
  const card = createElement(DepositRulesCard, { model: model.card })
  if (!model.inPage) return inShell('/finance/settings', card, model.role)
  const page = settingsScreen.cases.find((item) => item.id === 'finance')!.model.settings
  return inShell('/finance/settings', createElement(FinanceSettingsView, { model: page, depth: { depositRules: card } }), model.role)
}

export const designScreen = defineDesignScreen<RuleCase>({
  screen: 'SCR-449',
  title: 'Finance settings › Deposits › Refund on cancellation: what is kept or paid back, and the document that follows',
  view: RuleDesign,
  cases: [
    { id: 'finance', label: 'Finance · Four rules: an advance paid back, 20 % of a caparra kept, twice back when we cancel, one archived', model: base('finance') },
    { id: 'in-page', label: 'Finance · The card in its place after the deposit rules', model: base('finance', { rows: 'active', list: { value: { ...LIST, rules: RULES.filter((entry) => entry.status === 'ACTIVE') }, problem: null } }, true) },
    { id: 'add', label: 'Finance · Add: a penalty caparra, the customer cancels, 30 % kept (the words live)', model: base('finance', { dialog: { kind: 'add' }, draft: { ...emptyRule(), depositKind: 'CAPARRA_PENITENZIALE', refundRule: 'KEEP_PERCENT', keepPct: '30' } }) },
    { id: 'add-refused-rule', label: 'Finance · Twice back when the customer cancels: held with why (c.c. artt. 1385, 1386)', model: base('finance', { dialog: { kind: 'add' }, draft: { ...emptyRule(), depositKind: 'CAPARRA', refundRule: 'REFUND_DOUBLE' } }) },
    { id: 'edit', label: 'Finance · Change the made-to-measure caparra (its deposit, side and orders fixed)', model: base('finance', { dialog: { kind: 'edit', rule: RULES[1]! }, draft: ruleDraftOf(RULES[1]!) }) },
    { id: 'one-active', label: 'Finance · Refused: an active rule exists for this deposit, side and orders (said in the dialog)', model: base('finance', { dialog: { kind: 'add' }, draft: emptyRule(), problem: { key: 'finance-invoices-depth:rule.problem.oneActive', reload: false } }) },
    { id: 'archive', label: 'Finance · Archive two rules', model: base('finance', { dialog: { kind: 'archive', rules: RULES.slice(0, 2) } }) },
    { id: 'selected', label: 'Finance · Rows chosen: Archive 2 (the archived one not selectable)', model: base('finance', { selected: [uid(1), uid(3)] }) },
    { id: 'sales', label: 'Sales · Read only: Add, Change and Archive held with why', model: base('sales') },
    { id: 'empty', label: 'No rule yet: everything is paid back', model: base('finance', { list: { value: { ...LIST, rules: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: base('finance', { list: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { list: { value: null, problem: 'problem.read.unavailable' } }) },
  ],
})
