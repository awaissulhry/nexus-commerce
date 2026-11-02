import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_SITES, DEMO_TAG, DEMO_USER } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { scopeOf } from '../../../shell/scope/scope-model'
import type { BlockRecord, CorrectionRequest, DailySheet, DayRecord, Dispute, InboxItem, LabourCounts, LabourEdit, LabourRecord, LineDay, OffStandardCode } from './api'
import { addressOf, labourCanOf, legalRowOf, type AnswerDraft, type ItemRecord, type LabourAddress, type LegalRow } from './model'
import { LabourView, type LabourModel } from './view/LabourView'

/**
 * Design cases of SCR-139 — Production › Floor control › Labour & corrections (B-W2b-57; design production.labour) and the
 * shared made-up data of SCR-143 (one inbox). Made-up data only: an invented site, lines L1 and L2, stations SEW-01 and QC-01,
 * an invented operator ("Marta Esempio") named inside one record only, at a site whose legal gate is on, an invented team
 * leader ("Giulia Esempio") and an invented basis ("Accordo RSU demo n. 12"). Roles from factory-domain's templates: the
 * production manager, the floor supervisor, read-only, sales (no permission) and a made-up HR role.
 */

export const PREFIX = '/w/DEMO'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const NOW = Date.UTC(2026, 10, 18, 9, 40)
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const SITE = DEMO_SITES[0]
const L1 = { id: uid('3232', 1), code: 'L1', name: 'Linea 1 · Giacche' }
const L2 = { id: uid('3232', 2), code: 'L2', name: 'Linea 2 · Pantaloni' }
const SEW1 = { id: uid('3333', 1), code: 'SEW-01', name: 'Cucitura 1' }
const LEAD = { id: uid('3434', 1), name: 'Giulia Esempio' }
const WORKER = { id: uid('3434', 2), name: 'Marta Esempio' }
const EMPLOYEE = uid('3434', 3)
const WO = { id: uid('3535', 1), number: 'WO-00042' }
const BUNDLE = { id: uid('3636', 1), code: 'BN-000123' }
const OP = { id: uid('3737', 1), seq: 20, code: 'SEW', name: 'Cucitura maniche' }

function item(n: number, over: Partial<InboxItem> & Pick<InboxItem, 'kind'>): InboxItem {
  return {
    id: uid('3838', n),
    version: 1,
    siteId: SITE.id,
    line: L1,
    workDate: '2026-11-17',
    workOrder: null,
    bundle: null,
    operation: null,
    changes: [],
    code: null,
    minutes: null,
    recordType: null,
    recordId: null,
    unusual: [],
    named: true,
    raisedAt: ago(60),
    ageMinutes: 60,
    ...over,
  }
}

export const CORRECTION = item(1, { kind: 'CORRECTION', workOrder: WO, bundle: BUNDLE, operation: OP, changes: [{ field: 'good', from: 12, to: 10 }, { field: 'scrap', from: 0, to: 2 }], recordType: 'OperationScan', recordId: uid('3939', 1), raisedAt: ago(1560), ageMinutes: 1560 })
export const DISPUTE_BLOCK = item(2, { kind: 'DISPUTE', line: L2, code: 'WRONG_TIME', recordType: 'OffStandardEntry', recordId: uid('4040', 1), raisedAt: ago(320), ageMinutes: 320 })
export const DISPUTE_REPORT = item(3, { kind: 'DISPUTE', code: 'WRONG_QUANTITY', recordType: 'OperationScan', recordId: uid('3939', 1), raisedAt: ago(200), ageMinutes: 200 })
export const BLOCK_NORMAL = item(4, { kind: 'OFF_STANDARD', code: 'WAIT_MATERIAL', minutes: 25, recordType: 'OffStandardEntry', recordId: uid('3838', 4), raisedAt: ago(180), ageMinutes: 180 })
export const BLOCK_NORMAL_2 = item(5, { kind: 'OFF_STANDARD', code: 'CLEANING', minutes: 15, recordType: 'OffStandardEntry', recordId: uid('3838', 5), raisedAt: ago(150), ageMinutes: 150 })
export const BLOCK_LONG = item(6, { kind: 'OFF_STANDARD', line: L2, code: 'TRAINING', minutes: 95, unusual: ['LONG', 'TYPED_AFTERWARDS'], recordType: 'OffStandardEntry', recordId: uid('3838', 6), raisedAt: ago(120), ageMinutes: 120 })
const DAY_ID = `${L1.id}:2026-11-16`
export const DAY_READY = item(7, { kind: 'LINE_DAY', id: DAY_ID, version: null, workDate: '2026-11-16', recordType: 'LabourDay', named: false, raisedAt: ago(2020), ageMinutes: 3000 })

