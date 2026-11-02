import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, inShell, PREFIX, ROLES } from '../_shared/fixtures'
import type { BundleTiles, Finding, FindingsSummary, TrackedBundle, WhoAnswer } from './api'
import type { BundlesModel, FindingsDialog, ReprintRun } from './list-model'
import { bundlesCanOf } from './model'
import { BundlesView } from './view/BundlesView'

/**
 * SCR-259 — Bundles (design production.bundles) with made-up data only: every state of the list (loading, error, empty,
 * nothing matching, no permission, more pages, live updates), the tiles pressed, Reprint N, and the scan-pattern checks
 * in each of their states (on, a station site, no legal basis, the purpose off), the bundles behind a count, Dismiss and
 * "Show who" (held for everyone but the owner; the purpose; the one finding's scans). Every name is invented.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE = uid('2222', 1)

type Role = 'owner' | 'manager' | 'supervisor' | 'reader'
const EXTRA = {
  owner: ['production.bundles.view', 'production.bundles', 'production.bundles.findings', 'production.bundles.who', 'print.labels', 'production.settings.view'],
  manager: ['production.bundles.view', 'production.bundles', 'production.bundles.findings', 'print.labels'],
  supervisor: ['production.bundles.view', 'production.bundles'],
  reader: ['production.bundles.view'],
} as const
const SHELL = { owner: 'owner', manager: 'manager', supervisor: 'teamLeader', reader: 'sales' } as const
export const permissionsOf = (role: Role): string[] => [...ROLES[SHELL[role]], ...EXTRA[role]]
export const bundlesCanAs = (role: Role) => bundlesCanOf(permissionsOf(role))

const op = (seq: number, code: string, name: string) => ({ id: uid('3333', seq), seq, code, name })
const CUT = op(10, 'TAGLIO', 'Taglio pelle')
const BACK = op(20, 'SCHIENA', 'Assemblaggio schiena')
const SLEEVE = op(30, 'MANICHE', 'Montaggio maniche')
const STATION = { id: uid('4444', 1), code: 'CUC-03', name: 'Postazione cucito 3' }
const HIDE = { hideId: uid('5555', 1), code: 'PL-00412', lotId: uid('5656', 1), lotCode: 'LT-0098' }

const row = (n: number, extra: Partial<TrackedBundle> = {}): TrackedBundle => ({
  id: uid('7171', n),
  code: `BN-${String(n).padStart(6, '0')}`,
  replacedCodes: [],
  status: 'ACTIVE',
  siteId: SITE,
  workOrder: { id: uid('9191', 1), number: 'WO-00012', status: 'IN_PROGRESS' },
  style: { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' },
  workOrderSizeId: uid('8181', n),
  colourwayCode: 'BLK',
  colourwayName: 'Nero',
  size: '52',
  part: null,
  quantity: 10,
  parentBundleId: null,
  place: 'LINE',
  qualityReason: null,
  operation: BACK,
  next: SLEEVE,
  subcontract: null,
  since: at(29, 8, 40),
  lastScan: { at: at(29, 8, 40), operation: BACK, station: STATION },
  stuck: { stuck: false, workingHours: 1.2, limitHours: 4 },
  hides: [HIDE],
  voidedAt: null,
  createdAt: at(28, 15, 10),
  ...extra,
})

export const ROWS: TrackedBundle[] = [
  row(1),
  row(2, { size: '50', stuck: { stuck: true, workingHours: 6.4, limitHours: 4 }, since: at(28, 16, 5), lastScan: { at: at(28, 16, 5), operation: CUT, station: null }, operation: CUT, next: BACK }),
  row(3, { place: 'CUTTING', operation: null, next: CUT, lastScan: null, size: '54', part: 'Maniche', quantity: 8 }),
  row(4, { place: 'QUALITY', qualityReason: 'HOLD', next: null, replacedCodes: ['BN-000040'] }),
  row(5, { place: 'QUALITY', qualityReason: 'REWORK', next: null, colourwayCode: 'RED', colourwayName: 'Rosso' }),
  row(6, { place: 'SUBCONTRACTOR', subcontract: { orderId: uid('6161', 1), number: 'SC-00007' }, next: null }),
  row(7, { place: 'FINISHED', operation: SLEEVE, next: null }),
  row(8, { status: 'VOID', place: 'VOID', operation: null, next: null, lastScan: null, voidedAt: at(28, 16, 30), workOrder: { id: uid('9191', 2), number: 'WO-00009', status: 'COMPLETED' } }),
]

export const TILES: BundleTiles = { active: 42, stuck: 3, stuckLimitHours: 4, ticketsReplacedToday: 2, onHold: 1, atSubcontractor: 6, capped: false, asOf: at(29, 9, 42) }

const LINE = { id: uid('1212', 1), code: 'L-1', name: 'Linea cucito 1' }
const SITES = (checks: FindingsSummary['sites'][number]['checks']): FindingsSummary['sites'] => [{ id: SITE, code: 'STAB-N', name: 'Stabilimento Demo Nord', checks }]

export const SUMMARY: FindingsSummary = {
  days: 7,
  sites: SITES('ON'),
  rows: [
    { line: LINE, operation: { code: 'SCHIENA', name: 'Assemblaggio schiena' }, kind: 'BUNCHED_AT_SHIFT_END', open: 4, reviewed: 1, dismissed: 0 },
    { line: LINE, operation: { code: 'MANICHE', name: 'Montaggio maniche' }, kind: 'GAP_BELOW_STANDARD', open: 2, reviewed: 0, dismissed: 1 },
    { line: null, operation: null, kind: 'MOVED_NOT_SCANNED', open: 1, reviewed: 0, dismissed: 0 },
  ],
  asOf: at(29, 9, 42),
}

const finding = (n: number, extra: Partial<Finding> = {}): Finding => ({
  id: uid('1313', n),
  siteId: SITE,
  kind: 'BUNCHED_AT_SHIFT_END',
  status: 'OPEN',
  bundle: { id: uid('7171', n), code: `BN-${String(n).padStart(6, '0')}`, quantity: 10, part: null },
  workOrder: { id: uid('9191', 1), number: 'WO-00012' },
  operation: BACK,
  line: LINE,
  windowStart: at(28, 16, 50),
  windowEnd: at(28, 17, 15),
  seen: { shiftEnd: at(28, 17, 0), windowMinutes: 30, scansInTheBurst: 7, scansOfThisBundle: 1 },
  reviewedAt: null,
  reviewNote: null,
  version: 1,
  createdAt: at(28, 18, 25),
  ...extra,
})

export const FINDINGS: Finding[] = [finding(1), finding(2), finding(3, { status: 'REVIEWED', reviewedAt: at(29, 8, 0) }), finding(4, { status: 'DISMISSED', reviewedAt: at(29, 8, 5), reviewNote: 'Cambio turno anticipato' })]

const dialog = (over: Partial<FindingsDialog> = {}): FindingsDialog => ({ ask: { kind: 'BUNCHED_AT_SHIFT_END', lineId: LINE.id, operationCode: 'SCHIENA' }, rows: { items: FINDINGS, more: false, problem: null }, busy: false, notice: null, dismiss: null, who: null, ...over })

/** Two made-up names, inside one finding's dialog only. */
const ANSWER: WhoAnswer = {
  finding: { id: FINDINGS[0]!.id, kind: 'BUNCHED_AT_SHIFT_END', windowStart: at(28, 16, 50), windowEnd: at(28, 17, 15) },
  purpose: 'TALK_WITH_THE_WORKER',
  logged: true,
  scans: [
    { id: uid('1414', 1), kind: 'REPORT', at: at(28, 16, 58), operation: BACK, good: 10, scrap: 0, rework: 0, worker: { id: uid('1515', 1), name: 'Bea Esempio' }, station: STATION },
    { id: uid('1414', 2), kind: 'UNDO', at: at(28, 17, 2), operation: BACK, good: 0, scrap: 0, rework: 0, worker: { id: uid('1515', 2), name: 'Carlo Prova' }, station: STATION },
  ],
}
const WHO = { finding: FINDINGS[0]!, basis: { kind: 'UNION_AGREEMENT', reference: 'Accordo demo 2026/14', recordedAt: at(1, 9) }, busy: false, problem: null, answer: null }

