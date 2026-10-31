import { at, COMPANY_ID, ME, NOW, SITE_ID, uid } from '../../_shared/fixtures'
import type { ContainmentAction, Decision, DefectChoice, DispositionChoice, NcrCard, NcrCounts, NcrLane, NcrPrefill, NcrRecord, NcrSettingsAnswer, NcrSummary, OperationChoice, Person, ReasonChoice, SiteChoice, StockPlace } from '../api'

/**
 * Made-up data of the Nonconformances screens (SCR-144, SCR-145): DEMO- numbers, Demo names, made-up quantities. Nothing
 * here is a real company, person, supplier or result.
 */

export { NOW, ME, COMPANY_ID, SITE_ID }

export const PEOPLE: Person[] = [
  { id: ME, name: 'Demo Owner', me: true },
  { id: uid('5201', 1), name: 'Demo Inspector', me: false },
  { id: uid('5201', 2), name: 'Demo Production Manager', me: false },
]

export const SITES: SiteChoice[] = [
  {
    id: SITE_ID,
    companyId: COMPANY_ID,
    code: 'DEMO-A',
    name: 'Demo plant',
    locations: [
      { id: uid('5202', 1), code: 'A1-STORE', name: 'Demo store', kind: 'STORAGE', status: 'ACTIVE' },
      { id: uid('5202', 2), code: 'A1-QUA', name: 'Demo quarantine', kind: 'QUARANTINE', status: 'ACTIVE' },
      { id: uid('5202', 3), code: 'A1-2ND', name: 'Demo second quality', kind: 'STORAGE', status: 'ACTIVE' },
    ],
  },
]

const defect = { id: uid('5203', 1), code: 'SEAM-OPEN', labelEn: 'Open seam', labelIt: 'Cucitura aperta', icon: 'scissors', colour: null }
const lining = { id: uid('5203', 2), code: 'LINING-TEAR', labelEn: 'Torn lining', labelIt: 'Fodera strappata', icon: null, colour: null }

const base: NcrSummary = {
  id: uid('5300', 1),
  number: 'NCR-DEMO-0031',
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  title: 'Seam opens at the armour pocket',
  source: 'INSPECTION',
  sourceType: 'Inspection',
  sourceId: uid('5301', 1),
  stage: 'CONTAINED',
  severity: 'MAJOR',
  defect,
  zone: 'SHOULDER_L',
  foundAt: 'FINAL',
  foundOn: at(27, 10, 15),
  quantityAffected: '40',
  quantitySuspect: '12',
  uom: 'PCS',
  decided: { decided: '28', left: '12', words: '28 of 40 PCS decided · 12 left' },
  style: { id: uid('5302', 1), code: 'DEMO-JK-100', name: 'Demo touring jacket', ppe: true },
  colourway: { id: uid('5302', 2), code: 'BLK', name: 'Black' },
  size: '52',
  serial: null,
  workOrder: { id: uid('5303', 1), number: 'WO-DEMO-0150' },
  item: null,
  lot: null,
  supplier: null,
  ownerId: uid('5201', 1),
  containmentDueAt: at(28, 10, 15),
  containmentOverdue: false,
  actions: { open: 0, done: 2 },
  decisionsWaiting: 2,
  ageDays: 2,
  containedAt: at(27, 15, 0),
  decidedAt: null,
  closedAt: null,
  cancelledAt: null,
  version: 9,
  createdAt: at(27, 10, 20),
  updatedAt: at(29, 8, 0),
}

