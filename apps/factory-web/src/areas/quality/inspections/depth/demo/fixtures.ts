import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../../shell/office/view/OfficeShellView'
import { COMPANY_ID, ME, ROLE_PERMISSIONS, SITE_ID, at, uid, type RoleCase } from '../../../_shared/fixtures'
import { INSPECTION, PASSED, readOf, ROWS } from '../../demo/fixtures'
import type { Inspection, InspectionRead, InspectionRow } from '../../api'
import type { AqlPlan, Amendments, Cause, Incoming, IncomingRow, Inline, InlineRow, InspectionAql, ProfilePick, Reports, Sheet, WorkOrderPlans } from '../api'

/**
 * B-W2b-127 — design-only made-up data of Inspections in depth: Demo incoming lots (DEMO-LOT-…), in-line checks of Demo work
 * orders, a Demo final plan (DEMO-FIN v2), its sheet, the sample, a correction asked and countersigned, the report's
 * versions and Demo shipments. No real company, person, supplier, result or number.
 */

const OTHER = uid('3333', 9)
const PLAN_ID = uid('9101', 1)
const VERSION_ID = uid('9102', 2)
const SUPPLIER = { id: uid('9201', 1), name: 'Demo Tannery S.p.A.' }

// ---- the list: incoming and in-line rows beside the final ones --------------------------------------------------------------

export const INCOMING_ROWS: IncomingRow[] = [
  { id: uid('9301', 1), number: 'DEMO-IIN-0007', status: 'OPEN', companyId: COMPANY_ID, siteId: SITE_ID, lot: { id: uid('9311', 1), code: 'DEMO-LOT-0231', qualityStatus: 'QUARANTINE' }, item: { id: uid('9321', 1), code: 'DEMO-LEA-100', name: 'Demo cowhide 1.2 mm black' }, receipt: null, lotSize: '12.0000', uom: 'HIDE', sampleSize: 5, done: 2, computedResult: null, decision: null, inspectorKind: 'FLOOR', dueAt: at(30, 12, 0), createdAt: at(29, 9, 10), supplier: SUPPLIER, plan: { code: 'DEMO-INC', number: 1 }, amended: false },
  { id: uid('9301', 2), number: 'DEMO-IIN-0006', status: 'DECIDED', companyId: COMPANY_ID, siteId: SITE_ID, lot: { id: uid('9311', 2), code: 'DEMO-LOT-0229', qualityStatus: 'QUARANTINE' }, item: { id: uid('9321', 1), code: 'DEMO-LEA-100', name: 'Demo cowhide 1.2 mm black' }, receipt: null, lotSize: '12.0000', uom: 'HIDE', sampleSize: 5, done: 5, computedResult: 'FAIL', decision: { accepted: '4.0000', rejected: '1.0000', toSort: '7.0000' }, inspectorKind: 'FLOOR', dueAt: null, createdAt: at(27, 14, 0), supplier: SUPPLIER, plan: { code: 'DEMO-INC', number: 1 }, amended: true },
  { id: uid('9301', 3), number: 'DEMO-IIN-0005', status: 'DECIDED', companyId: COMPANY_ID, siteId: SITE_ID, lot: { id: uid('9311', 3), code: 'DEMO-LOT-0226', qualityStatus: 'RELEASED' }, item: { id: uid('9321', 2), code: 'DEMO-TEX-210', name: 'Demo mesh lining' }, receipt: null, lotSize: '35.5000', uom: 'M', sampleSize: 3, done: 3, computedResult: 'PASS', decision: { accepted: '35.5000', rejected: '0.0000', toSort: '0.0000' }, inspectorKind: 'OFFICE', dueAt: null, createdAt: at(24, 10, 0), supplier: { id: uid('9201', 2), name: 'Demo Textiles S.r.l.' }, plan: { code: 'DEMO-INC', number: 1 }, amended: false },
]

