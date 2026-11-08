import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { OperationCheck, OperationSteps } from './checks'
import type { OffStandardBlock, OffStandardTile } from './indirect'
import { NEW_EXTRA, type ExtraChoices, type ExtraDraft } from './extra'
import { NO_COUNTS, type BundleCard, type CardOperation, type CardReason, type CorrectionTarget, type Counts } from './model'
import { NEW_NOTE } from './notes'
import type { PickerReason } from '../reasons/model'
import type { StackRow } from './stack'
import { NOT_STARTED, afterPause, afterStart, type OpenItem, type Timing } from './timing'
import type { TaskProblem } from '../shared/task-api'
import { NO_WORK, OperationView, type CountsStep, type LastStrip, type OperationStep, type OperationViewModel, type Work } from './view/OperationView'
import type { OverrideModel } from './view/OverrideDialog'

/**
 * SCR-090's cases (design floor.operation): scan a bundle ticket, its card, the counts (reason-first), Finish, the two
 * ticks, Undo, Ask a correction, and every refusal in words; B-W2b-69: Start, Pause, Resume, Pieces so far, Hand back, the checks
 * before it counts and the team leader's override, the lots, the steps, several bundles with size buttons, no-bundle time, a
 * photo or comment. Made-up data only: a "Demo" plant, a made-up tenant tag, made-up styles and orders; never a real company,
 * person or number, never money, never another person's counts.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 123 })
const NEW_TICKET = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 188 })
const OTHER_BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 122 })
const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4211 })
const FOREIGN = formatScanId({ type: 'BUNDLE', tenantTag: tenantTag('0190f0e2-0000-7000-8000-000000000001'), ref: 9 })
const STATION = 'SEW-04 · Linea 2 St 4'
const AT = '2026-10-29T08:41:00.000Z'

const REASONS: CardReason[] = [
  { kind: 'SCRAP', code: 'LEATHER_FLAW', label: { it: 'Difetto della pelle', en: 'Leather flaw' }, sortOrder: 10 },
  { kind: 'SCRAP', code: 'CUT_WRONG', label: { it: 'Taglio sbagliato', en: 'Cut wrong' }, sortOrder: 20 },
  { kind: 'SCRAP', code: 'STITCHING', label: { it: 'Cucitura irrecuperabile', en: 'Stitching beyond repair' }, sortOrder: 30 },
  { kind: 'SCRAP', code: 'STAIN', label: { it: 'Macchia', en: 'Stain' }, sortOrder: 40 },
  { kind: 'SCRAP', code: 'TEAR', label: { it: 'Strappo o foro', en: 'Tear or hole' }, sortOrder: 50 },
  { kind: 'SCRAP', code: 'OTHER', label: { it: 'Altro', en: 'Other' }, sortOrder: 90 },
  { kind: 'REWORK', code: 'RESTITCH', label: { it: 'Cucitura da rifare', en: 'Stitching to redo' }, sortOrder: 10 },
  { kind: 'REWORK', code: 'ALIGNMENT', label: { it: 'Pezzi non allineati', en: 'Panels not aligned' }, sortOrder: 20 },
  { kind: 'REWORK', code: 'HARDWARE', label: { it: 'Zip o accessorio', en: 'Zip or hardware' }, sortOrder: 30 },
  { kind: 'REWORK', code: 'OTHER', label: { it: 'Altro', en: 'Other' }, sortOrder: 90 },
]

const op = (id: string, seq: number, code: string, name: string, workCentreKind: string, state: CardOperation['state'], expected: number | null, report: CardOperation['report'] = null): CardOperation => ({
  id,
  seq,
  code,
  name,
  scanRequired: true,
  workCentreKind,
  final: seq === 40,
  sewn: seq === 30,
  state,
  expected,
  report,
})

const OP10 = op('op-10', 10, 'CUT', 'Taglio pelle', 'CUTTING', 'DONE', 20, { scanId: 's-10', kind: 'REPORT', goodQuantity: 20, scrapQuantity: 0, reworkQuantity: 0, serverTime: '2026-10-29T07:10:00.000Z', station: { id: 'st-cut', code: 'CUT-02' }, own: false })
const OP20 = op('op-20', 20, 'SEW-SIDE', 'Cucire fianchi', 'SEWING', 'OPEN', 20)
const OP30 = op('op-30', 30, 'SEW-SLV', 'Attaccare maniche', 'SEWING', 'NOT_REACHED', null)
const OP40 = op('op-40', 40, 'FIN', 'Rifinitura e controllo', 'FINISHING', 'NOT_REACHED', null)
/** B-W2b-82: added to the released work order: picked by hand, good pieces only, up to the bundle's own pieces. */
const OP50: CardOperation = { ...op('op-50', 50, 'REINF', 'Rinforzo colletto', 'SEWING', 'OPEN', 20), scanRequired: false, unplanned: true, final: false, sewn: false }

const CARD: BundleCard = {
  scanned: BUNDLE,
  refusal: null,
  bundle: { id: 'b-123', code: BUNDLE, status: 'ACTIVE', quantity: 20, part: null, workOrderSizeId: 'c-52', colourwayCode: 'NERO', colourwayName: 'Nero', size: '52' },
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042', batchNumber: 'B-26-041', status: 'IN_PROGRESS', siteId: 'site-a', style: { code: 'GIA-01', name: 'Giacca moto Demo' } },
  station: { id: 'st-sew', code: 'SEW-04', name: STATION, kind: 'SEWING' },
  operations: [OP10, OP20, OP30, OP40],
  next: 'op-20',
  choose: [],
  hint: null,
  reasons: REASONS,
}