/** The list's rows (newest first): every stage, every severity, a supplier NCR, an overdue containment. */
export const ROWS: NcrSummary[] = [
  {
    ...base,
    id: uid('5300', 7),
    number: 'NCR-DEMO-0037',
    title: 'Lining torn on two sleeves',
    stage: 'OPEN',
    severity: 'MINOR',
    defect: lining,
    zone: 'LINING',
    source: 'BUNDLE',
    sourceType: 'Bundle',
    foundAt: 'IN_LINE',
    foundOn: at(29, 8, 30),
    quantityAffected: '2',
    quantitySuspect: null,
    decided: { decided: '0', left: '2', words: '0 of 2 PCS decided · 2 left' },
    ownerId: null,
    containmentDueAt: at(30, 8, 30),
    actions: { open: 1, done: 0 },
    decisionsWaiting: 0,
    ageDays: 0,
    containedAt: null,
    version: 2,
    createdAt: at(29, 8, 35),
  },
  {
    ...base,
    id: uid('5300', 6),
    number: 'NCR-DEMO-0036',
    title: 'Leather lot below the agreed thickness',
    stage: 'OPEN',
    severity: 'CRITICAL',
    defect: null,
    zone: null,
    source: 'SUPPLIER',
    sourceType: 'Lot',
    foundAt: 'INCOMING',
    foundOn: at(26, 14, 0),
    quantityAffected: '51.8',
    quantitySuspect: null,
    uom: 'FT2',
    decided: { decided: '12', left: '39.8', words: '12 of 51.8 FT2 decided · 39.8 left' },
    style: null,
    colourway: null,
    size: null,
    workOrder: null,
    item: { id: uid('5304', 1), code: 'DEMO-LTH-01', name: 'Demo cowhide 1.2 mm' },
    lot: { id: uid('5304', 2), code: 'DEMO-LOT-0007' },
    supplier: { id: uid('5304', 3), code: 'DEMO-SUP', name: 'Demo Tannery' },
    ownerId: ME,
    containmentDueAt: at(27, 14, 0),
    containmentOverdue: true,
    actions: { open: 1, done: 0 },
    decisionsWaiting: 1,
    ageDays: 3,
    containedAt: null,
    version: 4,
    createdAt: at(26, 14, 5),
  },
  base,
  {
    ...base,
    id: uid('5300', 4),
    number: 'NCR-DEMO-0029',
    title: 'Wrong care label on a size run',
    stage: 'DECIDED',
    severity: 'MINOR',
    defect: null,
    zone: 'LABEL',
    source: 'AUDIT',
    sourceType: null,
    sourceId: null,
    quantityAffected: '24',
    quantitySuspect: null,
    decided: { decided: '24', left: '0', words: 'All 24 PCS decided' },
    actions: { open: 0, done: 1 },
    decisionsWaiting: 0,
    ageDays: 6,
    decidedAt: at(28, 16, 0),
    ownerId: ME,
    version: 14,
    createdAt: at(23, 9, 0),
  },
  {
    ...base,
    id: uid('5300', 3),
    number: 'NCR-DEMO-0027',
    title: 'Zip pull missing after packing',
    stage: 'DECIDED',
    severity: 'MAJOR',
    source: 'COMPLAINT',
    sourceType: 'Complaint',
    foundAt: 'CUSTOMER',
    quantityAffected: '3',
    quantitySuspect: null,
    decided: { decided: '3', left: '0', words: 'All 3 PCS decided' },
    actions: { open: 0, done: 1 },
    decisionsWaiting: 1,
    ageDays: 8,
    decidedAt: at(27, 11, 0),
    version: 11,
    createdAt: at(21, 9, 0),
  },
  {
    ...base,
    id: uid('5300', 2),
    number: 'NCR-DEMO-0024',
    title: 'Stitch density low on back panel',
    stage: 'CLOSED',
    severity: 'MINOR',
    quantityAffected: '6',
    quantitySuspect: null,
    decided: { decided: '6', left: '0', words: 'All 6 PCS decided' },
    actions: { open: 0, done: 1 },
    decisionsWaiting: 0,
    ageDays: 12,
    decidedAt: at(20, 11, 0),
    closedAt: at(22, 9, 0),
    version: 18,
    createdAt: at(17, 9, 0),
  },
]

export const COUNTS: NcrCounts = { open: 5, containmentOverdue: 1, waitingDisposition: 2, criticalOpen: 1, closedThisMonth: 4, mine: 2 }

const cardOf = (row: NcrSummary): NcrCard => {
  const next = row.stage === 'OPEN' ? 'CONTAINED' : row.stage === 'CONTAINED' ? 'DECIDED' : row.stage === 'DECIDED' ? 'CLOSED' : null
  const ready = row.stage === 'OPEN' ? row.actions.done > 0 && row.actions.open === 0 : row.stage === 'CONTAINED' ? Number(row.decided.left) <= 0 : row.stage === 'DECIDED' ? row.decisionsWaiting === 0 : false
  return { ...row, next: { stage: next, ready, words: ready ? null : 'x' } }
}

export const LANES: NcrLane[] = (['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED'] as const).map((stage) => {
  const cards = ROWS.filter((row) => row.stage === stage).map(cardOf)
  return { stage, count: stage === 'CLOSED' ? 4 : cards.length, truncated: false, cards }
})