const inlineRow = (n: number, over: Partial<InlineRow>): InlineRow => ({
  id: uid('9401', n),
  kind: 'ROVING',
  status: 'DECIDED',
  outcome: 'GREEN',
  siteId: SITE_ID,
  companyId: COMPANY_ID,
  line: { id: uid('9411', 1), code: 'L1', name: 'Demo line 1' },
  workOrder: { id: uid('6601', 4), number: 'DEMO-WO-0151' },
  bundle: null,
  operation: { id: uid('9421', 1), seq: 30, code: 'SEW', name: 'Demo sewing' },
  pieces: 5,
  defectivePieces: 0,
  defects: 0,
  dhu: '0.0',
  defect: null,
  hasPlan: false,
  // B-W2b-213: no AQL sample to count, no due time, opened by a person (the rows below say otherwise).
  sampleSize: null,
  inspected: null,
  dueAt: null,
  openedByRule: false,
  decidedAt: at(29, 10, 5),
  createdAt: at(29, 10, 5),
  version: 1,
  ...over,
})

export const INLINE_ROWS: InlineRow[] = [
  inlineRow(1, { kind: 'FIRST_PIECE', status: 'OPEN', outcome: null, bundle: { id: uid('9431', 1), code: 'DEMO-BN-0151-01', quantity: 10 }, pieces: 0, dhu: null, hasPlan: true, decidedAt: null, createdAt: at(29, 8, 50) }),
  inlineRow(2, { kind: 'END_OF_LINE', outcome: 'FAIL', bundle: { id: uid('9431', 2), code: 'DEMO-BN-0151-02', quantity: 10 }, pieces: 10, defectivePieces: 2, defects: 3, dhu: '30.0', defect: { id: uid('9441', 1), code: 'STITCH-SKIP', labelIt: 'Punto saltato', labelEn: 'Skipped stitch', critical: false }, createdAt: at(29, 11, 40), decidedAt: at(29, 11, 40) }),
  inlineRow(3, { createdAt: at(28, 15, 20), decidedAt: at(28, 15, 20) }),
  // B-W2b-213: a roving check a rule opened, due in 4 hours, 2 of its AQL sample of 3 counted.
  inlineRow(4, { status: 'OPEN', outcome: null, bundle: { id: uid('9431', 4), code: 'DEMO-BN-0151-04', quantity: 10 }, pieces: 0, dhu: null, hasPlan: true, sampleSize: 3, inspected: 2, dueAt: at(29, 16, 0), openedByRule: true, decidedAt: null, createdAt: at(29, 12, 0) }),
]

/** The final rows with the W2b facts: plan versions, units counted, an amended result. */
export const DEPTH_ROWS: InspectionRow[] = ROWS.map((row, index) =>
  index === 0 ? { ...row, planVersion: { code: 'DEMO-FIN', number: 2 }, inspected: 3 } : index === 3 ? { ...row, planVersion: { code: 'DEMO-FIN', number: 2 }, inspected: 8, amended: true } : row,
)

export const AMENDED_ROWS: InspectionRow[] = DEPTH_ROWS.filter((row) => row.amended)

// ---- the final record on a plan -----------------------------------------------------------------------------------------------

export const PLANNED: Inspection = {
  ...INSPECTION,
  checklist: [],
  planVersion: { id: VERSION_ID, planId: PLAN_ID, code: 'DEMO-FIN', name: 'Demo final jacket', number: 2 },
  codeLetter: 'B',
  inspected: 3,
}

export const PLANNED_SIGNED: Inspection = { ...PASSED, checklist: [], planVersion: PLANNED.planVersion, codeLetter: 'B', inspected: 5, status: 'PASSED' }

export const plannedRead = (inspection: Inspection = PLANNED, over: Partial<InspectionRead> = {}): InspectionRead => readOf(inspection, over)

const result = (n: number, sampleIndex: number, outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE', over: Partial<Sheet['checks'][number]['results'][number]> = {}) => ({
  id: uid('9501', n),
  sampleIndex,
  outcome,
  value: null,
  note: null,
  photos: [] as { id: string; status: string }[],
  recordedBy: 'FLOOR' as const,
  recordedAt: at(29, 9, 30 + n),
  ...over,
})