const REPRINT: ReprintRun = { rows: ROWS.slice(0, 2).map((entry) => ({ id: entry.id, code: entry.code })), printers: { value: { printers: [{ id: uid('8383', 1), code: 'LBL-01', name: 'Etichette taglio' }], defaultPrinterId: uid('8383', 1) }, problem: null }, running: false, done: false, results: {} }

interface Case {
  role: Role
  list: BundlesModel
}

const base = (role: Role, over: Partial<BundlesModel> = {}): Case => ({
  role,
  list: { prefix: PREFIX, can: bundlesCanAs(role), view: 'active', q: '', rows: { items: ROWS.slice(0, 6), more: false, problem: null }, tiles: TILES, asOf: at(29, 9, 42), live: 'live', updates: 0, notice: null, summary: { value: SUMMARY, problem: null }, findings: null, reprint: null, ...over },
})

function BundlesDesign({ model }: { model: Case }) {
  return inShell('/production/bundles', createElement(BundlesView, { model: model.list }), SHELL[model.role])
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-259',
  title: 'Bundles (Production › Cutting room)',
  view: BundlesDesign,
  cases: [
    { id: 'active', label: 'Production manager: the active bundles, the tiles, the scan-pattern counts, live', model: base('manager'), note: 'Tick rows: the toolbar swaps to Export N and Reprint N. Press a tile: its rows. A count in the checks opens the bundles behind it, never the people.' },
    { id: 'stuck', label: 'The “No scan for 4 h” tile pressed (`?stuck=true`, the address Floor now links to)', model: base('manager', { view: 'stuck', rows: { items: [ROWS[1]!], more: false, problem: null } }) },
    { id: 'line', label: 'On the line (`?place=LINE`, the address Floor now’s heat map links to)', model: base('manager', { view: 'line', rows: { items: ROWS.slice(0, 2), more: false, problem: null } }) },
    { id: 'on-hold', label: 'The On hold tile pressed: holds only, rework stays out', model: base('manager', { view: 'onHold', rows: { items: ROWS.slice(3, 5), more: false, problem: null } }) },
    { id: 'all', label: 'Owner: every bundle, void and finished too', model: base('owner', { view: 'all', rows: { items: ROWS, more: false, problem: null } }) },
    { id: 'selected', label: 'Two bundles selected: Reprint 2 tickets can go', model: base('manager', { selected: ROWS.slice(0, 2).map((entry) => entry.id) }) },
    { id: 'selected-void', label: 'A void bundle selected: Reprint is held with the reason', model: base('manager', { view: 'all', rows: { items: ROWS, more: false, problem: null }, selected: [ROWS[0]!.id, ROWS[7]!.id] }) },
    { id: 'reprint', label: 'Reprint 2 tickets: why, the printer, or a PDF in the browser', model: base('manager', { selected: ROWS.slice(0, 2).map((entry) => entry.id), reprint: REPRINT }) },
    { id: 'reprint-done', label: 'Reprint 2 tickets: one new code, one refused in words', model: base('manager', { reprint: { ...REPRINT, done: true, results: { [ROWS[0]!.id]: { state: 'done', code: 'BN-000120', pdf: true }, [ROWS[1]!.id]: { state: 'failed', words: { key: 'production:refusal.bundle.VOIDED' } } } } }) },
    { id: 'no-print-right', label: 'Team leader: reads and voids, Reprint held without print.labels', model: base('supervisor', { can: { ...bundlesCanAs('supervisor'), printLabels: false }, selected: [ROWS[0]!.id] }) },
    { id: 'live-updates', label: 'Live: 3 changes wait behind Show (rows never move under the cursor)', model: base('manager', { updates: 3 }) },
    { id: 'more', label: 'More pages: Show 50 more in the footer', model: base('manager', { rows: { items: ROWS.slice(0, 6), more: true, problem: null } }) },
    { id: 'no-match', label: 'A scan that matches nothing: Clear filters', model: base('manager', { q: 'BN-999999', rows: { items: [], more: false, problem: null } }) },
    { id: 'empty', label: 'No bundles yet', model: base('manager', { rows: { items: [], more: false, problem: null }, tiles: { ...TILES, active: 0, stuck: 0, ticketsReplacedToday: 0, onHold: 0, atSubcontractor: 0 }, summary: { value: { ...SUMMARY, rows: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: base('manager', { rows: { items: null, more: false, problem: null }, tiles: null, asOf: null, live: 'connecting', summary: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed: in words, with Try again (never drawn as empty)', model: base('manager', { rows: { items: null, more: false, problem: 'error.offline' }, tiles: null, live: 'offline', summary: { value: null, problem: 'error.offline' } }) },
    { id: 'no-permission', label: 'No permission: the page names production.bundles.view', model: base('manager', { can: { ...bundlesCanAs('manager'), view: false } }) },
    { id: 'capped', label: 'More bundles than one read follows: said above the tiles', model: base('owner', { tiles: { ...TILES, capped: true } }) },
    { id: 'checks-station', label: 'Checks: this site records stations, not people', model: base('manager', { summary: { value: { ...SUMMARY, rows: [], sites: SITES('STATION_SITE') }, problem: null } }) },
    { id: 'checks-basis', label: 'Checks: no legal basis on record', model: base('manager', { summary: { value: { ...SUMMARY, rows: [], sites: SITES('NO_BASIS') }, problem: null } }) },
    { id: 'checks-off', label: 'Checks: the performance purpose is off (past findings stay readable)', model: base('manager', { summary: { value: { ...SUMMARY, sites: SITES('GATE_CLOSED') }, problem: null } }) },
    { id: 'checks-none', label: 'Checks on, nothing found', model: base('manager', { summary: { value: { ...SUMMARY, rows: [] }, problem: null } }) },
    { id: 'findings', label: 'A count pressed: the bundles behind it (owner: Show who offered in ⋯)', model: base('owner', { findings: dialog() }) },
    { id: 'findings-manager', label: 'Production manager: reviews; Show who held, it is the owner’s', model: base('manager', { findings: dialog() }) },
    { id: 'findings-reader', label: 'Read-only: the review held with its permission', model: base('reader', { findings: dialog() }) },
    { id: 'findings-gate', label: 'Owner, the purpose off: Show who held with the reason', model: base('owner', { summary: { value: { ...SUMMARY, sites: SITES('GATE_CLOSED') }, problem: null }, findings: dialog() }) },
    { id: 'findings-error', label: 'The findings could not be read', model: base('owner', { findings: dialog({ rows: { items: null, more: false, problem: 'error.offline' } }) }) },
    { id: 'dismiss', label: 'Dismiss a finding: a dismissal says why', model: base('manager', { findings: dialog({ dismiss: FINDINGS[0]! }) }) },
    { id: 'who', label: 'Show who: the purpose is required, the basis on record, “This view is logged”', model: base('owner', { findings: dialog({ who: WHO }) }) },
    { id: 'who-purpose', label: 'Show who: a purpose chosen', model: base('owner', { whoPurpose: 'WORKER_ASKED', findings: dialog({ who: WHO }) }) },
    { id: 'who-refused', label: 'Show who: the purpose was switched off meanwhile (409, in words)', model: base('owner', { whoPurpose: 'PAY_QUERY', findings: dialog({ who: { ...WHO, problem: { key: 'checks.GATE_CLOSED' } } }) }) },
    { id: 'who-answer', label: 'Show who: the scans of this one bundle in the window, with the names; gone when it closes', model: base('owner', { findings: dialog({ who: { ...WHO, answer: ANSWER } }) }) },
    { id: 'help', label: '? the keys of this list', model: base('manager', { helpOpen: true }) },
  ],
})