const WITH_UNPLANNED: BundleCard = { ...CARD, operations: [...CARD.operations, OP50] }
/** B-W2b-105 (QHS-039): the work order's first piece is open at Op 20 on another bundle: this one waits. */
const FIRST_PIECE_HELD: BundleCard = { ...CARD, firstPiece: { heldOperationIds: ['op-20'], firstBundle: false, check: { id: 'fp-1', status: 'OPEN', outcome: null, workOrderOperationId: 'op-20' }, message: null, fix: null } }
const EXTRA_CHOICES: ExtraChoices = {
  operations: [
    { id: 'lib-1', code: 'REINF', name: 'Rinforzo colletto', workCentreKind: 'SEWING', standardMinutes: '1.500', pays: 'PIECE_RATE' },
    { id: 'lib-2', code: 'PRESS', name: 'Stiratura extra', workCentreKind: 'FINISHING', standardMinutes: '0.800', pays: 'OFF_STANDARD' },
    { id: 'lib-3', code: 'BARTACK', name: 'Travette aggiuntive', workCentreKind: 'SEWING', standardMinutes: '0.600', pays: 'NO_PIECE_PAY' },
  ],
  reasons: [
    { code: 'QUALITY_FIX', label: { it: 'Per correggere un difetto', en: 'To fix a defect' }, needsNote: false },
    { code: 'MATERIAL_ISSUE', label: { it: 'Per un problema di materiale', en: 'A material problem' }, needsNote: false },
    { code: 'CUSTOMER_CHANGE', label: { it: 'Richiesta del cliente', en: 'The customer asked' }, needsNote: false },
    { code: 'MISSING_FROM_ROUTING', label: { it: 'Manca nel ciclo', en: 'Missing from the routing' }, needsNote: false },
    { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
  ],
}

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.operation', { station: { name: STATION, site: 'Stabilimento Demo Nord' }, ...extra })

const model = (step: OperationStep, extra: Partial<OperationViewModel> = {}): OperationViewModel => ({ frame: frame(), step, online: true, ...extra })

const extra = (draft: Partial<ExtraDraft> = {}, step: { choices?: ExtraChoices | null; problem?: TaskProblem | null; busy?: boolean } = {}): OperationStep => ({ kind: 'extra', card: CARD, back: counts(), choices: EXTRA_CHOICES, draft: { ...NEW_EXTRA, ...draft }, ...step })

const counts = (step: Partial<CountsStep> = {}): CountsStep => ({ kind: 'counts', card: CARD, operation: OP20, counts: NO_COUNTS, open: null, asOf: null, ...step })

// ---- B-W2b-69: the bundle at the operation ------------------------------------------------------------------------------------

const NOW = new Date('2026-10-29T08:41:00.000Z')
const RUNNING: Timing = { ...afterStart(NOT_STARTED, new Date(NOW.getTime() - 12 * 60_000 - 7_000)), secondsBefore: 0, piecesSoFar: 0 }
const PAUSED: Timing = afterPause(RUNNING, 'MATERIAL_WAIT', NOW)
const OVERRIDE_TILES: OperationCheck['overrideReasons'] = [
  { code: 'COUNTED_AGAIN', label: { it: 'Ricontati: i pezzi ci sono', en: 'Counted again: the pieces are here' }, needsNote: false },
  { code: 'EARLIER_LATE', label: { it: "L'operazione prima si registra dopo", en: 'The earlier operation is recorded later' }, needsNote: false },
  { code: 'COVERING_LINE', label: { it: "Aiuto un'altra linea", en: 'Helping another line' }, needsNote: false },
  { code: 'BACK_FROM_REWORK', label: { it: 'Pezzi tornati dalla ripresa', en: 'Pieces back from rework' }, needsNote: false },
  { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
]
const CHECK: OperationCheck = { modes: { quantityGuard: 'STRICT', skippedOperationRule: 'WARN' }, expected: 20, beyondBundle: false, findings: [], components: { asked: [], traceable: [] }, overrideReasons: OVERRIDE_TILES }
const PROTECTOR = { itemId: 'item-pro', code: 'PRO-300', name: 'Protezione spalla livello 2' }
const LINING = { itemId: 'item-lin', code: 'FOD-110', name: 'Fodera termica' }
const ASKED: OperationCheck = { ...CHECK, components: { asked: [PROTECTOR, LINING], traceable: [{ ...PROTECTOR, asked: true }, { ...LINING, asked: true }] } }
const STEPS: OperationSteps = {
  open: 2,
  steps: [
    { code: 'ALIGN', words: 'Allinea i fianchi con le tacche', required: true, tick: { outcome: 'DONE', at: '2026-10-29T08:31:00.000Z', mine: true, by: 'Ada Demo' } },
    { code: 'BARTACK', words: 'Travetta sulle tasche', required: true, tick: null },
    { code: 'LABEL', words: 'Cuci l’etichetta CE', required: true, tick: null },
    { code: 'TRIM', words: 'Taglia i fili', required: false, tick: { outcome: 'NOT_APPLICABLE', at: '2026-10-29T08:33:00.000Z', mine: false, by: null } },
  ],
}
const work = (extra: Partial<Work>): Work => ({ ...NO_WORK, timing: NOT_STARTED, check: CHECK, ...extra })
const started = (extra: Partial<Work> = {}) => counts({ work: work({ timing: RUNNING, ...extra }) })
const PAUSE_REASONS: PickerReason[] = [
  ['BREAK', 'Pausa', 'Break', 'coffee'],
  ['MATERIAL_WAIT', 'Attesa materiale', 'Waiting for material', 'package'],
  ['MACHINE', 'Macchina', 'Machine', 'wrench'],
  ['CALLED_AWAY', 'Chiamato altrove', 'Called away', 'user'],
  ['OTHER', 'Altro', 'Other', null],
].map(([code, it, en, icon], index) => ({ id: code!, list: 'PAUSE', code: code!, labelIt: it!, labelEn: en!, labelI18n: {}, icon: null, colour: icon ? '#1f6fde' : null, photo: null, needsDetail: code === 'OTHER', sortOrder: index }))

const override = (extra: Partial<OverrideModel> = {}): OverrideModel => ({
  subject: { code: BUNDLE, seq: 20, good: 22 },
  lines: [{ code: 'MORE_THAN_PASSED', message: '' }],
  reasons: OVERRIDE_TILES,
  reasonCode: null,
  words: '',
  lead: null,
  people: [
    { id: 'p-1', name: 'Ada Demo' },
    { id: 'p-2', name: 'Bea Esempio' },
    { id: 'p-3', name: 'Carlo Prova' },
  ],
  picking: false,
  busy: false,
  problem: null,
  offline: false,
  ...extra,
})

const row = (ref: number, size: string, quantity: number, extra: Partial<StackRow> = {}): StackRow => ({
  clientScanId: `demo-stack-${ref}`,
  card: { ...CARD, bundle: { ...CARD.bundle, id: `b-${ref}`, code: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref }), size, quantity } },
  operation: { ...OP20, expected: quantity },
  counts: NO_COUNTS,
  refusal: null,
  ...extra,
})
const STACK: StackRow[] = [row(123, '52', 20), row(124, '52', 20), row(125, '54', 20)]

