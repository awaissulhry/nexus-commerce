import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { at, COLOURS, ITEMS, LOCATIONS, LOTS, NOW, PREFIX, ROLE_PERMISSIONS, SITE, SITE_SOUTH, TIME_ZONE, uid } from '../../../_shared/stock/fixtures'
import type { CountLine, CountPlace, CountReason, CountRecord, CountRow, CountTiles, MaterialChoice } from '../api'
import { countsCan, type CountsCan } from '../model'
import type { CountRecordModel, CountsListModel, LinesPart, NewCountModel, PlaceChoice } from '../view-model'

/**
 * Made-up data for Warehouse › Counts' design cases (SCR-132, SCR-132-record): the invented company and site of the stock
 * screens ("Officina Demo", "STAB-N"), its places and materials, counts "CNT-D-0001" …, a counting team "Squadra A" and
 * people "Anna Esempio" / "Marco Prova". Nothing here is a real company, person, count or number. Design-only.
 */

export { NOW, PREFIX, SITE, SITE_SOUTH, TIME_ZONE }

// ---- roles -----------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases: the owner (everything, with costs), the warehouse (counts, approves other people's counts, applies; no
 * money), finance (sees counts, signs the year-end inventory off; has the cost grain), read-only (sees, changes nothing,
 * no money) and sales (no counts page: the page names the permission).
 */