export const ITEMS: readonly InboxItem[] = [DAY_READY, CORRECTION, DISPUTE_BLOCK, DISPUTE_REPORT, BLOCK_NORMAL, BLOCK_NORMAL_2, BLOCK_LONG]
export const BLOCKS: readonly InboxItem[] = [BLOCK_NORMAL, BLOCK_NORMAL_2, BLOCK_LONG]

export const COUNTS: LabourCounts = { corrections: 1, disputes: 2, offStandard: 3, lineDays: 1, heldDays: 2 }

function day(over: Partial<LineDay> & Pick<LineDay, 'line' | 'workDate' | 'state'>): LineDay {
  return { labourDayId: null, version: null, siteId: SITE.id, offStandard: { coded: true, left: 0 }, anomalies: 0, blockers: [], records: 42, closedAt: null, closedBy: null, reopenedAt: null, reopenedBy: null, reopenReason: null, note: null, ...over }
}

const DAYS: readonly LineDay[] = [
  day({ line: L1, workDate: '2026-11-17', state: 'OPEN', offStandard: { coded: false, left: 3 }, anomalies: 2, blockers: [{ kind: 'OFF_STANDARD_WAITING', count: 3 }, { kind: 'CORRECTION_WAITING', count: 1 }, { kind: 'DISPUTE_OPEN', count: 1 }] }),
  day({ line: L2, workDate: '2026-11-17', state: 'OPEN', offStandard: { coded: false, left: 1 }, anomalies: 1, blockers: [{ kind: 'OFF_STANDARD_RUNNING', count: 1 }, { kind: 'ATTENDANCE_ANOMALY', count: 1 }] }),
  day({ line: L1, workDate: '2026-11-16', state: 'READY' }),
  day({ line: L2, workDate: '2026-11-13', state: 'CLOSED', labourDayId: uid('4141', 1), version: 2, closedAt: ago(5000), closedBy: LEAD }),
]

const EDITS: readonly LabourEdit[] = [
  { id: uid('4242', 1), kind: 'LABOUR_EDIT', at: ago(30), siteId: SITE.id, line: L2, workDate: '2026-11-17', recordType: 'OffStandardEntry', recordId: uid('4040', 1), changes: [{ field: 'endedAt', from: '2026-11-17T10:00:00.000Z', to: '2026-11-17T09:30:00.000Z' }], by: LEAD, reason: 'Contestazione accolta: finito alle 10:30.', disputeId: uid('3838', 2), named: true },
  { id: uid('4242', 2), kind: 'SCAN_CORRECTION', at: ago(400), siteId: SITE.id, line: L1, workDate: '2026-11-16', recordType: 'OperationScan', recordId: uid('3939', 2), changes: [{ field: 'good', from: 20, to: 19 }, { field: 'scrap', from: 0, to: 1 }], by: LEAD, reason: 'Un capo scartato al controllo.', disputeId: null, named: true },
  { id: uid('4242', 3), kind: 'CLOCK_EDIT', at: ago(900), siteId: SITE.id, line: null, workDate: '2026-11-16', recordType: 'ClockEvent', recordId: uid('4343', 1), changes: [{ field: 'clock', from: 'IN 2026-11-16T07:02:00.000Z', to: null }], by: LEAD, reason: 'Timbratura doppia.', disputeId: null, named: true },
]

export const CODES: readonly OffStandardCode[] = [
  { id: uid('4444', 1), code: 'WAIT_MATERIAL', kind: 'OFF_STANDARD', active: true, labelIt: 'Attesa materiale', labelEn: 'Waiting for material', labelI18n: {} },
  { id: uid('4444', 2), code: 'CLEANING', kind: 'INDIRECT', active: true, labelIt: 'Pulizia', labelEn: 'Cleaning', labelI18n: {} },
  { id: uid('4444', 3), code: 'TRAINING', kind: 'INDIRECT', active: true, labelIt: 'Formazione', labelEn: 'Training', labelI18n: {} },
]