export const SHEET: Sheet = {
  inspection: { id: PLANNED.id, number: 'DEMO-INS-0012', workOrderId: PLANNED.workOrderId, status: 'OPEN', version: 7, lotSize: 24, sampleSize: 5, codeLetter: 'B', decidedAt: null },
  plan: { planId: PLAN_ID, code: 'DEMO-FIN', name: 'Demo final jacket', versionId: VERSION_ID, number: 2, samplingMethod: 'AQL_PROFILE' },
  checks: [
    { id: uid('9511', 1), code: 'CE_MARK', labelIt: 'Marcatura CE presente', labelEn: 'CE marking present', type: 'PASS_FAIL', checkClass: 'CRITICAL', mandatory: true, photoRequired: false, takesResult: true, onChart: false, choices: [], results: [result(1, 1, 'PASS'), result(2, 2, 'PASS'), result(3, 3, 'PASS')] },
    { id: uid('9511', 2), code: 'ZIP', labelIt: 'Cerniere scorrono', labelEn: 'Zips run freely', type: 'PASS_FAIL', checkClass: 'MAJOR', mandatory: true, photoRequired: false, takesResult: true, onChart: false, choices: [], results: [result(4, 1, 'PASS'), result(5, 2, 'FAIL', { note: 'Left zip catches at the hem.' })] },
    { id: uid('9511', 3), code: 'ARMOUR', labelIt: 'Protezioni della taglia giusta', labelEn: 'Armour fitted, right size', type: 'CHOICE', checkClass: 'CRITICAL', mandatory: true, photoRequired: false, takesResult: true, onChart: false, choices: ['L1', 'L2'], results: [result(6, 1, 'PASS', { value: 'L2', recordedBy: 'OFFICE' })] },
    { id: uid('9511', 4), code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Chest ½', type: 'MEASUREMENT', checkClass: 'MAJOR', mandatory: true, photoRequired: false, takesResult: true, onChart: true, choices: [], results: [] },
    { id: uid('9511', 5), code: 'FRONT', labelIt: 'Foto fronte', labelEn: 'Front photo', type: 'PHOTO', checkClass: null, mandatory: true, photoRequired: false, takesResult: true, onChart: false, choices: [], results: [result(7, 1, 'PASS', { photos: [{ id: uid('9521', 1), status: 'AVAILABLE' }] })] },
    { id: uid('9511', 6), code: 'LABEL', labelIt: 'Etichetta taglia', labelEn: 'Size label', type: 'PASS_FAIL', checkClass: 'MINOR', mandatory: false, photoRequired: true, takesResult: true, onChart: false, choices: [], results: [] },
    { id: uid('9511', 7), code: 'FOLD', labelIt: 'Piegare come da scheda', labelEn: 'Fold as the sheet shows', type: 'INSTRUCTION', checkClass: null, mandatory: false, photoRequired: false, takesResult: false, onChart: false, choices: [], results: [] },
  ],
  checksNow: { answered: 4, outOf: 6, failed: ['ZIP'], failedCritical: [], mandatoryMissing: ['CHEST'] },
  chart: {
    points: [
      {
        pointCode: 'CHEST',
        checkCode: 'CHEST',
        label: 'Chest ½',
        size: '52',
        source: 'PLAN',
        nominal: '58.000',
        tolerance: '1.000',
        uom: 'cm',
        values: [
          { id: uid('9531', 1), size: '52', sampleIndex: 1, measured: '58.400', nominal: '58.000', tolerance: '1.000', pass: true },
          { id: uid('9531', 2), size: '52', sampleIndex: 2, measured: '59.800', nominal: '58.000', tolerance: '1.000', pass: false },
        ],
      },
      {
        pointCode: 'BACK',
        checkCode: null,
        label: 'Back length',
        size: '52',
        source: 'TYPED',
        nominal: '72.000',
        tolerance: '1.500',
        uom: 'cm',
        values: [{ id: uid('9531', 3), size: '52', sampleIndex: 1, measured: '71.500', nominal: '72.000', tolerance: '1.500', pass: true }],
      },
    ],
    values: 3,
    outOfTolerance: 1,
    madeToMeasure: null,
  },
  identity: { mode: 'SERIAL', target: 24, matched: 22, missing: ['DEMO-0151-019'], missingCount: 1, unknown: ['DEMO-0149-004'], noNumber: 0, done: true, ok: false, scans: 23, batchNumber: null },
  photos: {
    slots: [
      { code: 'FRONT', labelIt: 'Foto fronte', labelEn: 'Front photo', mandatory: true, photos: 1, state: 'TAKEN' },
      { code: 'LABEL', labelIt: 'Etichetta taglia', labelEn: 'Size label', mandatory: true, photos: 0, state: 'MISSING' },
    ],
    waiting: [],
    mandatoryMissing: ['LABEL'],
  },
  counter: {
    sampleSize: 5,
    inspected: 3,
    remaining: 2,
    classes: [
      { defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1, found: 0, state: 'ok', spare: 0 },
      { defectClass: 'MAJOR', aql: '2.5', accept: 0, reject: 1, found: 0, state: 'limit', spare: 0 },
      { defectClass: 'MINOR', aql: '4.0', accept: 0, reject: 1, found: 0, state: 'limit', spare: 0 },
    ],
    verdict: 'open',
    stop: { stop: false, source: 'PLAN' },
  },
  result: { resultNow: 'FAIL', byCountsOnly: false },
  sign: { pass: { held: true, reasons: ['x'] }, fail: { held: false, reasons: [] } },
  may: { record: true },
}

export const SHEET_SIGNED: Sheet = { ...SHEET, inspection: { ...SHEET.inspection, status: 'PASSED', decidedAt: at(29, 15, 0) }, may: { record: false } }

export const PHOTO_SRC: Readonly<Record<string, string>> = {}

/** ISO 2859-1 for a lot of 480 at general level II, major 2.5 and minor 4.0 (letter H, sample 50). */
export const AQL_PLAN_480: AqlPlan = {
  lotSize: 480,
  level: 'II',
  levelText: 'II',
  codeLetter: 'H',
  sampleSize: 50,
  hundredPercent: false,
  samplesDiffer: false,
  classes: [
    { defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1, planLetter: null, planSampleSize: null, arrow: null, locked: true },
    { defectClass: 'MAJOR', aql: '2.5', accept: 3, reject: 4, planLetter: 'H', planSampleSize: 50, arrow: null, locked: false },
    { defectClass: 'MINOR', aql: '4.0', accept: 5, reject: 6, planLetter: 'H', planSampleSize: 50, arrow: null, locked: false },
  ],
}

const AQL_PLAN_24: AqlPlan = {
  lotSize: 24,
  level: 'II',
  levelText: 'II',
  codeLetter: 'B',
  sampleSize: 5,
  hundredPercent: false,
  samplesDiffer: true,
  classes: [
    { defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1, planLetter: null, planSampleSize: null, arrow: null, locked: true },
    { defectClass: 'MAJOR', aql: '2.5', accept: 0, reject: 1, planLetter: 'D', planSampleSize: 8, arrow: 'down', locked: false },
    { defectClass: 'MINOR', aql: '4.0', accept: 0, reject: 1, planLetter: 'C', planSampleSize: 5, arrow: 'down', locked: false },
  ],
}

export const AQL: InspectionAql = {
  inspection: { id: PLANNED.id, status: 'OPEN', lotSize: 24, sampleSize: 5, inspectionLevel: 'II', codeLetter: 'B', aqlMajor: '2.500', aqlMinor: '4.000', acceptMajor: 0, acceptMinor: 0, planVersionId: VERSION_ID, version: 7 },
  profile: { id: uid('9601', 1), code: 'AQL-DEMO', name: 'Demo customer profile', active: true },
  chain: {
    profile: { id: uid('9601', 1), code: 'AQL-DEMO', name: 'Demo customer profile', inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0' },
    source: 'CUSTOMER',
    sourceWords: { it: 'Il profilo del cliente Demo Moto', en: "The customer's profile (Demo Moto)" },
    steps: [
      { source: 'PLAN_VERSION', profileId: null, profileCode: null, skipped: 'x' },
      { source: 'STYLE_CUSTOMER', profileId: null, profileCode: null, skipped: 'x' },
      { source: 'STYLE', profileId: null, profileCode: null, skipped: 'x' },
      { source: 'CUSTOMER', profileId: uid('9601', 1), profileCode: 'AQL-DEMO', skipped: null },
    ],
  },
  plan: AQL_PLAN_24,
  matchesProfile: true,
  frozen: true,
  fixedSample: false,
  counts: { critical: 0, major: 0, minor: 1 },
  result: {
    verdict: 'open',
    classes: [
      { defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1, found: 0, state: 'ok', spare: 0 },
      { defectClass: 'MAJOR', aql: '2.5', accept: 0, reject: 1, found: 0, state: 'limit', spare: 0 },
      { defectClass: 'MINOR', aql: '4.0', accept: 0, reject: 1, found: 1, state: 'reject', spare: null },
    ],
    progress: { inspected: 3, sampleSize: 5, remaining: 2 },
    resultNow: 'FAIL',
    byCountsOnly: true,
  },
  mayApply: false,
}

export const AQL_W1: InspectionAql = { ...AQL, profile: null, plan: null, frozen: false, matchesProfile: null, result: { ...AQL.result, progress: null } }
export const AQL_OPEN: InspectionAql = { ...AQL, frozen: false, mayApply: true }

export const PROFILES: ProfilePick[] = [
  { id: uid('9601', 1), code: 'AQL-DEMO', name: 'Demo customer profile', levelText: 'II', aqlMajor: '2.5', aqlMinor: '4.0', isDefault: false, active: true },
  { id: uid('9601', 2), code: 'AQL-STD', name: 'Demo standard', levelText: 'II', aqlMajor: '2.5', aqlMinor: '4.0', isDefault: true, active: true },
  { id: uid('9601', 3), code: 'AQL-TIGHT', name: 'Demo tight', levelText: 'III', aqlMajor: '1.0', aqlMinor: '1.5', isDefault: false, active: true },
]

export const CAUSES: Cause[] = [
  { id: uid('9701', 1), code: 'SEW-ERROR', labelIt: 'Errore di cucitura', labelEn: 'Sewing error', active: true },
  { id: uid('9701', 2), code: 'MAT-FAULT', labelIt: 'Difetto del materiale', labelEn: 'Material fault', active: true },
  { id: uid('9701', 3), code: 'OLD-CODE', labelIt: 'Codice vecchio', labelEn: 'Old code', active: false },
]

// ---- amendments --------------------------------------------------------------------------------------------------------------

const DEFECT_ROW = { type: 'InspectionDefect', id: uid('7721', 3), label: 'MINOR THREAD-END' }

export const AMENDMENTS: Amendments = {
  record: { type: 'Inspection', id: PASSED.id, label: 'DEMO-INS-0010', status: 'PASSED', signed: true, companyId: COMPANY_ID, siteId: SITE_ID, amended: true },
  corrections: [
    {
      id: uid('9801', 1),
      ref: 1,
      field: 'zone',
      fieldWords: 'Garment zone',
      row: DEFECT_ROW,
      before: null,
      after: 'L_ELBOW',
      beforeWords: '',
      afterWords: 'Left elbow',
      reason: 'The zone was left out at the bench.',
      state: 'SIGNED',
      askedBy: { id: OTHER, name: 'Marta Demo' },
      askedAt: at(29, 16, 0),
      signatureSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff',
      mine: false,
      answer: { id: uid('9801', 2), kind: 'SIGNED', by: { id: ME, name: 'Demo Person' }, at: at(29, 16, 20), reason: null, signatureSha256: 'ffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211' },
    },
    {
      id: uid('9801', 3),
      ref: null,
      field: 'note',
      fieldWords: 'Note',
      row: null,
      before: null,
      after: 'Hem re-checked after the zip complaint.',
      beforeWords: '',
      afterWords: 'Hem re-checked after the zip complaint.',
      reason: 'The supervisor asked for the note.',
      state: 'WAITING',
      askedBy: { id: OTHER, name: 'Marta Demo' },
      askedAt: at(30, 9, 0),
      signatureSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mine: false,
      answer: null,
    },
  ],
  fields: [
    { field: 'note', row: null, kind: 'note', words: 'Note', value: null, valueWords: '', nullable: true, amendedBy: null, waiting: uid('9801', 3) },
    { field: 'zone', row: DEFECT_ROW, kind: 'zone', words: 'Garment zone', value: 'L_ELBOW', valueWords: 'Left elbow', nullable: true, amendedBy: uid('9801', 2), waiting: null },
    { field: 'causeCodeId', row: DEFECT_ROW, kind: 'cause', words: 'Cause', value: null, valueWords: '', nullable: true, amendedBy: null, waiting: null },
    { field: 'measured', row: { type: 'InspectionMeasurement', id: uid('9531', 1), label: 'CHEST 52 unit 1' }, kind: 'decimal', words: 'Measured', value: '58.400', valueWords: '58.4 cm', nullable: false, amendedBy: null, waiting: null },
  ],
  waiting: 1,
  may: { request: true, sign: true },
}

export const AMENDMENTS_MINE: Amendments = { ...AMENDMENTS, corrections: AMENDMENTS.corrections.map((entry) => (entry.state === 'WAITING' ? { ...entry, mine: true, askedBy: { id: ME, name: 'Demo Person' } } : entry)) }
export const AMENDMENTS_NONE: Amendments = { ...AMENDMENTS, record: { ...AMENDMENTS.record, amended: false }, corrections: [], fields: AMENDMENTS.fields.map((field) => ({ ...field, waiting: null, amendedBy: null })), waiting: 0 }

// ---- the report --------------------------------------------------------------------------------------------------------------

export const REPORTS: Reports = {
  inspection: { id: PASSED.id, number: 'DEMO-INS-0010', status: 'PASSED', workOrderId: PASSED.workOrderId, signed: true },
  versions: [
    { id: uid('9901', 2), version: 2, language: 'it', number: null, fileId: uid('9911', 2), createdAt: at(30, 10, 0), createdBy: { id: ME, name: 'Demo Person' } },
    { id: uid('9901', 1), version: 1, language: 'en', number: null, fileId: uid('9911', 1), createdAt: at(29, 17, 0), createdBy: { id: OTHER, name: 'Marta Demo' } },
  ],
  shipments: [
    { id: uid('9921', 1), number: 'DEMO-SH-0042', status: 'PACKED', customer: 'Demo Moto S.r.l.', shareable: true },
    { id: uid('9921', 2), number: 'DEMO-SH-0043', status: 'DRAFT', customer: 'Demo Moto S.r.l.', shareable: false },
  ],
  shares: [
    { shipmentId: uid('9921', 1), shipmentNumber: 'DEMO-SH-0042', fileId: uid('9931', 1), version: 1, live: false, sharedAt: at(29, 17, 10) },
    { shipmentId: uid('9921', 1), shipmentNumber: 'DEMO-SH-0042', fileId: uid('9931', 2), version: 2, live: true, sharedAt: at(30, 10, 5) },
  ],
  ready: { ok: true },
  may: { make: true, share: true },
}

// ---- the incoming and in-line records ---------------------------------------------------------------------------------------

export const INCOMING: Incoming = {
  inspection: { id: INCOMING_ROWS[1]!.id, number: 'DEMO-IIN-0006', status: 'DECIDED', companyId: COMPANY_ID, siteId: SITE_ID, subject: 'LOT', lotSize: '12.0000', uom: 'HIDE', byHide: true, sampleSize: 5, codeLetter: 'B', found: { critical: 0, major: 1, minor: 0 }, computedResult: 'FAIL', overrideReason: null, decision: { accepted: '4.0000', rejected: '1.0000', toSort: '7.0000' }, decidedAt: at(27, 16, 0), signatureSha256: 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf', cancelledAt: null, cancelReason: null, dueAt: null, note: null, version: 9, createdAt: at(27, 14, 0) },
  lot: { id: uid('9311', 2), code: 'DEMO-LOT-0229', qualityStatus: 'QUARANTINE', item: { id: uid('9321', 1), code: 'DEMO-LEA-100', name: 'Demo cowhide 1.2 mm black' }, supplier: SUPPLIER },
  receipt: null,
  plan: { planId: uid('9101', 2), code: 'DEMO-INC', name: 'Demo incoming leather', versionId: uid('9102', 3), number: 1 },
  sampling: { method: 'AQL', profile: { id: uid('9601', 2), code: 'AQL-STD', name: 'Demo standard' }, plan: { ...AQL_PLAN_24, lotSize: 12, codeLetter: 'B', samplesDiffer: false } },
  progress: { done: 5, sampleSize: 5, remaining: 0, decided: 5, accepted: 4, rejected: 1, toSort: 0, undecided: 0 },
  result: { verdict: 'reject', classes: [{ defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1, found: 0, state: 'ok', spare: 0 }, { defectClass: 'MAJOR', aql: '2.5', accept: 0, reject: 1, found: 1, state: 'reject', spare: null }, { defectClass: 'MINOR', aql: '4.0', accept: 0, reject: 1, found: 0, state: 'limit', spare: 0 }], progress: { inspected: 5, sampleSize: 5, remaining: 0 }, resultNow: 'FAIL', byCountsOnly: true },
  hides: [
    { id: uid('9341', 1), hideId: uid('9351', 1), code: 'DEMO-H01', seq: 1, receivedArea: { area: '50.0000', uom: 'FT2' }, measured: true, declaredArea: '50.0000', measuredArea: '49.5000', areaUom: 'FT2', areaCheck: { differencePercent: '-1.00', outcome: 'WITHIN' }, shadeGroup: { id: uid('9361', 1), label: '1', outOfShade: false }, grade: { id: uid('9371', 1), code: 'A' }, marks: [], worstClass: null, decision: 'ACCEPTED', note: null },
    { id: uid('9341', 2), hideId: uid('9351', 2), code: 'DEMO-H02', seq: 2, receivedArea: { area: '50.0000', uom: 'FT2' }, measured: false, declaredArea: null, measuredArea: '50.0000', areaUom: 'FT2', areaCheck: null, shadeGroup: { id: uid('9361', 1), label: '1', outOfShade: false }, grade: { id: uid('9371', 3), code: 'C' }, marks: [{ kind: 'DEFECT', code: 'SCAR', defectClass: 'MAJOR', labelIt: 'Cicatrice', labelEn: 'Scar' }], worstClass: 'MAJOR', decision: 'REJECTED', note: 'Scar across the back.' },
    { id: uid('9341', 3), hideId: uid('9351', 3), code: 'DEMO-H03', seq: 3, receivedArea: { area: '50.0000', uom: 'FT2' }, measured: true, declaredArea: '50.0000', measuredArea: '46.0000', areaUom: 'FT2', areaCheck: { differencePercent: '-8.00', outcome: 'SHORT' }, shadeGroup: { id: uid('9361', 2), label: '2', outOfShade: true }, grade: { id: uid('9371', 2), code: 'B' }, marks: [], worstClass: null, decision: 'ACCEPTED', note: null },
  ],
  areaCheck: { uom: 'FT2', tolerancePercent: '2.00', hides: 2, differencePercent: '-4.50', outcome: 'SHORT', opensClaim: true },
  checks: [{ id: uid('9381', 1), code: 'SHADE', labelIt: 'Tono come il campione', labelEn: 'Shade as the swatch', checkClass: 'MAJOR', mandatory: true, answers: [{ id: uid('9391', 1), sampleIndex: 1, outcome: 'PASS', value: null, note: null }] }],
  next: {
    step: 'SORT',
    words: { it: 'Seleziona le pelli: 1 respinta, 7 da selezionare. Il lotto resta in quarantena finché il laboratorio non lo rilascia.', en: 'Sort the hides: 1 rejected, 7 to sort. The lot stays in quarantine until the lab releases it.' },
    lotStatus: 'QUARANTINE',
    rejectedHides: [{ hideId: uid('9351', 2), code: 'DEMO-H02' }],
    toSortHides: [],
    holdPrefill: { subjectType: 'Hide', subjectIds: [uid('9351', 2)], reasonNote: 'x' },
  },
  inspector: { kind: 'FLOOR', name: null, hidden: true },
}

export const INCOMING_OPEN: Incoming = { ...INCOMING, inspection: { ...INCOMING.inspection, id: INCOMING_ROWS[0]!.id, number: 'DEMO-IIN-0007', status: 'OPEN', computedResult: null, decision: null, decidedAt: null, signatureSha256: null }, progress: { ...INCOMING.progress, done: 2, decided: 2, accepted: 1, rejected: 1, remaining: 3 }, hides: INCOMING.hides.slice(0, 2), next: null }

export const INLINE: Inline = {
  ...INLINE_ROWS[1]!,
  plan: null,
  checks: [],
  results: [],
  sample: null,
  suggested: null,
  holdsRun: null,
  inspector: { kind: 'FLOOR', name: null, workerHidden: true, own: false },
  operatorHidden: true,
  operator: null,
  signatureSha256: null,
  cancelledAt: null,
  cancelReason: null,
  note: 'Two jackets back to sewing.',
}

export const INLINE_FIRST: Inline = {
  ...INLINE_ROWS[0]!,
  plan: { versionId: uid('9102', 4), planId: uid('9101', 3), code: 'DEMO-INL', name: 'Demo first piece', number: 1 },
  checks: [
    { id: uid('9451', 1), code: 'SEAM', labelIt: 'Cucitura dritta', labelEn: 'Seam straight', type: 'PASS_FAIL', checkClass: 'CRITICAL', mandatory: true, nominal: null, tolerance: null, uom: null },
    { id: uid('9451', 2), code: 'SPI', labelIt: 'Punti per pollice', labelEn: 'Stitches per inch', type: 'MEASUREMENT', checkClass: 'MAJOR', mandatory: true, nominal: '10.000', tolerance: '1.000', uom: 'pcs' },
  ],
  results: [{ id: uid('9461', 1), code: 'SEAM', sampleIndex: 1, outcome: 'PASS', value: null, note: null, recordedAt: at(29, 9, 0) }],
  sample: null,
  suggested: null,
  holdsRun: true,
  inspector: { kind: 'OFFICE', name: 'Demo Person', workerHidden: false, own: true },
  operatorHidden: false,
  operator: null,
  signatureSha256: null,
  cancelledAt: null,
  cancelReason: null,
  note: null,
}

// ---- New inspection: the plans that apply to a work order ---------------------------------------------------------------------

export const PLANS: WorkOrderPlans = {
  workOrderId: uid('6601', 4),
  plans: [
    { id: PLAN_ID, code: 'DEMO-FIN', name: 'Demo final jacket', approved: { id: VERSION_ID, number: 2 }, matches: true, usable: true, suggested: true },
    { id: uid('9101', 4), code: 'DEMO-PHOTO', name: 'Demo final with photos', approved: { id: uid('9102', 5), number: 1 }, matches: false, usable: true, suggested: false },
  ],
  suggestedId: PLAN_ID,
  sampling: { method: 'AQL_PROFILE', sampleSize: 50, plan: AQL_PLAN_480, named: false },
}

export const PLANS_NONE: WorkOrderPlans = { ...PLANS, plans: [], suggestedId: null, sampling: null }

// ---- the Office shell around a page of this step (the window frame for the report tabs) -----------------------------------------

/** The Office shell around a page as the page sees it: the window frame for a window page (the report tabs). */
export function inDepthShell(path: string, page: ReactNode, role: RoleCase = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}
