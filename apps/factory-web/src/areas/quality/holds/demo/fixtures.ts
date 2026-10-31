import type { HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { COMPANY_ID, ME, SITE_ID, at, day, uid } from '../../_shared/fixtures'
import type { Hold, HoldCheck, HoldCounts, HoldDetail, HoldPreview, Person } from '../api'

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

/** A hold's record with its release checks. */
export const detailOf = (value: Hold, checks: HoldCheck[] = [ACTIVE_OK, NOT_PLACER_OK], over: Partial<HoldDetail> = {}): HoldDetail => ({
  hold: value,
  workOrders: value.subjectType === 'WorkOrder' ? [{ id: value.subjects[0]!.id, number: value.subjects[0]!.label ?? '', status: 'ON_HOLD', heldFromStatus: 'IN_PROGRESS', holdReason: 'Quality check', heldByThis: true, batchNumber: 'DEMO-B-0142' }] : [],
  release: { checks, releasable: checks.every((entry) => entry.ok || entry.key === 'STATEMENT'), mayRelease: true },
  canChange: value.status === 'ACTIVE',
  ...over,
})

export const DETAIL_READY = detailOf(HOLDS[0]!)
export const DETAIL_PLACER = detailOf(HOLDS[4]!, [ACTIVE_OK, check('NOT_PLACER', false, 'You placed this hold - another person must release it.')])
export const DETAIL_MAKER = detailOf(HOLDS[1]!, [ACTIVE_OK, NOT_PLACER_OK, check('NOT_MAKER', false, 'You made garments of work order DEMO-WO-0142: another person, who made none of them, releases the hold.'), check('REINSPECTION', false, 'Re-inspection signed (now: missing for DEMO-WO-0142).')])
export const DETAIL_STATEMENT = detailOf(HOLDS[3]!, [ACTIVE_OK, NOT_PLACER_OK, check('NOT_MAKER', true, 'You made none of the held garments (the floor records).'), check('STATEMENT', false, 'The floor records name the station only: sign that you made none of the held garments.')])
export const DETAIL_CR_VI = detailOf(HOLDS[6]!, [ACTIVE_OK, NOT_PLACER_OK, check('CR_VI', false, 'Cr VI result PASS (now: DEMO-LOT-0219 FAIL).')])
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
