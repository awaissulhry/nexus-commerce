import { alertPhrase } from '@nexus/factory-domain/alerts/rules'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { AlertRule } from '../../_shared/rules/api'
import { DEMO_AT, DEMO_CHOICES, DEMO_KINDS, DEMO_NOW, DEMO_RULES, DEMO_TIMERS, demoRules } from '../../_shared/rules/demo'
import { draftOf } from '../../_shared/rules/model'
import type { AlertItem } from './api'
import type { AlertRow, AlertsList, AlertsViewModel, AlertView } from './model'
import { AlertsView } from './view/AlertsView'

/**
 * SCR-234 Alerts — made-up data only (PLAN §3.1): invented people at no real company, invented records and dates. Each case
 * is one state the Owner reviews: the open alerts with the tiles and the rules, a tile pressed, a filter, the selection
 * with Acknowledge N, the popup (open, resolved), Assign, Resolve, Snooze, the rule dialog (a change with its dry run, a
 * date rule with its timers, read only, a new rule, a refused save), live updates, a person who only reads (alerts.view),
 * offline, empty, loading, the list's error while the rules still work, the rules' error, no permission, the keys.
 */

const PREFIX = '/w/DEMO'
const ME = { id: '0190f0e2-3333-7000-8000-000000000001', name: 'Alex Demo', me: true }
const BEA = { id: '0190f0e2-3333-7000-8000-000000000002', name: 'Bea Esempio', me: false }
const CARLO = { id: '0190f0e2-3333-7000-8000-000000000003', name: 'Carlo Prova', me: false }
const aid = (n: number) => `0190f0e2-4444-7000-8000-${String(n).padStart(12, '0')}`
const ALL_VERBS: AlertItem['verbs'] = ['ACKNOWLEDGE', 'ASSIGN', 'SNOOZE', 'RESOLVE']

function alert(n: number, ruleKind: string, record: { type: string; label: string }, facts: Record<string, string | number | boolean>, extra: Partial<AlertItem> = {}): AlertRow {
  const phrase = alertPhrase(ruleKind, record.label, facts)!
  const base: AlertItem = {
    id: aid(n),
    ruleId: DEMO_RULES.find((rule) => rule.ruleKind === ruleKind)?.id ?? DEMO_RULES[0]!.id,
    ruleKind,
    severity: 'WARNING',
    state: 'OPEN',
    record: { type: record.type, id: `0190f0e2-5555-7000-8000-${String(n).padStart(12, '0')}`, label: record.label },
    companyId: '0190f0e2-6666-7000-8000-000000000001',
    siteId: null,
    partyId: null,
    placeLabel: 'Demo Pelletteria',
    words: { key: phrase.key, params: { ...phrase.params } },
    facts,
    raisedAt: DEMO_AT(30, 8, 15),
    occurrence: 1,
    ageDays: 1,
    acknowledged: null,
    assigned: null,
    snoozed: null,
    resolved: null,
    forMe: true,
    verbs: ALL_VERBS,
    version: 1,
    ...extra,
  }
  return { ...base, href: `${PREFIX}/home/alerts?open=${base.id}`, recordHref: `${PREFIX}/records/${base.record.type}/${base.record.id}` }
}

