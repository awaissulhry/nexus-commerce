import { ANNEX_III_POINTS, POINT_INFO, type AnnexIIIPoint, type ItemState, type PointState } from '@nexus/factory-domain/compliance/techfiles/rules'
import { COMPANY_ID, uid } from '../../../quality/_shared/fixtures'
import type { Assessment, Batch, ControlTest, FileRecord, FileSummary, Item, ListAnswer, Pack, PacksAnswer, Production, Report, ReportsAnswer, RiskAnswer, RiskRow } from '../api'

/**
 * Made-up data shared by the technical files' design cases (SCR-120, SCR-120-file, SCR-326, SCR-327): "Demo" styles (DEMO-…
 * codes), invented certificates, batches, labs, packs and people. Nothing here is a real company, person, number or result.
 * This file exports no `designScreen`: the screens' own fixtures use it.
 */

export const NOW = '2026-11-10T09:42:00.000Z'
export const TODAY = '2026-11-10'
const at = (day: string, time = '09:00') => `${day}T${time}:00.000Z`
const sha = (n: number) => `${String(n).padStart(4, '0')}a9c1e77b04d5e6a8c3b2f1e0d9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a3f2e1d0`

export const PEOPLE = {
  me: { id: uid('7401', 1), name: 'Marta Demo' },
  luca: { id: uid('7401', 2), name: 'Luca Esempio' },
  sara: { id: uid('7401', 3), name: 'Sara Prova' },
}

const style = (n: number, code: string, name: string, ppeCategory: string, ppeClass: string | null) => ({ id: uid('7402', n), code, name, ppeCategory, ppeClass })
export const STYLES = {
  jacket: style(1, 'DEMO-JKT-01', 'Giacca Demo Touring', 'CATEGORY_II', 'AA'),
  trousers: style(2, 'DEMO-TRS-02', 'Pantalone Demo Città', 'CATEGORY_II', 'A'),
  gloves: style(3, 'DEMO-GLV-03', 'Guanto Demo Estate', 'CATEGORY_II', '1KP'),
  suit: style(4, 'DEMO-SUT-04', 'Tuta Demo Pista', 'CATEGORY_III', 'AAA'),
  vest: style(5, 'DEMO-VST-05', 'Gilet Demo Città', 'NOT_PPE', null),
}

const certificate = (n: number, number: string, standard: string, validTo: string) => ({ id: uid('7403', n), number, standard, status: 'VALID', validTo })
export const CERTS = {
  jacket: certificate(1, 'DEMO-CERT-0101', 'EN 17092-3:2020', '2029-03-31'),
  suit: certificate(2, 'DEMO-CERT-0102', 'EN 17092-2:2020', '2027-01-15'),
  gloves: certificate(3, 'DEMO-CERT-0103', 'EN 13594:2015', '2028-06-30'),
}

const summary = (n: number, over: Partial<FileSummary>): FileSummary => ({
  id: uid('7404', n),
  number: `TF-DEMO-${String(n).padStart(4, '0')}`,
  status: 'OPEN',
  companyId: COMPANY_ID,
  style: STYLES.jacket,
  certificate: null,
  certificates: { valid: 1, all: 1 },
  annex: { done: 13, outOf: 13, open: null, missingItems: 0 },
  risk: null,
  testReports: { count: 0, latestOn: null },
  production: { made: 0, withEvidence: 0, missing: 0, failed: 0, inProgress: 0 },
  latestBatch: null,
  keeper: PEOPLE.me,
  lastChangeAt: at('2026-11-07'),
  retainUntil: null,
  retention: 'NOT_SET',
  may: { manage: true, sign: true, share: true },
  version: 4,
  ...over,
})

