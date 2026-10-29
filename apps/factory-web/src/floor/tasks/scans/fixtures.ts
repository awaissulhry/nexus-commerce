import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import { NO_COUNTS, type BundleCard, type CardOperation, type CardReason, type CorrectionTarget, type Counts } from './model'
import { OperationView, type LastStrip, type OperationStep, type OperationViewModel } from './view/OperationView'

/**
 * SCR-090's cases (design floor.operation): scan a bundle ticket, its card, the counts (reason-first), Finish, the two
 * ticks, Undo, Ask a correction, and every refusal in words. Made-up data only: a "Demo" plant, a made-up tenant tag,
 * made-up styles and orders; never a real company, person or number, never money, never another person's counts.
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

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.operation', { station: { name: STATION, site: 'Stabilimento Demo Nord' }, ...extra })

const model = (step: OperationStep, extra: Partial<OperationViewModel> = {}): OperationViewModel => ({ frame: frame(), step, online: true, ...extra })

const counts = (step: Partial<Extract<OperationStep, { kind: 'counts' }>> = {}): OperationStep => ({ kind: 'counts', card: CARD, operation: OP20, counts: NO_COUNTS, open: null, asOf: null, ...step })

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
      model: model(counts({ counts: SCRAP_REWORK, open: 'scrap' })),
      note: 'Each tap on a reason adds one piece with that reason and takes it from Good; −1 takes it back. Finish · 18 good.',
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
    { id: 'notice-held', label: 'Scans held by the worker notice', model: model({ kind: 'scan' }, { held: true }) },
    { id: 'no-permission', label: 'No permission', model: model({ kind: 'noPermission' }), note: 'A person without production.scan at this station: nothing to scan here (fail closed).' },
  ],
})
