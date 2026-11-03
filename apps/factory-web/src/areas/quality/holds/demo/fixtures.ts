import type { HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { COMPANY_ID, ME, SITE_ID, at, day, uid } from '../../_shared/fixtures'
import type { Hold, HoldCheck, HoldCounts, HoldDetail, HoldPreview, HoldSettingsAnswer, Person } from '../api'
import type { Affected, Genealogy, HoldGroup, ImpactNodeView } from '../depth/api'

/**
 * Design-only made-up data of Quality › Holds (SCR-078) and its tag (SCR-078-tag): Demo lots (DEMO-LOT-…), hides,
 * work orders (DEMO-WO-…), bundles, serials, a shipment, Demo people of the office ("Demo Quality Lead"). No real
 * company, person, code or result. No designScreen here: the screens' own fixtures use it.
 */

export const OTHER_USER = uid('3333', 9)
export const LEAD = uid('3333', 11)
const SITE = { id: SITE_ID, code: 'DEMO-A1', name: 'Demo plant A1' }
const QUARANTINE = { id: uid('7810', 1), code: 'DEMO-Q-01', name: 'Quarantine shelf' }

export const PEOPLE: Person[] = [
  { id: ME, name: 'Demo Planner', me: true },
  { id: LEAD, name: 'Demo Quality Lead', me: false },
  { id: OTHER_USER, name: 'Demo Inspector', me: false },
]

export const REASONS = [
  { code: 'QUALITY_CHECK', labelIt: 'Verifica qualità', labelEn: 'Quality check', needsDetail: false },
  { code: 'MISSING_CERTIFICATE', labelIt: 'Certificato mancante', labelEn: 'Missing certificate', needsDetail: false },
  { code: 'CUSTOMER_REQUEST', labelIt: 'Richiesta del cliente', labelEn: 'Customer request', needsDetail: false },
  { code: 'SUPPLIER_CHECK', labelIt: 'Verifica fornitore', labelEn: 'Supplier check', needsDetail: false },
  { code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true },
]
export const REASON_WORDS: ReadonlyMap<string, { labelIt: string; labelEn: string }> = new Map(REASONS.map((entry) => [entry.code, { labelIt: entry.labelIt, labelEn: entry.labelEn }]))

const subjects = (type: HoldSubjectType, labels: readonly string[], family: string) => labels.map((label, index) => ({ id: uid(family, index + 1), label, state: type === 'Lot' ? 'RELEASED' : type === 'WorkOrder' ? 'ON_HOLD' : 'ACTIVE' }))

const hold = (n: number, over: Partial<Hold> & Pick<Hold, 'subjectType' | 'subjects'>): Hold => ({
  id: uid('7801', n),
  // B-W2b-17: the hold's number (made up; the HOLD series of a company).
  number: `DEMO-HLD-${String(90 + n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  site: SITE,
  status: 'ACTIVE',
  subjectWords: 'x',
  quantity: null,
  blocks: 'Blocks issuing and cutting.',
  reasonCode: 'QUALITY_CHECK',
  reason: 'Quality check',
  reasonNote: null,
  sourceType: null,
  sourceId: null,
  placedAt: at(27, 9, 10),
  placedBy: { kind: 'USER', userId: OTHER_USER },
  ownerId: null,
  owner: null,
  expectedReleaseOn: null,
  overdue: false,
  ageDays: 2,
  quarantine: 'NOT_NEEDED',
  quarantineLocation: null,
  quarantineMovedAt: null,
  ncrId: null,
  releasedAt: null,
  releasedBy: null,
  releaseNote: null,
  closedAt: null,
  closedById: null,
  closeNote: null,
  note: null,
  // B-W2b-114: the board's lane and the hold by genealogy (made up).
  nextStep: 'NEW',
  group: null,
  version: 1,
  createdAt: at(27, 9, 10),
  updatedAt: at(27, 9, 10),
  ...over,
})

export const HOLDS: Hold[] = [
  hold(1, {
    subjectType: 'Lot',
    subjects: subjects('Lot', ['DEMO-LOT-0231', 'DEMO-LOT-0233', 'DEMO-LOT-0234'], '7821'),
    quantity: '412.0000 FT2',
    reasonCode: 'SUPPLIER_CHECK',
    reason: 'Supplier check',
    reasonNote: 'The demo tannery warned of a dye batch',
    placedAt: at(29, 9, 10),
    ageDays: 0,
    ownerId: ME,
    owner: { id: ME, name: 'Demo Planner' },
    expectedReleaseOn: day(31),
    quarantine: 'ASKED',
    quarantineLocation: QUARANTINE,
  }),
  hold(2, {
    subjectType: 'WorkOrder',
    subjects: subjects('WorkOrder', ['DEMO-WO-0142'], '7822'),
    quantity: '48 garments',
    sourceType: 'Inspection',
    sourceId: uid('7701', 9),
    placedBy: { kind: 'SYSTEM', userId: null },
    placedAt: at(20, 11, 20),
    ageDays: 9,
    expectedReleaseOn: day(25),
    overdue: true,
    ownerId: LEAD,
    owner: { id: LEAD, name: 'Demo Quality Lead' },
  }),
  hold(3, {
    subjectType: 'Hide',
    subjects: subjects('Hide', ['DEMO-HIDE-0231-07'], '7823'),
    quantity: '38.5000 FT2',
    placedBy: { kind: 'WORKER', userId: null },
    placedAt: at(28, 14, 2),
    ageDays: 1,
    quarantine: 'MOVED',
    quarantineLocation: QUARANTINE,
    quarantineMovedAt: at(28, 15, 30),
  }),
  hold(4, {
    subjectType: 'GarmentSerial',
    subjects: subjects('GarmentSerial', ['DEMO-0139-001', 'DEMO-0139-002', 'DEMO-0139-003', 'DEMO-0139-004'], '7824'),
    quantity: '4 garments',
    sourceType: 'QualityReleaseReversal',
    sourceId: uid('7731', 1),
    placedBy: { kind: 'SYSTEM', userId: null },
    placedAt: at(26, 9, 30),
    ageDays: 3,
  }),
  hold(5, {
    subjectType: 'Bundle',
    subjects: subjects('Bundle', ['DEMO-BN-0142-04'], '7825'),
    quantity: '10 garments',
    reasonNote: 'Stitch length out on the left sleeve',
    placedBy: { kind: 'USER', userId: ME },
    placedAt: at(29, 8, 45),
    ageDays: 0,
  }),
  hold(6, {
    // B-W2b-17: a hold placed before holds were numbered (its number column says "—").
    number: null,
    subjectType: 'Shipment',
    subjects: subjects('Shipment', ['DEMO-SHP-0088'], '7826'),
    quantity: '24 garments',
    reasonCode: 'CUSTOMER_REQUEST',
    reason: 'Customer request',
    sourceType: 'Complaint',
    sourceId: uid('7741', 1),
    placedAt: at(28, 10, 0),
    ageDays: 1,
    ownerId: OTHER_USER,
    owner: { id: OTHER_USER, name: 'Demo Inspector' },
  }),
  hold(7, {
    subjectType: 'Lot',
    subjects: subjects('Lot', ['DEMO-LOT-0219'], '7827'),
    quantity: '96.0000 FT2',
    sourceType: 'LabResult',
    sourceId: uid('7751', 1),
    placedBy: { kind: 'SYSTEM', userId: null },
    placedAt: at(24, 16, 0),
    ageDays: 5,
    quarantine: 'ASKED',
    quarantineLocation: QUARANTINE,
  }),
]

export const RELEASED: Hold[] = [
  hold(8, {
    subjectType: 'Lot',
    subjects: subjects('Lot', ['DEMO-LOT-0207'], '7828'),
    status: 'RELEASED',
    quantity: '120.0000 FT2',
    placedAt: at(20, 9, 0),
    ageDays: 2,
    releasedAt: at(22, 11, 0),
    releasedBy: { kind: 'USER', userId: LEAD },
    releaseNote: 'Supplier report checked: within the limit.',
  }),
]

export const CLOSED: Hold[] = [
  hold(9, {
    subjectType: 'Hide',
    subjects: subjects('Hide', ['DEMO-HIDE-0199-02'], '7829'),
    status: 'CLOSED',
    quantity: '12.0000 FT2',
    placedAt: at(18, 9, 0),
    ageDays: 4,
    ncrId: uid('7761', 1),
    closedAt: at(22, 15, 0),
    closedById: LEAD,
    closeNote: 'Decided in DEMO-NCR-0004: scrapped.',
  }),
]

export const COUNTS: HoldCounts = { open: HOLDS.length, overdue: 1, system: 3, mine: 1, waitingQuarantine: 2 }

const check = (key: HoldCheck['key'], ok: boolean, words: string): HoldCheck => ({ key, ok, words })
const ACTIVE_OK = check('ACTIVE', true, 'The hold is active.')
const NOT_PLACER_OK = check('NOT_PLACER', true, 'Released by someone other than the person who placed it.')

const STORE = { id: uid('7810', 2), code: 'DEMO-A1-RACK-03', name: 'Leather rack 3' }
const WORKSHOP = { id: uid('7810', 3), code: 'DEMO-TERZ-P2', name: 'Demo workshop P2' }

/** Where a demo stock hold's goods lie: the open rack (moves on confirming), and a little at an outside workshop (stays). */
function STOCK_OF(value: Hold): HoldDetail['stock'] {
  const moved = value.quarantine === 'MOVED'
  return {
    places: [QUARANTINE],
    lying: moved
      ? [{ locationId: QUARANTINE.id, code: QUARANTINE.code, name: QUARANTINE.name, kind: 'QUARANTINE', onHand: '412', uom: 'FT2', moves: false }]
      : [
          { locationId: STORE.id, code: STORE.code, name: STORE.name, kind: 'BIN', onHand: '380.5', uom: 'FT2', moves: value.quarantine === 'ASKED' },
          { locationId: WORKSHOP.id, code: WORKSHOP.code, name: WORKSHOP.name, kind: 'SUBCONTRACTOR', onHand: '31.5', uom: 'FT2', moves: false },
        ],
  }
}

/** A hold's record with its release checks. */
export const detailOf = (value: Hold, checks: HoldCheck[] = [ACTIVE_OK, NOT_PLACER_OK], over: Partial<HoldDetail> = {}): HoldDetail => ({
  hold: value,
  workOrders: value.subjectType === 'WorkOrder' ? [{ id: value.subjects[0]!.id, number: value.subjects[0]!.label ?? '', status: 'ON_HOLD', heldFromStatus: 'IN_PROGRESS', holdReason: 'Quality check', heldByThis: true, batchNumber: 'DEMO-B-0142' }] : [],
  release: { checks, releasable: checks.every((entry) => entry.ok || entry.key === 'STATEMENT'), mayRelease: true, placerMayRelease: false },
  canChange: value.status === 'ACTIVE',
  // B-W2b-114: a stock hold's stock by place (the quarantine move's facts); null for other kinds.
  stock: value.status === 'ACTIVE' && (value.subjectType === 'Lot' || value.subjectType === 'Hide') ? STOCK_OF(value) : null,
  ...over,
})

export const DETAIL_READY = detailOf(HOLDS[0]!)
export const DETAIL_PLACER = detailOf(HOLDS[4]!, [ACTIVE_OK, check('NOT_PLACER', false, 'You placed this hold - another person must release it.')])
export const DETAIL_MAKER = detailOf(HOLDS[1]!, [ACTIVE_OK, NOT_PLACER_OK, check('NOT_MAKER', false, 'You made garments of work order DEMO-WO-0142: another person, who made none of them, releases the hold.'), check('REINSPECTION', false, 'Re-inspection signed (now: missing for DEMO-WO-0142).')])
export const DETAIL_STATEMENT = detailOf(HOLDS[3]!, [ACTIVE_OK, NOT_PLACER_OK, check('NOT_MAKER', true, 'You made none of the held garments (the floor records).'), check('STATEMENT', false, 'The floor records name the station only: sign that you made none of the held garments.')])
export const DETAIL_CR_VI = detailOf(HOLDS[6]!, [ACTIVE_OK, NOT_PLACER_OK, check('CR_VI', false, 'Cr VI result PASS (now: DEMO-LOT-0219 FAIL).')])
/** B-W2b-17: you placed it, and your company lets the placer release (QualitySettings.placerMayRelease). */
export const DETAIL_PLACER_MAY: HoldDetail = (() => {
  const base = detailOf(HOLDS[4]!, [ACTIVE_OK, check('NOT_PLACER', true, "You placed this hold; the company's rule lets the person who placed it release it.")])
  return { ...base, release: { ...base.release, placerMayRelease: true } }
})()

/** B-W2b-17: who releases holds — the company follows the standard rule; set for the company; read only. */
export const SETTINGS_DEFAULT: HoldSettingsAnswer = { settings: { companyId: COMPANY_ID, inForce: { placerMayRelease: false, source: 'DEFAULT' }, own: null, version: 0 }, mayChange: true }
export const SETTINGS_COMPANY: HoldSettingsAnswer = { settings: { companyId: COMPANY_ID, inForce: { placerMayRelease: true, source: 'COMPANY' }, own: { placerMayRelease: true, updatedAt: at(26, 11, 30) }, version: 3 }, mayChange: true }
export const SETTINGS_READ_ONLY: HoldSettingsAnswer = { ...SETTINGS_DEFAULT, mayChange: false }

export const DETAIL_RELEASED = detailOf(RELEASED[0]!, [check('ACTIVE', false, 'The hold is released already.'), NOT_PLACER_OK], { canChange: false })

export const PREVIEW: HoldPreview = {
  siteId: SITE_ID,
  subjects: [
    { id: uid('7821', 1), code: 'DEMO-LOT-0231', label: 'DEMO-LOT-0231', state: 'RELEASED', quantity: '206.0000 FT2', problem: null },
    { id: uid('7821', 2), code: 'DEMO-LOT-0233', label: 'DEMO-LOT-0233', state: 'RELEASED', quantity: '206.0000 FT2', problem: null },
  ],
  words: 'Blocks issuing and cutting of 2 lots (412.0000 FT2).',
  quantity: '412.0000 FT2',
  workOrders: [],
  quarantinePlaces: [QUARANTINE],
}

export const PREVIEW_PROBLEMS: HoldPreview = {
  ...PREVIEW,
  subjects: [
    ...PREVIEW.subjects,
    { id: null, code: 'DEMO-LOT-9999', label: null, state: null, quantity: null, problem: 'Not found at a site you reach.' },
    { id: uid('7821', 9), code: 'DEMO-LOT-0190', label: 'DEMO-LOT-0190', state: 'REJECTED', quantity: null, problem: 'Lot DEMO-LOT-0190 is rejected: it goes back to the supplier or is scrapped, and is never used.' },
  ],
}

export const PREVIEW_WORK_ORDER: HoldPreview = {
  siteId: SITE_ID,
  subjects: [{ id: uid('7822', 1), code: null, label: 'DEMO-WO-0147', state: 'IN_PROGRESS', quantity: '20 garments', problem: null }],
  words: 'Blocks issuing, cutting, scanning, releasing, packing and shipping of 1 work order (20 garments).',
  quantity: '20 garments',
  workOrders: [{ id: uid('7822', 1), number: 'DEMO-WO-0147', status: 'IN_PROGRESS', move: 'HOLD' }],
  quarantinePlaces: [],
}

export const QUARANTINE_PLACE = QUARANTINE

// ---- B-W2b-114: holds in depth (made up: DEMO-LOT-…, DEMO-WO-…, DEMO-SH-…, Demo customers) --------------------------------

/** The holds of the list spread over the board's lanes. */
export const BOARD_HOLDS: Hold[] = HOLDS.map((value, index) => ({ ...value, nextStep: (['NEW', 'INVESTIGATING', 'WAITING_DECISION', 'NEW', 'READY_TO_RELEASE', 'INVESTIGATING', 'WAITING_DECISION'] as const)[index % 7]! }))

const SUSPECT = { id: uid('7821', 1), code: 'DEMO-LOT-0231' }
const n = (kind: ImpactNodeView['kind'], idx: number, over: Partial<ImpactNodeView>): ImpactNodeView => ({
  key: `${kind}:${uid('7830', idx)}`,
  kind,
  id: uid('7830', idx),
  code: null,
  reach: 'EXACT',
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  hidden: false,
  state: null,
  holdKind: null,
  hold: 'NONE',
  problem: null,
  holds: [],
  workOrderId: null,
  ...over,
})
const WO1 = uid('7830', 20)
const WO2 = uid('7830', 21)
const NODES: ImpactNodeView[] = [
  { ...n('LOT', 1, { code: SUSPECT.code, holdKind: 'Lot', hold: 'HOLDABLE', state: 'RELEASED', lot: { itemCode: 'DEMO-LEA-BLK', itemName: 'Demo cowhide black', uom: 'FT2', onHand: '412', colourCode: 'BLK' } }), key: `LOT:${SUSPECT.id}`, id: SUSPECT.id },
  n('HIDE', 2, { code: 'DEMO-HIDE-0231-07', holdKind: 'Hide', hold: 'HOLDABLE', state: 'PARTLY_CUT', hideOnHand: '18' }),
  n('HIDE', 3, { code: 'DEMO-HIDE-0231-08', holdKind: 'Hide', hold: 'HELD', state: 'FULL', holds: [{ id: uid('7801', 3), reasonCode: 'QUALITY_CHECK' }], hideOnHand: '52' }),
  { ...n('WORK_ORDER', 20, { code: 'DEMO-WO-0142', holdKind: 'WorkOrder', hold: 'HOLDABLE', state: 'IN_PROGRESS', workOrder: { styleCode: 'DEMO-JKT-01', batchNumber: 'DEMO-B-0142', status: 'IN_PROGRESS' } }), workOrderId: WO1 },
  { ...n('WORK_ORDER', 21, { code: 'DEMO-WO-0145', holdKind: 'WorkOrder', hold: 'HOLDABLE', state: 'COMPLETED', reach: 'POSSIBLE', workOrder: { styleCode: 'DEMO-JKT-02', batchNumber: 'DEMO-B-0145', status: 'COMPLETED' } }), workOrderId: WO2 },
  n('CELL', 30, { code: 'BLK 50', workOrderId: WO1, cell: { colourwayCode: 'BLK', size: '50', quantity: 60, released: 20, packed: 6, shipped: 0, returned: 0 } }),
  n('CELL', 31, { code: 'BLK 52', workOrderId: WO1, cell: { colourwayCode: 'BLK', size: '52', quantity: 46, released: 0, packed: 0, shipped: 0, returned: 0 } }),
  n('CELL', 32, { code: 'BLK 50', workOrderId: WO2, reach: 'POSSIBLE', cell: { colourwayCode: 'BLK', size: '50', quantity: 38, released: 38, packed: 0, shipped: 18, returned: 0 } }),
  n('BUNDLE', 40, { code: 'DEMO-BN-0001', holdKind: 'Bundle', hold: 'HOLDABLE', state: 'ACTIVE', workOrderId: WO1, bundle: { quantity: 12, part: null } }),
  n('BUNDLE', 41, { code: 'DEMO-BN-0002', holdKind: 'Bundle', hold: 'NOT_HOLDABLE', state: 'VOID', workOrderId: WO1, problem: 'Bundle DEMO-BN-0002 is VOID: only an active bundle is held.', bundle: { quantity: 12, part: null } }),
  n('SHIPMENT', 50, { code: 'DEMO-SH-0031', holdKind: 'Shipment', hold: 'HOLDABLE', state: 'PACKED', shipment: { ddtNumbers: [], left: false } }),
  n('SHIPMENT', 51, { code: 'DEMO-SH-0028', holdKind: 'Shipment', hold: 'LEFT', state: 'DELIVERED', reach: 'POSSIBLE', problem: 'Shipment DEMO-SH-0028 has left: what has left is the PPE register\'s (a recall), not a hold\'s.', shipment: { ddtNumbers: ['DEMO-DDT-77/2026'], left: true } }),
  n('CUSTOMER', 60, { code: 'DEMO-C-001', siteId: null, companyId: null, partyName: 'Demo Moto Shop', received: true, reach: 'POSSIBLE' }),
  n('CUSTOMER', 61, { code: 'DEMO-C-002', siteId: null, companyId: null, partyName: 'Demo Rider Store', received: false }),
]
const k = (kind: ImpactNodeView['kind'], idx: number) => (kind === 'LOT' && idx === 1 ? `LOT:${SUSPECT.id}` : `${kind}:${uid('7830', idx)}`)
const EDGES: Genealogy['edges'] = [
  { from: k('LOT', 1), to: k('HIDE', 2), link: 'HIDE_OF', exact: true, quantity: null, uom: null },
  { from: k('LOT', 1), to: k('HIDE', 3), link: 'HIDE_OF', exact: true, quantity: null, uom: null },
  { from: k('HIDE', 2), to: k('WORK_ORDER', 20), link: 'ISSUED', exact: true, quantity: '34', uom: 'FT2' },
  { from: k('LOT', 1), to: k('WORK_ORDER', 21), link: 'ISSUED', exact: false, quantity: '20', uom: 'FT2' },
  { from: k('WORK_ORDER', 20), to: k('CELL', 30), link: 'SIZE', exact: true, quantity: null, uom: null },
  { from: k('WORK_ORDER', 20), to: k('CELL', 31), link: 'SIZE', exact: true, quantity: null, uom: null },
  { from: k('WORK_ORDER', 21), to: k('CELL', 32), link: 'SIZE', exact: false, quantity: null, uom: null },
  { from: k('CELL', 30), to: k('BUNDLE', 40), link: 'BUNDLED', exact: true, quantity: null, uom: null },
  { from: k('CELL', 30), to: k('BUNDLE', 41), link: 'BUNDLED', exact: true, quantity: null, uom: null },
  { from: k('CELL', 30), to: k('SHIPMENT', 50), link: 'SHIPPED', exact: true, quantity: '6', uom: 'PCS' },
  { from: k('CELL', 32), to: k('SHIPMENT', 51), link: 'SHIPPED', exact: false, quantity: '18', uom: 'PCS' },
  { from: k('SHIPMENT', 51), to: k('CUSTOMER', 60), link: 'DELIVERED_TO', exact: false, quantity: null, uom: null },
  { from: k('SHIPMENT', 50), to: k('CUSTOMER', 61), link: 'DELIVERED_TO', exact: true, quantity: null, uom: null },
]
const LEVELS: Genealogy['levels'] = [
  { kind: 'LOT', exact: 1, possible: 0 },
  { kind: 'HIDE', exact: 2, possible: 0 },
  { kind: 'WORK_ORDER', exact: 1, possible: 1 },
  { kind: 'CELL', exact: 2, possible: 1 },
  { kind: 'BUNDLE', exact: 2, possible: 0 },
  { kind: 'SHIPMENT', exact: 1, possible: 1 },
  { kind: 'CUSTOMER', exact: 1, possible: 1 },
]
const STATES: Genealogy['states'] = { material: [{ uom: 'FT2', onHand: '412' }], hidesInStock: 0, garments: { inWork: 86, inStock: 14, packed: 6, shipped: 18, returned: 0 }, customers: 1 }

export const GENEALOGY: Genealogy = {
  start: { type: 'Lot', id: SUSPECT.id, code: SUSPECT.code, companyId: COMPANY_ID, siteId: SITE_ID },
  starts: [{ key: `LOT:${SUSPECT.id}`, kind: 'LOT', id: SUSPECT.id, code: SUSPECT.code }],
  asOf: at(29, 9, 30),
  nodes: NODES,
  edges: EDGES,
  levels: LEVELS,
  gaps: [{ code: 'ISSUED_BY_QUANTITY', severity: 'COARSE', at: k('WORK_ORDER', 21), count: 1 }],
  states: STATES,
  restricted: [],
  sites: [{ id: SITE_ID, code: SITE.code, name: SITE.name, mayPlace: true, quarantinePlaces: [QUARANTINE] }],
  extending: null,
  group: null,
}

/** The same tree, the site without a quarantine place, and one site the person does not hold at. */
export const GENEALOGY_NO_PLACE: Genealogy = { ...GENEALOGY, sites: [{ ...GENEALOGY.sites[0]!, quarantinePlaces: [] }] }
export const GENEALOGY_OTHER_SITE: Genealogy = { ...GENEALOGY, sites: [{ ...GENEALOGY.sites[0]!, mayPlace: false }], restricted: [{ permission: 'quality.holds.view', nodes: 2 }, { permission: 'parties.view', nodes: 1 }] }
export const GENEALOGY_NOTHING: Genealogy = { ...GENEALOGY, nodes: [NODES[0]!], edges: [], levels: [{ kind: 'LOT', exact: 1, possible: 0 }], gaps: [], states: { material: [{ uom: 'FT2', onHand: '412' }], hidesInStock: 0, garments: { inWork: 0, inStock: 0, packed: 0, shipped: 0, returned: 0 }, customers: 0 } }

export const GROUP: HoldGroup = {
  id: uid('7840', 1),
  sourceType: 'Lot',
  sourceId: SUSPECT.id,
  sourceCode: SUSPECT.code,
  reasonCode: 'SUPPLIER_CHECK',
  reasonNote: 'The demo tannery warned of a dye batch',
  counts: { Lot: 1, Hide: 1, WorkOrder: 2, Shipment: 1, garments: 126, shippedGarments: 18, customers: 2 },
  placedAt: at(29, 9, 40),
  placedBy: 'USER',
  version: 2,
  holds: [
    { id: HOLDS[0]!.id, number: HOLDS[0]!.number, subjectType: 'Lot', count: 3, status: 'ACTIVE', siteCode: SITE.code },
    { id: HOLDS[1]!.id, number: HOLDS[1]!.number, subjectType: 'WorkOrder', count: 2, status: 'ACTIVE', siteCode: SITE.code },
    { id: HOLDS[5]!.id, number: HOLDS[5]!.number, subjectType: 'Shipment', count: 1, status: 'ACTIVE', siteCode: SITE.code },
  ],
}
export const GENEALOGY_EXTEND: Genealogy = { ...GENEALOGY, extending: { holdId: HOLDS[0]!.id, number: HOLDS[0]!.number, status: 'ACTIVE', groupId: GROUP.id }, group: GROUP }

export const AFFECTED: Affected = { holdId: HOLDS[0]!.id, traced: 1, of: 1, traceable: true, ...GENEALOGY, group: GROUP, extend: { start: { type: 'Lot', id: SUSPECT.id, code: SUSPECT.code }, held: null } }
export const AFFECTED_READ_ONLY: Affected = { ...AFFECTED, extend: { start: null, held: 'NO_RIGHT' } }
export const AFFECTED_PARCELS: Affected = { ...AFFECTED, traceable: false, traced: 0, of: 2, nodes: [], edges: [], levels: [], gaps: [], group: null, extend: { start: null, held: 'KIND' }, states: { material: [], hidesInStock: 0, garments: { inWork: 0, inStock: 0, packed: 0, shipped: 0, returned: 0 }, customers: 0 } }
/** A hold in the group (its number, a link back). */
export const IN_GROUP: Hold = { ...HOLDS[0]!, group: { id: GROUP.id, sourceType: 'Lot', sourceId: SUSPECT.id, sourceCode: SUSPECT.code }, nextStep: 'INVESTIGATING' }
