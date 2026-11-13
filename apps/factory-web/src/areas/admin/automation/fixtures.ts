import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_CHOICES, DEMO_KINDS, DEMO_NOW, DEMO_RULES, DEMO_TIMERS, demoRules } from '../../_shared/rules/demo'
import { draftOf } from '../../_shared/rules/model'
import { MODULE_TIMERS, type AutomationViewModel } from './model'
import { AutomationView } from './view/AutomationView'
// B-W2b-307: Approval rules (made-up data).
import { approvalRulesModel, DEMO_APPROVAL_RULES, DEMO_DIALOG, DEMO_HELD_RULE, DEMO_RULES_ANSWER, DEMO_TEST } from './approval-rules/demo'
import { newDraft } from './approval-rules/model'

/**
 * SCR-167 Approvals, automation & AI (the W2a part) — made-up data only (PLAN §3.1): invented companies, sites and
 * records. Cases: Reminders & timers with the date rules, the rule dialog with its timers, a dry run, New rule (date kinds
 * only), a refused save, a switch being saved, a person who only reads (alerts.view), offline, empty, loading, an error, no
 * permission, the keys. Approval rules (W2b), Automation, Run log and AI (W3) are held in the switch with when.
 */

const DATE_RULES = DEMO_RULES.filter((rule) => rule.trigger === 'DATE')
const CERT = DATE_RULES[0]!

function model(overrides: Partial<AutomationViewModel> = {}): AutomationViewModel {
  return {
    access: 'open',
    now: DEMO_NOW,
    prefix: '/w/DEMO',
    manage: true,
    live: 'live',
    view: 'timers',
    rules: { status: 'ready', data: demoRules(DATE_RULES) },
    savingRules: [],
    ruleDialog: null,
    busy: false,
    notice: null,
    moduleTimers: MODULE_TIMERS,
    help: false,
    ...overrides,
  }
}

const dialog = (extra: Partial<NonNullable<AutomationViewModel['ruleDialog']>> = {}): NonNullable<AutomationViewModel['ruleDialog']> => ({
  mode: 'edit',
  rule: CERT,
  kinds: DEMO_KINDS.filter((kind) => kind.trigger === 'DATE'),
  choices: { status: 'ready', data: DEMO_CHOICES },
  test: null,
  timers: { status: 'ready', data: DEMO_TIMERS },
  problem: null,
  ...extra,
})