const LEGAL_BASIS = { kind: 'UNION_AGREEMENT', reference: 'Accordo RSU demo n. 12', recordedAt: '2026-03-03T09:00:00.000Z', recordedByName: 'Alex Demo' }
const GATE_ON = { open: true, leadsSeeFigures: false }
const GATE_OFF = { open: false, leadsSeeFigures: false }
export const LEGAL = {
  basis: [legalRowOf(SITE, { scanSubject: 'WORKER', legalBasis: LEGAL_BASIS }, GATE_ON)],
  leads: [legalRowOf(SITE, { scanSubject: 'WORKER', legalBasis: LEGAL_BASIS }, { open: true, leadsSeeFigures: true })],
  on: [legalRowOf(SITE, null, GATE_ON)],
  off: [legalRowOf(SITE, { scanSubject: 'WORKER', legalBasis: null }, GATE_OFF)],
  station: [legalRowOf(SITE, { scanSubject: 'STATION', legalBasis: null }, GATE_OFF)],
  unknown: [legalRowOf(SITE, null, null)],
  sites: [legalRowOf(DEMO_SITES[0], { scanSubject: 'WORKER', legalBasis: LEGAL_BASIS }, GATE_ON), legalRowOf(DEMO_SITES[1], { scanSubject: 'STATION', legalBasis: null }, GATE_OFF)],
} satisfies Record<string, readonly LegalRow[]>

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
export const ROLES = {
  // B-W2b-73: a made-up custom role: decides scan corrections, keeps no labour records.
  correctOnly: ['home.view', 'production.scan.correct'],
  production: template('production_manager'),
  supervisor: template('floor_supervisor'),
  readOnly: template('read_only'),
  sales: template('sales'),
  hr: ['home.view', 'production.labour.view', 'production.settings.view', 'people.view', 'people.figures.view'],
}
export type Role = keyof typeof ROLES

export interface LabourCase {
  role: Role
  model: LabourModel
}

const SCOPE = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, everySite: true, chosen: SITE.id })
const ALL_SITES = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, everySite: true, chosen: null })

export function base(role: Role, over: Partial<LabourModel> = {}, address: Partial<LabourAddress> = {}): LabourCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: labourCanOf(ROLES[role]),
      address: { ...addressOf(null), ...address },
      scope: SCOPE,
      timeZone: 'Europe/Rome',
      today: '2026-11-18',
      legal: LEGAL.basis,
      counts: COUNTS,
      blocks: { pending: 3, normal: 2, unusual: 1, running: 1 },
      rows: { items: ITEMS, more: false, limitReached: false, problem: null },
      updates: 0,
      days: { items: DAYS, from: '2026-11-12', to: '2026-11-18', problem: null },
      edits: { items: EDITS, from: '2026-11-05', to: '2026-11-18', more: false, limitReached: false, problem: null },
      lines: [L1, L2],
      codes: CODES,
      asOf: new Date(NOW).toISOString(),
      live: 'live',
      announcement: null,
      busy: false,
      notice: null,
      detail: null,
      dialog: null,
      payrollHref: null,
      now: NOW,
      ...over,
    },
  }
}

export const keyOf = (entry: Pick<InboxItem, 'kind' | 'id'>) => `${entry.kind}:${entry.id}`
export const ready = (entry: Pick<InboxItem, 'kind' | 'id'>, value: ItemRecord): LabourModel['detail'] => ({ key: keyOf(entry), loaded: { status: 'ready', value } })

const RECORD: LabourRecord = {
  scanId: uid('3939', 1),
  state: 'STANDING',
  siteId: SITE.id,
  workDate: '2026-11-17',
  at: ago(1600),
  workOrder: WO,
  bundle: BUNDLE,
  operation: { ...OP, standardMinutes: '1.500' },
  line: L1,
  station: SEW1,
  reported: { good: 12, scrap: 0, rework: 0 },
  counts: { good: 12, scrap: 0, rework: 0 },
  earnedMinutes: '18.000',
  steps: [],
  worker: WORKER,
  employeeId: EMPLOYEE,
  workerHidden: false,
  enteredByLead: false,
  disputes: [],
  correctionsWaiting: 1,
}
const HIDDEN: Pick<LabourRecord, 'worker' | 'employeeId' | 'workerHidden'> = { worker: null, employeeId: null, workerHidden: true }
const REQUEST: CorrectionRequest = {
  id: CORRECTION.id,
  status: 'PENDING',
  workOrderId: WO.id,
  bundleId: BUNDLE.id,
  scanId: uid('3939', 1),
  goodQuantity: 10,
  scrapQuantity: 2,
  reworkQuantity: 0,
  reason: 'Due capi avevano la cucitura aperta.',
  serverTime: ago(1560),
  decisionNote: null,
  bundleCode: BUNDLE.code,
  operation: OP,
  workOrder: WO,
  recorded: { goodQuantity: 12, scrapQuantity: 0, reworkQuantity: 0, serverTime: ago(1600) },
  askedAt: SEW1,
}
const AROUND = [
  { id: uid('3939', 4), kind: 'REPORT', operation: { id: uid('3737', 2), seq: 10, code: 'CUT', name: 'Preparazione' }, goodQuantity: 12, scrapQuantity: 0, reworkQuantity: 0, serverTime: ago(2000), station: { id: uid('3333', 2), code: 'PRP-01', name: 'Preparazione 1' }, voidedById: null },
  { id: uid('3939', 1), kind: 'REPORT', operation: OP, goodQuantity: 12, scrapQuantity: 0, reworkQuantity: 0, serverTime: ago(1600), station: SEW1, voidedById: null },
]
export const CORRECTION_RECORD: ItemRecord = { kind: 'CORRECTION', request: REQUEST, record: RECORD, around: AROUND }
const CORRECTION_HIDDEN: ItemRecord = { kind: 'CORRECTION', request: REQUEST, record: { ...RECORD, ...HIDDEN }, around: AROUND }
const CORRECTION_LEAD: ItemRecord = { kind: 'CORRECTION', request: REQUEST, record: { ...RECORD, ...HIDDEN, enteredByLead: true, steps: [{ scanId: uid('3939', 5), kind: 'CORRECTION', at: ago(1580), counts: { good: 11, scrap: 1, rework: 0 }, approvedBy: LEAD, reason: 'Prima rettifica.' }] }, around: null }

