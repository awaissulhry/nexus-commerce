import { CHECKLIST_ITEMS } from '@nexus/factory-domain/quality/final/rules'
import type { Lot } from '../../_shared/lots'
import { COMPANY_ID, ME, SITE_ID, at, uid } from '../../_shared/fixtures'
import type { FinalCell, FinalState, GateCheck, Inspection, InspectionRead, InspectionRow, Inspectors, PickedDefect, Release, ReleaseDetail, ReleaseRule, ReturnPick, ReturnRecord, WorkOrderCells, WorkOrderPick } from '../api'
import type { Evidence } from '../../evidence/api'

/**
 * Design-only made-up data of Inspections (SCR-075), the inspection record (SCR-076) and the evidence trail: Demo work
 * orders (DEMO-WO-…), inspections (DEMO-INS-…), releases (DEMO-REL-…), lots (DEMO-LOT-…), a Demo jacket style and Demo
 * customers. No real company, person, certificate or result. No designScreen here: the screens' own fixtures use it.
 */

const WORKER = uid('5501', 1)
const OTHER_USER = uid('3333', 9)
const WO = { a: uid('6601', 1), b: uid('6601', 2), c: uid('6601', 3), d: uid('6601', 4) }
const CELL = { a50: uid('6611', 1), a52: uid('6611', 2), a54: uid('6611', 3), b48: uid('6611', 4) }

const floor = { kind: 'FLOOR' as const, workerId: WORKER, userId: null }
const office = (userId: string) => ({ kind: 'OFFICE' as const, workerId: null, userId })

const row = (n: number, over: Partial<InspectionRow>): InspectionRow => ({
  id: uid('7701', n),
  inspectionNumber: `DEMO-INS-${String(n).padStart(4, '0')}`,
  label: `DEMO-INS-${String(n).padStart(4, '0')}`,
  workOrderId: WO.a,
  number: 'DEMO-WO-0142',
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  status: 'PASSED',
  lotSize: 48,
  sampleSize: 8,
  computedResult: 'PASS',
  overridden: false,
  inspector: floor,
  released: 0,
  reversed: 0,
  toRelease: 0,
  onHold: false,
  holdWords: null,
  assigned: null,
  holds: 0,
  ncrs: 0,
  undecided: false,
  version: 3,
  decidedAt: at(27, 10, 42),
  createdAt: at(27, 9, 15),
  ...over,
})

export const ROWS: InspectionRow[] = [
  row(12, { status: 'OPEN', computedResult: null, decidedAt: null, inspector: office(ME), assigned: { kind: 'USER', userId: ME, workerId: null, name: 'Demo Person' }, createdAt: at(29, 8, 40), number: 'DEMO-WO-0151', workOrderId: WO.d, lotSize: 24, sampleSize: 5 }),
  row(11, { status: 'OPEN', computedResult: null, decidedAt: null, assigned: { kind: 'WORKER', userId: null, workerId: WORKER, name: null }, createdAt: at(29, 8, 5), number: 'DEMO-WO-0149', workOrderId: WO.c, lotSize: 12, sampleSize: 3 }),
  row(13, { status: 'OPEN', computedResult: null, decidedAt: null, inspector: office(OTHER_USER), createdAt: at(29, 7, 50), number: 'DEMO-WO-0152', workOrderId: WO.d, lotSize: 10, sampleSize: 3 }),
  row(10, { released: 30, toRelease: 18, decidedAt: at(28, 16, 5), createdAt: at(28, 15, 0) }),
  row(9, { number: 'DEMO-WO-0147', workOrderId: WO.b, status: 'FAILED', computedResult: 'FAIL', onHold: true, holdWords: 'x', undecided: true, decidedAt: at(28, 11, 20), createdAt: at(28, 10, 0), lotSize: 20, sampleSize: 5 }),
  row(14, { number: 'DEMO-WO-0144', workOrderId: WO.b, status: 'FAILED', computedResult: 'FAIL', onHold: true, holdWords: 'x', holds: 1, ncrs: 1, decidedAt: at(27, 11, 20), createdAt: at(27, 10, 0), lotSize: 16, sampleSize: 5 }),
  row(8, { number: 'DEMO-WO-0139', released: 12, reversed: 4, onHold: true, holdWords: 'x', decidedAt: at(26, 9, 30), createdAt: at(26, 8, 50), lotSize: 12, sampleSize: 3, inspector: office(OTHER_USER) }),
  row(7, { number: 'DEMO-WO-0137', overridden: true, released: 0, toRelease: 10, computedResult: 'FAIL', lotSize: 10, sampleSize: 3, decidedAt: at(25, 14, 5), createdAt: at(25, 13, 10) }),
  row(6, { number: 'DEMO-WO-0133', released: 36, decidedAt: at(22, 11, 0), createdAt: at(22, 10, 15), lotSize: 36, sampleSize: 8 }),
  row(5, { number: 'DEMO-WO-0130', status: 'CANCELLED', computedResult: null, decidedAt: null, createdAt: at(21, 9, 0), lotSize: 6, sampleSize: 2 }),
  row(4, { inspectionNumber: null, label: 'DEMO-WO-0121 · inspection 1', number: 'DEMO-WO-0121', released: 60, decidedAt: at(14, 10, 0), createdAt: at(14, 9, 0), lotSize: 60, sampleSize: 13 }),
]

