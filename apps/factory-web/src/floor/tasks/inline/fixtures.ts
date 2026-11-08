import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { BundleCard, CardOperation } from '../scans/model'
import type { CheckRecord, CheckRow, LineDhu, RovingBoard, StageDefect } from './api'
import { cuttingDraftOf, NEW_EOL, NEW_ROVING } from './model'
import { InlineView, type DefectList, type InlineStep, type InlineViewModel } from './view/InlineView'

/**
 * SCR-176's cases (B-W2b-105; design floor.inline, QHS-039 … QHS-042): Which check? (first pieces waiting, none, reading, offline with
 * the held tiles, a bench with no line, no permission); First piece (scan, wrong codes, not on the tablet, which operation, the
 * plan's checks fresh / partly answered / a critical fail / no plan / a measurement in and out of tolerance / a choice / an
 * office-only check, the PIN to approve or reject: ready, checking, wrong, locked, offline; approved, rejected; refused: open
 * already); Cutting (pass, fail with the defect and the recut line, offline held); Roving (reading, the board, nothing on the line,
 * from this tablet; one operation: green, amber suggested, green held, a critical defect); End of line (scan with the DHU, the
 * card, a pass saved here then recorded, offline; Defect → which defect → which operation → Send back; a tenant with no OTHER
 * rework reason; sent back; the rework refused, the defect kept). Roles: the inspector at the bench (no line) and a team leader on
 * the line tablet (with the line's DHU). Made-up data of a "Demo" plant: never a real company, person or number, never money.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 501 })
const FIRST = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 412 })
const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 7001 })
const AT = '2026-11-08T08:41:00.000Z'
const LINE = { code: 'L1', name: 'Linea 1' }

const frame = (extra: Partial<InlineViewModel['frame']> = {}) => signedInFrame('tile.inline', { station: { name: 'L1 · Tablet capo linea', site: 'Stabilimento Demo Nord' }, ...extra })
const benchFrame = (extra: Partial<InlineViewModel['frame']> = {}) => signedInFrame('tile.inline', { station: { name: 'QC-01 · Banco controllo', site: 'Stabilimento Demo Nord' }, ...extra })

const op = (id: string, seq: number, code: string, name: string, kind: string, state: CardOperation['state']): CardOperation => ({ id, seq, code, name, scanRequired: true, workCentreKind: kind, final: seq === 40, sewn: seq === 30, state, expected: 20, report: null })
const OPS = [op('op-10', 10, 'CUT', 'Taglio pelle', 'CUTTING', 'DONE'), op('op-20', 20, 'SEW-SIDE', 'Cucire fianchi', 'SEWING', 'DONE'), op('op-30', 30, 'SEW-SLV', 'Attaccare maniche', 'SEWING', 'DONE'), op('op-40', 40, 'FIN', 'Rifinitura', 'FINISHING', 'DONE')]

const CARD: BundleCard = {
  scanned: BUNDLE,
  refusal: null,
  bundle: { id: 'b-501', code: BUNDLE, status: 'ACTIVE', quantity: 20, part: null, workOrderSizeId: 'c-52', colourwayCode: 'NERO', colourwayName: 'Nero', size: '52' },
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042', batchNumber: null, status: 'IN_PROGRESS', siteId: 'site-a', style: { code: 'GIA-01', name: 'Giacca moto Demo' } },
  station: null,
  operations: OPS,
  next: null,
  choose: [],
  hint: null,
  reasons: [
    { kind: 'REWORK', code: 'RESTITCH', label: { it: 'Cucitura da rifare', en: 'Stitching to redo' }, sortOrder: 10 },
    { kind: 'REWORK', code: 'OTHER', label: { it: 'Altro', en: 'Other' }, sortOrder: 90 },
  ],
  firstPiece: null,
}
const FIRST_CARD: BundleCard = { ...CARD, scanned: FIRST, bundle: { ...CARD.bundle, id: 'b-412', code: FIRST, quantity: 12 } }
const NO_OTHER: BundleCard = { ...CARD, reasons: [{ kind: 'REWORK', code: 'RESTITCH', label: { it: 'Cucitura da rifare', en: 'Stitching to redo' }, sortOrder: 10 }, { kind: 'REWORK', code: 'ALIGNMENT', label: { it: 'Pezzi non allineati', en: 'Panels not aligned' }, sortOrder: 20 }] }

const DHU: LineDhu = { line: { id: 'line-1', ...LINE }, day: '2026-11-08', dhu: '7.5', defects: 3, pieces: 40, checks: 2, byOperation: [{ code: 'SEW-SIDE', name: 'Cucire fianchi', defects: 3 }], asOf: AT }

const defect = (id: string, code: string, label: string, severity = 'MINOR', icon: string | null = null): StageDefect => ({ id, code, label, icon, colour: null, severity, needsDetail: false })
const DEFECTS: StageDefect[] = [
  defect('d-stitch', 'STITCH-SKIP', 'Punto saltato'),
  defect('d-seam', 'SEAM-OPEN', 'Cucitura aperta', 'MAJOR'),
  defect('d-stain', 'STAIN', 'Macchia'),
  defect('d-armour', 'ARMOUR-MISSING', 'Protezione mancante', 'CRITICAL'),
  defect('d-zip', 'ZIP', 'Zip difettosa'),
]
const CUT_DEFECTS: StageDefect[] = [defect('c-notch', 'NOTCH', 'Tacche mancanti'), defect('c-dir', 'DIRECTION', 'Verso del pelo'), defect('c-shade', 'SHADE', 'Tonalità diversa'), defect('c-hide', 'HIDE-FLAW', 'Difetto della pelle preso', 'MAJOR')]
const ready = (defects: readonly StageDefect[]): DefectList => ({ state: 'ready', defects, asOf: null })

const row = (id: string, number: string, bundle: string, operation: CheckRow['operation'], createdAt: string, hasPlan = true): CheckRow => ({
  id,
  kind: 'FIRST_PIECE',
  status: 'OPEN',
  outcome: null,
  line: { id: 'line-1', ...LINE },
  workOrder: { id: `wo-${id}`, number },
  bundle: { id: `b-${id}`, code: bundle, quantity: 12 },
  operation,
  pieces: 0,
  defectivePieces: 0,
  defects: 0,
  dhu: null,
  defect: null,
  hasPlan,
  decidedAt: null,
  createdAt,
  version: 1,
})
const OPEN_ROWS: CheckRow[] = [
  row('fp-1', 'WO-DEMO-0042', FIRST, { id: 'op-20', seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, '2026-11-08T07:05:00.000Z'),
  row('fp-2', 'WO-DEMO-0045', formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 530 }), null, '2026-11-08T07:40:00.000Z', false),
]

const planCheck = (code: string, labelIt: string, type: string, extra: Partial<CheckRecord['checks'][number]> = {}): CheckRecord['checks'][number] => ({
  id: `pc-${code}`,
  code,
  labelIt,
  labelEn: labelIt,
  labelI18n: {},
  type,
  checkClass: 'MAJOR',
  mandatory: true,
  photoRequired: false,
  nominal: null,
  tolerance: null,
  uom: null,
  choices: [],
  ...extra,
})
const CHECKS = [
  planCheck('SEAM', 'Cuciture dritte e chiuse', 'PASS_FAIL', { checkClass: 'CRITICAL' }),
  planCheck('ARMOUR', 'Tasche protezioni al posto giusto', 'PASS_FAIL', { checkClass: 'CRITICAL' }),
  planCheck('LABEL', 'Etichetta di composizione', 'PASS_FAIL'),
  planCheck('ZIP', 'Zip scorre senza impuntarsi', 'PASS_FAIL', { checkClass: 'MINOR', mandatory: false }),
  planCheck('CHEST', 'Mezzo torace', 'MEASUREMENT', { nominal: '56', tolerance: '1', uom: 'cm' }),
  planCheck('SLEEVE', 'Lunghezza manica', 'MEASUREMENT', { nominal: '64.5', tolerance: '0.5', uom: 'cm' }),
  planCheck('COLOUR', 'Colore cuciture', 'CHOICE', { choices: ['Nero', 'Grigio'], checkClass: 'MINOR' }),
  planCheck('NOTE', 'Annota il lotto delle protezioni', 'FREE_TEXT', { mandatory: false, checkClass: 'MINOR' }),
  planCheck('READ', 'Controlla il capo sul manichino taglia 52', 'INSTRUCTION', { mandatory: false }),
]
const result = (code: string, outcome: 'PASS' | 'FAIL', value: string | null = null): CheckRecord['results'][number] => ({ id: `r-${code}`, code, sampleIndex: 1, outcome, value, note: null, recordedAt: AT })

const RECORD: CheckRecord = {
  ...row('fp-1', 'WO-DEMO-0042', FIRST, { id: 'op-20', seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, '2026-11-08T07:05:00.000Z'),
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' },
  bundle: { id: 'b-412', code: FIRST, quantity: 12 },
  plan: { versionId: 'pv-1', planId: 'p-1', code: 'INL-FIRST', name: 'Primo capo giacche', number: 1 },
  checks: CHECKS,
  results: [],
  blockers: ['SEAM', 'ARMOUR', 'LABEL', 'CHEST', 'SLEEVE', 'COLOUR'],
  suggested: null,
  holdsRun: true,
  sendBack: null,
  signatureSha256: null,
}
const PARTLY: CheckRecord = { ...RECORD, results: [result('SEAM', 'PASS'), result('ARMOUR', 'PASS'), result('CHEST', 'PASS', '56.4')], blockers: ['LABEL', 'SLEEVE', 'COLOUR'] }
const ANSWERED: CheckRecord = { ...RECORD, results: [result('SEAM', 'PASS'), result('ARMOUR', 'PASS'), result('LABEL', 'PASS'), result('CHEST', 'PASS', '56.4'), result('SLEEVE', 'PASS', '64.3'), result('COLOUR', 'PASS', 'Nero')], blockers: [] }
const CRITICAL_FAIL: CheckRecord = { ...RECORD, results: [result('SEAM', 'FAIL'), result('ARMOUR', 'PASS')], blockers: ['LABEL', 'CHEST', 'SLEEVE', 'COLOUR'] }
const NO_PLAN: CheckRecord = { ...RECORD, plan: null, checks: [], blockers: [], hasPlan: false }

const BOARD: RovingBoard = {
  line: { id: 'line-1', ...LINE },
  day: '2026-11-08',
  tiles: [
    { workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, operation: { id: 'op-20', seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, latest: { checkId: 'rv-1', outcome: 'AMBER', outcomeWords: { it: 'Giallo', en: 'Amber' }, pieces: 7, defectivePieces: 1, at: '2026-11-08T08:10:00.000Z' }, checksToday: 2 },
    { workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, operation: { id: 'op-30', seq: 30, code: 'SEW-SLV', name: 'Attaccare maniche' }, latest: { checkId: 'rv-2', outcome: 'GREEN', outcomeWords: { it: 'Verde', en: 'Green' }, pieces: 7, defectivePieces: 0, at: '2026-11-08T08:25:00.000Z' }, checksToday: 1 },
    { workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, operation: { id: 'op-40', seq: 40, code: 'FIN', name: 'Rifinitura' }, latest: null, checksToday: 0 },
    { workOrder: { id: 'wo-45', number: 'WO-DEMO-0045' }, operation: { id: 'op-45-20', seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, latest: { checkId: 'rv-3', outcome: 'RED', outcomeWords: { it: 'Rosso', en: 'Red' }, pieces: 7, defectivePieces: 3, at: '2026-11-08T07:55:00.000Z' }, checksToday: 3 },
  ],
  lineChecksToday: 6,
  asOf: AT,
}

const lead = (step: InlineStep, extra: Partial<InlineViewModel> = {}): InlineViewModel => ({ frame: frame(), online: true, step, line: LINE, dhu: DHU, done: null, signer: 'Ada Demo', ...extra })
const bench = (step: InlineStep, extra: Partial<InlineViewModel> = {}): InlineViewModel => ({ frame: benchFrame(), online: true, step, line: null, dhu: null, done: null, signer: 'Ada Demo', ...extra })
const offline = { frame: frame({ online: false }), online: false }
const checks = (record: CheckRecord, extra: Partial<Extract<InlineStep, { kind: 'fpChecks' }>> = {}): InlineStep => ({ kind: 'fpChecks', record, measuring: null, value: null, choice: null, ...extra })
const eolDefect = (extra: Partial<Extract<InlineStep, { kind: 'eolDefect' }>> = {}): InlineStep => ({ kind: 'eolDefect', card: CARD, draft: NEW_EOL, stage: 'defect', defects: ready(DEFECTS), reworkReasons: [], needsReason: false, ...extra })

export const designScreen = defineDesignScreen<InlineViewModel>({
  screen: 'SCR-176',
  title: 'In-line inspection (floor.inline)',
  view: onFloor(InlineView),
  cases: [
    // ---- Which check? ----
    { id: 'kinds', label: 'Which check? (team leader, line tablet)', model: lead({ kind: 'kinds', open: OPEN_ROWS }), note: 'The line and its DHU today on top (per line, never per person); four tiles; the first pieces waiting as a list, the keys in its footer.' },
    { id: 'kinds-none', label: 'Nothing waits for approval', model: lead({ kind: 'kinds', open: [] }) },
    { id: 'kinds-loading', label: 'Reading the first pieces', model: lead({ kind: 'kinds', open: null }) },
    { id: 'kinds-bench', label: 'Inspector at the bench (no line)', model: bench({ kind: 'kinds', open: OPEN_ROWS }), note: 'A bench tablet shows no line: Roving is held with the reason; the DHU shows on a line tablet.' },
    { id: 'kinds-offline', label: 'Offline: what is held, and why', model: lead({ kind: 'kinds', open: [] }, { ...offline, dhuAsOf: AT }), note: 'A first piece is signed with the PIN and a cutting result is recorded at once: both held; End of line still works (it queues).' },
    { id: 'no-permission', label: 'No permission (an operator)', model: bench({ kind: 'noPermission' }) },
    // ---- First piece ----
    { id: 'fp-scan', label: 'First piece: scan the first bundle', model: bench({ kind: 'scan', check: 'FIRST_PIECE' }) },
    { id: 'fp-scan-wrong', label: 'Scanned a hide tag', model: bench({ kind: 'scan', check: 'FIRST_PIECE', wrong: { why: 'notBundle', code: HIDE } }) },
    { id: 'fp-loading', label: 'Reading the bundle', model: bench({ kind: 'loading', code: FIRST }) },
    { id: 'fp-operation', label: 'Which operation waits for it?', model: bench({ kind: 'fpOperation', card: FIRST_CARD }), note: 'The bundle\'s operations as tiles, or Every operation: from now on no other bundle of the run is worked there (QHS-039).' },
    { id: 'fp-checks', label: 'The plan\'s checks, fresh', model: bench(checks(RECORD)), note: 'DS FloorChecklist by class; the key measurements as rows; an office-only check and an instruction in words. Approve held: required checks left.' },
    { id: 'fp-checks-partly', label: 'Partly answered', model: bench(checks(PARTLY)) },
    { id: 'fp-checks-done', label: 'All answered: Approve opens', model: bench(checks(ANSWERED)) },
    { id: 'fp-checks-critical', label: 'A critical check failed', model: bench(checks(CRITICAL_FAIL)), note: 'Approve is held with the check named; Reject is the way on (the API refuses a passing outcome: PLAN_RESULTS).' },
    { id: 'fp-checks-noplan', label: 'No plan applies', model: bench(checks(NO_PLAN)) },
    { id: 'fp-measure-in', label: 'Measuring: within tolerance', model: bench(checks(PARTLY, { measuring: 'SLEEVE', value: 64.3 })), note: 'The value on the pad; DS LimitMeter against 64,5 ± 0,5 cm; the verdict by the numbers.' },
    { id: 'fp-measure-out', label: 'Measuring: out of tolerance', model: bench(checks(PARTLY, { measuring: 'SLEEVE', value: 65.4 })) },
    { id: 'fp-measure-choice', label: 'A choice', model: bench(checks(PARTLY, { measuring: 'COLOUR', choice: 'Nero' })) },
    { id: 'fp-checks-offline', label: 'Offline: answers held', model: bench(checks(PARTLY), { frame: benchFrame({ online: false }), online: false }) },
    { id: 'fp-sign', label: 'Approve with PIN', model: bench({ kind: 'fpSign', record: ANSWERED, outcome: 'APPROVED' }), note: 'What is signed beside the DS PinSignBlock; the sixth digit signs (POST /floor/step-up, then the same decide).' },
    { id: 'fp-sign-reject', label: 'Reject with PIN', model: bench({ kind: 'fpSign', record: CRITICAL_FAIL, outcome: 'REJECTED' }) },
    { id: 'fp-sign-busy', label: 'Checking the PIN', model: bench({ kind: 'fpSign', record: ANSWERED, outcome: 'APPROVED', busy: true }) },
    { id: 'fp-sign-wrong', label: 'Wrong PIN', model: bench({ kind: 'fpSign', record: ANSWERED, outcome: 'APPROVED', pin: 'wrong' }) },
    { id: 'fp-sign-locked', label: 'Too many wrong PINs', model: bench({ kind: 'fpSign', record: ANSWERED, outcome: 'APPROVED', pin: 'locked' }) },
    { id: 'fp-sign-offline', label: 'Offline: signing held', model: bench({ kind: 'fpSign', record: ANSWERED, outcome: 'APPROVED' }, { frame: benchFrame({ online: false }), online: false }) },
    { id: 'fp-approved', label: 'Approved: the run is free', model: bench({ kind: 'fpDone', record: { ...ANSWERED, status: 'DECIDED', outcome: 'APPROVED', signatureSha256: '9f2c4e7a1b03d6c85e0f9a4b7d21c3e8f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1' } }), note: 'The operation screens of the run lift their hold at once (live).' },
    { id: 'fp-rejected', label: 'Rejected: the run keeps waiting', model: bench({ kind: 'fpDone', record: { ...CRITICAL_FAIL, status: 'DECIDED', outcome: 'REJECTED', signatureSha256: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9' } }) },
    { id: 'fp-refused', label: 'Refused: a first piece is open already', model: bench({ kind: 'problem', problem: { kind: 'refused', code: 'FIRST_PIECE_OPEN', message: '', fix: null }, code: FIRST }) },
    // ---- Cutting ----
    { id: 'cut-scan', label: 'Cutting: scan a bundle of the lay', model: bench({ kind: 'scan', check: 'CUTTING' }) },
    { id: 'cut-pass', label: 'Cutting: nothing rejected', model: bench({ kind: 'cutting', card: CARD, draft: cuttingDraftOf(20), defects: ready(CUT_DEFECTS) }) },
    { id: 'cut-fail', label: 'Cutting: 2 pieces to recut', model: bench({ kind: 'cutting', card: CARD, draft: { pieces: 20, rejected: 2, defectId: 'c-shade' }, defects: ready(CUT_DEFECTS) }), note: 'Rejected pieces are recut: the cutting office makes the recut ticket (the floor has no recut route).' },
    { id: 'cut-offline', label: 'Cutting offline: held', model: bench({ kind: 'cutting', card: CARD, draft: cuttingDraftOf(20), defects: { state: 'offline', defects: [], asOf: null } }, { frame: benchFrame({ online: false }), online: false }) },
    { id: 'cut-done', label: 'Cutting recorded', model: bench({ kind: 'scan', check: 'CUTTING' }, { done: { kind: 'cutting', code: BUNDLE, pieces: 2, ticks: 'recorded' } }) },
    // ---- Roving ----
    { id: 'roving', label: 'Roving: the line\'s operations', model: lead({ kind: 'roving', board: BOARD, asOf: null }), note: 'Each operation with today\'s light in words and colour; per operation, never per person.' },
    { id: 'roving-loading', label: 'Roving: reading the line', model: lead({ kind: 'roving', board: null, asOf: null }) },
    { id: 'roving-empty', label: 'Roving: nothing on the line', model: lead({ kind: 'roving', board: { ...BOARD, tiles: [], lineChecksToday: 0 }, asOf: null }) },
    { id: 'roving-offline', label: 'Roving offline: from this tablet', model: lead({ kind: 'roving', board: BOARD, asOf: AT }, { ...offline, dhuAsOf: AT }) },
    { id: 'roving-green', label: 'One operation: all right (green)', model: lead({ kind: 'rovingTile', tile: BOARD.tiles[0]!, draft: NEW_ROVING, defects: ready(DEFECTS) }) },
    { id: 'roving-amber', label: 'One piece wrong: amber suggested', model: lead({ kind: 'rovingTile', tile: BOARD.tiles[0]!, draft: { ...NEW_ROVING, defective: 1, defectId: 'd-stitch' }, defects: ready(DEFECTS) }) },
    { id: 'roving-green-held', label: 'Green held with a piece wrong', model: lead({ kind: 'rovingTile', tile: BOARD.tiles[0]!, draft: { ...NEW_ROVING, defective: 1, defectId: 'd-stitch', colour: 'GREEN' }, defects: ready(DEFECTS) }), note: 'The API refuses it; the screen says so first, Record held with the words.' },
    { id: 'roving-critical', label: 'A critical defect: always red', model: lead({ kind: 'rovingTile', tile: BOARD.tiles[1]!, draft: { ...NEW_ROVING, defective: 1, defectId: 'd-armour' }, defects: ready(DEFECTS) }) },
    { id: 'roving-saved', label: 'Roving saved on this tablet', model: lead({ kind: 'roving', board: BOARD, asOf: null }, { done: { kind: 'roving', code: 'SEW-SIDE · Cucire fianchi', colour: 'AMBER', ticks: 'saved' } }) },
    // ---- End of line ----
    { id: 'eol-scan', label: 'End of line: scan, with the line\'s DHU', model: lead({ kind: 'scan', check: 'END_OF_LINE' }) },
    { id: 'eol-card', label: 'The bundle: Pass in one tap', model: lead({ kind: 'eol', card: CARD, asOf: null }), note: 'Pass (main, Enter) records all its pieces; Defect sends one back (3 taps after the scan).' },
    { id: 'eol-passed', label: 'Passed: saved, then recorded', model: lead({ kind: 'scan', check: 'END_OF_LINE' }, { done: { kind: 'pass', code: BUNDLE, pieces: 20, ticks: 'saved' } }) },
    { id: 'eol-offline', label: 'Offline: Pass queues, Defect held', model: lead({ kind: 'eol', card: CARD, asOf: AT }, { ...offline, dhuAsOf: AT }) },
    { id: 'eol-not-on-tablet', label: 'Offline: a bundle not on this tablet', model: lead({ kind: 'scan', check: 'END_OF_LINE', wrong: { why: 'notOnTablet', code: BUNDLE } }, offline) },
    { id: 'eol-defect', label: 'Defect: which one, how many', model: lead(eolDefect()) },
    { id: 'eol-operation', label: 'Defect: which operation caused it', model: lead(eolDefect({ draft: { ...NEW_EOL, defectId: 'd-seam', defective: 2 }, stage: 'operation' })), note: 'The bundle\'s operations as tiles; charged to the operation, never to a person (MES-127).' },
    { id: 'eol-send', label: 'Ready to send back', model: lead(eolDefect({ draft: { ...NEW_EOL, defectId: 'd-seam', defective: 2, operationId: 'op-20' }, stage: 'operation' })) },
    { id: 'eol-reason', label: 'No OTHER rework reason: why is it reworked?', model: lead(eolDefect({ card: NO_OTHER, draft: { ...NEW_EOL, defectId: 'd-seam', operationId: 'op-20' }, stage: 'reason', needsReason: true, reworkReasons: NO_OTHER.reasons.map((reason) => ({ id: reason.code, list: 'REWORK', code: reason.code, labelIt: reason.label.it, labelEn: reason.label.en, labelI18n: {}, icon: null, colour: null, photo: null, needsDetail: false, sortOrder: reason.sortOrder })) })) },
    { id: 'eol-sent', label: 'Sent back', model: lead({ kind: 'scan', check: 'END_OF_LINE' }, { done: { kind: 'sentBack', code: BUNDLE, pieces: 2, operation: 'SEW-SIDE Cucire fianchi', ticks: 'recorded' } }) },
    { id: 'eol-rework-refused', label: 'The rework did not open: the defect stands', model: lead({ kind: 'scan', check: 'END_OF_LINE' }, { done: { kind: 'defectKept', code: BUNDLE, pieces: 2, operation: 'SEW-SIDE Cucire fianchi', ticks: 'recorded', problem: 'NEXT_REPORTED' } }) },
    { id: 'error', label: 'Server not answering', model: lead({ kind: 'problem', problem: { kind: 'unavailable' }, code: null }) },
  ],
})