export const FILES: FileSummary[] = [
  summary(1, {
    style: STYLES.jacket,
    certificate: CERTS.jacket,
    annex: { done: 9, outOf: 13, open: 'B_RISK_ASSESSMENT', missingItems: 2 },
    risk: { id: uid('7405', 2), revision: 2, status: 'DRAFT', signedAt: null },
    testReports: { count: 3, latestOn: '2026-10-21' },
    production: { made: 4, withEvidence: 2, missing: 1, failed: 1, inProgress: 0 },
    latestBatch: { workOrderId: uid('7406', 4), number: 'WO-DEMO-0044', batchNumber: 'LOT-DEMO-0044' },
  }),
  summary(2, {
    style: STYLES.suit,
    status: 'COMPLETE',
    certificate: CERTS.suit,
    certificates: { valid: 1, all: 2 },
    risk: { id: uid('7405', 11), revision: 1, status: 'SIGNED', signedAt: at('2026-09-14') },
    testReports: { count: 5, latestOn: '2026-10-30' },
    production: { made: 6, withEvidence: 6, missing: 0, failed: 0, inProgress: 0 },
    latestBatch: { workOrderId: uid('7406', 12), number: 'WO-DEMO-0039', batchNumber: 'LOT-DEMO-0039' },
    keeper: PEOPLE.luca,
    lastChangeAt: at('2026-10-30'),
  }),
  summary(3, {
    style: STYLES.gloves,
    certificate: CERTS.gloves,
    annex: { done: 4, outOf: 13, open: 'A_DESCRIPTION', missingItems: 6 },
    testReports: { count: 0, latestOn: null },
    production: { made: 1, withEvidence: 0, missing: 0, failed: 0, inProgress: 1 },
    keeper: null,
    lastChangeAt: at('2026-11-02'),
  }),
  summary(4, {
    style: STYLES.trousers,
    status: 'ARCHIVED',
    certificates: { valid: 0, all: 1 },
    risk: { id: uid('7405', 21), revision: 3, status: 'SIGNED', signedAt: at('2016-05-02') },
    testReports: { count: 2, latestOn: '2016-11-20' },
    production: { made: 8, withEvidence: 8, missing: 0, failed: 0, inProgress: 0 },
    retainUntil: '2027-03-31',
    retention: 'ENDS_WITHIN_YEAR',
    lastChangeAt: at('2017-03-31'),
    may: { manage: true, sign: true, share: true },
  }),
  summary(5, {
    style: STYLES.vest,
    annex: { done: 11, outOf: 13, open: 'K_USER_INFORMATION', missingItems: 1 },
    certificates: { valid: 0, all: 0 },
    risk: { id: uid('7405', 31), revision: 1, status: 'SIGNED', signedAt: at('2026-08-01') },
    keeper: PEOPLE.sara,
    lastChangeAt: at('2026-08-01'),
  }),
]

export const LIST: ListAnswer = {
  files: FILES,
  tiles: { complete: 1, withItemsMissing: 3, itemsMissing: 9, batchesWithoutEvidence: 2, retentionEndingInYear: 1, onLegalHold: 0, authorityPacksSentThisYear: 1 },
  mayCreate: true,
  asOf: NOW,
}

// ---- the record of DEMO-JKT-01 ----------------------------------------------------------------------------------------------

let itemN = 0
const item = (point: AnnexIIIPoint, state: ItemState, evidence: Item['evidence'], over: Partial<Item> = {}): Item => ({
  id: uid('7407', ++itemN),
  point,
  seq: 1,
  state,
  evidence,
  note: null,
  reviewedAt: state === 'REVIEWED' || state === 'NOT_APPLICABLE' ? at('2026-11-03', '10:15') : null,
  reviewedBy: state === 'REVIEWED' || state === 'NOT_APPLICABLE' ? PEOPLE.me : null,
  version: 2,
  updatedAt: at('2026-11-03'),
  ...over,
})
const record = (recordType: string, n: number, label: string, state: NonNullable<Item['evidence']>['state'] = 'CURRENT'): Item['evidence'] => ({ kind: 'RECORD', recordType, recordId: uid('7408', n), fileId: null, label, state, words: null })
const fileRef = (n: number, label: string): Item['evidence'] => ({ kind: 'FILE', recordType: 'TechnicalFile', recordId: null, fileId: uid('7409', n), label, state: 'CURRENT', words: null })