const DISPUTE_ON_BLOCK: Dispute = {
  id: DISPUTE_BLOCK.id,
  version: 1,
  siteId: SITE.id,
  line: L2,
  workDate: '2026-11-17',
  recordType: 'OffStandardEntry',
  recordId: uid('4040', 1),
  reason: 'WRONG_TIME',
  words: 'Ho finito prima delle 10:30.',
  status: 'OPEN',
  answer: null,
  answeredAt: null,
  answeredBy: null,
  withdrawnAt: null,
  raisedAt: ago(320),
  raisedOn: 'FLOOR',
  worker: WORKER,
  employeeId: EMPLOYEE,
  workerHidden: false,
  record: { label: 'WAIT_MATERIAL · Attesa materiale', counts: null, code: 'WAIT_MATERIAL', startedAt: '2026-11-17T08:30:00.000Z', endedAt: '2026-11-17T10:00:00.000Z', minutes: 90, status: 'APPROVED', version: 3 },
  edits: [],
  canAnswer: true,
  own: false,
}
export const DISPUTE_RECORD: ItemRecord = { kind: 'DISPUTE', dispute: DISPUTE_ON_BLOCK }
const DISPUTE_ON_REPORT: ItemRecord = { kind: 'DISPUTE', dispute: { ...DISPUTE_ON_BLOCK, id: DISPUTE_REPORT.id, line: L1, recordType: 'OperationScan', recordId: uid('3939', 1), reason: 'WRONG_QUANTITY', words: 'Erano dieci, non dodici.', ...HIDDEN, record: { label: 'BN-000123 · 20 SEW', counts: { good: 12, scrap: 0, rework: 0 }, code: null, startedAt: null, endedAt: null, minutes: null, status: 'STANDING', version: null } } }
const DISPUTE_OWN: ItemRecord = { kind: 'DISPUTE', dispute: { ...DISPUTE_ON_BLOCK, own: true, canAnswer: false } }
const DISPUTE_DONE: ItemRecord = {
  kind: 'DISPUTE',
  dispute: { ...DISPUTE_ON_BLOCK, status: 'UPHELD', canAnswer: false, answer: 'Corretto: il blocco finisce alle 10:30.', answeredAt: ago(30), answeredBy: LEAD, edits: [{ id: uid('4242', 1), at: ago(30), by: LEAD, reason: 'Contestazione accolta.', changes: [{ field: 'endedAt', from: '2026-11-17T10:00:00.000Z', to: '2026-11-17T09:30:00.000Z' }] }] },
}

export const BLOCK_RECORD: BlockRecord = {
  id: BLOCK_NORMAL.id,
  version: 1,
  siteId: SITE.id,
  line: L1,
  station: SEW1,
  code: { id: CODES[0]!.id, code: 'WAIT_MATERIAL', kind: 'OFF_STANDARD', labelIt: 'Attesa materiale', labelEn: 'Waiting for material', labelI18n: {} },
  source: 'FLOOR',
  status: 'PENDING',
  workDate: '2026-11-17',
  startedAt: '2026-11-17T08:00:00.000Z',
  endedAt: '2026-11-17T08:25:00.000Z',
  minutes: 25,
  named: true,
  unusual: [],
  worker: WORKER,
  workerHidden: false,
  note: null,
  approvedAt: null,
  approvedBy: null,
  approvedByHidden: false,
  rejectedAt: null,
  rejectedBy: null,
  rejectedByHidden: false,
  rejectReason: null,
  edits: [],
  canDecide: true,
  own: false,
}

