import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_CHOICES, DEMO_KINDS, DEMO_NOW, DEMO_RULES, DEMO_TIMERS, demoRules } from '../../_shared/rules/demo'
import { draftOf } from '../../_shared/rules/model'
import { MODULE_TIMERS, type AutomationViewModel } from './model'
import { AutomationView } from './view/AutomationView'

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
  ],
})