export const certificate = { id: uid('8801', 1), number: 'CERT-DEMO-0001', standard: 'EN 17092-4:2020', ppeClass: 'AA', statusNow: 'VALID', validTo: '2029-03-12' }

const release = (n: number, over: Partial<Release>): Release => ({
  id: uid('7801', n),
  releaseNumber: `DEMO-REL-${String(n).padStart(4, '0')}`,
  workOrderId: WO.a,
  number: 'DEMO-WO-0142',
  workOrderSizeId: CELL.a52,
  inspectionId: uid('7701', 10),
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  quantity: 12,
  reversed: 0,
  onHold: 0,
  releasedBy: office(ME),
  releasedAt: at(28, 16, 30),
  signatureSha256: 'a3f1c0d29b8e7f6a5d4c3b2a19f8e7d6c5b4a3928170615f4e3d2c1b0a998877',
  secondPerson: { reasons: [], words: 'x' },
  certificates: [certificate],
  serials: [],
  reversals: [],
  note: null,
  ...over,
})

export const RELEASES: Release[] = [
  release(3, {
    number: 'DEMO-WO-0139',
    workOrderId: WO.c,
    inspectionId: uid('7701', 8),
    quantity: 12,
    reversed: 4,
    onHold: 4,
    releasedBy: office(OTHER_USER),
    releasedAt: at(26, 11, 0),
    reversals: [
      { id: uid('7901', 1), quantity: 4, reasonCode: 'DEFECT_FOUND_LATER', reason: 'A stitch run on the left sleeve found at packing; back to rework.', serialIds: [], serialsTo: null, reversedById: ME, reversedAt: at(27, 15, 5), onHold: true },
    ],
  }),
  release(2, {
    number: 'DEMO-WO-0121',
    inspectionId: uid('7701', 4),
    quantity: 20,
    reversed: 2,
    onHold: 0,
    releasedBy: floor,
    releasedAt: at(14, 11, 0),
    secondPerson: { reasons: ['CUSTOMER'], words: 'x' },
    serials: [
      { id: uid('7951', 1), serial: 'DEMO-SN-0121-001', status: 'SHIPPED', packed: true },
      { id: uid('7951', 2), serial: 'DEMO-SN-0121-002', status: 'MADE', packed: false },
      { id: uid('7951', 3), serial: 'DEMO-SN-0121-003', status: 'VOID', packed: false },
    ],
    reversals: [
      { id: uid('7901', 2), quantity: 2, reasonCode: 'CUSTOMER_COMPLAINT', reason: 'Demo customer reported a zip that does not close.', serialIds: [uid('7951', 2), uid('7951', 3)], serialsTo: 'MADE', reversedById: OTHER_USER, reversedAt: at(16, 9, 0), onHold: false },
    ],
  }),
]

export const RELEASE_DETAIL: ReleaseDetail = {
  release: RELEASES[0]!,
  reverseImpact: { reversible: 6, onDraft: 0, packed: 2, shipped: 0, words: 'x' },
  registerEntries: [{ id: uid('8901', 1), reference: 'REG-DEMO-0007', status: 'OPEN', reversalId: uid('7901', 1) }],
}