const DAY_HISTORY = [
  { id: uid('4545', 1), change: 'CLOSED' as const, at: ago(6000), by: LEAD, reason: null },
  { id: uid('4545', 2), change: 'REOPENED' as const, at: ago(5500), by: { id: uid('3434', 4), name: 'Alex Demo' }, reason: 'Manca un blocco di formazione.' },
  { id: uid('4545', 3), change: 'CLOSED' as const, at: ago(5000), by: LEAD, reason: null },
]
const dayRecord = (source: LineDay, over: Partial<DayRecord> = {}): DayRecord => ({ ...source, history: [], canClose: source.state === 'READY', canReopen: source.state === 'CLOSED', ...over })

const SHEET: DailySheet = {
  person: { employeeId: EMPLOYEE, name: WORKER.name },
  siteId: SITE.id,
  workDate: '2026-11-17',
  as: 'FIGURE_ROLE',
  sheet: {
    pieces: { good: 112, scrap: 2, rework: 1 },
    records: 4,
    productionMinutes: '168.000',
    offStandard: { minutes: 40, byCode: [{ codeId: CODES[0]!.id, code: 'WAIT_MATERIAL', kind: 'OFF_STANDARD', minutes: 25, blocks: 1 }, { codeId: CODES[1]!.id, code: 'CLEANING', kind: 'INDIRECT', minutes: 15, blocks: 1 }] },
    attendance: { status: 'OPEN', presentMinutes: 480, breakMinutes: 30, ordinaryMinutes: 450, overtimeMinutes: 0, absenceMinutes: 0 },
    exceptions: [{ kind: 'CORRECTION_WAITING', count: 1 }, { kind: 'DISPUTE_OPEN', count: 1 }],
  },
  records: [{ scanId: uid('3939', 1), at: ago(1600), workOrder: WO, bundle: BUNDLE, operation: OP, line: L1, state: 'STANDING', counts: { good: 12, scrap: 0, rework: 0 }, earnedMinutes: '18.000' }],
  edits: [{ id: uid('4242', 1), at: ago(30), recordType: 'OffStandardEntry', changes: [{ field: 'endedAt', from: '2026-11-17T10:00:00.000Z', to: '2026-11-17T09:30:00.000Z' }], reason: 'Contestazione accolta.' }],
  attendanceShown: true,
}
const PERSON = { employeeId: EMPLOYEE, name: WORKER.name }
const sheetCase = (over: Partial<Extract<NonNullable<LabourModel['dialog']>, { kind: 'sheet' }>> = {}): NonNullable<LabourModel['dialog']> => ({ kind: 'sheet', person: PERSON, workDate: '2026-11-17', access: { status: 'ready', value: { allowed: true, as: 'FIGURE_ROLE', refusal: null, needsReason: true } }, reason: '', note: '', sheet: null, problem: null, ...over })
const draft = (over: Partial<AnswerDraft> = {}): AnswerDraft => ({ outcome: 'UPHELD', answer: '', fix: { codeId: '', startedAt: '', endedAt: '' }, ...over })
const target = { lineId: L1.id, lineCode: 'L1', lineName: L1.name, workDate: '2026-11-16', version: null }

