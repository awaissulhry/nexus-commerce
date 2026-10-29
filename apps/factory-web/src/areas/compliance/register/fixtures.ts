import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../shell/design-data'
import { at, canFor, COMPANY_ID, inShell, NOW, PREFIX, uid, type RoleCase } from '../../quality/_shared/fixtures'
import { failedRead, ready, reading, type Read } from '../../quality/_shared/model'
import type { Entry, EntryDetail, PartyOption, ReversedRelease, StyleOption, Trace } from './api'
import { blankDraft, PAGE, tileCounts, viewRows, type ListDialog, type NewEntryDraft, type NewEntryModel, type RegisterListModel, type RegisterView } from './model'
import { RegisterListView } from './view/RegisterListView'

/**
 * SCR-113 PPE register & recalls — made-up entries only ("Demo" styles and customers, DEMO- batches, REG-DEMO-
 * references, made-up DDT and authority numbers). Each case is one state the Owner reviews: the list with its tiles,
 * every tile pressed, filters and search, nothing yet, nothing matching, loading, a failed read, the roles (owner,
 * quality inspector, production manager and read-only who see it with every change held, sales without the permission), a
 * selection with Export, live updates, more pages, and New entry (blank, with the trace preview, with trace problems).
 * The shared data below also feeds SCR-113-entry (record/fixtures.ts).
 */

// ---- shared made-up data --------------------------------------------------------------------------------------------------