// ---- the record ----------------------------------------------------------------------------------------------------------

const actions: ContainmentAction[] = [
  {
    id: uid('5310', 1),
    seq: 1,
    kind: 'HOLD_STOCK',
    description: 'Hold the finished garments of the work order',
    ownerId: uid('5201', 1),
    dueAt: at(27, 18, 0),
    overdue: false,
    status: 'DONE',
    doneAt: at(27, 11, 0),
    doneById: uid('5201', 1),
    evidenceNote: 'Placed with the NCR.',
    cancelReason: null,
    files: 0,
    record: { type: 'QualityHold', id: uid('5311', 1) },
    hold: { id: uid('5311', 1), status: 'ACTIVE', subjectType: 'WorkOrder', count: 1 },
    version: 2,
  },
  {
    id: uid('5310', 2),
    seq: 2,
    kind: 'CHECK_WIP',
    description: 'Check the bundles still on the line',
    ownerId: uid('5201', 2),
    dueAt: at(28, 12, 0),
    overdue: false,
    status: 'DONE',
    doneAt: at(27, 14, 30),
    doneById: uid('5201', 2),
    evidenceNote: 'Two bundles checked, 4 more pockets found and added to the quantity.',
    cancelReason: null,
    files: 1,
    record: null,
    hold: null,
    version: 3,
  },
]

export const DISPOSITIONS: DispositionChoice[] = [
  { id: uid('5320', 1), code: 'REWORK', labelEn: 'Rework', labelIt: 'Rilavorazione', icon: null, colour: null, outcome: 'REWORK', stockMoveReason: null, followUp: 'REWORK_ORDER', reinspection: true, stockAction: 'Opens a rework order; inspected again.', approvalSeverity: null, active: true, sortOrder: 1 },
  { id: uid('5320', 2), code: 'SCRAP', labelEn: 'Scrap', labelIt: 'Scarto', icon: null, colour: null, outcome: 'SCRAP', stockMoveReason: 'SCRAP', followUp: null, reinspection: false, stockAction: 'Leaves the stock as scrap.', approvalSeverity: 'MINOR', active: true, sortOrder: 2 },
  { id: uid('5320', 3), code: 'REGRADE', labelEn: 'Second quality', labelIt: 'Seconda scelta', icon: null, colour: null, outcome: 'REGRADE', stockMoveReason: 'TRANSFER', followUp: null, reinspection: false, stockAction: 'Moves to a second-quality place.', approvalSeverity: null, active: true, sortOrder: 3 },
  { id: uid('5320', 4), code: 'USE_AS_IS', labelEn: 'Use as is', labelIt: 'Usare così', icon: null, colour: null, outcome: 'USE_AS_IS', stockMoveReason: null, followUp: null, reinspection: false, stockAction: 'No stock move.', approvalSeverity: 'MINOR', active: true, sortOrder: 4 },
  { id: uid('5320', 5), code: 'REPAIR', labelEn: 'Repair', labelIt: 'Riparazione', icon: null, colour: null, outcome: 'REPAIR', stockMoveReason: null, followUp: 'REPAIR_ORDER', reinspection: true, stockAction: 'Names its repair.', approvalSeverity: null, active: true, sortOrder: 5 },
  { id: uid('5320', 6), code: 'RETURN', labelEn: 'Return to supplier', labelIt: 'Reso al fornitore', icon: null, colour: null, outcome: 'RETURN_TO_SUPPLIER', stockMoveReason: 'TRANSFER', followUp: 'SUPPLIER_CLAIM', reinspection: false, stockAction: 'Moves to the returns place; opens the supplier claim.', approvalSeverity: null, active: true, sortOrder: 6 },
]

const code = (index: number) => {
  const found = DISPOSITIONS[index]!
  return { id: found.id, code: found.code, labelEn: found.labelEn, labelIt: found.labelIt, icon: found.icon, colour: found.colour, outcome: found.outcome, stockMoveReason: found.stockMoveReason, followUp: found.followUp, reinspection: found.reinspection, words: found.stockAction }
}