function shellFor(role: Role, page: ReactNode) {
  const path = '/production/labour'
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export function LabourDesign({ model }: { model: LabourCase }) {
  return shellFor(model.role, createElement(LabourView, { model: model.model }))
}

const open = (entry: InboxItem) => ({ open: keyOf(entry) })
const blockOff: ItemRecord = { kind: 'OFF_STANDARD', block: { ...BLOCK_RECORD, worker: null, workerHidden: true }, item: BLOCK_NORMAL }
const readyDay = DAYS[2]!
const heldDay = DAYS[0]!
const closedDay = DAYS[3]!

export const designScreen = defineDesignScreen<LabourCase>({
  screen: 'SCR-139',
  title: 'Labour review & corrections (Production › Floor control)',
  view: LabourDesign,
  cases: [
    { id: 'inbox', label: 'Production manager: the legal basis first, tiles, one queue, line days, the changes', model: base('production'), note: 'No name anywhere on this page: the queue says where, when and what. “raised by” is left out (a person in a list).' },
    { id: 'gate-off', label: 'Legal basis: the site’s gate is off (the default): sheets off, records never say who', model: base('production', { legal: LEGAL.off }) },
    { id: 'station-site', label: 'Legal basis: the site records stations: “Per-person sheets are off on this site”', model: base('production', { legal: LEGAL.station, rows: { items: [DAY_READY, CORRECTION], more: false, limitReached: false, problem: null }, counts: { ...COUNTS, disputes: 0, offStandard: 0 } }) },
    { id: 'leads', label: 'Legal basis: the site lets team leads see one person’s day', model: base('production', { legal: LEGAL.leads }) },
    { id: 'basis-unread', label: 'Legal basis: in force, its wording not readable by this role', model: base('hr', { legal: LEGAL.on }) },
    { id: 'basis-failed', label: 'Legal basis: the read failed: said as such, never as on or off', model: base('production', { legal: LEGAL.unknown }) },
    { id: 'basis-reading', label: 'Legal basis: being read', model: base('production', { legal: null }) },
    { id: 'all-sites', label: 'All sites in the top bar: one line per site, a Site column', model: base('production', { legal: LEGAL.sites, scope: ALL_SITES }) },
    { id: 'tile-corrections', label: 'The tile “Corrections to decide” pressed (the API’s own kind filter)', model: base('production', { rows: { items: [CORRECTION], more: false, limitReached: false, problem: null } }, { kind: 'CORRECTION' }) },
    { id: 'tile-days', label: 'The tile “Line days to close” pressed; 2 more days are held', model: base('production', { rows: { items: [DAY_READY], more: false, limitReached: false, problem: null } }, { kind: 'LINE_DAY' }) },
    { id: 'selected', label: 'Selected: Approve 2 normal blocks · Close 1 day; the long block cannot be ticked and says why', model: base('production', { selected: [keyOf(BLOCK_NORMAL), keyOf(BLOCK_NORMAL_2), keyOf(DAY_READY)] }) },
    { id: 'updates', label: 'Live: rows never move; “3 updates · Show”, the tiles already follow', model: base('production', { updates: 3, counts: { ...COUNTS, corrections: 2 } }) },
    { id: 'more', label: 'More items than one read: Show more', model: base('production', { rows: { items: ITEMS, more: true, limitReached: false, problem: null } }) },
    { id: 'correction', label: 'A correction request: the original entry, the proposed one, the scans around it; the person named (gate on)', model: base('production', { detail: ready(CORRECTION, CORRECTION_RECORD) }, open(CORRECTION)) },
    { id: 'correction-hidden', label: 'The same with the gate off: someone is on it, never who; “Open this person’s day” held', model: base('production', { detail: ready(CORRECTION, CORRECTION_HIDDEN) }, open(CORRECTION)) },
    { id: 'correction-steps', label: 'A correction of a report a lead entered, corrected once before; no right to read the scans around it', model: base('production', { detail: ready(CORRECTION, CORRECTION_LEAD) }, open(CORRECTION)) },
    { id: 'correction-read-only', label: 'Read-only: sees it, decides nothing (held, with why)', model: base('readOnly', { detail: ready(CORRECTION, CORRECTION_HIDDEN) }, open(CORRECTION)) },
    { id: 'dispute-block', label: 'A dispute of an off-standard block: their words, the record, Uphold / Reject', model: base('production', { detail: ready(DISPUTE_BLOCK, DISPUTE_RECORD) }, open(DISPUTE_BLOCK)) },
    { id: 'dispute-report', label: 'A dispute of a report (gate off: no name)', model: base('production', { detail: ready(DISPUTE_REPORT, DISPUTE_ON_REPORT) }, open(DISPUTE_REPORT)) },
    { id: 'dispute-own', label: 'A dispute of one’s own record: held, another person answers', model: base('supervisor', { detail: ready(DISPUTE_BLOCK, DISPUTE_OWN) }, open(DISPUTE_BLOCK)) },
    { id: 'dispute-answered', label: 'An answered dispute: the answer and what it changed', model: base('production', { detail: ready(DISPUTE_BLOCK, DISPUTE_DONE) }, open(DISPUTE_BLOCK)) },
    { id: 'day-ready', label: 'A line day ready to close: nothing holds it', model: base('production', { detail: ready(DAY_READY, { kind: 'LINE_DAY', day: dayRecord(readyDay) }) }, open(DAY_READY)) },
    { id: 'day-held', label: 'A line day held: what holds it, with the counts; Close day held', model: base('production', { detail: { key: `LINE_DAY:${L1.id}:2026-11-17`, loaded: { status: 'ready', value: { kind: 'LINE_DAY', day: dayRecord(heldDay) } } } }, { open: `LINE_DAY:${L1.id}:2026-11-17` }) },
    { id: 'day-closed', label: 'A closed day: its history; Reopen', model: base('production', { detail: { key: `LINE_DAY:${L2.id}:2026-11-13`, loaded: { status: 'ready', value: { kind: 'LINE_DAY', day: dayRecord(closedDay, { history: DAY_HISTORY, reopenedAt: ago(5500), reopenedBy: { id: uid('3434', 4), name: 'Alex Demo' }, reopenReason: 'Manca un blocco di formazione.' }) } } } }, { open: `LINE_DAY:${L2.id}:2026-11-13` }) },
    { id: 'day-closed-supervisor', label: 'Floor supervisor: closes a day, Reopen held (the manager’s)', model: base('supervisor', { detail: { key: `LINE_DAY:${L2.id}:2026-11-13`, loaded: { status: 'ready', value: { kind: 'LINE_DAY', day: dayRecord(closedDay, { canReopen: false }) } } } }, { open: `LINE_DAY:${L2.id}:2026-11-13` }) },
    { id: 'item-loading', label: 'The item is being read', model: base('production', { detail: { key: keyOf(CORRECTION), loaded: { status: 'loading' } } }, open(CORRECTION)) },
    { id: 'item-gone', label: 'An item that does not exist (or another site’s)', model: base('production', { detail: { key: 'CORRECTION:nothing', loaded: { status: 'notFound' } } }, { open: 'CORRECTION:nothing' }) },
    { id: 'reject', label: 'Reject: the reason is required, and reaches the person', model: base('production', { detail: ready(CORRECTION, CORRECTION_RECORD), dialog: { kind: 'reject', target: { kind: 'CORRECTION', id: CORRECTION.id, version: null, open: keyOf(CORRECTION) }, reason: '', problem: null } }, open(CORRECTION)) },
    { id: 'reject-refused', label: 'Refused: you took this scan (four eyes), in words', model: base('production', { detail: ready(CORRECTION, CORRECTION_RECORD), dialog: { kind: 'reject', target: { kind: 'CORRECTION', id: CORRECTION.id, version: null, open: keyOf(CORRECTION) }, reason: 'Non torna con il cartellino.', problem: { key: 'refusal.SELF_APPROVAL' } } }, open(CORRECTION)) },
    { id: 'answer-block', label: 'Uphold a dispute of a block: the answer in words and the block’s right time in the same step', model: base('production', { detail: ready(DISPUTE_BLOCK, DISPUTE_RECORD), dialog: { kind: 'answer', open: keyOf(DISPUTE_BLOCK), draft: draft({ answer: 'Hai ragione: finito alle 10:30.' }), problem: null } }, open(DISPUTE_BLOCK)) },
    { id: 'answer-report', label: 'Uphold a dispute of a report: it changes no count, says how a report changes', model: base('production', { detail: ready(DISPUTE_REPORT, DISPUTE_ON_REPORT), dialog: { kind: 'answer', open: keyOf(DISPUTE_REPORT), draft: draft(), problem: null } }, open(DISPUTE_REPORT)) },
    { id: 'answer-rejected', label: 'Reject a dispute: the day is closed (refused in words)', model: base('production', { detail: ready(DISPUTE_BLOCK, DISPUTE_RECORD), dialog: { kind: 'answer', open: keyOf(DISPUTE_BLOCK), draft: draft({ outcome: 'REJECTED', answer: 'Il cartellino dice le 11:00.' }), problem: { key: 'refusal.DAY_CLOSED' } } }, open(DISPUTE_BLOCK)) },
    { id: 'close', label: 'Close the day for L1: closed days feed pay; reopening needs permission and a reason', model: base('production', { dialog: { kind: 'close', days: [target], note: '', problem: null } }) },
    { id: 'close-held', label: 'Refused: something came up meanwhile (409 HELD, in words)', model: base('production', { dialog: { kind: 'close', days: [target], note: '', problem: { key: 'refusal.HELD' } } }) },
    { id: 'close-many', label: 'Close 3 days', model: base('production', { dialog: { kind: 'close', days: [target, { ...target, lineId: L2.id, lineCode: 'L2', lineName: L2.name }, { ...target, workDate: '2026-11-15' }], note: '', problem: null } }) },
    { id: 'reopen', label: 'Reopen a closed day: the reason is required', model: base('production', { dialog: { kind: 'reopen', day: { lineId: L2.id, lineCode: 'L2', lineName: L2.name, workDate: '2026-11-13', version: 2 }, reason: '', problem: null } }) },
    { id: 'sheet-reason', label: 'Daily sheet: someone else’s day takes a reason first; nothing is read yet', model: base('hr', { detail: ready(CORRECTION, CORRECTION_RECORD), dialog: sheetCase() }, open(CORRECTION)) },
    { id: 'sheet', label: 'Daily sheet: one person, one day; no percentage, no comparison, no colour judgement; “This view is logged”', model: base('hr', { detail: ready(CORRECTION, CORRECTION_RECORD), dialog: sheetCase({ reason: 'PAY_QUERY', sheet: SHEET }) }, open(CORRECTION)) },
    { id: 'sheet-no-attendance', label: 'Daily sheet: attendance not shown (the site’s attendance purpose is off)', model: base('hr', { dialog: sheetCase({ reason: 'PAY_QUERY', sheet: { ...SHEET, attendanceShown: false, sheet: { ...SHEET.sheet, attendance: null, exceptions: [] }, edits: [] } }) }) },
    { id: 'sheet-gate-off', label: 'Daily sheet refused: the gate went off since (409, in words)', model: base('hr', { dialog: sheetCase({ access: { status: 'ready', value: { allowed: false, as: null, refusal: 'GATE_CLOSED', needsReason: false } } }) }) },
    { id: 'sheet-not-allowed', label: 'Daily sheet refused: this person may not open it (403, in words)', model: base('production', { dialog: sheetCase({ access: { status: 'ready', value: { allowed: false, as: null, refusal: 'NOT_ALLOWED', needsReason: false } } }) }) },
    { id: 'sheet-reading', label: 'Daily sheet: asking whether it may open', model: base('hr', { dialog: sheetCase({ access: { status: 'loading' } }) }) },
    { id: 'find', label: 'Open a person’s day (name search): one person, one day', model: base('hr', { dialog: { kind: 'find', query: '', hits: null, person: null, workDate: '2026-11-17' } }) },
    { id: 'find-hits', label: 'Name search: a hit picked', model: base('hr', { dialog: { kind: 'find', query: 'Mart', hits: { status: 'ready', value: [{ id: EMPLOYEE, displayName: WORKER.name, employeeCode: 'E-0101' }] }, person: { id: EMPLOYEE, displayName: WORKER.name, employeeCode: 'E-0101' }, workDate: '2026-11-17' } }) },
    { id: 'find-none', label: 'Name search: nobody by that name', model: base('hr', { dialog: { kind: 'find', query: 'Zzz', hits: { status: 'ready', value: [] }, person: null, workDate: '2026-11-17' } }) },
    { id: 'decided', label: 'A decision done: the next item opens, a receipt stays', model: base('production', { notice: { tone: 'success', words: { key: 'notice.corrected' } } }) },
    { id: 'empty', label: 'Nothing to decide ✓', model: base('production', { rows: { items: [], more: false, limitReached: false, problem: null }, counts: { corrections: 0, disputes: 0, offStandard: 0, lineDays: 0, heldDays: 0 }, blocks: { pending: 0, normal: 0, unusual: 0, running: 0 }, days: { items: [], from: '2026-11-12', to: '2026-11-18', problem: null }, edits: { items: [], from: '2026-11-05', to: '2026-11-18', more: false, limitReached: false, problem: null } }) },
    { id: 'no-match', label: 'Filtered to nothing: Clear filters', model: base('production', { rows: { items: [], more: false, limitReached: false, problem: null } }, { kind: 'DISPUTE', q: 'zzz' }) },
    { id: 'supervisor', label: 'Floor supervisor: decides; Reopen held', model: base('supervisor') },
    { id: 'read-only', label: 'Read-only: reads every part, decides nothing; no selection', model: base('readOnly') },
    { id: 'hr', label: 'A made-up HR role: reads the page, opens a person’s day; decides nothing', model: base('hr', { blocks: null }) },
    { id: 'offline', label: 'The live stream is offline: the page says it is not updating', model: base('production', { live: 'offline' }) },
    { id: 'keys', label: 'The keys (the footer’s information icon, “?”)', model: base('production', { dialog: { kind: 'keys' } }) },
    { id: 'loading', label: 'Loading', model: base('production', { rows: { items: null, more: false, limitReached: false, problem: null }, counts: null, blocks: null, legal: null, days: { items: null, from: null, to: null, problem: null }, edits: { items: null, from: null, to: null, more: false, limitReached: false, problem: null }, asOf: null }) },
    { id: 'error', label: 'The reads failed: in words, Try again', model: base('production', { rows: { items: null, more: false, limitReached: false, problem: 'problem.offline' }, counts: null, days: { items: null, from: null, to: null, problem: 'problem.offline' }, edits: { items: null, from: null, to: null, more: false, limitReached: false, problem: 'problem.offline' } }) },
    { id: 'no-permission', label: 'Sales: no permission (production.labour.view)', model: base('sales') },
    { id: 'correct-only', label: 'A custom role, production.scan.correct alone: the row on Today opens that correction', model: base('correctOnly', { detail: { key: `CORRECTION:${CORRECTION.id}`, loaded: { status: 'ready', value: { ...CORRECTION_RECORD, record: null, around: null } } } }, { open: `CORRECTION:${CORRECTION.id}` }), note: 'B-W2b-73: no queue, no line days, no changes: the page reads none of them for this person.' },
    { id: 'correct-only-closed', label: 'The same role with no correction open: back to Today', model: base('correctOnly', { notice: { tone: 'success', words: { key: 'notice.corrected' } } }) },
  ],
})

export { blockOff }