const ITEMS: Record<AnnexIIIPoint, Item[]> = {
  A_DESCRIPTION: [item('A_DESCRIPTION', 'REVIEWED', record('Style', 1, 'Style DEMO-JKT-01 Giacca Demo Touring'))],
  B_RISK_ASSESSMENT: [item('B_RISK_ASSESSMENT', 'LINKED', record('ProductRiskAssessment', 2, 'Product risk assessment revision 1', 'SUPERSEDED'))],
  C_REQUIREMENTS: [item('C_REQUIREMENTS', 'REVIEWED', record('ComplianceDocument', 3, 'EU declaration of conformity it revision 2 (DEMO-DOC-0021)'))],
  D_DRAWINGS: [
    item('D_DRAWINGS', 'REVIEWED', record('StyleRevision', 4, 'DEMO-JKT-01 revision 2 (its BOM, routing and construction)')),
    item('D_DRAWINGS', 'LINKED', fileRef(1, 'Disegno tecnico DEMO-JKT-01 rev2.pdf'), { seq: 2 }),
  ],
  E_EXPLANATIONS: [item('E_EXPLANATIONS', 'MISSING', null)],
  F_STANDARDS: [item('F_STANDARDS', 'REVIEWED', record('Certificate', 5, 'Certificate DEMO-CERT-0101 (EN 17092-3:2020)'))],
  G_OTHER_SPECIFICATIONS: [item('G_OTHER_SPECIFICATIONS', 'NOT_APPLICABLE', null, { note: 'Only the harmonised standard is applied.' })],
  H_CALCULATIONS: [item('H_CALCULATIONS', 'REVIEWED', record('ProductionControlTest', 6, 'seam strength PASS (Laboratorio Demo, DEMO-RP-118, 2026-10-21)'))],
  I_TEST_REPORTS: [item('I_TEST_REPORTS', 'REVIEWED', record('Certificate', 5, 'Certificate DEMO-CERT-0101 (EN 17092-3:2020)'))],
  J_PRODUCTION_CONTROL: [item('J_PRODUCTION_CONTROL', 'MISSING', null)],
  K_USER_INFORMATION: [item('K_USER_INFORMATION', 'REVIEWED', record('ComplianceDocument', 7, 'User information it revision 2'))],
  L_SINGLE_UNIT: [item('L_SINGLE_UNIT', 'NOT_APPLICABLE', null, { note: 'Not made to measure.' })],
  M_SERIES_FITTED: [item('M_SERIES_FITTED', 'NOT_APPLICABLE', null, { note: 'Sold in standard sizes only.' })],
}

const pointState = (items: readonly Item[]): PointState => {
  if (items.length === 0) return 'NONE'
  if (items.some((entry) => entry.state === 'MISSING')) return 'MISSING'
  if (items.some((entry) => entry.state === 'LINKED')) return 'LINKED'
  if (items.every((entry) => entry.state === 'NOT_APPLICABLE')) return 'NOT_APPLICABLE'
  return 'REVIEWED'
}

export function recordOf(file: FileSummary, items: Record<AnnexIIIPoint, Item[]> = ITEMS, over: Partial<FileRecord['file']> = {}): FileRecord {
  const points = ANNEX_III_POINTS.map((point) => ({ point, letter: POINT_INFO[point].letter, law: POINT_INFO[point].law, title: { en: POINT_INFO[point].en, it: POINT_INFO[point].it }, state: pointState(items[point]), items: items[point] }))
  return {
    file: { ...file, note: null, completedAt: null, completedBy: null, archivedAt: null, archivedBy: null, archiveReason: null, createdAt: at('2026-09-01'), createdBy: PEOPLE.me, ...over },
    points,
    risk: { signed: { id: uid('7405', 1), revision: 1, signedAt: at('2026-09-20') }, draft: { id: uid('7405', 2), revision: 2 } },
    completeProblems: points.filter((entry) => entry.state !== 'REVIEWED' && entry.state !== 'NOT_APPLICABLE').map((entry) => ({ path: `points/${entry.point}`, message: `Point (${entry.letter}) is not reviewed.` })),
    asOf: NOW,
  }
}

export const OPEN_RECORD = recordOf(FILES[0]!)

