import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX, SCOPE_ALL, SCOPE_ONE, SIGHT_HR, SIGHT_OFF, SIGHT_REQUEST, SITE_N, type PeopleRole } from '../_shared/fixtures'
import type { SightState } from '../_shared/parts'
import type { OperationDetail, OperationRow, Operations, Overview, PersonFigures, ReviewEntry, ReviewQueue, Trend } from './api'
import { efficiencyAddressOf, efficiencyCan, EMPTY_DECISION, EMPTY_PERSON, sectionSpecs } from './model'
import { EfficiencyView, type EfficiencyModel, type Read } from './view/EfficiencyView'

/**
 * SCR-161 — Efficiency with made-up lines, styles and operations only (invented numbers, "Paolo Prova" only inside the one-person
 * dialog's own cases): HR at a site with the legal basis, the production manager and the floor supervisor with the gate off, every
 * section's states, what the minimum group size hides, the standard review's detail and its refusals, one person's dialog
 * from choosing to the figures and the refusals, Arrange, how it is computed, the keys.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const LINE_A = { id: uid('6101', 1), code: 'L-A', name: 'Linea giacche' }
const LINE_B = { id: uid('6101', 2), code: 'L-B', name: 'Linea pantaloni' }
const LINE_C = { id: uid('6101', 3), code: 'L-C', name: 'Linea guanti' }
const STYLE_A = { id: uid('6102', 1), code: 'ST-100', name: 'Giacca Demo' }
const STYLE_B = { id: uid('6102', 2), code: 'ST-200', name: 'Pantalone Demo' }
const FROM = '2026-10-01'
const TO = '2026-10-31'
const NOW = '2026-11-02T09:42:00.000Z'

const figures = (efficiency: string, onStandard: string, earned: string, attended: string, off: string): Overview['lines'][number]['figures'] => ({ earnedMinutes: earned, attendedMinutes: attended, plannedMinutes: attended, offStandardMinutes: off, onStandardMinutes: attended, efficiency, onStandardEfficiency: onStandard, plannedEfficiency: efficiency })
const HIDDEN_FIGURES: Overview['lines'][number]['figures'] = { earnedMinutes: null, attendedMinutes: null, plannedMinutes: null, offStandardMinutes: null, onStandardMinutes: null, efficiency: null, onStandardEfficiency: null, plannedEfficiency: null }

const OVERVIEW: Overview = {
  siteId: SITE_N.id,
  from: FROM,
  to: TO,
  asOf: NOW,
  attendance: { open: true, provisional: false },
  tiles: figures('78.4', '86.1', '18240.000', '23262.000', '2080.000'),
  previous: null,
  lines: [
    { line: LINE_A, people: 8, tooFew: false, figures: figures('81.2', '88.0', '12480.000', '15369.000', '1200.000') },
    { line: LINE_B, people: 5, tooFew: false, figures: figures('72.8', '81.9', '5760.000', '7893.000', '880.000') },
    { line: LINE_C, people: null, tooFew: true, figures: HIDDEN_FIGURES },
  ],
  hiddenGroups: 1,
  traineeDaysLeftOut: 3,
  individual: { available: false },
}

const point = (date: string, efficiency: string | null, tooFew = false): Trend['lines'][number]['points'][number] => ({ date, tooFew, efficiency, onStandardEfficiency: efficiency, earnedMinutes: efficiency === null ? null : '480.000', attendedMinutes: efficiency === null ? null : '600.000' })
const TREND: Trend = {
  siteId: SITE_N.id,
  from: FROM,
  to: TO,
  lines: [
    { line: LINE_A, targetPercent: '85.0', points: [point('2026-10-26', '79.1'), point('2026-10-27', '82.4'), point('2026-10-28', null, true), point('2026-10-29', '84.0'), point('2026-10-30', '80.6')] },
    { line: LINE_B, targetPercent: null, points: [point('2026-10-26', '70.2'), point('2026-10-27', '74.8'), point('2026-10-28', '71.0'), point('2026-10-29', '75.3'), point('2026-10-30', '73.6')] },
  ],
}

const series = (values: readonly (string | null)[]): OperationRow['series'] => values.map((value, index) => ({ date: `2026-10-${26 + index}`, tooFew: value === null, actualMinutes: value === null ? null : '1.300', differencePercent: value }))
const row = (n: number, style: OperationRow['style'], code: string, name: string, smv: string, over: Partial<OperationRow> = {}): OperationRow => ({
  routingOperationId: uid('6103', n),
  style,
  revisionId: uid('6104', n),
  operation: { id: uid('6105', n), code, name, seq: n * 10 },
  standardMinutes: smv,
  people: 4,
  tooFew: false,
  figures: { bundles: 12, pieces: 240, actualMinutes: '1.300', differencePercent: '4.2', state: 'WITHIN' },
  series: series(['3.1', '4.0', null, '5.2', '4.1']),
  ...over,
})
const hiddenRow: Partial<OperationRow> = { people: null, tooFew: true, figures: { bundles: null, pieces: null, actualMinutes: null, differencePercent: null, state: null }, series: series([null, null, null, null, null]) }

const ROWS: OperationRow[] = [
  row(1, STYLE_A, 'CUC-01', 'Cucitura spalla', '1.250'),
  row(2, STYLE_A, 'CUC-02', 'Attacco manica', '2.400', { figures: { bundles: 14, pieces: 280, actualMinutes: '3.120', differencePercent: '30.0', state: 'REVIEW' } }),
  row(3, STYLE_A, 'RIF-01', 'Rifinitura collo', '0.900', { figures: { bundles: 3, pieces: 60, actualMinutes: '0.930', differencePercent: '3.3', state: 'TOO_FEW_BUNDLES' } }),
  row(4, STYLE_B, 'CUC-07', 'Cucitura laterale', '1.800', { figures: { bundles: 9, pieces: 180, actualMinutes: '1.530', differencePercent: '-15.0', state: 'REVIEW' } }),
  row(5, STYLE_B, 'TAG-01', 'Taglio rinforzi', '0.600', hiddenRow),
]
const OPERATIONS: Operations = { siteId: SITE_N.id, from: FROM, to: TO, rule: { tolerancePercent: 10, minBundles: 5 }, operations: ROWS, hiddenGroups: 1, untimedReports: 6, traineeBundles: 2 }

const entry = (source: OperationRow, over: Partial<ReviewEntry> = {}): ReviewEntry => ({
  routingOperationId: source.routingOperationId,
  style: source.style,
  revisionId: source.revisionId,
  operation: source.operation,
  standardMinutes: source.standardMinutes,
  people: source.people,
  tooFew: source.tooFew,
  figures: source.figures,
  direction: 'OVER',
  reason: 'OFF_STANDARD',
  since: '2026-10-12',
  lastDecision: null,
  ...over,
})
const QUEUE: ReviewQueue = {
  siteId: SITE_N.id,
  from: '2026-09-03',
  to: '2026-11-02',
  rule: { tolerancePercent: 10, minBundles: 5 },
  count: 3,
  queue: [entry(ROWS[1]!), entry(ROWS[3]!, { direction: 'UNDER', since: '2026-10-20' }), entry(ROWS[4]!, { reason: 'INVESTIGATING', since: '2026-10-22', direction: null, lastDecision: { id: uid('6106', 1), decision: 'INVESTIGATE', at: '2026-10-22T09:00:00.000Z' } })],
  leftOut: 1,
}
const MOST_LEFT_OUT: ReviewQueue = { ...QUEUE, count: 1, queue: [QUEUE.queue[0]!], leftOut: 6 }

const DETAIL: OperationDetail = {
  siteId: SITE_N.id,
  from: '2026-09-03',
  to: '2026-11-02',
  routingOperationId: ROWS[1]!.routingOperationId,
  style: STYLE_A,
  revisionId: ROWS[1]!.revisionId,
  operation: ROWS[1]!.operation,
  standardMinutes: '2.400',
  people: 4,
  tooFew: false,
  figures: ROWS[1]!.figures,
  days: ROWS[1]!.series,
  review: { reason: 'OFF_STANDARD', since: '2026-10-12', lastDecision: { id: uid('6106', 2), decision: 'INVESTIGATE', at: '2026-10-14T10:00:00.000Z' } },
  history: [
    { id: uid('6106', 2), decision: 'INVESTIGATE', at: '2026-10-14T10:00:00.000Z', by: 'Anna Esempio', reason: 'Tessuto nuovo sulla linea, da capire con il reparto.', proposedMinutes: null },
    { id: uid('6106', 3), decision: 'KEEP', at: '2026-07-02T10:00:00.000Z', by: 'Anna Esempio', reason: 'Scarto stagionale, rientrato.', proposedMinutes: null },
  ],
  rule: { tolerancePercent: 10, minBundles: 5 },
}

const FIGURES: PersonFigures = {
  person: { employeeId: uid('6107', 1), name: 'Paolo Prova' },
  siteId: SITE_N.id,
  from: FROM,
  to: TO,
  as: 'FIGURE_ROLE',
  days: [
    { date: '2026-10-28', pieces: 64, earnedMinutes: '112.000', timedEarnedMinutes: '96.000', timedMinutes: '120.000', offStandardMinutes: '15.000', efficiency: '80.0' },
    { date: '2026-10-29', pieces: 58, earnedMinutes: '101.500', timedEarnedMinutes: '101.500', timedMinutes: '118.000', offStandardMinutes: '0.000', efficiency: '86.0' },
  ],
  leftOut: { traineeDays: 1, sharedReports: 2 },
  recorded: true,
}
const PEOPLE_LIST = [
  { id: uid('6107', 1), name: 'Paolo Prova', code: 'D-0002' },
  { id: uid('6107', 2), name: 'Giulia Esempio', code: 'D-0001' },
]

const ready = <T,>(value: T): Read<T> => ({ status: 'ready', value })
const failed: Read<never> = { status: 'error', problem: { ns: 'people', words: { key: 'problem.unavailable' } } }
const idle: Read<never> = { status: 'idle' }
const loading: Read<never> = { status: 'loading' }
const specs = sectionSpecs((id) => id)

function role(person: PeopleRole, extra: readonly string[] = []) {
  return efficiencyCan([...PEOPLE_ROLES[person], ...extra])
}

const HR = [...PEOPLE_ROLES.hr, 'people.efficiency.view', 'people.efficiency.review', 'people.figures.view']

const base = (over: Partial<EfficiencyModel> = {}): EfficiencyModel => ({
  prefix: PREFIX,
  scope: SCOPE_ONE,
  can: role('production'),
  address: efficiencyAddressOf(null),
  sight: SIGHT_OFF,
  overview: ready(OVERVIEW),
  trend: ready(TREND),
  operations: ready(OPERATIONS),
  review: ready(QUEUE),
  lines: [LINE_A, LINE_B, LINE_C],
  styles: [STYLE_A, STYLE_B],
  updates: 0,
  notice: null,
  bulk: null,
  sending: false,
  pop: null,
  layout: defaultSectionLayout(specs),
  specs,
  arranging: false,
  timeZone: 'Europe/Rome',
  detail: null,
  person: null,
  ...over,
})

const hr = (over: Partial<EfficiencyModel> = {}): EfficiencyModel => base({ can: efficiencyCan(HR), sight: SIGHT_REQUEST, overview: ready({ ...OVERVIEW, individual: { available: true } }), ...over })
const waiting = (sight: SightState, over: Partial<EfficiencyModel> = {}): EfficiencyModel => base({ sight, overview: idle, trend: idle, operations: idle, review: idle, lines: [], styles: [], ...over })
const person = (over: Partial<NonNullable<EfficiencyModel['person']>> = {}): NonNullable<EfficiencyModel['person']> => ({ people: { status: 'ready', people: PEOPLE_LIST }, draft: EMPTY_PERSON, busy: false, problem: null, figures: null, ...over })
const detail = (over: Partial<NonNullable<EfficiencyModel['detail']>> = {}): NonNullable<EfficiencyModel['detail']> => ({ read: ready(DETAIL) as NonNullable<EfficiencyModel['detail']>['read'], draft: EMPTY_DECISION, busy: false, problem: null, done: null, id: DETAIL.routingOperationId, ids: QUEUE.queue.map((item) => item.routingOperationId), ...over })
const opened = (over: Partial<NonNullable<EfficiencyModel['detail']>> = {}) => ({ address: { ...efficiencyAddressOf(null), open: DETAIL.routingOperationId }, detail: detail(over) })

function EfficiencyDesign({ model }: { model: EfficiencyModel }) {
  return inShell('/people/efficiency', createElement(EfficiencyView, { model }), 'production')
}

export const designScreen = defineDesignScreen<EfficiencyModel>({
  screen: 'SCR-161',
  title: 'Efficiency (People)',
  view: EfficiencyDesign,
  cases: [
    { id: 'manager', label: 'Production manager, the gate off: lines and operations, no person at all', model: base(), note: 'One line hidden: too few people. Nothing sorts or ranks.' },
    { id: 'hr-gate-on', label: 'HR at a site with the legal basis: View one person', model: hr() },
    { id: 'hr-gate-off', label: 'HR, gate off: no picker, the words say why', model: base({ can: efficiencyCan(HR) }) },
    { id: 'gate-on-not-hr', label: 'Gate on, not HR: nobody to choose', model: base({ sight: SIGHT_HR }) },
    { id: 'supervisor', label: 'Floor supervisor: reads, cannot decide (held with why)', model: base({ can: role('supervisor', ['people.efficiency.view']) }) },
    { id: 'read-only', label: 'Read only', model: base({ can: efficiencyCan([...PEOPLE_ROLES.readOnly, 'people.efficiency.view']) }) },
    { id: 'no-permission', label: 'No right to this page', model: base({ can: role('sales') }) },
    { id: 'all-sites', label: 'All sites: a site must be chosen, nothing is read', model: waiting({ status: 'allSites' }, { scope: SCOPE_ALL }) },
    { id: 'privacy-loading', label: 'Reading what you see: nothing else is read yet', model: waiting({ status: 'loading' }) },
    { id: 'privacy-failed', label: 'The privacy note failed: nothing is read, Try again', model: waiting({ status: 'failed' }) },
    { id: 'loading', label: 'Figures loading', model: base({ overview: loading, trend: loading, operations: loading, review: loading }) },
    { id: 'error', label: 'Every section failed on its own, never drawn as empty', model: base({ overview: failed, trend: failed, operations: failed, review: failed }) },
    { id: 'empty', label: 'Nothing timed in the period', model: base({ overview: ready({ ...OVERVIEW, tiles: null, lines: [], hiddenGroups: 0, traineeDaysLeftOut: 0 }), trend: ready({ ...TREND, lines: [] }), operations: ready({ ...OPERATIONS, operations: [], hiddenGroups: 0, untimedReports: 0, traineeBundles: 0 }), review: ready({ ...QUEUE, count: 0, queue: [], leftOut: 0 }) }) },
    { id: 'attendance-off', label: "The site's attendance purpose off: earned only, in words", model: base({ overview: ready({ ...OVERVIEW, attendance: { open: false, provisional: false }, tiles: { ...OVERVIEW.tiles!, attendedMinutes: null, efficiency: null, onStandardEfficiency: null } }) }) },
    { id: 'provisional', label: 'Attended minutes provisional', model: base({ overview: ready({ ...OVERVIEW, attendance: { open: true, provisional: true } }) }) },
    { id: 'compare', label: 'Compared with the previous period', model: base({ address: { ...efficiencyAddressOf(null), compare: true }, overview: ready({ ...OVERVIEW, previous: { from: '2026-08-31', to: '2026-09-30', tiles: figures('76.1', '84.0', '17800.000', '23400.000', '2300.000') } }) }) },
    { id: 'compare-nothing', label: 'Compared, nothing in the previous period: said in words', model: base({ address: { ...efficiencyAddressOf(null), compare: true }, overview: ready({ ...OVERVIEW, previous: { from: '2026-08-31', to: '2026-09-30', tiles: null } }) }) },
    { id: 'day-chosen', label: "A day's operations", model: base({ address: { ...efficiencyAddressOf(null), day: '2026-10-29' } }) },
    { id: 'updates', label: 'Live scans wait behind N updates', model: base({ updates: 4 }) },
    { id: 'left-out-some', label: 'Queue: some left out', model: base() },
    { id: 'left-out-most', label: 'Queue: most left out, said as a warning with the reason', model: base({ can: efficiencyCan([...PEOPLE_ROLES.production, 'people.privacy.view']), review: ready(MOST_LEFT_OUT) }) },
    { id: 'left-out-all', label: 'Queue: everything left out, never "Nothing to review"', model: base({ review: ready({ ...QUEUE, count: 0, queue: [], leftOut: 4 }) }) },
    { id: 'queue-empty', label: 'Nothing to review', model: base({ review: ready({ ...QUEUE, count: 0, queue: [], leftOut: 0 }) }) },
    { id: 'pop', label: 'Operation pop-over', model: base({ pop: { id: ROWS[1]!.routingOperationId, detail: ready(DETAIL) } }) },
    { id: 'sent', label: 'Sent to the review, one refused', model: base({ notice: { tone: 'warning', key: 'sent.done', params: { count: 1 }, refused: [{ label: 'CUC-07 · Cucitura laterale', problem: { ns: 'efficiency', words: { key: 'refused.TOO_FEW_PEOPLE' } } }] } }) },
    { id: 'review', label: 'Standard review detail', model: base(opened()) },
    { id: 'review-change', label: 'Change: new standard, the law, a reason', model: base(opened({ draft: { decision: 'CHANGE', reason: 'Tessuto più pesante dal lotto di ottobre.', proposed: '3,10' } })) },
    { id: 'review-keep-held', label: 'Keep without a reason: held with why', model: base(opened({ draft: { ...EMPTY_DECISION, decision: 'KEEP' } })) },
    { id: 'review-done', label: 'Change recorded: on to Products', model: base(opened({ done: { decision: 'CHANGE', styleId: STYLE_A.id } })) },
    { id: 'review-moved', label: 'Someone decided first: read again', model: base(opened({ draft: { decision: 'KEEP', reason: 'Va bene così.', proposed: '' }, problem: { ns: 'efficiency', words: { key: 'refused.REVIEW_MOVED' } } })) },
    { id: 'review-no-right', label: 'Read only: the decision is held', model: base({ can: efficiencyCan([...PEOPLE_ROLES.readOnly, 'people.efficiency.view']), ...opened() }) },
    { id: 'review-few', label: 'Under investigation with too few people: no figures, can be closed', model: base(opened({ read: ready({ ...DETAIL, tooFew: true, people: null, figures: ROWS[4]!.figures, days: [] }) as NonNullable<EfficiencyModel['detail']>['read'] })) },
    { id: 'review-loading', label: 'Detail loading', model: base(opened({ read: { status: 'loading' } })) },
    { id: 'review-error', label: 'Detail failed', model: base(opened({ read: { status: 'error', problem: { ns: 'people', words: { key: 'problem.unavailable' } } } })) },
    { id: 'bulk', label: 'Keep 2: one reason', model: base({ bulk: { decision: 'KEEP', rows: QUEUE.queue.slice(0, 2), reason: '', busy: false } }) },
    { id: 'person', label: 'One person: choose person and purpose', model: hr({ person: person() }) },
    { id: 'person-filled', label: 'One person: ready to show (recorded)', model: hr({ person: person({ draft: { personId: PEOPLE_LIST[0]!.id, reason: 'WORKER_REQUEST', note: '' } }) }) },
    { id: 'person-figures', label: 'One person: the figures, in the dialog only', model: hr({ person: person({ draft: { personId: PEOPLE_LIST[0]!.id, reason: 'WORKER_REQUEST', note: '' }, figures: FIGURES }) }) },
    { id: 'person-empty', label: 'One person: nothing in the period', model: hr({ person: person({ draft: { personId: PEOPLE_LIST[0]!.id, reason: 'PAY_QUERY', note: '' }, figures: { ...FIGURES, days: [], leftOut: { traineeDays: 0, sharedReports: 0 } } }) }) },
    { id: 'person-gate-closed', label: 'The gate closed meanwhile (409): the same words for any id', model: hr({ person: person({ draft: { personId: PEOPLE_LIST[0]!.id, reason: 'PAY_QUERY', note: '' }, problem: { ns: 'efficiency', words: { key: 'refused.gatePerformance' } } }) }) },
    { id: 'person-not-allowed', label: 'Not allowed (403): the same words for every refusal', model: hr({ person: person({ draft: { personId: PEOPLE_LIST[0]!.id, reason: 'PAY_QUERY', note: '' }, problem: { ns: 'efficiency', words: { key: 'refused.notAllowed' } } }) }) },
    { id: 'person-no-register', label: 'No HR register: nobody to choose from', model: hr({ person: person({ people: { status: 'noRegister' } }) }) },
    { id: 'person-loading', label: 'One person: the people are read', model: hr({ person: person({ people: { status: 'loading' } }) }) },
    { id: 'how', label: 'How efficiency is computed', model: base({ howOpen: true }) },
    { id: 'arrange', label: 'Arrange', model: base({ arranging: true }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: base({ keysOpen: true }) },
  ],
})

export { FIGURES, OVERVIEW }