const decisions: Decision[] = [
  {
    id: uid('5330', 1),
    seq: 1,
    disposition: code(0),
    quantity: '20',
    note: 'Re-sew the pocket seam at operation 40.',
    decidedAt: at(28, 9, 0),
    decidedById: uid('5201', 1),
    approvalRequired: false,
    approvedAt: null,
    approvedById: null,
    state: 'DONE',
    mayApprove: false,
    doneAt: at(28, 9, 30),
    stockMove: null,
    followUp: { type: 'ReworkOrder', id: uid('5331', 1), label: 'Rework of 20 at 40 · WO-DEMO-0150', state: 'OPEN' },
    version: 3,
  },
  {
    id: uid('5330', 2),
    seq: 2,
    disposition: code(1),
    quantity: '8',
    note: 'Leather cut through at the seam.',
    decidedAt: at(28, 9, 10),
    decidedById: uid('5201', 1),
    approvalRequired: true,
    approvedAt: null,
    approvedById: null,
    state: 'WAITING_APPROVAL',
    mayApprove: true,
    doneAt: null,
    stockMove: null,
    followUp: null,
    version: 1,
  },
]

export const RECORD: NcrRecord = {
  ncr: {
    ...base,
    description: 'At final inspection the left armour pocket seam opens under a light pull on 28 garments; 12 more of the same cut are suspect.',
    foundBy: { kind: 'USER', userId: uid('5201', 1), workerId: null },
    closedById: null,
    closeNote: null,
    closeSignatureSha256: null,
    cancelReason: null,
    createdById: uid('5201', 1),
  },
  containment: actions,
  decisions,
  links: [
    { id: uid('5340', 1), recordType: 'Inspection', recordId: uid('5301', 1), label: 'INS-DEMO-0412', note: null, createdAt: at(27, 10, 20), createdById: uid('5201', 1) },
    { id: uid('5340', 2), recordType: 'WorkOrder', recordId: uid('5303', 1), label: 'WO-DEMO-0150', note: null, createdAt: at(27, 10, 20), createdById: uid('5201', 1) },
    { id: uid('5340', 3), recordType: 'ReworkOrder', recordId: uid('5331', 1), label: 'Rework of 20 at 40', note: 'Decision 1', createdAt: at(28, 9, 30), createdById: uid('5201', 1) },
  ],
  holds: [{ id: uid('5311', 1), status: 'ACTIVE', subjectType: 'WorkOrder', subjectIds: [uid('5303', 1)], reasonCode: 'NCR', reasonNote: 'Seam defect under investigation', placedAt: at(27, 11, 0), decidedHere: true }],
  register: { id: uid('5350', 1), reference: 'REG-DEMO-0009', status: 'OPEN' },
  next: {
    stage: 'DECIDED',
    checks: [
      { key: 'STAGE', ok: true, words: 'x' },
      { key: 'ALL_DECIDED', ok: false, words: 'x' },
      { key: 'APPROVED', ok: false, words: 'x' },
    ],
    ready: false,
  },
  closing: {
    checks: [
      { key: 'ALL_DECIDED', ok: false, words: 'x' },
      { key: 'APPROVED', ok: false, words: 'x' },
      { key: 'CARRIED_OUT', ok: false, words: 'x' },
      { key: 'HOLDS', ok: true, words: 'x' },
    ],
    ready: false,
  },
  actions: { edit: null, contain: 'x', decide: 'x', close: 'x', cancel: 'x' },
  may: { manage: true, approve: true, close: true, raise: true },
}

/** The same NCR fresh: OPEN, nothing contained or decided. */
export const RECORD_OPEN: NcrRecord = {
  ...RECORD,
  ncr: { ...RECORD.ncr, ...ROWS[0]!, description: 'Two sleeves with a torn lining found at the sleeve-setting operation.', foundBy: { kind: 'WORKER', userId: null, workerId: uid('5205', 1) }, closedById: null, closeNote: null, closeSignatureSha256: null, cancelReason: null, createdById: ME },
  containment: [{ ...actions[1]!, id: uid('5310', 9), seq: 1, kind: 'CHECK_WIP', description: null, status: 'OPEN', doneAt: null, doneById: null, evidenceNote: null, files: 0, ownerId: null, dueAt: at(30, 8, 30), version: 1 }],
  decisions: [],
  links: [{ id: uid('5340', 9), recordType: 'Bundle', recordId: uid('5306', 1), label: 'BN-DEMO-0042', note: null, createdAt: at(29, 8, 35), createdById: ME }],
  holds: [],
  register: null,
  next: { stage: 'CONTAINED', checks: [{ key: 'STAGE', ok: true, words: 'x' }, { key: 'ACTION_DONE', ok: false, words: 'x' }, { key: 'NO_OPEN_ACTION', ok: false, words: 'x' }], ready: false },
  closing: { checks: [{ key: 'ACTION_DONE', ok: false, words: 'x' }, { key: 'NO_OPEN_ACTION', ok: false, words: 'x' }, { key: 'ALL_DECIDED', ok: false, words: 'x' }, { key: 'APPROVED', ok: true, words: 'x' }, { key: 'CARRIED_OUT', ok: true, words: 'x' }, { key: 'HOLDS', ok: true, words: 'x' }], ready: false },
  actions: { edit: null, contain: 'x', decide: 'x', close: 'x', cancel: null },
}