const allReviewed = Object.fromEntries(ANNEX_III_POINTS.map((point) => [point, ITEMS[point].map((entry) => (entry.state === 'NOT_APPLICABLE' ? entry : { ...entry, state: 'REVIEWED' as const, reviewedAt: at('2026-10-30'), reviewedBy: PEOPLE.luca, evidence: entry.evidence ?? record('StyleRevision', 4, 'DEMO-SUT-04 revision 1 (its BOM, routing and construction)') }))])) as Record<AnnexIIIPoint, Item[]>
export const COMPLETE_RECORD = recordOf(FILES[1]!, allReviewed, { completedAt: at('2026-10-30', '16:20'), completedBy: PEOPLE.luca })
export const ARCHIVED_RECORD = recordOf(FILES[3]!, allReviewed, { archivedAt: at('2017-03-31'), archivedBy: PEOPLE.luca, archiveReason: 'Style no longer made: last garment sold in March 2017.' })

// ---- the risk assessment ----------------------------------------------------------------------------------------------------

const row = (n: number, over: Partial<RiskRow>): RiskRow => ({
  id: uid('7410', n),
  seq: n,
  hazard: 'ABRASION',
  hazardNote: null,
  garmentZone: 'shoulder',
  intendedUse: 'Road riding in all seasons',
  foreseeableMisuse: 'Worn open at speed',
  control: 'Cowhide 1.2 mm, double-stitched seams',
  standardClause: 'EN 17092-3:2020 6.3',
  standardId: null,
  residualRisk: 'LOW',
  note: null,
  version: 3,
  updatedAt: at('2026-11-05'),
  ...over,
})
export const RISK_ROWS: RiskRow[] = [
  row(1, {}),
  row(2, { hazard: 'IMPACT', garmentZone: 'elbow_l', control: 'Level 2 protector EN 1621-1 in a fixed pocket', standardClause: 'EN 17092-3:2020 6.6' }),
  row(3, { hazard: 'IMPACT', garmentZone: 'elbow_r', control: 'Level 2 protector EN 1621-1 in a fixed pocket', standardClause: 'EN 17092-3:2020 6.6' }),
  row(4, { hazard: 'SEAM_BURST', garmentZone: 'back', control: 'Safety seams, bonded nylon thread', standardClause: 'EN 17092-3:2020 6.4', residualRisk: 'MEDIUM' }),
  row(5, { hazard: 'VISIBILITY', garmentZone: null, foreseeableMisuse: null, control: 'Reflective piping front and back', standardClause: null, residualRisk: 'NEGLIGIBLE' }),
]

const assessment = (n: number, over: Partial<Assessment>): Assessment => ({
  id: uid('7405', n),
  revision: 1,
  status: 'SIGNED',
  classReasoning: 'Class AA: touring use at road speed; zones 1 and 2 in cowhide, zone 3 in Cordura 500D.',
  note: null,
  signedAt: at('2026-09-20', '14:05'),
  signedBy: PEOPLE.luca,
  signedByName: 'Luca Esempio',
  signedByFunction: 'Quality manager',
  supersededAt: null,
  createdBy: PEOPLE.me,
  rows: RISK_ROWS.slice(0, 3),
  version: 5,
  createdAt: at('2026-09-10'),
  updatedAt: at('2026-09-20'),
  ...over,
})

export const RISK: RiskAnswer = {
  technicalFileId: FILES[0]!.id,
  fileStatus: 'OPEN',
  assessments: [
    assessment(1, {}),
    assessment(2, { revision: 2, status: 'DRAFT', signedAt: null, signedBy: null, signedByName: null, signedByFunction: null, rows: RISK_ROWS, version: 7, createdAt: at('2026-11-04'), updatedAt: at('2026-11-05') }),
  ],
  may: { manage: true, sign: true },
  asOf: NOW,
}
export const RISK_SIGNED: RiskAnswer = { ...RISK, assessments: [assessment(1, { status: 'SIGNED', rows: RISK_ROWS })] }
export const RISK_EMPTY: RiskAnswer = { ...RISK, assessments: [] }

