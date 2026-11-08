import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { HideResult, IncomingRecord, OpenRow, PlanCheck } from './api'
import { componentDraftOf, decisionDefault, hideDraftOf, rollDraftFor, withLineToggled, type DecisionDraft, type MapTool } from './model'
import { IncomingView, type IncomingStep, type IncomingViewModel } from './view/IncomingView'

/**
 * SCR-175's cases (B-W2b-115; design floor.incoming, QHS-025, QHS-028, QHS-032 … QHS-034, QHS-036, QHS-065, MES-054): Scan the lot
 * (the site's open inspections, none, reading, offline, a wrong code, nothing to inspect, another bench's code, several to choose,
 * no permission, the server not answering); a hide lot (fresh, under way with a rejected hide and the lot's area short, offline
 * from this tablet, another inspector's); a hide (the 2-tap path, the area measured short, the hide map with defects, a zone being
 * drawn, a full sample, offline); fabric rolls (the list, a roll within the limit, over the limit, its width to measure); armour,
 * zips and hardware (the lines, a protector in order, one without its certificate); the defect counter of a counted lot; the
 * plan's checks (a choice and a measurement in and out of tolerance); the decision (ready, held with every reason, an override the
 * office makes, a workshop's bundles); the PIN (ready, checking, wrong, locked, offline); signed (released, to sort, a workshop's).
 * Roles: the floor inspector at the inspection bench; an inspector the inspection is not theirs. Made-up data of a "Demo" plant:
 * never a real company, person or number, never money.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const LOT = formatScanId({ type: 'LOT', tenantTag: TAG, ref: 3107 })
const HIDE = (n: number) => formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 7000 + n })
const ROLL = (n: number) => formatScanId({ type: 'ROLL', tenantTag: TAG, ref: 900 + n })
const AT = '2026-11-08T08:41:00.000Z'

const frame = (extra: Partial<IncomingViewModel['frame']> = {}) => signedInFrame('tile.incoming', { station: { name: 'QC-01 · Banco controllo', site: 'Stabilimento Demo Nord' }, ...extra })

const SHADES = [
  { id: 'sh1', label: '1', outOfShade: false, swatchRef: 'Campione NER-1' },
  { id: 'sh2', label: '2', outOfShade: false, swatchRef: 'Campione NER-2' },
  { id: 'sh3', label: '3', outOfShade: false, swatchRef: null },
  { id: 'shx', label: 'Fuori tono', outOfShade: true, swatchRef: null },
]
const GRADES = [
  { id: 'gA', code: 'A', labelIt: 'Prima scelta', labelEn: 'First choice', usableShare: '85.00' },
  { id: 'gB', code: 'B', labelIt: 'Seconda scelta', labelEn: 'Second choice', usableShare: '72.00' },
  { id: 'gC', code: 'C', labelIt: 'Terza scelta', labelEn: 'Third choice', usableShare: '60.00' },
]
const DEFECTS = [
  { id: 'd1', code: 'SCAR', labelIt: 'Cicatrice', labelEn: 'Scar', defectClass: 'MAJOR' as const },
  { id: 'd2', code: 'TICK', labelIt: 'Morso di zecca', labelEn: 'Tick bite', defectClass: 'MINOR' as const },
  { id: 'd3', code: 'HOLE', labelIt: 'Buco', labelEn: 'Hole', defectClass: 'CRITICAL' as const },
  { id: 'd4', code: 'GRAIN', labelIt: 'Fiore rovinato', labelEn: 'Damaged grain', defectClass: 'MINOR' as const },
]
const CERTS = [
  { id: 'c1', number: 'CERT-DEMO-0021', standard: 'EN 1621-1:2012', validTo: '2028-03-31' },
  { id: 'c2', number: 'CERT-DEMO-0022', standard: 'EN 1621-2:2014', validTo: '2027-09-30' },
]

const checks: PlanCheck[] = [
  { id: 'pc-shade', code: 'SHADE', labelIt: 'Tonalità uniforme nel lotto', labelEn: 'Even shade across the lot', type: 'CHOICE', checkClass: 'MAJOR', mandatory: true, photoRequired: false, nominal: null, tolerance: null, uom: null, choices: ['Uniforme', 'Due tonalità', 'Tre o più'], answers: [] },
  { id: 'pc-thick', code: 'THICKNESS', labelIt: 'Spessore', labelEn: 'Thickness', type: 'MEASUREMENT', checkClass: 'MINOR', mandatory: false, photoRequired: false, nominal: '1.200', tolerance: '0.200', uom: 'mm', choices: [], answers: [] },
  { id: 'pc-smell', code: 'SMELL', labelIt: 'Nessun odore anomalo', labelEn: 'No unusual smell', type: 'PASS_FAIL', checkClass: 'MINOR', mandatory: true, photoRequired: false, nominal: null, tolerance: null, uom: null, choices: [], answers: [] },
  { id: 'pc-docs', code: 'DOCS', labelIt: 'Certificato Cr VI allegato al DDT', labelEn: 'Cr VI certificate with the DDT', type: 'PASS_FAIL', checkClass: 'CRITICAL', mandatory: true, photoRequired: false, nominal: null, tolerance: null, uom: null, choices: [], answers: [] },
]

const hide = (n: number, extra: Partial<HideResult> = {}): HideResult => ({
  id: `hr${n}`,
  hideId: `h${n}`,
  code: HIDE(n),
  seq: n,
  state: 'FULL',
  receivedArea: { area: '50.0000', uom: 'FT2' },
  measured: false,
  declaredArea: null,
  measuredArea: '50.0000',
  areaUom: 'FT2',
  areaCheck: null,
  shadeGroup: { id: 'sh1', label: '1', outOfShade: false },
  grade: { id: 'gA', code: 'A' },
  marks: [],
  worstClass: null,
  decision: 'ACCEPTED',
  note: null,
  version: 1,
  ...extra,
})

const SCAR = { kind: 'DEFECT' as const, x: 0.42, y: 0.38, code: 'SCAR', zone: null, outline: [], note: null, defectClass: 'MAJOR' as const, labelIt: 'Cicatrice', labelEn: 'Scar' }
const ZONE_C = { kind: 'ZONE' as const, x: 0.78, y: 0.66, code: null, zone: 'C', outline: [{ x: 0.7, y: 0.58 }, { x: 0.88, y: 0.6 }, { x: 0.86, y: 0.76 }, { x: 0.72, y: 0.74 }], note: null, defectClass: null, labelIt: null, labelEn: null }

const BASE: IncomingRecord = {
  inspection: {
    id: 'iin-2',
    number: 'IIN-DEMO-0002',
    status: 'OPEN',
    subject: 'LOT',
    lotSize: '12.0000',
    uom: 'HIDE',
    byHide: true,
    byRoll: false,
    sampleSize: 5,
    codeLetter: 'B',
    inspectionLevel: 'II',
    acceptMajor: 0,
    acceptMinor: 1,
    found: { critical: 0, major: 0, minor: 0 },
    computedResult: null,
    decision: null,
    decidedAt: null,
    signatureSha256: null,
    cancelledAt: null,
    version: 4,
    createdAt: AT,
  },
  lot: { id: 'lot-1', code: LOT, qualityStatus: 'QUARANTINE', dyeBatch: 'BG-DEMO-77', supplierLotRef: 'CONC-DEMO-0912', item: { id: 'it1', code: 'LEA-BLK-12', name: 'Pelle bovina nera 1,2 mm' }, colour: { id: 'col1', code: 'NER', name: 'Nero' } },
  receipt: null,
  plan: { planId: 'p1', code: 'INC-PELLE', name: 'Pelle, pelle per pelle', versionId: 'pv1', number: 1 },
  sampling: { method: 'AQL', profile: { id: 'pr1', code: 'AQL-STD', name: 'Standard', inspectionLevel: 'II' }, plan: { lotSize: 12, levelText: 'II', codeLetter: 'B', sampleSize: 5, hundredPercent: false } },
  progress: { done: 0, sampleSize: 5, remaining: 5, decided: 0, accepted: 0, rejected: 0, toSort: 0, undecided: 0 },
  result: {
    verdict: 'open',
    classes: [
      { defectClass: 'CRITICAL', accept: 0, reject: 1, found: 0, state: 'ok' },
      { defectClass: 'MAJOR', accept: 0, reject: 1, found: 0, state: 'ok' },
      { defectClass: 'MINOR', accept: 1, reject: 2, found: 0, state: 'ok' },
    ],
    resultNow: 'PASS',
  },
  hides: [],
  rolls: [],
  rollSummary: { rolls: 0, lengthM: '0.00', points: 0, pointsPer100SqYd: null, limit: '40', over: 0, accepted: 0, rejected: 0, toSort: 0, undecided: 0 },
  components: [],
  areaCheck: null,
  checks,
  choices: { shadeGroups: SHADES, grades: GRADES, hideDefects: DEFECTS, fourPointLimit: '40', certificates: CERTS, coveringCertificate: CERTS[0]! },
  candidates: Array.from({ length: 12 }, (_unused, index) => ({ hideId: `h${index + 1}`, code: HIDE(index + 1), state: index === 11 ? 'PARTLY_CUT' : 'FULL', whole: index !== 11, area: '50.0000', areaUom: 'FT2' as const })),
  rollCandidates: [],
  next: null,
  yours: true,
  may: { record: true, decide: true, cancel: true },
}

const withHides = (record: IncomingRecord, hides: readonly HideResult[], extra: Partial<IncomingRecord> = {}): IncomingRecord => {
  const ids = new Set(hides.map((entry) => entry.hideId))
  const count = (decision: string) => hides.filter((entry) => entry.decision === decision).length
  return {
    ...record,
    hides: [...hides],
    candidates: record.candidates.filter((candidate) => !ids.has(candidate.hideId)),
    progress: { done: hides.length, sampleSize: record.inspection.sampleSize, remaining: record.inspection.sampleSize - hides.length, decided: hides.filter((entry) => entry.decision).length, accepted: count('ACCEPTED'), rejected: count('REJECTED'), toSort: count('TO_SORT'), undecided: hides.filter((entry) => !entry.decision).length },
    ...extra,
  }
}

const failing = (record: IncomingRecord): IncomingRecord => ({
  ...record,
  inspection: { ...record.inspection, found: { critical: 0, major: 1, minor: 0 } },
  result: { ...record.result, verdict: 'reject', resultNow: 'FAIL', classes: record.result.classes.map((entry) => (entry.defectClass === 'MAJOR' ? { ...entry, found: 1, state: 'reject' as const } : entry)) },
})

const UNDER_WAY = failing(
  withHides(
    BASE,
    [
      hide(1, { measured: true, measuredArea: '49.5000', areaCheck: { declared: '50.0000', difference: '-0.5000', differencePercent: '-1.00', outcome: 'WITHIN' } }),
      hide(2, { marks: [SCAR, ZONE_C], worstClass: 'MAJOR', grade: { id: 'gC', code: 'C' }, decision: 'REJECTED' }),
      hide(3, { measured: true, measuredArea: '46.0000', areaCheck: { declared: '50.0000', difference: '-4.0000', differencePercent: '-8.00', outcome: 'SHORT' }, shadeGroup: { id: 'sh2', label: '2', outOfShade: false } }),
    ],
    { areaCheck: { uom: 'FT2', tolerancePercent: '2', hides: 2, declared: '100.0000', measuredArea: '95.5000', differencePercent: '-4.50', outcome: 'SHORT', opensClaim: true } },
  ),
)

const ANSWERED = checks.map((check) =>
  check.code === 'SHADE'
    ? { ...check, answers: [{ id: 'a1', sampleIndex: 1, outcome: 'PASS' as const, value: 'Uniforme', note: null }] }
    : check.code === 'THICKNESS'
      ? { ...check, answers: [{ id: 'a2', sampleIndex: 1, outcome: 'PASS' as const, value: '1.25', note: null }] }
      : { ...check, answers: [{ id: `a-${check.code}`, sampleIndex: 1, outcome: 'PASS' as const, value: null, note: null }] },
)

const SAMPLE_DONE = failing(
  withHides(
    { ...UNDER_WAY, checks: ANSWERED },
    [...UNDER_WAY.hides, hide(4, { shadeGroup: { id: 'sh1', label: '1', outOfShade: false } }), hide(5, { shadeGroup: { id: 'sh2', label: '2', outOfShade: false }, grade: { id: 'gB', code: 'B' } })],
  ),
)

const PASSING_DONE = withHides({ ...BASE, checks: ANSWERED }, [hide(1), hide(2), hide(3), hide(4), hide(5)])

// ---- a lot counted in a length: fabric rolls (4-point) ------------------------------------------------------------------------

const ROLL_LOT: IncomingRecord = {
  ...BASE,
  inspection: { ...BASE.inspection, id: 'iin-3', number: 'IIN-DEMO-0003', lotSize: '120.0000', uom: 'M', byHide: false, byRoll: true, sampleSize: 3, codeLetter: null, inspectionLevel: null, acceptMajor: null, acceptMinor: null },
  lot: { ...BASE.lot!, code: formatScanId({ type: 'LOT', tenantTag: TAG, ref: 3110 }), dyeBatch: null, item: { id: 'it2', code: 'LIN-MESH-150', name: 'Fodera rete traspirante' }, colour: { id: 'col2', code: 'GRF', name: 'Grafite' } },
  plan: { planId: 'p2', code: 'INC-TESSUTO', name: 'Tessuto, 4 punti', versionId: 'pv2', number: 2 },
  sampling: { method: 'FIXED', profile: null, plan: null },
  progress: { ...BASE.progress, sampleSize: 3, remaining: 2, done: 1 },
  rolls: [
    { id: 'rr1', rollRef: ROLL(1), roll: { id: 'roll1', code: ROLL(1), state: 'IN_STOCK', supplierRollRef: 'SUP-DEMO-41' }, onePoint: 6, twoPoint: 4, threePoint: 2, fourPoint: 1, points: 24, widthCm: '145.00', lengthM: '60.00', pointsPer100SqYd: '23.07', verdict: { suggested: 'ACCEPTED', over: false }, decision: 'ACCEPTED', version: 1 },
  ],
  rollSummary: { rolls: 1, lengthM: '60.00', points: 24, pointsPer100SqYd: '23.07', limit: '40', over: 0, accepted: 1, rejected: 0, toSort: 0, undecided: 0 },
  hides: [],
  candidates: [],
  checks: [],
  rollCandidates: [
    { rollId: 'roll2', code: ROLL(2), supplierRollRef: 'SUP-DEMO-42', state: 'IN_STOCK', length: '40', uom: 'M', widthCm: '145.00' },
    { rollId: 'roll3', code: ROLL(3), supplierRollRef: null, state: 'IN_STOCK', length: '20', uom: 'M', widthCm: null },
  ],
}

// ---- a lot counted by the piece: components and the counter -------------------------------------------------------------------

const PIECE_LOT: IncomingRecord = {
  ...BASE,
  inspection: { ...BASE.inspection, id: 'iin-4', number: 'IIN-DEMO-0004', lotSize: '24.0000', uom: 'PCS', byHide: false, byRoll: false, sampleSize: 5, acceptMajor: 0, acceptMinor: 1, found: { critical: 0, major: 0, minor: 1 } },
  lot: { ...BASE.lot!, code: formatScanId({ type: 'LOT', tenantTag: TAG, ref: 3120 }), dyeBatch: null, item: { id: 'it3', code: 'PRT-SH-B', name: 'Protezione spalla tipo B' }, colour: null },
  plan: { planId: 'p3', code: 'INC-PROTEZIONI', name: 'Protezioni EN 1621', versionId: 'pv3', number: 1 },
  hides: [],
  candidates: [],
  checks: [],
  components: [
    { id: 'cr1', seq: 1, kind: 'PROTECTOR', marking: 'EN 1621-1:2012 · B', protectorType: 'B', size: null, certificate: CERTS[0]!, certificateCheck: { state: 'VALID' }, checkedQuantity: 5, defectiveQuantity: 0, suggested: 'ACCEPTED', decision: 'ACCEPTED', version: 1 },
    { id: 'cr2', seq: 2, kind: 'ZIP', marking: null, protectorType: null, size: null, certificate: null, certificateCheck: { state: 'NOT_NEEDED' }, checkedQuantity: 5, defectiveQuantity: 1, suggested: 'REJECTED', decision: null, version: 1 },
  ],
}

// ---- goods back from a workshop (QHS-036) ---------------------------------------------------------------------------------------

const WORKSHOP: IncomingRecord = {
  ...BASE,
  inspection: { ...BASE.inspection, id: 'iin-5', number: 'IIN-DEMO-0005', subject: 'WORKSHOP', lotSize: '7.0000', uom: 'PCS', byHide: false, byRoll: false, sampleSize: 3, found: { critical: 0, major: 1, minor: 0 } },
  lot: null,
  receipt: {
    id: 'rc1',
    seq: 1,
    receivedAt: AT,
    order: { id: 'so1', number: 'SC-DEMO-0011', status: 'PARTLY_RECEIVED' },
    workOrder: { id: 'wo1', number: 'WO-DEMO-0042' },
    lots: 7,
    lines: [
      { id: 'l1', seq: 1, operation: { seq: 30, code: 'SEW', name: 'Cucitura' }, bundle: { id: 'b1', code: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 601 }) }, good: 3, defective: 0, scrapped: 0, state: 'HELD' },
      { id: 'l2', seq: 2, operation: { seq: 30, code: 'SEW', name: 'Cucitura' }, bundle: { id: 'b2', code: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 602 }) }, good: 1, defective: 1, scrapped: 0, state: 'HELD' },
      { id: 'l3', seq: 3, operation: { seq: 30, code: 'SEW', name: 'Cucitura' }, bundle: { id: 'b3', code: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 603 }) }, good: 2, defective: 0, scrapped: 0, state: 'HELD' },
    ],
  },
  plan: { planId: 'p4', code: 'INC-TERZISTA', name: 'Rientro da terzista', versionId: 'pv4', number: 1 },
  sampling: { method: 'FIXED', profile: null, plan: null },
  hides: [],
  candidates: [],
  checks: [],
  result: { ...BASE.result, resultNow: 'FAIL', classes: BASE.result.classes.map((entry) => (entry.defectClass === 'MAJOR' ? { ...entry, found: 1, state: 'reject' as const } : entry)) },
}

const OPEN_ROWS: OpenRow[] = [
  { id: 'iin-2', number: 'IIN-DEMO-0002', status: 'OPEN', lot: { id: 'lot-1', code: LOT, qualityStatus: 'QUARANTINE' }, item: { id: 'it1', code: 'LEA-BLK-12', name: 'Pelle bovina nera 1,2 mm' }, receipt: null, lotSize: '12.0000', uom: 'HIDE', sampleSize: 5, done: 3, createdAt: AT },
  { id: 'iin-3', number: 'IIN-DEMO-0003', status: 'OPEN', lot: { id: 'lot-2', code: ROLL_LOT.lot!.code, qualityStatus: 'QUARANTINE' }, item: { id: 'it2', code: 'LIN-MESH-150', name: 'Fodera rete traspirante' }, receipt: null, lotSize: '120.0000', uom: 'M', sampleSize: 3, done: 0, createdAt: AT },
  { id: 'iin-5', number: 'IIN-DEMO-0005', status: 'OPEN', lot: null, item: null, receipt: { id: 'rc1', workOrderId: 'wo1' }, lotSize: '7.0000', uom: 'PCS', sampleSize: 3, done: 0, createdAt: AT },
]

// ---- the steps -----------------------------------------------------------------------------------------------------------------

const at = (step: IncomingStep, extra: Partial<IncomingViewModel> = {}): IncomingViewModel => ({ frame: frame(), online: true, step, done: null, signer: 'Ada Demo', waiting: 0, ...extra })
const offline = { frame: frame({ online: false }), online: false }
const record = (rec: IncomingRecord, section: Extract<IncomingStep, { kind: 'record' }>['section'], extra: Partial<Extract<IncomingStep, { kind: 'record' }>> = {}): IncomingStep => ({ kind: 'record', record: rec, section, asOf: null, decision: decisionDefault(rec), pad: null, ...extra })
const NO_TOOL: MapTool = { kind: 'defect', code: null }
const hideStep = (rec: IncomingRecord, hideId: string, extra: Partial<Extract<IncomingStep, { kind: 'hide' }>> = {}): IncomingStep => ({ kind: 'hide', record: rec, draft: hideDraftOf(rec, hideId)!, sub: 'main', tool: NO_TOOL, zoom: 0, cross: { x: 0.5, y: 0.5 }, ...extra })
const decided = (rec: IncomingRecord, quantities: { accepted: string; rejected: string; toSort: string }, step: NonNullable<IncomingRecord['next']>['step'], extra: Partial<NonNullable<IncomingRecord['next']>> = {}): IncomingRecord => ({
  ...rec,
  inspection: { ...rec.inspection, status: 'DECIDED', decision: quantities, decidedAt: AT, signatureSha256: '9f2c4e7a1b03d6c85e0f9a4b7d21c3e8f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1' },
  next: { step, lotStatus: 'QUARANTINE', rejectedHides: [], toSortHides: [], rejectedRolls: [], rejectedLines: [], ...extra },
})

const freshHide = hideDraftOf(UNDER_WAY, 'h4')!
const SPLIT: DecisionDraft = { accepted: 4, rejected: 1, toSort: 7, rejectedLines: [] }

export const designScreen = defineDesignScreen<IncomingViewModel>({
  screen: 'SCR-175',
  title: 'Incoming inspection (floor.incoming)',
  view: onFloor(IncomingView),
  cases: [
    // ---- Scan the lot ----
    { id: 'scan', label: 'Scan the lot (the site\'s open inspections)', model: at({ kind: 'scan', open: OPEN_ROWS }), note: 'A lot\'s label, the supplier\'s lot, the dye batch, a hide tag or an inspection number opens the inspection with its plan (QHS-065). Rows: no person, keys in the footer\'s icon.' },
    { id: 'scan-none', label: 'Nothing open here', model: at({ kind: 'scan', open: [] }) },
    { id: 'scan-loading', label: 'Reading the open inspections', model: at({ kind: 'scan', open: null }) },
    { id: 'scan-list-failed', label: 'The open inspections could not be read', model: at({ kind: 'scan', open: [], openFailed: true }), note: 'Never "nothing open" when the read failed: the scan still works.' },
    { id: 'scan-offline', label: 'Offline: what opens, what waits', model: at({ kind: 'scan', open: OPEN_ROWS }, offline), note: 'An inspection read in this visit opens from the tablet; a new one needs its number from the office.' },
    { id: 'scan-not-found', label: 'A code nothing has', model: at({ kind: 'scan', open: OPEN_ROWS, wrong: { why: 'notFound', code: 'LT-NOPE-00' } }) },
    { id: 'scan-nothing', label: 'Nothing to inspect (no plan applies)', model: at({ kind: 'scan', open: OPEN_ROWS, wrong: { why: 'nothing', code: LOT } }) },
    { id: 'scan-other-bench', label: 'Another bench\'s label (a bundle)', model: at({ kind: 'scan', open: OPEN_ROWS, wrong: { why: 'otherBench', code: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 77 }) } }) },
    { id: 'loading', label: 'Opening the inspection', model: at({ kind: 'loading', code: LOT }) },
    { id: 'choose', label: 'The code leads to several inspections', model: at({ kind: 'choose', code: 'BG-DEMO-77', choices: [{ target: 'INCOMING', recordType: 'IncomingInspection', id: 'iin-2', number: 'IIN-DEMO-0002' }, { target: 'INCOMING', recordType: 'IncomingInspection', id: 'iin-7', number: 'IIN-DEMO-0007' }, { target: 'FINAL', recordType: 'Inspection', id: 'ins-9', number: 'INS-DEMO-0009' }] }) },
    { id: 'no-permission', label: 'No permission (an operator)', model: at({ kind: 'noPermission' }) },
    { id: 'error', label: 'Server not answering', model: at({ kind: 'problem', problem: { kind: 'unavailable' }, code: LOT }) },
    // ---- Hide by hide ----
    { id: 'hides-fresh', label: 'A hide lot just opened: sample and hides', model: at(record(BASE, 'hides')), note: 'Sample "Inspect 5 of 12 hides" with its bar, the plan and how the sample was drawn (AQL level II, letter B). Scan the first hide, or tap a whole hide of the lot.' },
    { id: 'hides-under-way', label: 'Under way: a rejected hide, the area short', model: at(record(UNDER_WAY, 'hides'), { done: { kind: 'hide', code: HIDE(3), decision: 'ACCEPTED', ticks: 'recorded' } }), note: 'The lot\'s area −4,50 % against the tannery\'s (tolerance 2 %): the office opens the claim. The result in words from the counts.' },
    { id: 'hides-saved-here', label: 'Offline: a hide saved on this tablet', model: at(record(UNDER_WAY, 'hides', { asOf: AT }), { ...offline, done: { kind: 'hide', code: HIDE(3), decision: 'ACCEPTED', ticks: 'saved' } }) },
    { id: 'hides-not-yours', label: 'Another inspector\'s inspection', model: at(record({ ...UNDER_WAY, yours: false, may: { record: false, decide: false, cancel: false } }, 'hides')) },
    { id: 'hide', label: 'A hide: shade tile, then Accept (2 taps)', model: at(hideStep(UNDER_WAY, 'h4', { draft: { ...freshHide, shadeGroupId: 'sh1' } })), note: 'Enter = Accept; Reject in the body. Area and marks on their own step.' },
    { id: 'hide-fresh', label: 'A hide just scanned', model: at(hideStep(UNDER_WAY, 'h4')) },
    { id: 'hide-area', label: 'The area measured: short', model: at(hideStep(UNDER_WAY, 'h4', { draft: { ...freshHide, measuredArea: 46.2 }, sub: 'area' })), note: 'The difference in %, big, in its tone against the tolerance.' },
    { id: 'hide-area-within', label: 'The area measured: within tolerance', model: at(hideStep(UNDER_WAY, 'h4', { draft: { ...freshHide, measuredArea: 49.6 }, sub: 'area' })) },
    { id: 'hide-map', label: 'Hide map: defects', model: at(hideStep(UNDER_WAY, 'h2', { sub: 'map', tool: { kind: 'defect', code: 'TICK' }, cross: { x: 0.42, y: 0.38 } })), note: 'A tap places the defect picked; each mark is also a row of words with Remove. + / − zoom, no pinch; the keys in the info icon.' },
    { id: 'hide-map-pick', label: 'Hide map: pick a defect first', model: at(hideStep(UNDER_WAY, 'h4', { sub: 'map' })) },
    { id: 'hide-map-zone', label: 'Hide map: drawing zone B', model: at(hideStep(UNDER_WAY, 'h2', { sub: 'map', zoom: 1, cross: { x: 0.3, y: 0.6 }, tool: { kind: 'zone', zone: 'B', points: [{ x: 0.2, y: 0.5 }, { x: 0.35, y: 0.52 }] } })) },
    { id: 'hide-offline', label: 'A hide offline (it queues)', model: at(hideStep(UNDER_WAY, 'h4', { draft: { ...freshHide, shadeGroupId: 'sh2' } }), offline) },
    { id: 'hide-sample-full', label: 'Sample full: a 6th hide refused', model: at(record(SAMPLE_DONE, 'hides', { wrong: { why: 'sampleFull', code: HIDE(6) } })) },
    // ---- Fabric rolls ----
    { id: 'rolls', label: 'Fabric rolls: the sample\'s rolls', model: at(record(ROLL_LOT, 'rolls')), note: 'Scan a roll\'s tag, or type the supplier\'s number; the summary from the numbers.' },
    { id: 'roll', label: 'A roll within the limit', model: at({ kind: 'roll', record: ROLL_LOT, draft: { ...rollDraftFor(ROLL_LOT, ROLL(2)), counts: [5, 3, 1, 0] }, sub: 'main' }), note: 'Counters for 1- to 4-point defects; points per 100 sq yd against 40.' },
    { id: 'roll-over', label: 'A roll over the limit: reject suggested', model: at({ kind: 'roll', record: ROLL_LOT, draft: { ...rollDraftFor(ROLL_LOT, 'SUP-DEMO-99'), counts: [10, 8, 4, 6], widthCm: 150, lengthM: 40 }, sub: 'main' }) },
    { id: 'roll-width', label: 'A roll with no width: measure it', model: at({ kind: 'roll', record: ROLL_LOT, draft: rollDraftFor(ROLL_LOT, ROLL(3)), sub: 'main' }) },
    { id: 'roll-width-pad', label: 'The width pad', model: at({ kind: 'roll', record: ROLL_LOT, draft: { ...rollDraftFor(ROLL_LOT, ROLL(3)), widthCm: 145 }, sub: 'width' }) },
    { id: 'rolls-offline', label: 'Rolls offline: held with the reason', model: at(record(ROLL_LOT, 'rolls', { asOf: AT }), offline) },
    // ---- Armour, zips, hardware ----
    { id: 'components', label: 'Armour, zips, hardware: the lines', model: at(record(PIECE_LOT, 'components')) },
    { id: 'component', label: 'A protector line in order', model: at({ kind: 'component', record: PIECE_LOT, draft: { ...componentDraftOf(PIECE_LOT, null), kind: 'PROTECTOR', protectorType: 'B', markingOk: true } }), note: 'Type A or B, its EN 1621 certificate (the one covering the lot first), the marking read, pieces looked at and not right.' },
    { id: 'component-missing', label: 'A protector with no certificate: reject suggested', model: at({ kind: 'component', record: PIECE_LOT, draft: { ...componentDraftOf(PIECE_LOT, null), kind: 'PROTECTOR', certificateId: null, markingOk: false, defective: 1 } }) },
    // ---- the counter ----
    { id: 'counter', label: 'Defects of a counted lot', model: at(record(PIECE_LOT, 'counter')), note: 'Units with a critical, major or minor defect against the plan\'s accept and reject numbers.' },
    // ---- the plan's checks ----
    { id: 'checks', label: 'The plan\'s checks', model: at(record(UNDER_WAY, 'checks')), note: 'Pass / fail on the DS FloorChecklist; a choice and a measurement on their own step.' },
    { id: 'measure-choice', label: 'A choice', model: at({ kind: 'measure', record: UNDER_WAY, checkId: 'pc-shade', value: null, choice: 'Uniforme' }) },
    { id: 'measure-in', label: 'A measurement within tolerance', model: at({ kind: 'measure', record: UNDER_WAY, checkId: 'pc-thick', value: 1.25, choice: null }) },
    { id: 'measure-out', label: 'A measurement out of tolerance', model: at({ kind: 'measure', record: UNDER_WAY, checkId: 'pc-thick', value: 1.5, choice: null }) },
    // ---- the decision ----
    { id: 'decision-held', label: 'Decision held: the sample is not done', model: at(record(UNDER_WAY, 'decision')), note: 'Every reason in words; Sign is held with the first.' },
    { id: 'decision-split', label: 'Decision: a split, ready to sign', model: at(record(SAMPLE_DONE, 'decision', { decision: SPLIT })), note: 'Three pads that add up to the lot: 4 accepted, 1 rejected, 7 to sort.' },
    { id: 'decision-digits', label: 'Decision: typing a quantity', model: at(record(SAMPLE_DONE, 'decision', { decision: SPLIT, pad: 'toSort' })) },
    { id: 'decision-sum', label: 'Decision held: does not add up', model: at(record(SAMPLE_DONE, 'decision', { decision: { ...SPLIT, toSort: 5 } })) },
    { id: 'decision-override', label: 'Decision held: the whole lot over a failing sample', model: at(record(SAMPLE_DONE, 'decision', { decision: { accepted: 12, rejected: 0, toSort: 0, rejectedLines: [] } })), note: 'An override needs written reasons: the office makes it.' },
    { id: 'decision-pass', label: 'Decision: the whole lot accepted', model: at(record(PASSING_DONE, 'decision')) },
    { id: 'decision-waiting', label: 'Decision held: writes still on this tablet', model: at(record(SAMPLE_DONE, 'decision', { decision: SPLIT }), { waiting: 2 }) },
    { id: 'decision-workshop', label: 'Goods back from a workshop: decide by bundle', model: at(record(WORKSHOP, 'decision', { decision: withLineToggled(WORKSHOP, decisionDefault(WORKSHOP), 'l2') })), note: 'Bundle tiles; the pads follow the bundles (no "to sort"); QHS-036.' },
    // ---- the PIN ----
    { id: 'sign', label: 'Sign with the PIN', model: at({ kind: 'sign', record: SAMPLE_DONE, draft: SPLIT }), note: 'What is signed beside the DS PinSignBlock; the sixth digit signs (POST /floor/step-up, then the same decide).' },
    { id: 'sign-busy', label: 'Checking the PIN', model: at({ kind: 'sign', record: SAMPLE_DONE, draft: SPLIT, busy: true }) },
    { id: 'sign-wrong', label: 'Wrong PIN', model: at({ kind: 'sign', record: SAMPLE_DONE, draft: SPLIT, pin: 'wrong' }) },
    { id: 'sign-locked', label: 'Too many wrong PINs', model: at({ kind: 'sign', record: SAMPLE_DONE, draft: SPLIT, pin: 'locked' }) },
    { id: 'sign-offline', label: 'Offline: signing held', model: at({ kind: 'sign', record: SAMPLE_DONE, draft: SPLIT }, offline) },
    // ---- signed ----
    { id: 'done-release', label: 'Signed: the whole lot accepted', model: at({ kind: 'done', record: decided(PASSING_DONE, { accepted: '12', rejected: '0', toSort: '0' }, 'RELEASE') }), note: 'The lot is released by a person with the quality role who types its code (never by the inspection).' },
    { id: 'done-sort', label: 'Signed: a split with hides to sort', model: at({ kind: 'done', record: decided(SAMPLE_DONE, { accepted: '4', rejected: '1', toSort: '7' }, 'SORT', { rejectedHides: [{ hideId: 'h2', code: HIDE(2) }] }) }) },
    { id: 'done-workshop', label: 'Signed: goods back, one bundle rejected', model: at({ kind: 'done', record: decided(WORKSHOP, { accepted: '5', rejected: '2', toSort: '0' }, 'RELEASE_PART', { rejectedLines: [{ id: 'l2', seq: 2, bundleCode: WORKSHOP.receipt!.lines[1]!.bundle!.code, operationCode: 'SEW', pieces: 2 }] }) }) },
  ],
})