export const designScreen = defineDesignScreen<AutomationViewModel>({
  screen: 'SCR-167',
  title: 'Approvals, automation & AI: Reminders & timers (W2a), the rule dialog',
  view: AutomationView,
  cases: [
    { id: 'timers', label: 'Reminders & timers', model: model(), note: 'Every date rule as one sentence: its days in place, whom it tells, how often, its waiting timers and the next one, last fired, fired in 7 days, on/off. The other four lists say when they come.' },
    { id: 'rule', label: 'A date rule and its timers', model: model({ ruleDialog: dialog() }), note: 'Days or working days; waiting, fired and cancelled timers (with why). ⌘S saves.' },
    {
      id: 'rule-test',
      label: 'A changed rule and its dry run',
      model: model({ ruleDialog: dialog({ draft: { ...draftOf(CERT), numbers: { daysBefore: '60' }, workingDays: true }, test: { status: 'ready', data: { wouldFind: 3, complete: true, sample: [{ record: { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000201', label: 'CERT-DEMO-0007' } }, { record: { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000202', label: 'CERT-DEMO-0011' } }], fired7Days: 1 } } }) }),
      note: 'Counted against the records as they are now: Nexus keeps no copy of last week.',
    },
    { id: 'rule-new', label: 'New rule (date kinds)', model: model({ ruleDialog: { mode: 'new', rule: null, kinds: DEMO_KINDS.filter((kind) => kind.trigger === 'DATE'), choices: { status: 'ready', data: DEMO_CHOICES }, test: null, timers: null, problem: null } }), note: 'Certificate expiring or invoice deadline: the kind’s own numbers, a place the person may keep rules for.' },
    { id: 'rule-refused', label: 'Save refused: e-mail alone', model: model({ ruleDialog: dialog({ problem: 'refusal.noBell' }) }) },
    { id: 'rule-read-only', label: 'A rule I may only read', model: model({ manage: false, rules: { status: 'ready', data: demoRules(DATE_RULES.map((rule) => ({ ...rule, canChange: false })), false) }, ruleDialog: dialog({ rule: { ...CERT, canChange: false }, choices: null, timers: null }) }) },
    { id: 'saving', label: 'A switch being saved', model: model({ savingRules: [DATE_RULES[1]!.id], notice: { key: 'rules:notice.switchedOn', tone: 'success' } }) },
    { id: 'read-only', label: 'Only alerts.view', model: model({ manage: false, rules: { status: 'ready', data: demoRules(DATE_RULES.map((rule) => ({ ...rule, canChange: false })), false) } }), note: 'New rule, the switches and the numbers say why they are held.' },
    { id: 'offline', label: 'Offline', model: model({ live: 'offline' }) },
    { id: 'empty', label: 'No date rules', model: model({ rules: { status: 'ready', data: demoRules([]) } }) },
    { id: 'loading', label: 'Loading', model: model({ rules: { status: 'loading' } }) },
    { id: 'error', label: 'Could not be read', model: model({ rules: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'no-permission', label: 'No permission (no alerts.view)', model: model({ access: 'refused', rules: { status: 'loading' } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ help: true }) },
    // B-W2b-307 (design admin.automation sec:approval-rules, pop:rule; PLT-086, PLT-042, PLT-105).
    { id: 'w2b-307-approval-rules', label: 'B-W2b-307 · Approval rules', model: model({ view: 'approvals', approvalRules: approvalRulesModel() }), note: 'The locked rule first; each rule as its sentence with area, approver, signature, fired in 30 days and on/off. A kind with no checker yet is listed and held.' },
    { id: 'w2b-307-rule', label: 'B-W2b-307 · an approval rule (RuleBuilder)', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ dialog: DEMO_DIALOG }) }), note: "When a purchase order has order value over 5,000 → ask Finance, signed 'Released' with a fresh code; the order; the time to decide. ⌘S saves." },
    { id: 'w2b-307-rule-test', label: 'B-W2b-307 · the rule’s test', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ dialog: DEMO_TEST }) }), note: '"Would have asked for 4 of the last 50" with links, and who would approve.' },
    // B-W2b-382 (XF7:06): opened from Purchasing › Settings › New PO rule (`&kind=PURCHASE_ORDER`): the kind is chosen already.
    { id: 'w2b-382-rule-new-kind', label: 'B-W2b-382 · New rule opened for purchase orders: the kind preselected', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ dialog: { mode: 'new', rule: null, kind: 'PURCHASE_ORDER', test: null, problem: null } }) }), note: 'From Purchasing › Settings: "Purchase order" is chosen and its facts are offered; Warehouse › Settings opens it on "Stock adjustment".' },
    { id: 'w2b-307-rule-new', label: 'B-W2b-307 · New rule (written off)', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ dialog: { mode: 'new', rule: null, draft: { ...newDraft('PURCHASE_ORDER', '0190f0e2-1111-7000-8000-000000000001'), name: 'Orders over 10,000' }, test: null, problem: null } }) }) },
    { id: 'w2b-307-rule-refused', label: 'B-W2b-307 · Save refused: the approver cannot decide', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ dialog: { ...DEMO_DIALOG, problem: 'rules.problem.approver' } }) }) },
    { id: 'w2b-307-rule-held-money', label: 'B-W2b-307 · a threshold I may not see', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ rules: { status: 'ready', data: { ...DEMO_RULES_ANSWER, rules: [DEMO_HELD_RULE, ...DEMO_APPROVAL_RULES.slice(1)] } }, dialog: { mode: 'edit', rule: DEMO_HELD_RULE, test: null, problem: null } }) }), note: 'The value reads "…"; the rule is held with the reason.' },
    { id: 'w2b-307-rules-read-only', label: 'B-W2b-307 · approvals.view only', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ manage: false, rules: { status: 'ready', data: { ...DEMO_RULES_ANSWER, canAdd: false, rules: DEMO_APPROVAL_RULES.map((rule) => ({ ...rule, canChange: false })) } } }) }), note: 'New rule and the switches say why they are held.' },
    { id: 'w2b-307-rules-saving', label: 'B-W2b-307 · a switch being saved', model: model({ view: 'approvals', notice: { key: 'approvals:rules.notice.on', tone: 'success', params: { rule: 'Orders over 5,000' } }, approvalRules: approvalRulesModel({ saving: [DEMO_APPROVAL_RULES[1]!.id] }) }) },
    { id: 'w2b-307-rules-empty', label: 'B-W2b-307 · no approval rules', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ rules: { status: 'ready', data: { ...DEMO_RULES_ANSWER, rules: [] } } }) }), note: '"No approval rules. Quotes still use the margin floor from Sales › Settings."' },
    { id: 'w2b-307-rules-loading', label: 'B-W2b-307 · loading', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ rules: { status: 'loading' }, kinds: { status: 'loading' } }) }) },
    { id: 'w2b-307-rules-error', label: 'B-W2b-307 · could not be read', model: model({ view: 'approvals', approvalRules: approvalRulesModel({ rules: { status: 'error', problem: 'problem.unavailable' } }) }) },
    { id: 'w2b-307-rules-offline', label: 'B-W2b-307 · offline', model: model({ view: 'approvals', live: 'offline', approvalRules: approvalRulesModel({ offline: true }) }) },
    { id: 'w2b-307-rules-no-permission', label: 'B-W2b-307 · no approvals.view', model: model({ view: 'approvals' }), note: 'The list says it is not yours to open (never a locked box).' },
  ],
})