// ---- test reports and production ---------------------------------------------------------------------------------------

const report = (n: number, over: Partial<Report>): Report => ({
  source: 'CONTROL_TEST',
  id: uid('7411', n),
  title: 'seam strength',
  reportNumber: `DEMO-RP-${100 + n}`,
  lab: 'Laboratorio Demo',
  standardClause: 'EN 17092-2:2020 6.4',
  sample: '3 jackets, size 50',
  result: 'PASS',
  date: '2026-10-21',
  batchNumber: 'LOT-DEMO-0041',
  file: { id: uid('7412', n), name: `Rapporto DEMO-RP-${100 + n}.pdf`, sha256: sha(n) },
  certificate: { id: CERTS.jacket.id, number: CERTS.jacket.number },
  ...over,
})
export const REPORTS: ReportsAnswer = {
  technicalFileId: FILES[0]!.id,
  reports: [
    report(18, {}),
    report(19, { title: 'pocket retention (armour pocket, elbow)', reportNumber: 'DEMO-RP-119', standardClause: 'EN 17092-3:2020 6.6', date: '2026-10-02', batchNumber: 'LOT-DEMO-0042' }),
    report(20, { title: 'label durability', result: 'FAIL', reportNumber: 'DEMO-RP-120', standardClause: 'EN ISO 6330', date: '2026-09-28', batchNumber: 'LOT-DEMO-0043', sample: '5 labels after 5 washes' }),
    report(21, { source: 'CERTIFICATE_FILE', title: 'Certificate DEMO-CERT-0101', reportNumber: null, lab: null, standardClause: 'EN 17092-3:2020', sample: null, result: null, date: '2026-03-31', batchNumber: null, file: { id: uid('7412', 21), name: 'Certificato DEMO-CERT-0101.pdf', sha256: sha(21) } }),
  ],
  asOf: NOW,
}

const test = (n: number, over: Partial<ControlTest>): ControlTest => ({
  id: uid('7413', n),
  companyId: COMPANY_ID,
  styleId: STYLES.jacket.id,
  workOrder: null,
  batchNumber: null,
  test: 'SEAM_STRENGTH',
  testName: null,
  standardClause: 'EN 17092-2:2020 6.4',
  frequency: 'YEARLY',
  dueOn: '2026-12-01',
  sample: null,
  result: null,
  testedOn: null,
  testedBy: null,
  reportNumber: null,
  resultNote: null,
  labReportFile: null,
  retainUntil: null,
  retention: 'NOT_SET',
  overdue: false,
  note: null,
  version: 1,
  createdAt: at('2026-10-01'),
  updatedAt: at('2026-10-01'),
  ...over,
})

const batch = (n: number, number: string, over: Partial<Batch>): Batch => ({
  workOrder: { id: uid('7406', n), number, batchNumber: number.replace('WO', 'LOT'), status: 'COMPLETED', siteId: uid('7414', 1), releasedAt: at('2026-10-10'), completedAt: at('2026-10-20') },
  done: true,
  inProcess: { decided: 6, failed: 0, open: 0 },
  tests: [],
  finalInspection: { id: uid('7415', n), number: `INS-DEMO-${String(n).padStart(4, '0')}`, status: 'PASSED', decidedAt: at('2026-10-19') },
  releases: { count: 1, quantity: 120, lastAt: at('2026-10-20') },
  evidence: { state: 'COMPLETE', missing: [], failed: [] },
  ...over,
})