const TILES: OffStandardTile[] = [
  ['CLEANING', 'Pulizia', 'Cleaning', 'OFF_STANDARD'],
  ['TRAINING', 'Formazione', 'Training', 'INDIRECT'],
  ['SAMPLES', 'Campioni', 'Samples', 'INDIRECT'],
  ['MEETING', 'Riunione', 'Meeting', 'INDIRECT'],
  ['WAIT_WORK', 'Attesa lavoro', 'Waiting for work', 'OFF_STANDARD'],
].map(([code, it, en, kind]) => ({ id: `tile-${code}`, code: code!, kind: kind as OffStandardTile['kind'], labelIt: it!, labelEn: en!, labelI18n: {}, icon: null, colour: null }))
const BLOCK: OffStandardBlock = { id: 'block-1', code: TILES[0]!, startedAt: '2026-10-29T08:29:00.000Z' }

const openItem = (state: OpenItem['state'], ref: number, extra: Partial<OpenItem> = {}): OpenItem => ({ bundleId: `b-${ref}`, bundleCode: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref }), operation: { id: 'op-30', seq: 30, code: 'SEW-SLV', name: 'Attaccare maniche' }, state, pausedAt: state === 'PAUSED' ? '2026-10-29T09:58:00.000Z' : null, runningSince: state === 'RUNNING' ? '2026-10-29T08:12:00.000Z' : null, pausedAtClockOut: false, ...extra })

const strip = (extra: Partial<LastStrip> = {}): LastStrip => ({ bundleCode: OTHER_BUNDLE, operationSeq: 20, good: 20, scrap: 0, rework: 0, ticks: 'recorded', undo: 'closed', ...extra })

const SCRAP_REWORK: Counts = { scrap: { LEATHER_FLAW: 1 }, rework: { RESTITCH: 1 }, typedGood: null }

const TARGETS: CorrectionTarget[] = [
  { key: 's-901', scanId: 's-901', clientScanId: 'c-901-demo', bundleCode: OTHER_BUNDLE, operation: { seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, good: 19, scrap: { STAIN: 1 }, rework: {}, at: '2026-10-29T08:12:00.000Z', pending: false },
  { key: 's-900', scanId: 's-900', clientScanId: 'c-900-demo', bundleCode: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 121 }), operation: { seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, good: 16, scrap: {}, rework: {}, at: '2026-10-29T07:55:00.000Z', pending: true },
  { key: 's-899', scanId: 's-899', clientScanId: 'c-899-demo', bundleCode: formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 120 }), operation: { seq: 20, code: 'SEW-SIDE', name: 'Cucire fianchi' }, good: 20, scrap: {}, rework: {}, at: '2026-10-29T07:31:00.000Z', pending: false },
]