const STYLE_JACKET = { id: uid('6101', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket' }
const STYLE_GLOVE = { id: uid('6101', 2), code: 'DEMO-GLV-02', name: 'Demo racing glove' }
const MOTO_DEMO = { id: uid('6201', 1), code: 'DEMO-C01', name: 'Moto Demo S.r.l.' }
const ESEMPIO = { id: uid('6201', 2), code: 'DEMO-C02', name: 'Esempio Distribuzione S.p.A.' }
export const DEMO_LOT_ID = uid('6301', 1)
export const REVERSAL_ID = uid('6401', 1)
export const RELEASE_ID = uid('6501', 1)

const entry = (n: number, over: Partial<Entry>): Entry => ({
  id: uid('6001', n),
  companyId: COMPANY_ID,
  reference: `REG-DEMO-2026-${String(n).padStart(4, '0')}`,
  kind: 'COMPLAINT',
  status: 'OPEN',
  styleId: STYLE_JACKET.id,
  style: STYLE_JACKET,
  styleRevisionId: null,
  batchNumbers: [],
  serials: [],
  lotIds: [],
  workOrderIds: [],
  shipmentIds: [],
  partyId: null,
  party: null,
  ownerId: null,
  source: null,
  reportedAt: at(20 + (n % 9), 10, 15),
  description: 'Made-up description of what happened.',
  investigation: null,
  risk: 'ASSESSING',
  actionTaken: null,
  actionCompletedAt: null,
  distributorsInformedAt: null,
  authorityNotifiedAt: null,
  authorityReference: null,
  closedAt: null,
  closedById: null,
  closeReason: null,
  version: 3,
  createdAt: at(20 + (n % 9), 10, 20),
  updatedAt: at(28, 9, 0),
  ...over,
})

export const ENTRIES: Entry[] = [
  entry(8, {
    kind: 'COMPLAINT',
    batchNumbers: ['B-DEMO-0142'],
    partyId: MOTO_DEMO.id,
    party: MOTO_DEMO,
    reportedAt: at(28, 15, 5),
    description: 'A rider reports that the shoulder protector moved out of its pocket in a low-speed fall (made-up case).',
  }),
  entry(7, {
    kind: 'NON_CONFORMITY',
    batchNumbers: ['B-DEMO-0139'],
    workOrderIds: [uid('6601', 39)],
    source: { type: 'QualityReleaseReversal', id: REVERSAL_ID },
    risk: 'YES',
    investigation: 'The CE class label printed for this batch names a lower class than the certificate covers (made-up).',
    actionTaken: 'Garments still here relabelled; customers asked to return the shipped ones.',
    actionCompletedAt: at(27, 16, 0),
    distributorsInformedAt: at(27, 17, 30),
    reportedAt: at(26, 11, 0),
    description: 'Release taken back after the final check found a wrong class label on the batch (made-up).',
  }),
  entry(6, {
    kind: 'RECALL',
    style: STYLE_GLOVE,
    styleId: STYLE_GLOVE.id,
    serials: ['DEMO-S-000101', 'DEMO-S-000102', 'DEMO-S-000103', 'DEMO-S-000104', 'DEMO-S-000105'],
    risk: 'YES',
    investigation: 'Knuckle armour of a made-up supplier lot failed the impact test.',
    actionTaken: 'Recall of the five gloves sold; replacement offered.',
    actionCompletedAt: at(25, 12, 0),
    distributorsInformedAt: at(24, 10, 0),
    authorityNotifiedAt: at(25, 9, 30),
    authorityReference: 'SG-DEMO-0001',
    reportedAt: at(24, 9, 0),
    description: 'Recall of five gloves with knuckle armour from a lot that failed later testing (made-up).',
  }),
  entry(5, {
    kind: 'NON_CONFORMITY',
    batchNumbers: ['B-DEMO-0120', 'B-DEMO-0121', 'B-DEMO-0122'],
    lotIds: [DEMO_LOT_ID],
    source: { type: 'LabResult', id: uid('6701', 1) },
    risk: 'NO',
    investigation: 'Chromium VI above the limit on later evidence for the leather lot; the garments were not shipped.',
    reportedAt: at(23, 8, 45),
    description: 'A later lab result failed the leather lot used for three batches (made-up).',
  }),
  entry(4, {
    status: 'CLOSED',
    batchNumbers: ['B-DEMO-0101'],
    partyId: ESEMPIO.id,
    party: ESEMPIO,
    risk: 'NO',
    investigation: 'Stitching loose on one sleeve, cosmetic only.',
    actionTaken: 'Repaired under warranty; line briefed on the stitch length.',
    actionCompletedAt: at(21, 10, 0),
    closedAt: at(22, 16, 0),
    closeReason: 'Action done, no further complaint.',
    reportedAt: at(20, 9, 0),
    description: 'Loose stitching on one sleeve reported by the distributor (made-up).',
  }),
  entry(3, {
    kind: 'NON_CONFORMITY',
    status: 'CLOSED',
    batchNumbers: ['B-DEMO-0098'],
    source: { type: 'QualityReleaseReversal', id: uid('6401', 2) },
    risk: 'NO',
    actionTaken: 'Garments re-inspected and released again.',
    actionCompletedAt: at(20, 12, 0),
    closedAt: at(21, 9, 0),
    closeReason: 'Re-inspection passed; nothing had left.',
    reportedAt: at(19, 15, 0),
  }),
  entry(2, { kind: 'COMPLAINT', reportedAt: at(22, 14, 0), description: 'A customer says the sizing chart is wrong; no batch named yet (made-up).' }),
  entry(1, {
    status: 'CLOSED',
    style: STYLE_GLOVE,
    styleId: STYLE_GLOVE.id,
    batchNumbers: ['B-DEMO-0080'],
    risk: 'YES',
    actionTaken: 'Batch withdrawn.',
    actionCompletedAt: at(12, 9, 0),
    distributorsInformedAt: at(11, 9, 0),
    authorityNotifiedAt: at(11, 15, 0),
    authorityReference: 'ICSMS-DEMO-0002',
    closedAt: at(15, 10, 0),
    closeReason: 'Withdrawal complete; authority closed its file.',
    reportedAt: at(10, 9, 0),
  }),
]

const OPEN = ENTRIES.filter((row) => row.status === 'OPEN')
const CLOSED = ENTRIES.filter((row) => row.status === 'CLOSED')
export const TILES = tileCounts(OPEN, CLOSED)

export const RELEASES: ReversedRelease[] = [{ id: RELEASE_ID, releaseNumber: 'REL-DEMO-2026-0031', number: 'WO-DEMO-0139', reversals: [{ id: REVERSAL_ID }] }]

export const STYLES: StyleOption[] = [
  { ...STYLE_JACKET, companyId: COMPANY_ID, status: 'ACTIVE' },
  { ...STYLE_GLOVE, companyId: null, status: 'ACTIVE' },
  { id: uid('6101', 3), code: 'DEMO-PNT-03', name: 'Demo touring trousers', companyId: COMPANY_ID, status: 'ARCHIVED' },
]
export const PARTIES: PartyOption[] = [
  { id: MOTO_DEMO.id, code: MOTO_DEMO.code, legalName: MOTO_DEMO.name, tradeName: null },
  { id: ESEMPIO.id, code: ESEMPIO.code, legalName: ESEMPIO.name, tradeName: 'Esempio Moto' },
]

const cell = (n: number, size: string, concerned: number, released: number, packed: number, shipped: number) => ({
  workOrderSizeId: uid('6801', n),
  colourwayCode: 'BLK',
  size,
  pieces: concerned,
  concerned,
  released,
  packed,
  shipped,
  returned: 0,
  serials: [],
})

export const TRACE: Trace = {
  workOrders: [
    {
      id: uid('6601', 42),
      number: 'WO-DEMO-0142',
      batchNumber: 'B-DEMO-0142',
      styleId: STYLE_JACKET.id,
      styleCode: STYLE_JACKET.code,
      revision: 2,
      status: 'COMPLETED',
      reach: 'WHOLE',
      via: ['BATCH'],
      cells: [cell(1, '48', 12, 12, 0, 8), cell(2, '50', 16, 16, 4, 10), cell(3, '52', 20, 18, 0, 6)],
    },
  ],
  lots: [{ id: DEMO_LOT_ID, code: 'LOT-DEMO-0231', workOrderNumbers: ['WO-DEMO-0142'] }],
  shipments: [
    {
      id: uid('6901', 1),
      number: 'SH-DEMO-0031',
      status: 'SHIPPED',
      left: true,
      shippedAt: at(24, 15, 0),
      deliveredAt: null,
      partyId: MOTO_DEMO.id,
      partyCode: MOTO_DEMO.code,
      partyName: MOTO_DEMO.name,
      ddtNumbers: ['DDT-DEMO-2026-0153'],
      garments: 18,
      workOrderNumbers: ['WO-DEMO-0142'],
    },
    {
      id: uid('6901', 2),
      number: 'SH-DEMO-0034',
      status: 'PACKED',
      left: false,
      shippedAt: null,
      deliveredAt: null,
      partyId: ESEMPIO.id,
      partyCode: ESEMPIO.code,
      partyName: ESEMPIO.name,
      ddtNumbers: [],
      garments: 4,
      workOrderNumbers: ['WO-DEMO-0142'],
    },
    {
      id: uid('6901', 3),
      number: 'SH-DEMO-0029',
      status: 'DELIVERED',
      left: true,
      shippedAt: at(21, 11, 0),
      deliveredAt: at(23, 9, 0),
      partyId: ESEMPIO.id,
      partyCode: ESEMPIO.code,
      partyName: ESEMPIO.name,
      ddtNumbers: ['DDT-DEMO-2026-0148'],
      garments: 6,
      workOrderNumbers: ['WO-DEMO-0142'],
    },
  ],
  customers: [
    { partyId: MOTO_DEMO.id, code: MOTO_DEMO.code, name: MOTO_DEMO.name, garments: 18, shipmentNumbers: ['SH-DEMO-0031'], ddtNumbers: ['DDT-DEMO-2026-0153'] },
    { partyId: ESEMPIO.id, code: ESEMPIO.code, name: ESEMPIO.name, garments: 6, shipmentNumbers: ['SH-DEMO-0029'], ddtNumbers: ['DDT-DEMO-2026-0148'] },
  ],
  counts: { workOrders: 1, concerned: 48, released: 46, packed: 4, shipped: 24, returned: 0, customers: 2 },
  shippedGoods: true,
  problems: [],
}

export const TRACE_PROBLEMS: Trace = {
  ...TRACE,
  problems: [
    { path: 'batchNumbers.1', code: 'UNKNOWN_BATCH', message: 'No work order of this style carries batch B-DEMO-9999.' },
    { path: 'serials.0', code: 'OTHER_STYLE_SERIAL', message: 'Serial DEMO-S-000777 belongs to another style (DEMO-GLV-02).' },
  ],
}

export const TRACE_NOTHING_LEFT: Trace = {
  ...TRACE,
  shipments: [],
  customers: [],
  counts: { ...TRACE.counts, shipped: 0, packed: 0, customers: 0 },
  shippedGoods: false,
}

/** An entry as its record reads it: the row, the trace, the duties and what still stops it from closing. */
export function detailOf(row: Entry, trace: Trace = TRACE, toClose: EntryDetail['toClose'] = []): EntryDetail {
  const blank = (text: string | null) => !text || !text.trim()
  const duties: EntryDetail['duties'] = [
    { code: 'RISK_ASSESSMENT', required: true, done: row.risk !== 'ASSESSING', law: 'Reg. (EU) 2016/425 art. 8(8)' },
    { code: 'CORRECTIVE_ACTION', required: true, done: !blank(row.actionTaken) && row.actionCompletedAt !== null, law: 'Reg. (EU) 2016/425 art. 8(8)' },
    { code: 'DISTRIBUTORS', required: trace.shippedGoods, done: row.distributorsInformedAt !== null, law: 'Reg. (EU) 2016/425 art. 8(4)' },
    { code: 'AUTHORITY', required: row.risk === 'YES', done: row.authorityNotifiedAt !== null && !blank(row.authorityReference), law: 'Reg. (EU) 2016/425 art. 8(8)' },
  ]
  return { ...row, trace, duties, toClose: row.status === 'CLOSED' ? [] : toClose }
}

// ---- the list's cases -----------------------------------------------------------------------------------------------------

export interface RegisterDesignModel {
  readonly role: RoleCase
  readonly list: RegisterListModel
}

const companyIdOf = COMPANY_ID
export const newModel = (over: Partial<NewEntryModel> = {}, draft: Partial<NewEntryDraft> = {}): NewEntryModel => ({
  draft: { ...blankDraft(companyIdOf), ...draft },
  companies: [],
  styles: ready(STYLES),
  parties: ready(PARTIES),
  trace: null,
  busy: false,
  problem: null,
  showProblems: false,
  ...over,
})

function listModel(role: RoleCase, over: Partial<RegisterListModel> = {}): RegisterListModel {
  const view: RegisterView = over.view ?? 'all'
  const filtered = view === 'all' ? ENTRIES : view === 'closed' ? CLOSED : viewRows(view, OPEN).filter((row) => (view === 'risk' ? row.risk === 'YES' : view === 'assessing' ? row.risk === 'ASSESSING' : true))
  return {
    prefix: PREFIX,
    can: canFor(role),
    rows: ready(filtered),
    view,
    filters: {},
    query: '',
    limit: PAGE,
    tiles: TILES,
    asOf: NOW,
    live: 'live',
    updates: 0,
    selected: [],
    notice: null,
    newEntry: newModel(),
    ...over,
  }
}

/** The list with its own selection, dialog and draft (ticks, the header box, shift-click, x, c and the dialog work in review). */
function RegisterDesign({ model }: { model: RegisterDesignModel }) {
  const [selected, setSelected] = useState<readonly string[]>(model.list.selected)
  const [dialog, setDialog] = useState<ListDialog | null>(model.list.dialog ?? null)
  const [draft, setDraft] = useState<NewEntryDraft | null>(model.list.newEntry?.draft ?? null)
  useEffect(() => setSelected(model.list.selected), [model.list.selected])
  useEffect(() => setDialog(model.list.dialog ?? null), [model.list.dialog])
  useEffect(() => setDraft(model.list.newEntry?.draft ?? null), [model.list.newEntry])
  const list: RegisterListModel = { ...model.list, selected, dialog, newEntry: model.list.newEntry && draft ? { ...model.list.newEntry, draft } : model.list.newEntry }
  return inShell(
    '/compliance/register',
    createElement(RegisterListView, { model: list, actions: { onSelect: (ids: readonly string[]) => setSelected([...ids]), onDialog: setDialog, onDraft: setDraft } }),
    model.role,
  )
}

const pick = (...refs: number[]) => ENTRIES.filter((row) => refs.some((n) => row.reference.endsWith(String(n).padStart(4, '0')))).map((row) => row.id)
const loadingRead: Read<readonly Entry[]> = reading()

export const designScreen = defineDesignScreen<RegisterDesignModel>({
  screen: 'SCR-113',
  title: 'PPE register & recalls',
  view: RegisterDesign,
  cases: [
    { id: 'owner', label: 'Owner: the register with its tiles', model: { role: 'owner', list: listModel('owner') }, note: 'Every entry, newest first; who keeps the register at rest; a tile is a saved view.' },
    { id: 'inspector', label: 'Quality inspector (view + manage)', model: { role: 'inspector', list: listModel('inspector') } },
    {
      id: 'read-only',
      label: 'Read-only: New entry held with its reason',
      model: { role: 'readOnly', list: listModel('readOnly', { selected: pick(8, 7) }) },
      note: 'New entry stays focusable and says which permission is missing; Export still works on the selection.',
    },
    {
      id: 'production',
      label: 'Production manager: sees the register, changes nothing (held with the reason)',
      model: { role: 'production', list: listModel('production') },
      note: 'The production manager template holds compliance.register.view, not manage.',
    },
    { id: 'sales', label: 'Sales: no permission (which one, who grants it)', model: { role: 'sales', list: listModel('sales') } },
    { id: 'tile-open', label: 'Tile pressed: open entries', model: { role: 'owner', list: listModel('owner', { view: 'open' }) } },
    { id: 'tile-risk', label: 'Tile pressed: may present a risk – open', model: { role: 'owner', list: listModel('owner', { view: 'risk' }) } },
    { id: 'tile-assessing', label: 'Tile pressed: risk being assessed', model: { role: 'owner', list: listModel('owner', { view: 'assessing' }) } },
    {
      id: 'tile-uninformed',
      label: 'Tile pressed: distributors not yet informed',
      model: { role: 'owner', list: listModel('owner', { view: 'uninformed' }) },
      note: 'Open entries not yet marked as informed (the list rows carry no duties: an entry whose goods never left is listed too).',
    },
    { id: 'tile-closed', label: 'Tile pressed: closed', model: { role: 'owner', list: listModel('owner', { view: 'closed' }) } },
    {
      id: 'filtered',
      label: 'Filters and search: kind Complaint, “sleeve”',
      model: { role: 'owner', list: listModel('owner', { filters: { kind: 'COMPLAINT' }, query: 'sleeve', rows: ready(ENTRIES.filter((row) => row.reference.endsWith('0004'))) }) },
    },
    { id: 'filtered-empty', label: 'No entry matches these filters', model: { role: 'owner', list: listModel('owner', { query: 'zzz', rows: ready([]) }) } },
    {
      id: 'empty',
      label: 'First day: the register is empty',
      model: { role: 'owner', list: listModel('owner', { rows: ready([]), tiles: tileCounts([], []) }) },
    },
    { id: 'loading', label: 'Loading', model: { role: 'owner', list: listModel('owner', { rows: loadingRead, tiles: {}, asOf: null, live: 'connecting' }) } },
    {
      id: 'error',
      label: "The API didn't answer",
      model: { role: 'owner', list: listModel('owner', { rows: failedRead('problem.unavailable'), tiles: { open: null, risk: null, assessing: null, uninformed: null, closed: null }, asOf: null, live: 'offline' }) },
      note: 'Never drawn as an empty list; the tiles say they could not count.',
    },
    { id: 'selection', label: 'Selection: Export 3 (CSV)', model: { role: 'owner', list: listModel('owner', { selected: pick(8, 7, 4) }) } },
    { id: 'live-updates', label: 'Live: 2 updates waiting behind Show', model: { role: 'owner', list: listModel('owner', { updates: 2 }) }, note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: the last copy with its time', model: { role: 'owner', list: listModel('owner', { live: 'offline' }) } },
    {
      id: 'more',
      label: 'More than one page (Show more)',
      model: { role: 'owner', list: listModel('owner', { limit: ENTRIES.length }) },
      note: 'The list has no cursor: Show more reads a larger page, up to the API’s 500 (then held with its reason).',
    },
    { id: 'at-max', label: 'At the most the list reads (500): held with its reason', model: { role: 'owner', list: listModel('owner', { limit: 500, rows: ready(ENTRIES) }) } },
    { id: 'notice', label: 'A receipt after an export', model: { role: 'owner', list: listModel('owner', { notice: { key: 'done.exported', tone: 'success', params: { count: 3 } } }) } },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: { role: 'owner', list: listModel('owner', { focusRow: 1, selected: pick(7) }) } },
    { id: 'shortcuts', label: 'All shortcuts (?)', model: { role: 'owner', list: listModel('owner', { dialog: { kind: 'shortcuts' } }) } },
    { id: 'new', label: 'New entry (blank)', model: { role: 'owner', list: listModel('owner', { dialog: { kind: 'new' } }) }, note: '⌘↵ adds; Add is held with the first missing thing.' },
    {
      id: 'new-several-companies',
      label: 'New entry: a person working in two companies chooses one',
      model: { role: 'owner', list: listModel('owner', { dialog: { kind: 'new' }, newEntry: newModel({ companies: DEMO_COMPANIES }, { companyId: '' }) }) },
    },
    {
      id: 'new-trace',
      label: 'New entry: where are these garments? (trace preview)',
      model: {
        role: 'owner',
        list: listModel('owner', {
          dialog: { kind: 'new' },
          newEntry: newModel({ trace: ready(TRACE) }, { styleId: STYLE_JACKET.id, batchNumbers: ['B-DEMO-0142'], partyId: MOTO_DEMO.id, description: 'Shoulder protector moved in a fall (made-up).' }),
        }),
      },
      note: 'Work orders (every garment of the batch), shipments that left with their DDT, the customers.',
    },
    {
      id: 'new-trace-problems',
      label: 'New entry: a batch and a serial that cannot be traced (said in words)',
      model: {
        role: 'owner',
        list: listModel('owner', {
          dialog: { kind: 'new' },
          newEntry: newModel({ trace: ready(TRACE_PROBLEMS) }, { styleId: STYLE_JACKET.id, batchNumbers: ['B-DEMO-0142', 'B-DEMO-9999'], serials: ['DEMO-S-000777'], description: 'Made-up.' }),
        }),
      },
    },
    {
      id: 'new-problems',
      label: 'New entry: Add pressed with things missing (a recall without garments)',
      model: { role: 'owner', list: listModel('owner', { dialog: { kind: 'new' }, newEntry: newModel({ showProblems: true }, { kind: 'RECALL' }) }) },
    },
    {
      id: 'new-no-styles',
      label: 'New entry: a role that cannot list styles or customers (said in words)',
      model: { role: 'inspector', list: listModel('inspector', { dialog: { kind: 'new' }, newEntry: newModel({ styles: null, parties: null }) }) },
    },
    {
      id: 'new-refused',
      label: 'New entry: the company has no PPE register numbering',
      model: {
        role: 'owner',
        list: listModel('owner', {
          dialog: { kind: 'new' },
          newEntry: newModel({ problem: 'new.problem.noSeries' }, { styleId: STYLE_JACKET.id, batchNumbers: ['B-DEMO-0142'], description: 'Made-up.' }),
        }),
      },
    },
  ],
})