export const COUNT_ROLES = {
  owner: [...ROLE_PERMISSIONS.owner, 'inventory.counts.view', 'inventory.counts.manage', 'inventory.counts.approve', 'inventory.counts.signoff', 'files.read'],
  warehouse: template('warehouse'),
  finance: [...template('finance'), 'money.cost'],
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type CountRole = keyof typeof COUNT_ROLES
export const canAs = (role: CountRole): CountsCan => countsCan(COUNT_ROLES[role])

export function inShell(path: string, page: ReactNode, role: CountRole): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...COUNT_ROLES[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export const PEOPLE = { anna: 'Anna Esempio', marco: 'Marco Prova', lucia: 'Lucia Demo' }
export const SITES = [SITE, SITE_SOUTH].map((site) => ({ id: site.id, code: site.code, name: site.name }))
export const PLACES: PlaceChoice[] = [LOCATIONS.store, LOCATIONS.rackA, LOCATIONS.binA1, LOCATIONS.binA2, LOCATIONS.receiving, LOCATIONS.quarantine, LOCATIONS.cutting].map((place) => ({
  id: place.id,
  code: place.code,
  name: place.name,
  depth: place.depth,
}))

export const REASONS: CountReason[] = [
  { code: 'COUNT_ERROR', labelIt: 'Errore di conteggio precedente', labelEn: 'Earlier count error', needsDetail: false },
  { code: 'DAMAGED', labelIt: 'Danneggiato', labelEn: 'Damaged', needsDetail: false },
  { code: 'MISPLACED', labelIt: 'Ubicazione sbagliata', labelEn: 'In the wrong place', needsDetail: false },
  { code: 'NOT_RECORDED', labelIt: 'Movimento non registrato', labelEn: 'Move not recorded', needsDetail: true },
  { code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true },
]

// ---- counts ------------------------------------------------------------------------------------------------------------------

const yes = { allowed: true, reason: null }
const no = (reason: string) => ({ allowed: false, reason })

export function countRow(n: number, over: Partial<CountRow> = {}): CountRow {
  return {
    id: uid('5151', n),
    number: `CNT-D-${String(n).padStart(4, '0')}`,
    kind: 'CYCLE',
    status: 'COUNTING',
    companyId: SITE.companyId,
    site: { id: SITE.id, code: SITE.code, name: SITE.name },
    scope: { location: { id: LOCATIONS.rackA.id, code: LOCATIONS.rackA.code, name: LOCATIONS.rackA.name, path: 'N-MAG / N-MAG-A' }, item: null, lot: null, itemKind: null },
    inventoryDate: null,
    countTeam: 'Squadra A',
    note: null,
    startedAt: at(28, 8, 10),
    snapshotAt: at(28, 8, 10),
    submittedAt: null,
    approvalRequired: null,
    differenceAmount: null,
    currency: 'EUR',
    approvedAt: null,
    approvalNote: null,
    rejectedAt: null,
    rejectReason: null,
    appliedAt: null,
    signedOffAt: null,
    valuedList: null,
    cancelledAt: null,
    cancelReason: null,
    lines: { all: 120, counted: 84, differing: 7 },
    version: 4,
    createdAt: at(27, 16),
    updatedAt: at(30, 9, 30),
    ...over,
  }
}

const leatherScope = { location: null, item: null, lot: null, itemKind: 'LEATHER' as const }
export const COUNT_ROWS: CountRow[] = [
  countRow(1),
  countRow(2, { status: 'SUBMITTED', approvalRequired: true, submittedAt: at(29, 17), differenceAmount: 128_450, lines: { all: 46, counted: 46, differing: 9 }, countTeam: 'Squadra B', scope: leatherScope }),
  countRow(3, { status: 'SUBMITTED', approvalRequired: false, submittedAt: at(29, 11), differenceAmount: 3_120, lines: { all: 18, counted: 18, differing: 2 }, scope: { location: null, item: { id: ITEMS.zip.id, code: ITEMS.zip.code, name: ITEMS.zip.name }, lot: null, itemKind: null } }),
  countRow(4, { status: 'DRAFT', startedAt: null, snapshotAt: null, lines: { all: 0, counted: 0, differing: 0 }, countTeam: null, scope: { location: { id: LOCATIONS.quarantine.id, code: LOCATIONS.quarantine.code, name: LOCATIONS.quarantine.name, path: 'N-QUA' }, item: null, lot: null, itemKind: null } }),
  countRow(5, {
    kind: 'YEAR_END',
    number: 'CNT-D-0005',
    status: 'DRAFT',
    inventoryDate: '2026-12-31',
    startedAt: null,
    snapshotAt: null,
    lines: { all: 0, counted: 0, differing: 0 },
    countTeam: 'Tutto il magazzino',
    scope: { location: null, item: null, lot: null, itemKind: null },
  }),
  countRow(6, { status: 'APPROVED', approvalRequired: true, submittedAt: at(24, 12), approvedAt: at(24, 15), differenceAmount: 61_200, lines: { all: 60, counted: 60, differing: 4 }, scope: { location: null, item: { id: ITEMS.lining.id, code: ITEMS.lining.code, name: ITEMS.lining.name }, lot: { id: LOTS.lining.id, code: LOTS.lining.code }, itemKind: null } }),
  countRow(7, { status: 'APPLIED', approvalRequired: false, submittedAt: at(20, 12), approvedAt: at(20, 13), appliedAt: at(20, 13), differenceAmount: 0, lines: { all: 32, counted: 32, differing: 0 }, countTeam: null }),
]

export const COUNT_TILES: CountTiles = { drafts: 2, counting: 1, waitingApproval: 1, toApply: 2, yearEnd: 1 }

// ---- one count's lines -------------------------------------------------------------------------------------------------------------

const place = (location: (typeof LOCATIONS)[keyof typeof LOCATIONS]) => ({ id: location.id, code: location.code, name: location.name })
const item = (entry: (typeof ITEMS)[keyof typeof ITEMS], kind: string) => ({ id: entry.id, code: entry.code, name: entry.name, kind, tracking: entry.tracking, uom: entry.baseUom })

export function countLine(n: number, over: Partial<CountLine> = {}): CountLine {
  return {
    id: uid('5252', n),
    seq: n * 10,
    location: place(LOCATIONS.binA1),
    item: item(ITEMS.lining, 'LINING'),
    colour: COLOURS.black,
    lot: { id: LOTS.lining.id, code: LOTS.lining.code },
    hide: null,
    origin: 'SNAPSHOT',
    expected: '120.0000',
    counted: '120.0000',
    countedAt: at(30, 9, n),
    countedByYou: false,
    recount: null,
    final: '120.0000',
    difference: '0.0000',
    percent: '0.0',
    status: 'COUNTED',
    recountSuggested: false,
    reasonCode: null,
    reasonNote: null,
    move: null,
    unitCost: '4.200000',
    differenceAmount: 0,
    movedSinceSnapshot: false,
    version: 2,
    ...over,
  }
}

const hide = (n: number, area: string) => ({ id: uid('8282', n), code: `HD-DEMO-${String(n).padStart(4, '0')}`, area })
const leather = item(ITEMS.leather, 'LEATHER')
export const LINES: CountLine[] = [
  countLine(1),
  countLine(2, { counted: '112.5000', final: '112.5000', difference: '-7.5000', percent: '-6.3', recountSuggested: true, reasonCode: 'DAMAGED', move: { id: null, direction: 'OUT', baseQuantity: '7.5000' }, differenceAmount: -3_150, countedByYou: true }),
  countLine(3, { location: place(LOCATIONS.binA2), item: item(ITEMS.protector, 'PROTECTOR'), colour: null, lot: { id: LOTS.protector.id, code: LOTS.protector.code }, expected: '40.0000', counted: null, countedAt: null, final: null, difference: null, percent: null, status: 'UNCOUNTED', unitCost: '18.900000', differenceAmount: null }),
  countLine(4, { location: place(LOCATIONS.binA2), item: item(ITEMS.zip, 'HARDWARE'), colour: COLOURS.grey, lot: null, expected: '300.0000', counted: '296.0000', final: '296.0000', difference: '-4.0000', percent: '-1.3', move: { id: null, direction: 'OUT', baseQuantity: '4.0000' }, unitCost: '1.150000', differenceAmount: -460 }),
  countLine(5, {
    item: leather,
    lot: { id: LOTS.nappa.id, code: LOTS.nappa.code },
    hide: hide(7, '57.1000'),
    expected: '57.1000',
    counted: '0.0000',
    final: '0.0000',
    difference: '-57.1000',
    percent: '-100.0',
    recountSuggested: true,
    recount: { requestedAt: at(30, 9, 12), quantity: null, at: null },
    status: 'RECOUNT_DUE',
    move: { id: null, direction: 'OUT', baseQuantity: '57.1000' },
    unitCost: '9.800000',
    differenceAmount: -55_958,
  }),
  countLine(6, { item: leather, lot: { id: LOTS.nappa.id, code: LOTS.nappa.code }, hide: hide(8, '49.3000'), expected: '49.3000', counted: '49.3000', final: '49.3000', unitCost: '9.800000' }),
  countLine(7, {
    origin: 'ADDED',
    location: place(LOCATIONS.binA1),
    item: item(ITEMS.zip, 'HARDWARE'),
    colour: COLOURS.black,
    lot: null,
    expected: '0.0000',
    counted: '24.0000',
    final: '24.0000',
    difference: '24.0000',
    percent: null,
    recountSuggested: true,
    reasonCode: 'MISPLACED',
    move: { id: null, direction: 'IN', baseQuantity: '24.0000' },
    unitCost: '1.150000',
    differenceAmount: 2_760,
    countedByYou: true,
  }),
  countLine(8, { location: place(LOCATIONS.binA2), item: item(ITEMS.protector, 'PROTECTOR'), colour: null, lot: { id: LOTS.protector.id, code: LOTS.protector.code }, expected: '12.0000', counted: '10.0000', final: '10.0000', difference: '-2.0000', percent: '-16.7', recountSuggested: true, move: { id: null, direction: 'OUT', baseQuantity: '2.0000' }, unitCost: null, differenceAmount: null, movedSinceSnapshot: true }),
]
export const DIFFS = LINES.filter((line) => line.difference !== null && Number(line.difference) !== 0)
export const noCost = (lines: CountLine[]): CountLine[] => lines.map(({ unitCost: _unitCost, differenceAmount: _amount, ...rest }) => rest)

export function countRecord(row: CountRow, over: Partial<CountRecord> = {}): CountRecord {
  return {
    ...row,
    people: { createdBy: PEOPLE.anna, submittedBy: row.submittedAt ? PEOPLE.anna : null, approvedBy: row.approvedAt ? PEOPLE.marco : null, rejectedBy: null, appliedBy: row.appliedAt ? PEOPLE.marco : null, signedOffBy: row.signedOffAt ? PEOPLE.lucia : null },
    summary: { lines: 8, counted: 7, uncounted: 1, recountsDue: 1, differing: 5, unreasoned: 2, recountSuggested: 4, movedSinceSnapshot: 1, differenceAmount: 62_288, unvalued: 1 },
    approval: { required: true, limitAmount: 50_000, mayApprove: false, held: 'NOT_SUBMITTED', heldReason: 'The count is approved once it is submitted.' },
    actions: {
      edit: yes,
      start: no('Only a DRAFT count is started.'),
      record: yes,
      submit: no('Not ready.'),
      approve: no('The count is approved once it is submitted.'),
      sendBack: no('Only a SUBMITTED count is sent back.'),
      apply: no('A count is applied once it is approved.'),
      signOff: no('Only a year-end inventory is signed off.'),
      cancel: yes,
    },
    ...over,
  }
}

export const COUNTING = countRecord(countRow(1, { lines: { all: 8, counted: 7, differing: 5 } }))
export const SUBMITTED = countRecord(countRow(1, { status: 'SUBMITTED', submittedAt: at(30, 11), approvalRequired: true, differenceAmount: 62_288, lines: { all: 8, counted: 8, differing: 5 } }), {
  summary: { lines: 8, counted: 8, uncounted: 0, recountsDue: 0, differing: 5, unreasoned: 0, recountSuggested: 4, movedSinceSnapshot: 1, differenceAmount: 62_288, unvalued: 1 },
  approval: { required: true, limitAmount: 50_000, mayApprove: true, held: null, heldReason: null },
  actions: { ...COUNTING.actions, edit: no('x'), record: no('x'), submit: no('x'), approve: yes, sendBack: yes, apply: no('The differences wait for their approval.') },
})
export const OWN_VARIANCE = countRecord(SUBMITTED, {
  approval: { required: true, limitAmount: 50_000, mayApprove: false, held: 'OWN_VARIANCE', heldReason: 'You counted lines that differ.' },
  summary: SUBMITTED.summary,
  actions: { ...SUBMITTED.actions, approve: no('own') },
})

const doneLines = LINES.map((line) => (line.status === 'COUNTED' ? { ...line, reasonCode: line.reasonCode ?? (line.difference && Number(line.difference) !== 0 ? 'COUNT_ERROR' : null) } : { ...line, counted: '40.0000', final: '40.0000', difference: '0.0000', status: 'COUNTED' as const, recount: line.recount ? { ...line.recount, quantity: '0.0000', at: at(30, 10) } : null }))
export const DONE_LINES = doneLines
export const DONE_DIFFS = doneLines.filter((line) => line.difference !== null && Number(line.difference) !== 0)

export const YEAR_END_ROW = countRow(9, {
  kind: 'YEAR_END',
  number: 'CNT-D-0009',
  inventoryDate: '2025-12-31',
  scope: { location: null, item: null, lot: null, itemKind: null },
  countTeam: 'Tutto il magazzino',
  startedAt: at(2, 8, 0, 1),
  snapshotAt: '2025-12-31T22:59:59.999Z',
  status: 'APPLIED',
  submittedAt: at(3, 18, 0, 1),
  approvalRequired: true,
  approvedAt: at(4, 9, 0, 1),
  appliedAt: at(4, 9, 30, 1),
  differenceAmount: 61_198,
  lines: { all: 8, counted: 8, differing: 4 },
})
export const YEAR_END_APPLIED = countRecord(YEAR_END_ROW, {
  summary: { ...SUBMITTED.summary, differing: 4 },
  approval: { required: true, limitAmount: 50_000, mayApprove: false, held: 'NOT_SUBMITTED', heldReason: 'x' },
  actions: { ...SUBMITTED.actions, approve: no('x'), sendBack: no('x'), apply: no('x'), cancel: no('x'), signOff: yes },
})
export const YEAR_END_SIGNED = countRecord(
  { ...YEAR_END_ROW, status: 'SIGNED_OFF', signedOffAt: at(5, 11, 0, 1), valuedList: { pdfFileId: uid('5353', 1), sheetFileId: uid('5353', 2) } },
  { summary: YEAR_END_APPLIED.summary, approval: YEAR_END_APPLIED.approval, actions: { ...YEAR_END_APPLIED.actions, signOff: no('Signed off already.') } },
)
export const YEAR_END_DRAFT = countRecord(countRow(5, COUNT_ROWS[4]), {
  summary: { lines: 0, counted: 0, uncounted: 0, recountsDue: 0, differing: 0, unreasoned: 0, recountSuggested: 0, movedSinceSnapshot: 0, differenceAmount: 0, unvalued: 0 },
  approval: { required: false, limitAmount: 50_000, mayApprove: false, held: 'NOT_SUBMITTED', heldReason: 'x' },
  actions: { ...COUNTING.actions, record: no('x'), start: no('A year-end inventory starts on its inventory date (2026-12-31) or after it.') },
})
export const CYCLE_DRAFT = countRecord(COUNT_ROWS[3]!, {
  summary: YEAR_END_DRAFT.summary,
  approval: YEAR_END_DRAFT.approval,
  actions: { ...COUNTING.actions, record: no('x'), start: yes },
})
export const CANCELLED = countRecord(countRow(1, { status: 'CANCELLED', cancelledAt: at(29, 18), cancelReason: 'Scaffale riorganizzato: si riconta la settimana prossima.' }), {
  actions: { ...COUNTING.actions, edit: no('x'), record: no('x'), cancel: no('x') },
})

export const MATERIALS: MaterialChoice[] = [
  { id: ITEMS.zip.id, code: ITEMS.zip.code, name: ITEMS.zip.name, kind: 'HARDWARE', baseUom: 'PCS', tracking: 'NONE', colours: [] },
  { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name, kind: 'LEATHER', baseUom: 'FT2', tracking: 'HIDE', colours: [COLOURS.black] },
  // B-W2b-15 (Z2:06): a finished garment (one item per SKU) is found too.
  { id: uid('6464', 1), code: 'GIACCA-DEMO-01-NER-50', name: 'Giacca moto Demo · nero · 50', kind: 'FINISHED', baseUom: 'PCS', tracking: 'SERIAL', colours: [] },
]

/** B-W2b-15: every place of a count with its lines (the API's figures): the Lines tab's place filter. */
export const COUNT_PLACES: CountPlace[] = [
  { location: { id: LOCATIONS.binA1.id, code: LOCATIONS.binA1.code, name: LOCATIONS.binA1.name, path: LOCATIONS.binA1.path.join('/') }, lines: 14, counted: 11, differing: 3 },
  { location: { id: LOCATIONS.binA2.id, code: LOCATIONS.binA2.code, name: LOCATIONS.binA2.name, path: LOCATIONS.binA2.path.join('/') }, lines: 9, counted: 2, differing: 1 },
]

// ---- models ------------------------------------------------------------------------------------------------------------------------

export function listModel(role: CountRole, over: Partial<CountsListModel> = {}): CountsListModel {
  const can = canAs(role)
  const rows = can.cost ? COUNT_ROWS : COUNT_ROWS.map(({ differenceAmount: _amount, ...rest }) => rest)
  return {
    prefix: PREFIX,
    can,
    view: 'open',
    q: '',
    sites: SITES,
    siteId: null,
    rows: { items: rows, more: false, problem: null },
    tiles: COUNT_TILES,
    asOf: NOW,
    live: 'live',
    updates: 0,
    timeZone: TIME_ZONE,
    newCount: null,
    ...over,
  }
}

export function newCountModel(over: Partial<NewCountModel> = {}, draft: Partial<NewCountModel['draft']> = {}): NewCountModel {
  return {
    draft: { siteId: SITE.id, kind: 'CYCLE', year: 2026, locationId: LOCATIONS.rackA.id, item: null, lotId: null, itemKind: null, team: 'Squadra A', note: '', start: true, ...draft },
    places: PLACES,
    found: null,
    searching: false,
    lots: null,
    years: [2025, 2026],
    now: NOW,
    busy: false,
    problem: null,
    ...over,
  }
}

const LINES_ALL: LinesPart = { filter: 'all', q: '', locationId: null, items: LINES, more: false, problem: null }

export function recordModel(role: CountRole, record: CountRecord | null, over: Partial<CountRecordModel> = {}): CountRecordModel {
  const can = canAs(role)
  const strip = (value: CountRecord): CountRecord =>
    can.cost
      ? value
      : {
          ...value,
          differenceAmount: undefined,
          summary: { ...value.summary, differenceAmount: undefined },
          approval: { ...value.approval, limitAmount: undefined },
        }
  const lines = over.lines ?? LINES_ALL
  return {
    prefix: PREFIX,
    can,
    tab: 'lines',
    timeZone: TIME_ZONE,
    record: record ? { status: 'ready', value: strip(record) } : { status: 'loading' },
    lines: can.cost ? lines : { ...lines, items: lines.items ? noCost(lines.items) : null },
    diffs: { items: can.cost ? DIFFS : noCost(DIFFS), more: false, problem: null },
    reasons: REASONS,
    cells: {},
    undo: null,
    live: 'live',
    asOf: NOW,
    changed: null,
    dialog: null,
    busy: false,
    problem: null,
    notice: null,
    now: NOW,
    places: COUNT_PLACES,
    ...over,
    ...(over.lines ? { lines: can.cost ? over.lines : { ...over.lines, items: over.lines.items ? noCost(over.lines.items) : null } } : {}),
    ...(over.diffs ? { diffs: can.cost ? over.diffs : { ...over.diffs, items: over.diffs.items ? noCost(over.diffs.items) : null } } : {}),
  }
}