/** Decided and carried out: ready to close (the hold closes with it). */
export const RECORD_READY: NcrRecord = {
  ...RECORD,
  ncr: { ...RECORD.ncr, stage: 'DECIDED', decided: { decided: '40', left: '0', words: 'All 40 PCS decided' }, decisionsWaiting: 0, decidedAt: at(29, 9, 0), version: 15 },
  decisions: [decisions[0]!, { ...decisions[1]!, quantity: '20', approvedAt: at(28, 15, 0), approvedById: uid('5201', 2), state: 'DONE', mayApprove: false, doneAt: at(28, 16, 0), stockMove: { id: uid('5332', 1), reason: 'SCRAP', quantity: '20', uom: 'PCS', from: 'A1-STORE', to: null }, version: 4 }],
  next: { stage: 'CLOSED', checks: [{ key: 'STAGE', ok: true, words: 'x' }, { key: 'CARRIED_OUT', ok: true, words: 'x' }, { key: 'HOLDS', ok: true, words: 'x' }], ready: true },
  closing: { checks: [{ key: 'CARRIED_OUT', ok: true, words: 'x' }, { key: 'HOLDS', ok: true, words: 'x' }], ready: true },
  actions: { edit: 'x', contain: 'x', decide: 'x', close: null, cancel: 'x' },
}

export const RECORD_CLOSED: NcrRecord = {
  ...RECORD_READY,
  ncr: { ...RECORD_READY.ncr, stage: 'CLOSED', closedAt: at(29, 9, 30), closedById: ME, closeNote: 'Every garment reworked or scrapped; the line briefed.', closeSignatureSha256: 'demo', version: 16 },
  holds: [{ ...RECORD.holds[0]!, status: 'CLOSED' }],
  next: { stage: null, checks: [], ready: false },
  actions: { edit: 'x', contain: 'x', decide: 'x', close: 'x', cancel: 'x' },
}

export const PREFILL: NcrPrefill = {
  fromType: 'Inspection',
  fromId: uid('5301', 1),
  label: 'Inspection INS-DEMO-0412',
  companyId: COMPANY_ID,
  siteId: SITE_ID,
  source: 'INSPECTION',
  foundAt: 'FINAL',
  title: 'Open seam at the left shoulder',
  titleParts: null,
  defectIds: [],
  description: 'Found at final inspection of WO-DEMO-0150.',
  foundOn: at(29, 9, 10),
  foundById: ME,
  foundByWorkerId: null,
  quantityAffected: '13',
  uom: 'PCS',
  severity: 'MAJOR',
  defectCodeId: defect.id,
  zone: 'SHOULDER_L',
  styleId: uid('5302', 1),
  colourwayId: uid('5302', 2),
  size: '52',
  serial: null,
  workOrderId: uid('5303', 1),
  itemId: null,
  lotId: null,
  supplierId: null,
  links: [{ recordType: 'Inspection', recordId: uid('5301', 1), note: null }],
  holdIds: [],
  problem: null,
  files: [{ id: uid('5360', 1), kind: 'PHOTO', originalName: 'shoulder-seam.jpg' }],
  existing: [{ id: base.id, number: base.number, stage: base.stage }],
  containmentHours: 24,
}

export const DEFECTS: DefectChoice[] = [
  { id: defect.id, code: defect.code, category: { id: uid('5204', 1), code: 'SEAMS', labelIt: 'Cuciture', labelEn: 'Seams' }, labelIt: defect.labelIt, labelEn: defect.labelEn, icon: defect.icon, severity: 'MAJOR', zone: 'SHOULDER_L' },
  { id: lining.id, code: lining.code, category: { id: uid('5204', 2), code: 'LINING', labelIt: 'Fodera', labelEn: 'Lining' }, labelIt: lining.labelIt, labelEn: lining.labelEn, icon: null, severity: 'MINOR', zone: 'LINING' },
]