export const SERIAL_DETAIL: ReleaseDetail = {
  release: release(4, {
    number: 'DEMO-WO-0155',
    quantity: 3,
    serials: [
      { id: uid('7952', 1), serial: 'DEMO-SN-0155-001', status: 'RELEASED', packed: false },
      { id: uid('7952', 2), serial: 'DEMO-SN-0155-002', status: 'RELEASED', packed: false },
      { id: uid('7952', 3), serial: 'DEMO-SN-0155-003', status: 'RELEASED', packed: true },
    ],
  }),
  reverseImpact: { reversible: 2, onDraft: 0, packed: 1, shipped: 0, words: 'x' },
  registerEntries: [],
}

export const SHIPPED_DETAIL: ReleaseDetail = {
  release: release(5, { number: 'DEMO-WO-0133', quantity: 36, releasedAt: at(22, 12, 0) }),
  reverseImpact: { reversible: 0, onDraft: 0, packed: 0, shipped: 36, words: 'x' },
  registerEntries: [],
}

const lot = (n: number, over: Partial<Lot>): Lot => ({
  id: uid('9901', n),
  code: `DEMO-LOT-${String(n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  item: { id: uid('9911', n), code: 'DEMO-LEA-BLK', name: 'Demo cowhide 1.2 mm black', kind: 'LEATHER', isPpeComponent: false },
  itemColourId: null,
  supplierId: uid('9921', 1),
  supplierLotRef: null,
  dyeBatch: null,
  shade: null,
  receivedAt: at(20, 9, 0),
  receivedById: OTHER_USER,
  receipt: { id: uid('9931', n), number: `DEMO-GR-${String(n).padStart(4, '0')}`, status: 'POSTED' },
  qualityStatus: 'QUARANTINE',
  qualityNote: null,
  qualityDecidedAt: null,
  qualityDecidedById: null,
  hold: null,
  crVi: { required: true, status: 'PENDING', limitMgKg: '3.000', valueMgKg: null, evidence: null, testedOn: null },
  words: 'x',
  version: 1,
  ...over,
})

export const LOTS: Lot[] = [
  lot(31, {}),
  lot(29, { qualityStatus: 'BLOCKED', crVi: { required: true, status: 'FAIL', limitMgKg: '3.000', valueMgKg: '3.400', evidence: 'LOT_REPORT', testedOn: '2026-10-24' }, qualityNote: 'Chromium VI FAIL on later evidence.' }),
  lot(27, { item: { id: uid('9911', 27), code: 'DEMO-PROT-L2', name: 'Demo elbow protector level 2', kind: 'COMPONENT', isPpeComponent: true }, crVi: { required: false, status: 'NOT_REQUIRED', limitMgKg: null, valueMgKg: null, evidence: null, testedOn: null }, hold: 'Two boxes wet on arrival: check before use.' }),
]

export const RULE: ReleaseRule = {
  companyId: COMPANY_ID,
  inForce: { rule: 'WHEN_REQUIRED', source: 'DEFAULT', words: 'x' },
  own: { releaseFourEyes: null, secondPersonPartyIds: [uid('4401', 1)], updatedAt: at(20, 10, 0) },
  version: 3,
  customers: [
    { id: uid('4401', 1), code: 'DEMO-MOTO', name: 'Demo Moto S.r.l.', listedOn: 'COMPANY' },
    { id: uid('4401', 2), code: 'ESEMPIO-RACING', name: 'Esempio Racing S.p.A.', listedOn: 'TENANT' },
  ],
}

export const WORK_ORDERS: WorkOrderPick[] = [
  { id: WO.d, number: 'DEMO-WO-0151', batchNumber: 'DEMO-BT-0151', status: 'IN_PROGRESS', companyId: COMPANY_ID, siteId: SITE_ID, siteCode: 'NORD', styleCode: 'DEMO-JKT', styleName: 'Demo touring jacket', colourways: ['BLK'], pieces: 40, dueDate: '2026-11-05' },
  { id: WO.a, number: 'DEMO-WO-0142', batchNumber: 'DEMO-BT-0142', status: 'COMPLETED', companyId: COMPANY_ID, siteId: SITE_ID, siteCode: 'NORD', styleCode: 'DEMO-JKT', styleName: 'Demo touring jacket', colourways: ['BLK', 'RED'], pieces: 48, dueDate: '2026-10-30' },
]

export const WO_CELLS: WorkOrderCells = {
  id: WO.d,
  number: 'DEMO-WO-0151',
  style: { id: uid('6621', 1), code: 'DEMO-JKT', name: 'Demo touring jacket' },
  cells: [
    { id: CELL.a50, colourwayCode: 'BLK', size: '50', quantity: 20, progress: { finished: 14 } },
    { id: CELL.a52, colourwayCode: 'BLK', size: '52', quantity: 20, progress: { finished: 10 } },
  ],
  pieces: 40,
}

// ---- one inspection -----------------------------------------------------------------------------------------------------------

const answers = (count: number, failed: readonly string[] = []) =>
  CHECKLIST_ITEMS.slice(0, count).map((item) => ({ code: item.code, ok: failed.includes(item.code) ? false : item.code === 'REFLECTIVES' ? null : true, note: failed.includes(item.code) ? 'Fibre label sewn upside down on 2 garments.' : null }))

export const INSPECTION: Inspection = {
  id: uid('7701', 12),
  inspectionNumber: 'DEMO-INS-0012',
  label: 'DEMO-INS-0012',
  workOrderId: WO.d,
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  status: 'OPEN',
  plan: { lotSize: 24, sampleSize: 5, inspectionLevel: 'II', aqlMajor: '2.500', aqlMinor: '4.000', acceptMajor: 0, acceptMinor: 1, hundredPercent: false },
  checklist: answers(7),
  defects: [
    { id: uid('7721', 1), defectClass: 'MINOR', code: 'THREAD-END', defectCodeId: uid('7731', 1), zone: 'COLLAR', description: null, quantity: 1, workOrderSizeId: CELL.a50, note: 'Loose thread end at the collar.' },
  ],
  counts: { critical: 0, major: 0, minor: 1 },
  computed: { result: 'PASS', words: 'x' },
  overridden: false,
  overrideReason: null,
  inspector: office(ME),
  assigned: null,
  notMakerStatement: false,
  decidedAt: null,
  signatureSha256: null,
  note: null,
  version: 4,
  createdAt: at(29, 8, 40),
}

export const readOf = (inspection: Inspection, over: Partial<InspectionRead> = {}): InspectionRead => ({
  inspection,
  workOrder: { id: inspection.workOrderId, number: 'DEMO-WO-0151', status: 'IN_PROGRESS', batchNumber: 'DEMO-BT-0151' },
  maker: { made: false, words: 'x' },
  statementNeeded: false,
  yours: true,
  ...over,
})

export const ANSWERED: Inspection = { ...INSPECTION, checklist: answers(12), version: 9 }
export const FAILING_BY_COUNTS: Inspection = { ...ANSWERED, defects: [{ id: uid('7721', 2), defectClass: 'MAJOR', code: 'STITCH-SKIP', defectCodeId: uid('7731', 2), zone: 'SLEEVE_L', description: null, quantity: 2, workOrderSizeId: CELL.a52, note: null }], counts: { critical: 0, major: 2, minor: 0 }, computed: { result: 'FAIL', words: 'x' } }
export const FAILING_HARD: Inspection = { ...ANSWERED, checklist: answers(12, ['FIBRE_COMPOSITION']), computed: { result: 'FAIL', words: 'x' } }
export const PASSED: Inspection = { ...ANSWERED, id: uid('7701', 10), inspectionNumber: 'DEMO-INS-0010', label: 'DEMO-INS-0010', workOrderId: WO.a, status: 'PASSED', plan: { ...ANSWERED.plan, lotSize: 48, sampleSize: 8 }, decidedAt: at(28, 16, 5), signatureSha256: 'b7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3a2918070f6e5d4c3b2a190', version: 11, createdAt: at(28, 15, 0) }
export const FAILED: Inspection = { ...FAILING_HARD, id: uid('7701', 9), inspectionNumber: 'DEMO-INS-0009', label: 'DEMO-INS-0009', status: 'FAILED', decidedAt: at(28, 11, 20), signatureSha256: 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2', inspector: floor }
export const CANCELLED: Inspection = { ...INSPECTION, id: uid('7701', 5), inspectionNumber: 'DEMO-INS-0005', label: 'DEMO-INS-0005', status: 'CANCELLED' }

const check = (code: GateCheck['code'], state: GateCheck['state'], message: string, fix: string | null = null): GateCheck => ({ code, state, message, fix })
const okChecks = (cell: string, releasable: number): GateCheck[] => [
  check('WORK_ORDER', 'OK', 'Work order DEMO-WO-0142 is completed.'),
  check('INSPECTION', 'OK', 'DEMO-INS-0010 PASSED.'),
  check('QUANTITY', releasable > 0 ? 'OK' : 'OPEN', releasable > 0 ? `${releasable} garment(s) of ${cell} can be released from this inspection.` : `${cell} has 0 garment(s) left to release.`, releasable > 0 ? null : 'Release fewer garments.'),
  check('SERIALS', 'NOT_NEEDED', 'The style traces its garments by batch: no serial is named.'),
  check('LABELS', 'OK', `${cell} has its garment labels printed.`),
  check('CERTIFICATE', 'OK', `Covered: certificate CERT-DEMO-0001 (EN 17092-4:2020, AA) covers ${cell} today; valid until 2029-03-12.`),
  check('DOCUMENTS', 'OK', 'The DoC and the user information of revision 2 are on file in it, en.'),
  check('LOTS', 'OK', 'No material lot the work order took is on hold.'),
  check('MAKER', 'OK', "Made by (from the floor's records): 6 people. You are not among them."),
  check('SECOND_PERSON', 'NOT_NEEDED', 'An inspector who made none of the garments releases alone.'),
]

const cell = (id: string, size: string, pieces: number, released: number, releasable: number, checks: GateCheck[], over: Partial<FinalCell> = {}): FinalCell => ({
  workOrderSizeId: id,
  colourwayCode: 'BLK',
  size,
  pieces,
  released,
  labelsPrinted: pieces,
  releasable,
  readySerials: [],
  summary: 'x',
  checks,
  secondPersonReasons: [],
  ...over,
})

export const FINAL: FinalState = {
  workOrder: { id: WO.a, number: 'DEMO-WO-0142', status: 'COMPLETED', batchNumber: 'DEMO-BT-0142', companyId: COMPANY_ID, siteId: SITE_ID },
  inspectionId: PASSED.id,
  inspections: [{ id: PASSED.id, inspectionNumber: 'DEMO-INS-0010', label: 'DEMO-INS-0010', status: 'PASSED', lotSize: 48, released: 30, overridden: false, decidedAt: at(28, 16, 5) }],
  cells: [
    cell(CELL.a50, '50', 16, 16, 0, okChecks('BLK 50', 0)),
    cell(CELL.a52, '52', 16, 8, 8, okChecks('BLK 52', 8)),
    cell(CELL.a54, '54', 16, 6, 10, [
      ...okChecks('BLK 54', 10).filter((entry) => entry.code !== 'LABELS' && entry.code !== 'DOCUMENTS'),
      check('LABELS', 'OPEN', 'BLK 54 has 6 garment label(s) printed and 6 garment(s) released: no more can be released until 10 more label(s) are printed (QHS-051: labels before packing).', 'Print the garment labels at the final operation first.'),
      check('DOCUMENTS', 'OPEN', 'The user information leaflet for revision 2 is not on file in de (Reg. (EU) 2016/425 art. 8(7), Annex II 1.4).', "Put the signed DoC and leaflet of the style's revision on file (Compliance)."),
    ]),
  ],
  maker: { made: false, words: 'x' },
  documents: [],
  rule: { rule: 'WHEN_REQUIRED', source: 'DEFAULT', words: 'x', customerListed: false },
}

export const FINAL_SECOND: FinalState = {
  ...FINAL,
  cells: FINAL.cells.map((entry, index) =>
    index === 1
      ? {
          ...entry,
          secondPersonReasons: ['CUSTOMER'],
          checks: entry.checks.map((gate) =>
            gate.code === 'SECOND_PERSON'
              ? { ...gate, state: 'OPEN', message: "You signed the result; a second person must release it (the customer's garments always need a second person).", fix: 'Another inspector who made none of the garments releases it.' }
              : gate,
          ),
        }
      : entry,
  ),
  rule: { ...FINAL.rule, customerListed: true },
}

export const FINAL_SERIAL: FinalState = {
  ...FINAL,
  cells: [
    cell(CELL.a52, '52', 4, 1, 2, okChecks('BLK 52', 2).map((gate) => (gate.code === 'SERIALS' ? { ...gate, state: 'OK', message: '2 serial(s) named, made and labelled.' } : gate)), {
      readySerials: [
        { id: uid('7953', 1), serial: 'DEMO-SN-0142-002' },
        { id: uid('7953', 2), serial: 'DEMO-SN-0142-003' },
      ],
    }),
  ],
}

// ---- the evidence trail -----------------------------------------------------------------------------------------------------

export const EVIDENCE: Evidence = {
  subject: {
    kind: 'BATCH',
    serial: null,
    batchNumber: 'DEMO-BT-0142',
    workOrder: { id: WO.a, number: 'DEMO-WO-0142', status: 'COMPLETED', companyId: COMPANY_ID, siteId: SITE_ID, releasedAt: at(3, 8, 0) },
    cells: [
      { workOrderSizeId: CELL.a50, colourwayCode: 'BLK', size: '50', pieces: 16 },
      { workOrderSizeId: CELL.a52, colourwayCode: 'BLK', size: '52', pieces: 16 },
      { workOrderSizeId: CELL.a54, colourwayCode: 'BLK', size: '54', pieces: 16 },
    ],
  },
  style: { id: uid('6621', 1), code: 'DEMO-JKT', name: 'Demo touring jacket', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-4:2020', ppeClass: 'AA', tracking: 'BATCH' },
  revision: { id: uid('6631', 2), revision: 2, status: 'RELEASED', releasedAt: at(2, 9, 0) },
  labelTemplate: { id: uid('6641', 1), code: 'LBL-DEMO-JKT', revision: 2, status: 'ACTIVE', languages: ['it', 'en'] },
  documents: [
    { id: uid('6651', 1), kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 2, status: 'ISSUED', number: 'DOC-DEMO-0002', issuedAt: '2026-10-02', file: { id: uid('6661', 1), sha256: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0' } },
    { id: uid('6651', 2), kind: 'USER_INFORMATION', language: 'it', revision: 2, status: 'ISSUED', number: null, issuedAt: '2026-10-02', file: { id: uid('6661', 2), sha256: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9' } },
  ],
  certificates: {
    today: [
      { workOrderSizeId: CELL.a50, cell: 'BLK 50', words: 'Covered: certificate CERT-DEMO-0001 (EN 17092-4:2020, AA) covers BLK 50 today; valid until 2029-03-12.' },
      { workOrderSizeId: CELL.a52, cell: 'BLK 52', words: 'Covered: certificate CERT-DEMO-0001 (EN 17092-4:2020, AA) covers BLK 52 today; valid until 2029-03-12.' },
      { workOrderSizeId: CELL.a54, cell: 'BLK 54', words: 'Covered: certificate CERT-DEMO-0001 (EN 17092-4:2020, AA) covers BLK 54 today; valid until 2029-03-12.' },
    ],
    date: '2026-10-29',
  },
  lots: [
    {
      id: uid('9901', 21),
      code: 'DEMO-LOT-0021',
      item: { code: 'DEMO-LEA-BLK', name: 'Demo cowhide 1.2 mm black', isPpeComponent: false },
      qualityStatus: 'RELEASED',
      crVi: { required: true, status: 'PASS', valueMgKg: '1.200', limitMgKg: '3.000', evidence: 'LOT_REPORT', testedOn: '2026-10-21' },
      results: [{ id: uid('9941', 1), test: 'CR_VI', method: 'EN ISO 17075-1', valueMgKg: '1.200', belowDetectionLimit: false, limitMgKg: '3.000', verdict: 'PASS', lab: 'Demo Lab', reportNumber: 'LAB-DEMO-0412', testedOn: '2026-10-21', evidence: 'LOT_REPORT', fileId: uid('9951', 1), supersedesId: null }],
      documents: [{ id: uid('9961', 1), kind: 'LWG_CERTIFICATE', fileId: uid('9971', 1), validTo: '2027-06-30', status: 'ACTIVE' }],
    },
    {
      id: uid('9901', 22),
      code: 'DEMO-LOT-0022',
      item: { code: 'DEMO-PROT-L2', name: 'Demo elbow protector level 2', isPpeComponent: true },
      qualityStatus: 'RELEASED',
      crVi: { required: false, status: 'NOT_REQUIRED', valueMgKg: null, limitMgKg: null, evidence: null, testedOn: null },
      results: [],
      documents: [{ id: uid('9961', 2), kind: 'PPE_CERTIFICATE', fileId: uid('9971', 2), validTo: '2028-01-31', status: 'ACTIVE' }],
    },
  ],
  cutting: [
    { id: uid('9981', 1), hideCode: 'DEMO-H-001', lotId: uid('9901', 21), areaUsed: '42.5', uom: 'DM2', reversal: false, at: at(3, 9, 0) },
    { id: uid('9981', 2), hideCode: 'DEMO-H-002', lotId: uid('9901', 21), areaUsed: '40.1', uom: 'DM2', reversal: false, at: at(3, 10, 0) },
  ],
  bundles: [
    { id: uid('9991', 1), code: 'DEMO-B-01', workOrderSizeId: CELL.a50, quantity: 16, part: null, status: 'DONE', madeOn: 'FLOOR', at: at(3, 11, 0) },
    { id: uid('9991', 2), code: 'DEMO-B-02', workOrderSizeId: CELL.a52, quantity: 16, part: null, status: 'DONE', madeOn: 'FLOOR', at: at(3, 11, 5) },
    { id: uid('9991', 3), code: 'DEMO-B-03', workOrderSizeId: CELL.a54, quantity: 16, part: null, status: 'DONE', madeOn: 'FLOOR', at: at(3, 11, 10) },
  ],
  scans: [
    { id: uid('9992', 1), operation: { seq: 10, code: 'SEW-BODY', name: 'Sew the body' }, kind: 'REPORT', good: 48, scrap: 0, rework: 1, corrects: null, at: at(6, 15, 0) },
    { id: uid('9992', 2), operation: { seq: 20, code: 'FIT-ARMOUR', name: 'Fit the armour' }, kind: 'REPORT', good: 47, scrap: 1, rework: 0, corrects: null, at: at(8, 15, 0) },
    { id: uid('9992', 3), operation: { seq: 30, code: 'FINAL', name: 'Final pressing and labels' }, kind: 'REPORT', good: 47, scrap: 0, rework: 0, corrects: null, at: at(10, 15, 0) },
  ],
  inspections: [{ ...PASSED, checklistAnswered: 12 }],
  releases: [release(1, { quantity: 30, releasedAt: at(28, 16, 30) })],
  labelPrints: [{ id: uid('9993', 1), kind: 'PRINT', tracking: 'BATCH', workOrderSizeId: CELL.a52, quantity: 48, batchNumber: 'DEMO-BT-0142', reason: null, postedBy: 'FLOOR', at: at(10, 14, 0) }],
  shipments: [{ id: uid('9994', 1), number: 'DEMO-SH-0091', status: 'SHIPPED', shippedAt: at(29, 8, 0), garments: 18, ddtNumbers: ['DEMO-DDT-0153'] }],
  registerEntries: [],
}

export const EVIDENCE_GAPS: Evidence = {
  ...EVIDENCE,
  documents: EVIDENCE.documents.filter((document) => document.kind !== 'USER_INFORMATION'),
  lots: [{ ...EVIDENCE.lots[0]!, qualityStatus: 'BLOCKED', crVi: { ...EVIDENCE.lots[0]!.crVi, status: 'FAIL', valueMgKg: '3.400' } }, EVIDENCE.lots[1]!],
  registerEntries: [{ id: uid('8901', 3), reference: 'REG-DEMO-0009', kind: 'NON_CONFORMITY', status: 'OPEN', risk: 'ASSESSING', reportedAt: at(28, 10, 0) }],
  shipments: [],
}

export const EVIDENCE_SERIAL: Evidence = {
  ...EVIDENCE,
  subject: { ...EVIDENCE.subject, kind: 'SERIAL', serial: { id: uid('7951', 9), serial: 'DEMO-SN-0142-017', status: 'SHIPPED', bundleId: uid('9991', 2), releaseId: uid('7801', 1) }, cells: [EVIDENCE.subject.cells[1]!] },
  style: { ...EVIDENCE.style!, tracking: 'SERIAL' },
}

// ---- W2a (B-W2a-67): the library's picker, inspectors, a return to inspect -------------------------------------------------------

const CATEGORY = { seam: { id: uid('7730', 1), code: 'SEAM', labelIt: 'Cuciture', labelEn: 'Seams' }, label: { id: uid('7730', 2), code: 'LABEL', labelIt: 'Etichette', labelEn: 'Labels' }, leather: { id: uid('7730', 3), code: 'LEATHER', labelIt: 'Pelle', labelEn: 'Leather' } }
const picked = (n: number, code: string, labelEn: string, labelIt: string, severity: 'CRITICAL' | 'MAJOR' | 'MINOR', zone: string | null, category: (typeof CATEGORY)[keyof typeof CATEGORY]): PickedDefect => ({
  id: uid('7731', n),
  code,
  category,
  labelIt,
  labelEn,
  icon: null,
  colour: null,
  pictureFileId: null,
  severity,
  zone,
  needsDetail: false,
})
export const LIBRARY: PickedDefect[] = [
  picked(1, 'THREAD-END', 'Loose thread end', 'Filo non rifilato', 'MINOR', 'COLLAR', CATEGORY.seam),
  picked(2, 'STITCH-SKIP', 'Skipped stitch', 'Punto saltato', 'MAJOR', 'SLEEVE_L', CATEGORY.seam),
  picked(3, 'SEAM-OPEN', 'Open seam', 'Cucitura aperta', 'MAJOR', null, CATEGORY.seam),
  picked(4, 'LABEL-MISSING', 'Wrong or missing label', 'Etichetta errata o mancante', 'CRITICAL', 'LABEL', CATEGORY.label),
  picked(5, 'GRAIN-CRACK', 'Grain crack', 'Crepa del fiore', 'MAJOR', 'BACK', CATEGORY.leather),
]

export const INSPECTORS: Inspectors = {
  floorListed: true,
  inspectors: [
    { kind: 'USER', id: ME, name: 'Demo Person', me: true, made: [] },
    { kind: 'USER', id: OTHER_USER, name: 'Demo Inspector Two', me: false, made: [] },
    { kind: 'USER', id: uid('3333', 10), name: 'Demo Maker', me: false, made: ['DEMO-WO-0151'] },
    { kind: 'WORKER', id: WORKER, name: 'Demo Bench Inspector', me: false, made: [] },
  ],
}

export const RETURNS: ReturnPick[] = [
  { id: uid('7951', 1), number: 'DEMO-RMA-0007', siteId: SITE_ID, site: { id: SITE_ID, code: 'DEMO-A1' }, party: { id: uid('8101', 1), code: 'DEMO-CUST', legalName: 'Demo Customer S.r.l.' }, units: 3, receivedUnits: 3, receivedAt: at(28, 9, 0) },
]
export const RETURN_RECORD: ReturnRecord = {
  id: uid('7951', 1),
  number: 'DEMO-RMA-0007',
  status: 'RECEIVED',
  version: 4,
  lines: [
    { id: uid('7952', 1), seq: 1, description: 'DEMO-JKT-01 Black 52', serial: 'DEMO-0151-0007', batchNumber: null, quantity: 1, receivedQuantity: 1, safety: true, grade: null, cause: null, conditionNote: null },
    { id: uid('7952', 2), seq: 2, description: 'DEMO-JKT-01 Black 54', serial: null, batchNumber: 'DEMO-BT-0151', quantity: 2, receivedQuantity: 2, safety: false, grade: null, cause: null, conditionNote: null },
  ],
}