const ROWS: AlertRow[] = [
  alert(1, 'MATERIAL_SHORT', { type: 'WorkOrder', label: 'WO-DEMO-0042' }, { item: 'PEL-NAPPA-NERO' }, { severity: 'CRITICAL', placeLabel: 'Demo plant A1', siteId: '0190f0e2-6666-7000-8000-000000000101', ageDays: 0, raisedAt: DEMO_AT(31, 7, 50) }),
  alert(2, 'CERTIFICATE_EXPIRING', { type: 'Certificate', label: 'CERT-DEMO-0003' }, { dueDate: '2026-11-20', daysLeft: 20 }, { severity: 'CRITICAL', companyId: null, placeLabel: null, forMe: false, ageDays: 10, raisedAt: DEMO_AT(21, 0, 1) }),
  alert(3, 'ORDER_LATE_RISK', { type: 'SalesOrder', label: 'SO-DEMO-0042' }, { daysLeft: 2, late: false, promiseDate: '2026-11-02', daysBeforePromise: 3 }, { state: 'ACKNOWLEDGED', acknowledged: { by: ME, at: DEMO_AT(30, 9) }, verbs: ['ASSIGN', 'SNOOZE', 'RESOLVE'], version: 2 }),
  alert(4, 'HOLD_TOO_LONG', { type: 'QualityHold', label: 'HIDE-DEMO-0102' }, { hours: 30, threshold: 24 }, { placeLabel: 'Demo plant A1', assigned: { to: BEA, by: ME, at: DEMO_AT(30, 10) }, forMe: false, ageDays: 1 }),
  alert(5, 'PO_NOT_CONFIRMED', { type: 'PurchaseOrder', label: 'PO-DEMO-0031' }, { days: 3, threshold: 2 }, { severity: 'INFO', forMe: false, ageDays: 2, raisedAt: DEMO_AT(29, 9) }),
  alert(6, 'INVOICE_DEADLINE', { type: 'Ddt', label: '144/2026' }, { dueDate: '2026-11-15', daysLeft: 3 }, { ageDays: 0, raisedAt: DEMO_AT(31, 0, 2) }),
]
const TILES: AlertsList['tiles'] = [
  { tile: 'OPEN_FOR_ME', count: 3, complete: true },
  { tile: 'CRITICAL', count: 2, complete: true },
  { tile: 'UNASSIGNED', count: 5, complete: true },
  { tile: 'ACKNOWLEDGED', count: 1, complete: true },
  { tile: 'RESOLVED_TODAY', count: 4, complete: true },
]
const ready = (rows: readonly AlertRow[], extra: Partial<AlertsList> = {}): AlertsViewModel['list'] => ({ status: 'ready', data: { asOf: DEMO_AT(31, 9, 38), tiles: TILES, total: rows.length, complete: true, rows, more: false, loadingMore: false, ...extra } })
const CONTROLS: AlertsViewModel['controls'] = { tile: null, severity: null, kind: null, q: '', open: null, rule: null }

function model(overrides: Partial<AlertsViewModel> = {}): AlertsViewModel {
  return {
    access: 'open',
    now: DEMO_NOW,
    prefix: PREFIX,
    can: { view: true, handle: true, manageRules: true },
    live: 'live',
    controls: CONTROLS,
    list: ready(ROWS),
    updates: 0,
    selected: [],
    open: null,
    dialog: null,
    busy: false,
    notice: null,
    rules: { status: 'ready', data: demoRules() },
    ruleDialog: null,
    savingRules: [],
    ...overrides,
  }
}

const OPEN_VIEW: AlertView = {
  alert: ROWS[2]!,
  rule: { id: ROWS[2]!.ruleId, enabled: true, threshold: { daysBeforePromise: 3 } },
  history: [
    { verb: 'RAISED', at: DEMO_AT(30, 8, 15), actor: null, assignee: null, snoozedUntil: null, note: null },
    { verb: 'ACKNOWLEDGED', at: DEMO_AT(30, 9), actor: ME, assignee: null, snoozedUntil: null, note: null },
  ],
  similar: [{ id: aid(11), record: { type: 'SalesOrder', id: '0190f0e2-5555-7000-8000-000000000011', label: 'SO-DEMO-0039' }, severity: 'WARNING', state: 'OPEN', raisedAt: DEMO_AT(29, 8), href: `${PREFIX}/home/alerts?open=${aid(11)}` }],
}
const RULE_OF_OPEN = DEMO_RULES[0]!
const RESOLVED = alert(21, 'HOLD_TOO_LONG', { type: 'QualityHold', label: 'HIDE-DEMO-0090' }, { hours: 26, threshold: 24 }, {
  state: 'RESOLVED',
  verbs: [],
  forMe: false,
  resolved: { at: DEMO_AT(31, 8, 30), resolution: 'HANDLED', by: CARLO, note: 'Lab result in: the hide is released, the hold lifted.' },
  version: 4,
})
const RESOLVED_VIEW: AlertView = {
  alert: RESOLVED,
  rule: { id: RESOLVED.ruleId, enabled: true, threshold: { hours: 24 } },
  history: [
    { verb: 'RAISED', at: DEMO_AT(30, 6), actor: null, assignee: null, snoozedUntil: null, note: null },
    { verb: 'ASSIGNED', at: DEMO_AT(30, 7), actor: ME, assignee: CARLO, snoozedUntil: null, note: null },
    { verb: 'SNOOZED', at: DEMO_AT(30, 7, 5), actor: CARLO, assignee: null, snoozedUntil: DEMO_AT(30, 15), note: null },
    { verb: 'RESOLVED', at: DEMO_AT(31, 8, 30), actor: CARLO, assignee: null, snoozedUntil: null, note: 'Lab result in: the hide is released, the hold lifted.' },
  ],
  similar: [],
}
const openCase = { id: ROWS[2]!.id, detail: { status: 'ready' as const, data: OPEN_VIEW }, rule: { status: 'ready' as const, data: RULE_OF_OPEN } }
const PEOPLE = { status: 'ready' as const, data: [ME, BEA, CARLO] }