export const HOLD_REASONS: ReasonChoice[] = [
  { id: uid('5370', 1), code: 'NCR', labelIt: 'Non conformità aperta', labelEn: 'Open nonconformance', needsDetail: false },
  { id: uid('5370', 2), code: 'SUSPECT', labelIt: 'Merce sospetta', labelEn: 'Suspect goods', needsDetail: true },
]

export const STOCK: StockPlace[] = [
  { siteId: SITE_ID, location: { id: uid('5202', 1), code: 'A1-STORE', name: 'Demo store' }, item: { id: uid('5304', 1), code: 'DEMO-LTH-01', name: 'Demo cowhide 1.2 mm', baseUom: 'FT2' }, colour: null, lot: { id: uid('5304', 2), code: 'DEMO-LOT-0007' }, hide: null, onHand: '39.8', held: '39.8', available: '0' },
]

export const OPERATIONS: OperationChoice[] = [
  { id: uid('5380', 1), seq: 30, code: 'SLEEVE', name: 'Set sleeves' },
  { id: uid('5380', 2), seq: 40, code: 'POCKET', name: 'Armour pockets' },
  { id: uid('5380', 3), seq: 50, code: 'CLOSE', name: 'Close side seams' },
]

export const ASOF = NOW

// ---- B-W2b-17 (made-up) ---------------------------------------------------------------------------------------------

/** New NCR from two picked defect lines of INS-DEMO-0412 (the prefill takes only those lines; its title in parts). */
export const PREFILL_DEFECTS: NcrPrefill = {
  ...PREFILL,
  title: '2 defects at Inspection INS-DEMO-0412',
  titleParts: { key: 'INSPECTION_DEFECTS', values: { count: '2', inspection: 'INS-DEMO-0412' } },
  defectIds: [uid('5306', 1), uid('5306', 2)],
  description: 'SEAM-OPEN × 3 (SHOULDER_L); LINING-TORN × 2 (LINING)\nFound at final inspection of WO-DEMO-0150.',
  quantityAffected: '5',
  zone: null,
  existing: [],
  containmentHours: 48,
}

/** New NCR from a rejected bundle: the title in parts, worded in the reader's language. */
export const PREFILL_BUNDLE: NcrPrefill = {
  ...PREFILL,
  fromType: 'Bundle',
  fromId: uid('5307', 1),
  label: 'Bundle DEMO-BN-0031',
  source: 'BUNDLE',
  foundAt: 'IN_LINE',
  title: 'Rejected bundle DEMO-BN-0031',
  titleParts: { key: 'BUNDLE_REJECTED', values: { bundle: 'DEMO-BN-0031' } },
  description: null,
  quantityAffected: '10',
  severity: null,
  defectCodeId: null,
  zone: null,
  links: [{ recordType: 'Bundle', recordId: uid('5307', 1), note: null }],
  files: [],
  existing: [],
  containmentHours: 24,
}

/** The company's containment time: its own 48 hours (the tenant's 24 below it). */
export const CONTAINMENT_SETTINGS: NcrSettingsAnswer = {
  settings: { companyId: COMPANY_ID, inForce: { hours: 48, source: 'COMPANY' }, own: { defaultContainmentHours: 48, updatedAt: at(20, 9, 0) }, version: 3 },
  mayChange: true,
}

/** A containment cancelled with its reason (B-W2b-17's own column), and one cancelled before (its reason in the evidence). */
export const CANCELLED_ACTIONS: ContainmentAction[] = [
  { ...actions[1]!, id: uid('5310', 21), seq: 3, kind: 'CHECK_SHIPPED', description: 'Check the two shipments of last week', status: 'CANCELLED', doneAt: null, doneById: null, evidenceNote: null, cancelReason: 'Nothing of this work order was shipped yet.', files: 0, version: 2 },
  { ...actions[1]!, id: uid('5310', 22), seq: 4, kind: 'TELL_CUSTOMER', description: null, status: 'CANCELLED', doneAt: null, doneById: null, evidenceNote: 'Cancelled: The customer is told with the shipment note.', cancelReason: 'The customer is told with the shipment note.', files: 0, version: 2 },
]