export const PRODUCTION: Production = {
  technicalFileId: FILES[0]!.id,
  styleId: STYLES.jacket.id,
  batches: [
    batch(4, 'WO-DEMO-0044', {
      done: false,
      workOrder: { id: uid('7406', 4), number: 'WO-DEMO-0044', batchNumber: 'LOT-DEMO-0044', status: 'RELEASED', siteId: uid('7414', 1), releasedAt: at('2026-11-04'), completedAt: null },
      inProcess: { decided: 3, failed: 0, open: 2 },
      tests: [{ id: uid('7413', 4), test: 'POCKET_RETENTION', testName: null, result: null, testedOn: null, dueOn: '2026-11-12' }],
      finalInspection: null,
      releases: { count: 0, quantity: 0, lastAt: null },
      evidence: { state: 'IN_PROGRESS', missing: [], failed: [] },
    }),
    batch(3, 'WO-DEMO-0043', {
      tests: [{ id: uid('7413', 3), test: 'LABEL_DURABILITY', testName: null, result: 'FAIL', testedOn: '2026-09-28', dueOn: '2026-09-28' }],
      inProcess: { decided: 8, failed: 1, open: 0 },
      evidence: { state: 'FAILED', missing: [], failed: ['LABEL_DURABILITY'] },
    }),
    batch(2, 'WO-DEMO-0042', {
      tests: [{ id: uid('7413', 2), test: 'POCKET_RETENTION', testName: null, result: 'PASS', testedOn: '2026-10-02', dueOn: '2026-10-02' }],
      finalInspection: null,
      releases: { count: 0, quantity: 0, lastAt: null },
      evidence: { state: 'MISSING', missing: [{ code: 'FINAL_INSPECTION', test: null, testName: null, words: 'No final inspection.' }, { code: 'RELEASE', test: null, testName: null, words: 'Not released.' }], failed: [] },
    }),
    batch(1, 'WO-DEMO-0041', { tests: [{ id: uid('7413', 1), test: 'SEAM_STRENGTH', testName: null, result: 'PASS', testedOn: '2026-10-21', dueOn: '2026-10-21' }] }),
  ],
  summary: { made: 4, withEvidence: 1, missing: 1, failed: 1, inProgress: 1 },
  plan: [
    { test: 'SEAM_STRENGTH', testName: null, frequency: 'YEARLY', lastTestedOn: '2025-11-18', lastResult: 'PASS', nextDueOn: '2026-11-18', dueTestId: uid('7413', 9), state: 'DUE_SOON', tests: 2 },
    { test: 'POCKET_RETENTION', testName: null, frequency: 'EVERY_BATCH', lastTestedOn: '2026-10-02', lastResult: 'PASS', nextDueOn: '2026-11-12', dueTestId: uid('7413', 4), state: 'EVERY_BATCH', tests: 3 },
    { test: 'LABEL_DURABILITY', testName: null, frequency: 'QUARTERLY', lastTestedOn: '2026-07-28', lastResult: 'FAIL', nextDueOn: '2026-10-28', dueTestId: null, state: 'OVERDUE', tests: 2 },
    { test: 'OTHER', testName: 'Zip pull', frequency: 'ON_CHANGE', lastTestedOn: null, lastResult: null, nextDueOn: null, dueTestId: null, state: 'ON_CHANGE', tests: 0 },
  ],
  tests: [
    test(9, { dueOn: '2026-11-18' }),
    test(4, { test: 'POCKET_RETENTION', frequency: 'EVERY_BATCH', workOrder: { id: uid('7406', 4), number: 'WO-DEMO-0044' }, batchNumber: 'LOT-DEMO-0044', dueOn: '2026-11-12', standardClause: 'EN 17092-3:2020 6.6' }),
    test(1, { result: 'PASS', testedOn: '2026-10-21', testedBy: 'Laboratorio Demo', reportNumber: 'DEMO-RP-118', retainUntil: '2036-10-21', retention: 'KEPT', workOrder: { id: uid('7406', 1), number: 'WO-DEMO-0041' } }),
  ],
  asOf: NOW,
}

// ---- evidence packs -------------------------------------------------------------------------------------------------------