const HOLD_RULE = DEMO_RULES[1]!
const CERT_RULE = DEMO_RULES[5]!
const ruleDialog = (rule: AlertRule, extra: Partial<NonNullable<AlertsViewModel['ruleDialog']>> = {}): NonNullable<AlertsViewModel['ruleDialog']> => ({
  mode: 'edit',
  rule,
  kinds: DEMO_KINDS,
  choices: { status: 'ready', data: DEMO_CHOICES },
  test: null,
  timers: null,
  problem: null,
  ...extra,
})

export const designScreen = defineDesignScreen<AlertsViewModel>({
  screen: 'SCR-234',
  title: 'Alerts: tiles, open alerts, the popup, the rules and the rule dialog',
  view: AlertsView,
  cases: [
    { id: 'open', label: 'Open alerts and the rules', model: model(), note: 'Critical first, then the oldest; each alert in words; the record opens in a new tab with ⌘-click; the rules below, each as one sentence with its number edited in place and its switch.' },
    { id: 'tile-for-me', label: 'Open for me pressed', model: model({ controls: { ...CONTROLS, tile: 'OPEN_FOR_ME' }, list: ready(ROWS.filter((row) => row.forMe)) }), note: 'A tile is a saved filter of the list (pressed); pressing it again clears it.' },
    { id: 'filtered', label: 'Critical, material short', model: model({ controls: { ...CONTROLS, severity: 'CRITICAL', kind: 'MATERIAL_SHORT' }, list: ready(ROWS.slice(0, 1)) }) },
    { id: 'selected', label: 'Three selected: Acknowledge 2', model: model({ selected: [ROWS[0]!.id, ROWS[1]!.id, ROWS[2]!.id], focusRow: 0 }), note: 'The acknowledged one cannot be ticked again (its box says why); Acknowledge 2 is all or none.' },
    { id: 'popup', label: 'The alert’s popup', model: model({ open: openCase }), note: 'What, why (the rule as a sentence), its history, similar open alerts; D acknowledge, Assign, Snooze, Resolve; J / K step through the list.' },
    { id: 'popup-resolved', label: 'A resolved alert', model: model({ controls: { ...CONTROLS, tile: 'RESOLVED_TODAY' }, list: ready([RESOLVED]), open: { id: RESOLVED.id, detail: { status: 'ready', data: RESOLVED_VIEW }, rule: { status: 'ready', data: HOLD_RULE } } }), note: 'Every button held: resolved, it changes no more. The note says what was done.' },
    { id: 'assign', label: 'Assign', model: model({ open: openCase, dialog: { kind: 'assign', id: ROWS[2]!.id, people: PEOPLE } }), note: 'Only people who see its record and handle alerts there; they are told on the bell.' },
    { id: 'resolve', label: 'Resolve with a note', model: model({ open: openCase, dialog: { kind: 'resolve', id: ROWS[2]!.id } }), note: 'The note is required: the history keeps it.' },
    { id: 'snooze', label: 'Snooze', model: model({ open: openCase, dialog: { kind: 'snooze', id: ROWS[2]!.id } }), note: 'The site’s times; at most 30 days; it comes back by itself.' },
    { id: 'rule', label: 'Rule: hold longer than…', model: model({ ruleDialog: ruleDialog(HOLD_RULE) }), note: 'The rule as one sentence with its parts in place: hours, place, who is told, how, how often. ⌘S saves.' },
    {
      id: 'rule-changed',
      label: 'A changed rule and its dry run',
      model: model({ ruleDialog: ruleDialog(HOLD_RULE, { draft: { ...draftOf(HOLD_RULE), numbers: { hours: '48' }, cooldownMinutes: 240 }, test: { status: 'ready', data: { wouldFind: 2, complete: true, sample: [{ record: { type: 'QualityHold', id: '0190f0e2-5555-7000-8000-000000000102', label: 'HIDE-DEMO-0102' } }, { record: { type: 'QualityHold', id: '0190f0e2-5555-7000-8000-000000000105', label: 'LOT-DEMO-0005' } }], fired7Days: 4 } } }) }),
      note: '2 changes not saved; "Would find 2 records now · raised 4 alerts in the last 7 days" — counted now, honestly (no copy of last week exists).',
    },
    { id: 'rule-problem', label: 'A number out of bounds', model: model({ ruleDialog: ruleDialog(HOLD_RULE, { draft: { ...draftOf(HOLD_RULE), numbers: { hours: '900' } } }) }), note: 'The field says its bounds; Save is held with why.' },
    { id: 'rule-date', label: 'A date rule with its timers', model: model({ ruleDialog: ruleDialog(CERT_RULE, { timers: { status: 'ready', data: DEMO_TIMERS } }) }), note: 'Days or working days; the timers waiting, fired and cancelled (with why).' },
    { id: 'rule-read-only', label: 'A rule I may only read', model: model({ can: { view: true, handle: true, manageRules: false }, rules: { status: 'ready', data: demoRules(DEMO_RULES.map((rule) => ({ ...rule, canChange: false })), false) }, ruleDialog: ruleDialog({ ...HOLD_RULE, canChange: false }, { choices: null }) }), note: 'The same sentence in words; every control held with why.' },
    { id: 'rule-new', label: 'New rule', model: model({ ruleDialog: { mode: 'new', rule: null, kinds: DEMO_KINDS, choices: { status: 'ready', data: DEMO_CHOICES }, test: null, timers: null, problem: null } }), note: 'What it watches, then the sentence with the kind’s own numbers; told to the role its built-in rule tells.' },
    { id: 'rule-refused', label: 'Save refused: changed meanwhile', model: model({ ruleDialog: ruleDialog(HOLD_RULE, { problem: 'refusal.changed' }) }), note: 'Read again; the person makes the change again on the rule as it is now.' },
    { id: 'rule-saving', label: 'A switch being saved', model: model({ savingRules: [DEMO_RULES[3]!.id], rules: { status: 'ready', data: demoRules(DEMO_RULES.map((rule, index) => (index === 3 ? { ...rule, enabled: false } : rule))) }, notice: { key: 'rules:notice.switchedOff', tone: 'success' } }) },
    { id: 'updates', label: 'Live: 2 updates waiting', model: model({ updates: 2 }), note: 'Rows never move under the cursor: "2 updates · Show".' },
    { id: 'read-only', label: 'Only alerts.view', model: model({ can: { view: true, handle: false, manageRules: false }, list: ready(ROWS.map((row) => ({ ...row, verbs: [], forMe: false }))), rules: { status: 'ready', data: demoRules(DEMO_RULES.map((rule) => ({ ...rule, canChange: false })), false) }, open: { ...openCase, detail: { status: 'ready', data: { ...OPEN_VIEW, alert: { ...OPEN_VIEW.alert, verbs: [] } } } } }), note: 'No selection; the popup’s buttons and the rules’ switches say why they are held.' },
    { id: 'offline', label: 'Offline', model: model({ live: 'offline' }), note: 'Changes are held: "Offline — change it when back online."' },
    { id: 'empty', label: 'No open alerts', model: model({ list: ready([], { tiles: TILES.map((tile) => ({ ...tile, count: tile.tile === 'RESOLVED_TODAY' ? 4 : 0 })) }) }) },
    { id: 'empty-filtered', label: 'Nothing matches', model: model({ controls: { ...CONTROLS, q: 'zzz' }, list: ready([]) }) },
    { id: 'loading', label: 'Loading', model: model({ list: { status: 'loading' }, rules: { status: 'loading' } }) },
    { id: 'error', label: 'The list could not be read (the rules still work)', model: model({ list: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'rules-error', label: 'The rules could not be read', model: model({ rules: { status: 'error', problem: 'problem.failed' } }) },
    { id: 'no-permission', label: 'No permission (no alerts.view)', model: model({ access: 'refused', list: { status: 'loading' } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ dialog: { kind: 'help' } }) },
  ],
})