export const designScreen = defineDesignScreen<OperationViewModel>({
  screen: 'SCR-090',
  title: 'Operation',
  view: onFloor(OperationView),
  cases: [
    { id: 'ready', label: 'Ready to scan', model: model({ kind: 'scan' }), note: 'The ticket is the only input needed. A hardware scanner reads it anywhere on the screen; the camera and typing are the fallbacks.' },
    { id: 'ready-last', label: 'Ready to scan, last report on top', model: model({ kind: 'scan' }, { last: strip() }), note: 'The last report stays on top with its two ticks; its undo window closed with the next scan, so it offers "Ask a correction".' },
    { id: 'loading', label: 'Opening the bundle', model: model({ kind: 'loading', code: BUNDLE }) },
    { id: 'loaded', label: 'Bundle loaded: all good, one tap', model: model(counts()), note: 'Good opens at the expected number (what Op 10 passed): Finish · 20 good is one tap (Owner answer F3). Enter = Finish.' },
    {
      id: 'pick',
      label: 'Which operation?',
      model: model({ kind: 'pick', card: { ...CARD, next: null, choose: ['op-20', 'op-30'] }, options: [OP20, { ...OP30, state: 'OPEN', expected: 20 }], asOf: null }),
      note: 'Two operations of this station\'s work fit the bundle: big tiles, first in sequence first; arrows move, Enter picks.',
    },
    {
      id: 'scrap-rework',
      label: '1 scrap and 1 rework (reason-first)',
      model: model(counts({ counts: SCRAP_REWORK })),
      note: 'The counters after a scrap and a rework reason: Good balanced itself to 18. Finish · 18 good.',
    },
    {
      id: 'scrap-picker',
      label: 'Scrap opens the reason picker (SCR-091)',
      model: model(counts({ counts: SCRAP_REWORK, open: 'scrap' })),
      note: 'W2a: Scrap opens the illustrated reason picker (B-W2a-74): what it is for and the running count, then icon tiles. Each tap adds one piece with that reason and takes it from Good; − on the tile takes it back. Done goes back to the counts; Finish · 18 good stays one tap away (scan → Scrap → tile → Finish). Esc = Done.',
    },
    {
      id: 'rework-picker',
      label: 'Rework opens the reason picker',
      model: model(counts({ counts: SCRAP_REWORK, open: 'rework' })),
      note: 'The rework reasons the same way; the pieces reach the office\'s Production › Scrap & rework list with their reason.',
    },
    {
      id: 'picker-at-most',
      label: 'Reason picker: every piece has a reason',
      model: model(counts({ counts: { scrap: { LEATHER_FLAW: 19 }, rework: { RESTITCH: 1 }, typedGood: null }, open: 'scrap', problem: 'atMost' })),
      note: 'A tap past the bundle\'s pieces is refused in words; nothing is counted.',
    },
    {
      id: 'above',
      label: 'Good typed above what is left',
      model: model(counts({ counts: { ...SCRAP_REWORK, typedGood: 18 }, open: 'good', problem: 'atMost' })),
      note: 'Missing pieces: Good is typed on the pad; a digit past what is left is refused with an amber flash and "At most …".',
    },
    {
      id: 'recorded',
      label: 'Recorded (two ticks), next scan ready',
      model: model({ kind: 'scan' }, { last: strip({ bundleCode: BUNDLE, good: 19, scrap: 1, undo: 'open' }), receipt: true }),
      note: 'The receipt: saved on this tablet at once, recorded by the office once the server took it. The screen is already the scan step; Undo until the next scan or 2 minutes.',
    },
    {
      id: 'saved-offline',
      label: 'Offline: saved on this tablet (one tick)',
      model: model({ kind: 'scan' }, { frame: frame({ online: false, pending: 3, lastSentAt: '2026-10-29T08:20:00.000Z' }), online: false, last: strip({ bundleCode: BUNDLE, good: 20, ticks: 'saved', undo: 'open' }), receipt: true }),
      note: 'Reports queue: the banner counts what waits; it is sent in order when the network is back.',
    },
    { id: 'undo-offered', label: 'Undo offered', model: model({ kind: 'scan' }, { last: strip({ bundleCode: BUNDLE, good: 19, scrap: 1, undo: 'open', ticks: 'sending' }) }), note: 'Undo writes an UNDO row; the report stays (append-only).' },
    { id: 'undone', label: 'Report undone', model: model({ kind: 'scan' }, { last: strip({ bundleCode: BUNDLE, good: 19, scrap: 1, undo: 'undone', undoTicks: 'saved' }) }) },
    { id: 'corrections', label: 'Ask a correction: your reports today', model: model({ kind: 'corrections', targets: TARGETS, offline: false }), note: 'Own reports only, newest first; one already asked waits for the team leader. The keys sit in the list footer\'s info icon.' },
    { id: 'corrections-empty', label: 'Nothing reported today', model: model({ kind: 'corrections', targets: [], offline: false }) },
    {
      id: 'corrections-offline',
      label: 'Corrections offline',
      model: model({ kind: 'corrections', targets: [{ ...TARGETS[0]!, key: 'local:1', scanId: null }], offline: true }, { frame: frame({ online: false, pending: 1 }), online: false }),
      note: 'The list needs the network; the report just made on this tablet can still be corrected (queued).',
    },
    {
      id: 'correct',
      label: 'Correction: new counts and why',
      model: model({ kind: 'correct', target: TARGETS[0]!, counts: { scrap: {}, rework: {}, typedGood: 20 }, open: null, reason: 'found', reasons: REASONS }),
      note: 'The same pads; a reason; Send. The original report stays until the team leader decides (c.c. art. 2101).',
    },
    {
      id: 'correct-picker',
      label: 'Correction: scrap reasons in the picker',
      model: model({ kind: 'correct', target: TARGETS[0]!, counts: { scrap: { STAIN: 1 }, rework: {}, typedGood: null }, open: 'scrap', reason: 'found', reasons: REASONS }),
      note: 'Scrap in a correction opens the same reason picker; Done goes back to the new counts and the reason.',
    },
    { id: 'asked', label: 'Correction sent: waiting', model: model({ kind: 'asked', target: TARGETS[0]!, ticks: 'recorded' }) },
    {
      id: 'replaced',
      label: 'Refused: an old ticket',
      model: model({ kind: 'refused', code: 'REPLACED', message: '', fix: null, card: { ...CARD, bundle: { ...CARD.bundle, code: NEW_TICKET } }, scanned: BUNDLE }),
      note: 'A lost ticket was reprinted: the old code says which one replaced it. Never a toast: a full-screen state.',
    },
    { id: 'voided', label: 'Refused: bundle voided', model: model({ kind: 'refused', code: 'VOIDED', message: '', fix: null, card: { ...CARD, bundle: { ...CARD.bundle, status: 'VOID' } }, scanned: BUNDLE }) },
    {
      id: 'already-own',
      label: 'Already reported by you',
      model: model({ kind: 'already', card: CARD, operation: OP20, report: { scanId: 's-950', kind: 'REPORT', goodQuantity: 19, scrapQuantity: 1, reworkQuantity: 0, serverTime: AT, station: { id: 'st-sew', code: 'SEW-04' }, own: true }, undo: true }),
      note: 'Your own report: its counts, and Undo while its window is open (else Ask a correction).',
    },
    {
      id: 'already-other',
      label: 'Already reported by another person',
      model: model({ kind: 'already', card: CARD, operation: OP20, report: { scanId: 's-951', kind: 'REPORT', goodQuantity: 0, scrapQuantity: 0, reworkQuantity: 0, serverTime: AT, station: { id: 'st-sew-3', code: 'SEW-03' }, own: false }, undo: false }),
      note: 'Another person: no name and no numbers (Statuto dei Lavoratori art. 4); the team leader can see who.',
    },
    { id: 'wrong-type', label: 'Wrong label type', model: model({ kind: 'wrongType', type: 'hide', code: HIDE }) },
    { id: 'other-factory', label: 'Another factory\'s ticket', model: model({ kind: 'unknownCode', reason: 'otherFactory', code: FOREIGN }) },
    {
      id: 'not-on-tablet',
      label: 'Offline: bundle not on this tablet',
      model: model({ kind: 'notOnTablet', code: BUNDLE }, { frame: frame({ online: false, pending: 2 }), online: false }),
      note: 'A bundle never read on this tablet cannot be checked offline: report it when the network is back.',
    },
    {
      id: 'as-of',
      label: 'Offline: bundle from this tablet',
      model: model(counts({ asOf: '2026-10-29T08:35:00.000Z' }), { frame: frame({ online: false, pending: 1 }), online: false }),
      note: 'A bundle read earlier in this visit opens from the tablet, with its as-of time; the report queues.',
    },
    {
      id: 'wo-not-open',
      label: 'Work order not open',
      model: model({ kind: 'refused', code: 'WORK_ORDER_NOT_OPEN', message: '', fix: null, card: { ...CARD, workOrder: { ...CARD.workOrder, status: 'CANCELLED' } }, scanned: BUNDLE }),
      note: 'A work order on hold, done or cancelled takes no report; the refusal says why, Finish never shows.',
    },
    { id: 'previous', label: 'Refused: the operation before is not reported', model: model({ kind: 'refused', code: 'PREVIOUS_NOT_REPORTED', message: '', fix: null, card: CARD, scanned: BUNDLE }) },
    {
      id: 'leave',
      label: 'Leave this count?',
      model: model(counts({ counts: SCRAP_REWORK, open: 'scrap' }), { leave: { bundleCode: BUNDLE, operationSeq: 20, scrap: 1, rework: 1 } }),
      note: 'Another ticket scanned while counts are typed: Enter and Esc keep counting.',
    },
    { id: 'error', label: 'Server not answering', model: model({ kind: 'problem', problem: { kind: 'unavailable' }, code: BUNDLE }) },
    // ---- B-W2b-69: start, pause, finish ----
    { id: 'not-started', label: 'Not started: Start, or just Finish', model: model(counts({ work: work({}) })), note: 'Bar: Start · Not all good · Finish · 20 good. Finish stays one tap with no Start (Owner answer F3); scanning the ticket again is Start.' },
    { id: 'rush', label: 'Rush flag on the bundle', model: model(counts({ card: { ...CARD, workOrder: { ...CARD.workOrder, rush: true } }, work: work({}) })), note: 'Icon and word, never colour alone. First-piece hold (W2b-2) and Spec changed (W2b-4) join here later.' },
    // ---- B-W2b-105: the first-piece hold (QHS-039) and "Which operation caused it?" (MES-127) ----
    {
      id: 'first-piece-held',
      label: 'Waiting for first-piece approval: held',
      model: model(counts({ card: FIRST_PIECE_HELD, work: work({}) })),
      note: 'The flag with icon and words on the card; Start and Finish held with the reason on screen (the API refuses them: 409 FIRST_PIECE). Pause and Hand back stay free.',
    },
    { id: 'first-piece-rejected', label: 'First piece rejected: still held', model: model(counts({ card: { ...FIRST_PIECE_HELD, firstPiece: { ...FIRST_PIECE_HELD.firstPiece!, check: { ...FIRST_PIECE_HELD.firstPiece!.check!, status: 'DECIDED', outcome: 'REJECTED' } } }, work: work({}) })), note: 'A rejected first piece keeps the hold; a new one is asked.' },
    { id: 'first-piece-bundle', label: 'This bundle is the first piece', model: model(counts({ card: { ...CARD, firstPiece: { heldOperationIds: [], firstBundle: true, check: { id: 'fp-1', status: 'OPEN', outcome: null, workOrderOperationId: 'op-20' }, message: null, fix: null } }, work: work({}) })), note: 'The first bundle itself is worked (it goes through), then the inspector checks it.' },
    { id: 'first-piece-lifted', label: 'First piece approved while on screen', model: model({ ...counts({ card: { ...CARD, firstPiece: { heldOperationIds: [], firstBundle: false, check: { id: 'fp-1', status: 'DECIDED', outcome: 'APPROVED', workOrderOperationId: 'op-20' }, message: null, fix: null } }, work: work({}) }), firstPieceLifted: true }), note: 'Live: the hold lifts with a success flash and this line; Start and Finish open at once.' },
    { id: 'first-piece-refused', label: 'Start refused: waiting for the first piece', model: model({ kind: 'refused', code: 'FIRST_PIECE', message: '', fix: null, card: FIRST_PIECE_HELD, scanned: BUNDLE }), note: 'The API\'s 409 refusal/FIRST_PIECE in the screen\'s words; it opens again by itself when the first piece is approved.' },
    {
      id: 'cause',
      label: 'Which operation caused it?',
      model: model(counts({ counts: { ...SCRAP_REWORK, causedAt: { scrap: 'op-10' } }, open: 'scrap', work: work({}) })),
      note: 'Above the scrap reasons: the bundle\'s operations up to this one, Not known by default; Op 10 pressed here. Charged per operation, never per person (MES-127).',
    },
    { id: 'running', label: 'Running: the bundle\'s own clock', model: model(started()), note: 'FloorElapsed big; a screen reader hears it once a minute. Bar: Pause · Not all good · Finish · 20 good. No pace, no target (art. 4).' },
    { id: 'running-team', label: 'Running: a team on one tablet', model: model(started({ timing: { ...RUNNING, people: 3 } })), note: 'MES-094: the tablet\'s crew; only how many, never who.' },
    { id: 'not-all-good', label: 'Not all good: the scrap reasons', model: model(counts({ open: 'scrap', work: work({ timing: RUNNING }) })), note: 'Not all good opens the picker of Scrap; a button in the bar turns it to Rework, Finish stays one tap away.' },
    { id: 'pause-reason', label: 'Pause asks a reason', model: model({ kind: 'pause', from: started(), list: { state: 'ready', reasons: PAUSE_REASONS, asOf: null }, picked: null, words: '' }), note: 'The one picker over the PAUSE list; one tap pauses.' },
    { id: 'pause-words', label: 'Pause: a reason that asks a few words', model: model({ kind: 'pause', from: started(), list: { state: 'ready', reasons: PAUSE_REASONS, asOf: null }, picked: 'OTHER', words: '' }) },
    { id: 'pause-loading', label: 'Pause: reasons loading', model: model({ kind: 'pause', from: started(), list: { state: 'loading', reasons: [], asOf: null }, picked: null, words: '' }) },
    { id: 'pause-offline', label: 'Pause offline, reasons not on the tablet', model: model({ kind: 'pause', from: started(), list: { state: 'offline', reasons: [], asOf: null }, picked: null, words: '' }, { frame: frame({ online: false }), online: false }) },
    { id: 'paused', label: 'Paused: Resume is the main action', model: model(counts({ work: work({ timing: PAUSED }) }), { pauseReasons: PAUSE_REASONS }), note: 'The clock stands still with the reason in words; Finish is still one tap.' },
    { id: 'paused-clock-out', label: 'Paused at clock-out, offered back', model: model(counts({ work: work({ timing: { ...PAUSED, pauseReasonCode: 'CLOCK_OUT', pausedAtClockOut: true } }) })) },
    { id: 'pieces', label: 'Pieces so far', model: model({ kind: 'pieces', from: started(), value: 8 }), note: 'Another person may continue the bundle: − and + or the pad; never the last piece (that is the report).' },
    { id: 'pieces-saved', label: 'Pieces so far saved', model: model({ kind: 'scan' }, { done: { kind: 'pieces', bundleCode: BUNDLE, count: 8, ticks: 'recorded' } }) },
    { id: 'hand-back', label: 'Hand back?', model: model(started(), { handBack: { bundleCode: BUNDLE, operationSeq: 20 } }), note: 'There is no undo of a hand back, so it asks once; the time stays on the record.' },
    { id: 'handed-back', label: 'Handed back', model: model({ kind: 'scan' }, { done: { kind: 'handBack', bundleCode: BUNDLE, ticks: 'saved' } }) },
    { id: 'another-person', label: 'Another person works on it', model: model(counts({ work: work({ timing: { ...RUNNING, mine: false, actions: [] } }) })), note: 'No name and no clock: "another person, your team leader can see who". Finish still works (F3).' },
    { id: 'offline-running', label: 'Offline: running, saved on this tablet', model: model(started({ skewMs: 0 }), { frame: frame({ online: false, pending: 2 }), online: false }), note: 'Start, Pause, Resume, Pieces so far and Hand back queue with the tablet\'s time.' },
    { id: 'quantity-more', label: 'More than the operation before passed', model: model(counts({ counts: { ...NO_COUNTS, typedGood: 22 }, operation: { ...OP20, expected: 20 }, card: { ...CARD, bundle: { ...CARD.bundle, quantity: 24 } }, work: work({}) })), note: 'MES-097: Good stepped past what passed, up to the bundle: STRICT here, so a team leader signs at Finish.' },
    { id: 'stepper', label: 'Good stepped without typing', model: model(counts({ counts: { ...NO_COUNTS, typedGood: 18 }, work: work({}) })), note: 'MES-106: − and + on Good; the keys + and − too; the pad stays one tap away for the rare case.' },
    // ---- checks before it counts ----
    { id: 'guard-wrong-bundle', label: 'Red screen: bundle of another line', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [{ code: 'WRONG_BUNDLE', message: 'Bundle is for line L1.', fix: null, overridable: true }], target: 'report' }), note: 'A clear screen, not a log entry: why, what to do, and the team leader\'s override.' },
    { id: 'guard-more', label: 'Red screen: more than passed', model: model({ kind: 'guard', from: counts({ counts: { ...NO_COUNTS, typedGood: 22 }, work: work({}) }), lines: [{ code: 'MORE_THAN_PASSED', message: 'More than passed.', fix: null, overridable: true }], target: 'report' }) },
    { id: 'guard-offline', label: 'Red screen offline: the override waits', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [{ code: 'WRONG_BUNDLE', message: 'Bundle is for line L1.', fix: null, overridable: true }], target: 'report' }, { frame: frame({ online: false }), online: false }), note: 'The PIN is checked by the server: held with the reason.' },
    { id: 'guard-skill', label: 'Start held: a skill the person lacks', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [{ code: 'NOT_QUALIFIED', message: 'Not qualified.', fix: null, overridable: true }], target: 'start' }), note: 'MES-024: held; the team leader overrides with PIN and reason.' },
    { id: 'guard-authorisation', label: 'Start refused: no authorisation', model: model({ kind: 'refused', code: 'NOT_AUTHORISED', message: '', fix: null, card: CARD, scanned: BUNDLE }), note: 'An authorisation is never lifted.' },
    { id: 'guard-told', label: 'A warning: it counts, the team leader is told', model: model(counts({ work: work({ check: { ...CHECK, findings: [{ kind: 'SKIPPED_OPERATION', mode: 'WARN', code: 'PREVIOUS_NOT_REPORTED', message: 'Skipped.', fix: '', overridable: false }] } }) })), note: 'MES-098: the site\'s rule is WARN: Finish stays open.' },
    { id: 'other-running', label: 'Refused: another bundle is running', model: model({ kind: 'refused', code: 'OTHER_RUNNING', message: '', fix: null, card: CARD, scanned: BUNDLE }) },
    { id: 'override-reason', label: 'Team leader override: the reason', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [{ code: 'MORE_THAN_PASSED', message: '', fix: null, overridable: true }], target: 'report' }, { override: override() }) },
    { id: 'override-words', label: 'Team leader override: Other, a few words', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'OTHER' }) }) },
    { id: 'override-badge', label: 'Team leader override: badge or name', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'COUNTED_AGAIN' }) }) },
    { id: 'override-name', label: 'Team leader override: pick the name', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'COUNTED_AGAIN', picking: true }) }) },
    { id: 'override-pin', label: 'Team leader override: the PIN', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'COUNTED_AGAIN', lead: { kind: 'name', workerId: 'p-2', name: 'Bea Esempio' } }) }), note: 'The sixth digit signs; no digit is ever drawn or kept.' },
    { id: 'override-wrong', label: 'Team leader override: wrong PIN', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'COUNTED_AGAIN', lead: { kind: 'badge', code: 'x' }, problem: 'wrong' }) }), note: 'A wrong PIN counts on the team leader; the operator stays signed in.' },
    { id: 'override-self', label: 'Team leader override: their own scan', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'COUNTED_AGAIN', lead: { kind: 'badge', code: 'x' }, problem: 'self' }) }) },
    { id: 'override-locked', label: 'Team leader override: locked', model: model({ kind: 'guard', from: counts({ work: work({}) }), lines: [], target: 'report' }, { override: override({ reasonCode: 'COUNTED_AGAIN', lead: { kind: 'badge', code: 'x' }, problem: 'locked' }) }) },
    // ---- scan what you used, steps ----
    { id: 'components', label: 'Scan what you used', model: model(counts({ work: work({ check: ASKED }) })), note: 'MES-114: rows of what the operation asks; Finish waits for a lot of each. Nothing shows when the operation asks nothing.' },
    { id: 'components-ticked', label: 'Components: one lot covers all', model: model(counts({ work: work({ check: ASKED, lots: [{ code: 'LOT-PRO-0091', itemId: 'item-pro', garments: null }] }) })) },
    { id: 'components-two-lots', label: 'Components: two lots of one item', model: model(counts({ work: work({ check: ASKED, lots: [{ code: 'LOT-PRO-0091', itemId: 'item-pro', garments: 12 }, { code: 'LOT-PRO-0092', itemId: 'item-pro', garments: null }, { code: 'LOT-FOD-0040', itemId: 'item-lin', garments: null }] }) })), note: 'The first lot says how many it covers, by − and +; the last takes the rest.' },
    { id: 'components-say', label: 'Components: the second lot was just scanned', model: model(counts({ work: work({ check: ASKED, lots: [{ code: 'LOT-PRO-0091', itemId: 'item-pro', garments: 0 }, { code: 'LOT-PRO-0092', itemId: 'item-pro', garments: null }, { code: 'LOT-FOD-0040', itemId: 'item-lin', garments: null }] }) })), note: 'Finish waits until the first lot says how many: a guess would be a wrong trace on protective equipment.' },
    { id: 'components-wrong', label: 'Components: a wrong item is refused', model: model(counts({ work: work({ check: ASKED, lotRefusal: { code: 'WRONG_COMPONENT', message: 'Not a material.', fix: null } }) })) },
    { id: 'components-offline', label: 'Components: a lot read offline', model: model(counts({ work: work({ check: ASKED, lots: [{ code: 'LOT-PRO-0091', itemId: null, garments: null }], lotsUnchecked: true }) }), { frame: frame({ online: false, pending: 1 }), online: false }), note: 'Offline the row ticks on trust; the office checks the lot when the report arrives.' },
    { id: 'steps', label: 'Steps in this operation', model: model(counts({ work: work({ steps: STEPS }) })), note: 'MES-102: one tap ticks; who and when on each row; Finish waits for the required ones. The DS has no FloorChecklist yet: composed of FloorList rows.' },
    { id: 'steps-done', label: 'Steps all ticked: Finish opens', model: model(counts({ work: work({ steps: { open: 0, steps: STEPS.steps.map((step) => ({ ...step, tick: step.tick ?? { outcome: 'DONE', at: '2026-10-29T08:38:00.000Z', mine: true, by: 'Ada Demo' } })) } }) })) },
    // ---- several bundles ----
    // B-W2b-82 (MES-086): an unplanned operation, a real step.
    { id: 'unplanned-offered', label: 'Unplanned operation on the work order', model: model(counts({ card: WITH_UNPLANNED, work: work({}) })), note: 'A scan still opens the routing\'s next step (one tap stays one tap); the unplanned operation of this station\'s kind is one tap away.' },
    { id: 'unplanned-counts', label: 'Unplanned operation: good pieces only', model: model(counts({ card: WITH_UNPLANNED, operation: OP50, work: work({ check: { ...CHECK, expected: 20 } }) })), note: 'Up to the bundle\'s own pieces, whatever the routing passed. No Scrap, no Rework, no Not all good, no stack: a piece lost here would stay in the routing\'s flow. Finish is one tap; Back returns to the routing\'s step.' },
    { id: 'unplanned-running', label: 'Unplanned operation: running', model: model(counts({ card: WITH_UNPLANNED, operation: OP50, work: work({ timing: RUNNING }) })), note: 'Start, Pause and Pieces so far work like any operation: the minutes are the work order\'s.' },
    { id: 'unplanned-refused', label: 'Refused: scrap at an unplanned operation (a queued report)', model: model({ kind: 'refused', code: 'UNPLANNED_GOOD_ONLY', message: '', fix: null, card: WITH_UNPLANNED, scanned: BUNDLE }), note: 'Only an older client can send it; the words say what to do.' },
    { id: 'unplanned-already', label: 'All reported here, an unplanned operation left', model: model({ kind: 'already', card: { ...WITH_UNPLANNED, next: null, hint: { code: 'ALREADY_REPORTED', message: '', fix: '' } }, operation: { ...OP20, state: 'DONE' }, report: { scanId: 's-20', kind: 'REPORT', goodQuantity: 20, scrapQuantity: 0, reworkQuantity: 0, serverTime: AT, station: { id: 'st-sew', code: 'SEW-04' }, own: true }, undo: false }), note: 'A bundle done at this station can still go to the unplanned operation.' },
    { id: 'unplanned-lead', label: 'Team leader: Add an unplanned operation', model: model(counts({ work: work({}) }), { mayAdd: true }), note: 'production.extraops.add only. An operator never sees it.' },
    { id: 'extra-loading', label: 'Add: reading the operations', model: model(extra({}, { choices: null }), { mayAdd: true }) },
    { id: 'extra-pick', label: 'Add: the operation and why', model: model(extra({ operationId: 'lib-1' }), { mayAdd: true }), note: 'The library\'s active operations this work order lacks; the reason tiles; Add waits for both, in words on the bar.' },
    { id: 'extra-ready', label: 'Add: ready', model: model(extra({ operationId: 'lib-1', reason: 'QUALITY_FIX' }), { mayAdd: true }) },
    { id: 'extra-words', label: 'Add: Other asks a few words', model: model(extra({ operationId: 'lib-1', reason: 'OTHER' }), { mayAdd: true }) },
    { id: 'extra-no-rate', label: 'Add: no piece rate', model: model(extra({ operationId: 'lib-2', reason: 'MATERIAL_ISSUE' }), { mayAdd: true }), note: 'Piece pay is on and the operation has no rate in force: said before Add. No figure: a word.' },
    { id: 'extra-busy', label: 'Add: adding', model: model(extra({ operationId: 'lib-1', reason: 'QUALITY_FIX' }, { busy: true }), { mayAdd: true }) },
    { id: 'extra-empty', label: 'Add: nothing left to add', model: model(extra({}, { choices: { ...EXTRA_CHOICES, operations: [] } }), { mayAdd: true }) },
    { id: 'extra-error', label: 'Add: the list did not load', model: model(extra({}, { choices: null, problem: { kind: 'unavailable' } }), { mayAdd: true }) },
    { id: 'extra-refused', label: 'Add: refused in words', model: model(extra({ operationId: 'lib-1', reason: 'QUALITY_FIX' }, { problem: { kind: 'conflict', message: 'Work order WO-DEMO-0042 is not released or in progress: it takes no unplanned operation.' } }), { mayAdd: true }) },
    { id: 'extra-offline', label: 'Add offline: held with the reason', model: model(extra({ operationId: 'lib-1', reason: 'QUALITY_FIX' }), { mayAdd: true, online: false, frame: frame({ online: false }) }), note: 'Adding is online only: the list is the office\'s. Scans at an operation already added queue as usual.' },
    { id: 'extra-added', label: 'Added: the team leader stays on the bundle', model: model(counts({ card: WITH_UNPLANNED, work: work({}) }), { mayAdd: true, done: { kind: 'extra', bundleCode: 'WO-DEMO-0042', ticks: 'recorded', extra: { seq: 50, name: 'Rinforzo colletto', pays: 'PIECE_RATE' } } }) },
    { id: 'extra-added-no-rate', label: 'Added, no piece rate', model: model(counts({ card: WITH_UNPLANNED, work: work({}) }), { mayAdd: true, done: { kind: 'extra', bundleCode: 'WO-DEMO-0042', ticks: 'recorded', extra: { seq: 50, name: 'Stiratura extra', pays: 'OFF_STANDARD' } } }) },
    { id: 'stack-empty', label: 'Several bundles: nothing scanned yet', model: model({ kind: 'stack', rows: [], size: null }) },
    { id: 'stack', label: 'Several bundles: one size', model: model({ kind: 'stack', rows: STACK.slice(0, 2), size: null }), note: 'MES-100: scan several, Finish once. − and + per bundle, no typing.' },
    { id: 'stack-sizes', label: 'Several bundles: size buttons', model: model({ kind: 'stack', rows: STACK, size: null }), note: 'MES-107: with two sizes on the stack the size buttons count by size; each says its pieces.' },
    { id: 'stack-size-picked', label: 'Several bundles: one size picked', model: model({ kind: 'stack', rows: STACK, size: '54' }) },
    { id: 'stack-refused', label: 'Several bundles: one refused stays', model: model({ kind: 'stack', rows: [row(125, '54', 20, { refusal: { code: 'MORE_THAN_PASSED', message: 'More.', fix: null } }), row(126, '54', 20, { refusal: { code: 'CHECKLIST_OPEN', message: 'Steps.', fix: null } })], size: null, line: { key: 'partly', params: { count: 2, refused: 2 }, tone: 'warning' } }), note: 'A held one goes to the override on its own; anything else is reported alone.' },
    { id: 'stack-line', label: 'Several bundles: a scan that does not join', model: model({ kind: 'stack', rows: STACK.slice(0, 1), size: null, line: { key: 'already', params: { code: OTHER_BUNDLE }, tone: 'danger' } }) },
    { id: 'stack-shade', label: 'Several bundles: shades do not match', model: model({ kind: 'stack', rows: STACK.slice(0, 2), size: null, mismatch: true, line: { key: 'shade', tone: 'danger' } }), note: 'MES-078: parts of one work order joined here; Finish is held until one comes off.' },
    { id: 'stack-offline', label: 'Several bundles offline', model: model({ kind: 'stack', rows: STACK.slice(0, 2), size: null }, { frame: frame({ online: false, pending: 2 }), online: false }), note: 'One queued report per bundle, in the order scanned.' },
    { id: 'stack-leave', label: 'Several bundles: leave the stack?', model: model({ kind: 'stack', rows: STACK, size: null }, { stackLeave: { bundles: 3, good: 60 } }) },
    { id: 'stack-alone', label: 'Several bundles: back after a report alone', model: model({ kind: 'stack', rows: STACK.slice(1), size: null, line: { key: 'reportedAlone', params: { code: BUNDLE }, tone: 'success' } }), note: 'A bundle with scrap is reported alone; the rest of the stack waits and comes back.' },
    { id: 'stack-done', label: 'Several bundles: receipt', model: model({ kind: 'scan' }, { last: strip({ bundles: 3, good: 60, undo: 'closed' }), receipt: true }) },
    // ---- no bundle ----
    { id: 'indirect', label: 'No bundle: what are you doing?', model: model({ kind: 'indirect', codes: TILES }), note: 'MES-156, MES-158: one tap starts it. No pay rule on the floor.' },
    { id: 'indirect-loading', label: 'No bundle: tiles loading', model: model({ kind: 'indirect', codes: null }) },
    { id: 'indirect-offline', label: 'No bundle offline, tiles kept', model: model({ kind: 'indirect', codes: TILES }, { frame: frame({ online: false, pending: 1 }), online: false }) },
    { id: 'indirect-offline-none', label: 'No bundle offline, nothing kept', model: model({ kind: 'indirect', codes: null }, { frame: frame({ online: false }), online: false }) },
    { id: 'indirect-empty', label: 'No bundle: no tiles at this site', model: model({ kind: 'indirect', codes: [] }) },
    { id: 'indirect-running', label: 'No-bundle time running', model: model({ kind: 'scan' }, { running: { block: BLOCK, skewMs: 0 } }), note: 'Its own clock on the scan step; Done ends it; scanning a bundle returns to standard.' },
    { id: 'bundle-running-refused', label: 'Refused: a bundle is running', model: model({ kind: 'refused', code: 'BUNDLE_RUNNING', message: '', fix: null, card: null, scanned: '' }) },
    { id: 'open-work', label: 'Scan step: your open work', model: model({ kind: 'scan' }, { resume: [openItem('RUNNING', 121), openItem('PAUSED', 118)] }), note: 'Continue opens the bundle as if its ticket were scanned.' },
    // ---- photo or comment ----
    { id: 'note', label: 'Photo or comment', model: model({ kind: 'note', from: started(), draft: NEW_NOTE }), note: 'MES-101, COL-017: tile, photo or clip, a few words; posted to the work order\'s thread.' },
    { id: 'note-filled', label: 'Photo or comment: ready to post', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'STITCHING_DIFFERS', words: 'Filo diverso dal campione', files: [{ id: 'f-1', kind: 'photo', name: `${BUNDLE}-photo-1.jpg` }, { id: 'f-2', kind: 'clip', name: `${BUNDLE}-clip-2.webm` }] } }) },
    { id: 'note-other', label: 'Photo or comment: Other asks more', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'OTHER' } }) },
    { id: 'note-photo', label: 'Photo: the camera with the outline and the reminder', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'DAMAGED', capture: 'photo' } }), note: 'The DS PhotoCapture: outline guide, "keep faces out", mark the spot; the marks are drawn into the picture.' },
    { id: 'note-clip', label: 'Clip: 15 seconds', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'DAMAGED', capture: 'clip' } }), note: 'Composed here: the DS PhotoCapture has no clip mode (named in the notes).' },
    { id: 'note-uploading', label: 'Photo going up', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'DAMAGED', busy: true } }) },
    { id: 'note-failed', label: 'Photo did not go up', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'DAMAGED', failed: true } }) },
    { id: 'note-offline', label: 'Offline: comment saved, camera held', model: model({ kind: 'note', from: started(), draft: { ...NEW_NOTE, tile: 'DAMAGED' } }, { frame: frame({ online: false }), online: false }), note: 'The queue keeps no bytes: the camera is held with the reason; the comment queues.' },
    { id: 'note-posted', label: 'Note posted', model: model(started(), { done: { kind: 'note', bundleCode: BUNDLE, ticks: 'recorded' } }) },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: model({ kind: 'scan' }, { held: true }) },
    { id: 'no-permission', label: 'No permission', model: model({ kind: 'noPermission' }), note: 'A person without production.scan at this station: nothing to scan here (fail closed).' },
  ],
})