export const pack = (n: number, over: Partial<Pack>): Pack => ({
  id: uid('7416', n),
  number: `EP-DEMO-${String(n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  purpose: 'AUTHORITY',
  status: 'BUILT',
  technicalFileId: FILES[0]!.id,
  scope: { kind: 'BATCHES', batchNumbers: ['LOT-DEMO-0041', 'LOT-DEMO-0042'], serialFrom: null, serialTo: null, shipmentId: null },
  include: ['TECHFILE_INDEX', 'RISK_ASSESSMENT', 'DOC', 'USER_INFORMATION', 'CERTIFICATES', 'TEST_REPORTS', 'PRODUCTION_CONTROL', 'INSPECTIONS', 'LABELS', 'CR6'],
  language: 'de',
  recipient: 'Autorità di vigilanza Demo (DE)',
  recipientParty: { id: uid('7417', 1), name: 'Marktaufsicht Demo' },
  contents: [
    { title: 'Technical file TF-DEMO-0001 index', sha256: sha(31), recordType: 'TechnicalFile', recordId: FILES[0]!.id, fileId: null },
    { title: 'Product risk assessment revision 1', sha256: sha(32), recordType: 'ProductRiskAssessment', recordId: uid('7405', 1), fileId: null },
    { title: 'EU declaration of conformity de revision 2', sha256: sha(33), recordType: null, recordId: null, fileId: uid('7418', 1) },
    { title: 'Certificate DEMO-CERT-0101', sha256: sha(34), recordType: null, recordId: null, fileId: uid('7418', 2) },
    { title: 'Rapporto DEMO-RP-118.pdf', sha256: sha(35), recordType: null, recordId: null, fileId: uid('7418', 3) },
    { title: 'Production control, 2 batches', sha256: sha(36), recordType: null, recordId: null, fileId: null },
  ],
  documents: 6,
  fingerprint: sha(40),
  pdf: { id: uid('7419', n), name: `EP-DEMO-${String(n).padStart(4, '0')}.pdf`, sizeBytes: 412_880, sha256: sha(41) },
  zip: { id: uid('7420', n), name: `EP-DEMO-${String(n).padStart(4, '0')}.zip`, sizeBytes: 3_904_112, sha256: sha(42) },
  failureReason: null,
  builtAt: at('2026-11-06', '11:20'),
  builtBy: PEOPLE.me,
  retainUntil: '2036-11-06',
  retention: 'KEPT',
  links: [
    { id: uid('7421', 1), partyId: uid('7417', 1), email: 'pruefung@marktaufsicht-demo.example', state: 'OPEN', expiresAt: '2026-12-06T22:59:59.000Z', password: true, opens: 3, downloads: 2, revokedAt: null, createdAt: at('2026-11-06', '11:30') },
    { id: uid('7421', 2), partyId: uid('7417', 1), email: 'altro@marktaufsicht-demo.example', state: 'REVOKED', expiresAt: '2026-12-06T22:59:59.000Z', password: true, opens: 0, downloads: 0, revokedAt: at('2026-11-07'), createdAt: at('2026-11-06', '11:25') },
  ],
  note: 'Their reference DEMO-REF-2026-77.',
  may: { share: true, remove: false },
  version: 3,
  createdAt: at('2026-11-06', '11:18'),
  ...over,
})

export const BUILT_PACK = pack(1, {})
export const BUILDING_PACK = pack(2, { status: 'BUILDING', purpose: 'CUSTOMER', language: 'it', recipient: 'Cliente Demo S.r.l.', recipientParty: null, scope: { kind: 'STYLE', batchNumbers: null, serialFrom: null, serialTo: null, shipmentId: null }, contents: null, documents: null, fingerprint: null, pdf: null, zip: null, builtAt: null, builtBy: null, links: [], note: null, retainUntil: null, retention: 'NOT_SET', createdAt: NOW })
export const FAILED_PACK = pack(3, {
  status: 'FAILED',
  purpose: 'CUSTOMER',
  language: 'en',
  recipient: 'Customer Demo Ltd',
  recipientParty: null,
  contents: null,
  documents: null,
  fingerprint: null,
  pdf: null,
  zip: null,
  builtAt: null,
  builtBy: null,
  links: [],
  note: null,
  failureReason: 'The file store did not give the bytes of "Dichiarazione DEMO-DOC-0021.pdf".',
  may: { share: false, remove: true },
  retainUntil: null,
  retention: 'NOT_SET',
  createdAt: at('2026-11-02'),
})
export const PACKS: PacksAnswer = { technicalFileId: FILES[0]!.id, packs: [BUILT_PACK, FAILED_PACK], contents: BUILT_PACK.include, asOf: NOW }
