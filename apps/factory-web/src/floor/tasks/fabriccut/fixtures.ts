import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { BundleProcesses, LayStatus, LayView, OpenTrolleys, PlyRun, PrintJob, Recut, RecutCard, RecutPrinted, TicketCard, Trolley, WaitingTicket } from './api'
import { applyKeptRoll, rollDraftOf } from './model'
import { FabricCutView, type FabricCutViewModel, type FabricStep } from './view/FabricCutView'

/**
 * SCR-182's cases (B-W2b-121; design floor.fabriccut, MES-038 … MES-048): the start (tickets to cut, recuts waiting, reading, empty,
 * offline from the tablet, a wrong label, a role that sends no trolleys, no permission); the ticket's card (to start, offline, a work
 * order on hold, being cut); Spread (the lay planned by the office, under way, a roll scanned with its four figures, a refusal, a
 * mixed shade, the end back differs, every ply spread, a roll kept offline, reading); Check (both ends, the hard stop "Left 24,
 * right 23", offline); Cut (the time since the start, offline held, another ticket); Ply stickers (to print, printed, no printer, the
 * printer failed); Fabric used (the estimate and the lay report, corrected less, confirmed, offline, an over-issue refused); Recut
 * tickets (waiting, none, offline; one to start, started, printed, held); Send to sewing (open trolleys with the line's first, none; a
 * new trolley, loading with a bundle picked, a bundle that waits for fusing, kept offline, at the line with one missing, received,
 * another line). Roles: the cutter at the table, a cutter whose role sends no trolleys, the team leader at a line's station.
 * Made-up data of a "Demo" plant: never a real company, person or number, never money.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const BUNDLE = (ref: number) => formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref })
const ROLL = (ref: number) => formatScanId({ type: 'ROLL', tenantTag: TAG, ref })
const AT = '2026-11-08T08:41:00.000Z'
const STARTED_AT = '2026-11-08T08:05:00.000Z'

const frame = (extra: Partial<FabricCutViewModel['frame']> = {}) => signedInFrame('tile.fabriccut', { station: { name: 'CUT-02 · Tavolo taglio 2', site: 'Stabilimento Demo Nord' }, ...extra })
const lineFrame = (extra: Partial<FabricCutViewModel['frame']> = {}) => signedInFrame('tile.fabriccut', { station: { name: 'SEW-04 · Linea 2', site: 'Stabilimento Demo Nord' }, ...extra })

const MATERIAL = { item: { id: 'it-lin', code: 'FOD-RIP-01', name: 'Fodera ripstop' }, colour: { id: 'col-nr', code: 'NR', name: 'Nero' } }

const waiting = (id: string, number: string, status: 'OPEN' | 'STARTED', seq: number, plies: number, ratio: string, layStatus: 'PLANNED' | 'SPREADING' | 'CHECKED' = 'PLANNED'): WaitingTicket => ({
  id,
  number,
  code: number,
  status,
  layId: `lay-${id}`,
  laySeq: seq,
  startedAt: status === 'STARTED' ? STARTED_AT : null,
  doneAt: null,
  version: 1,
  cutOrder: { id: 'co-1', number: 'CO-2026-0042', kind: 'FABRIC', marker: 'MK-GIA-01', dueDate: '2026-11-20', material: { item: { code: MATERIAL.item.code, name: MATERIAL.item.name }, colour: { code: 'NR', name: 'Nero' } } },
  lay: { id: `lay-${id}`, seq, plies, status: layStatus },
  ratio,
  styles: ['GIA-01'],
})
const TICKETS: WaitingTicket[] = [
  waiting('t1', 'CTA-2026-00031', 'STARTED', 1, 24, '46:1 · 48:2 · 50:2 · 52:1', 'SPREADING'),
  waiting('t2', 'CTA-2026-00032', 'OPEN', 2, 24, '46:1 · 48:2 · 50:2 · 52:1'),
  waiting('t3', 'CTA-2026-00035', 'OPEN', 1, 12, '50:2 · 52:2'),
]

const run = (extra: Partial<PlyRun> = {}): PlyRun => ({ id: 'run-1', seq: 1, firstPly: 1, lastPly: 24, parts: ['Corpo fodera', 'Manica'], labelCount: 576, status: 'PRINTED', printedAt: AT, ...extra })

const card = (status: TicketCard['ticket']['status'], lay: LayStatus, extra: Partial<TicketCard> = {}): TicketCard => ({
  ticket: { id: 't1', number: 'CTA-2026-00031', code: 'CTA-2026-00031', status, layId: 'lay-1', laySeq: 1, startedAt: status === 'OPEN' ? null : STARTED_AT, doneAt: status === 'DONE' ? AT : null, version: 2 },
  cutOrder: {
    id: 'co-1',
    number: 'CO-2026-0042',
    kind: 'FABRIC',
    status: status === 'OPEN' ? 'RELEASED' : 'IN_PROGRESS',
    material: MATERIAL,
    marker: { name: 'MK-GIA-01', length: '3.2000', uom: 'M', widthCm: '145.00', words: { it: '3,2 m', en: '3.2 m' } },
    ratio: '46:1 · 48:2 · 50:2 · 52:1',
    plies: 24,
    garments: 144,
    dueDate: '2026-11-20',
    station: { id: 'st-2', code: 'CUT-02', name: 'Tavolo taglio 2' },
  },
  lay: { id: 'lay-1', seq: 1, of: 2, plies: 24, status: lay, counted: lay === 'CHECKED' || lay === 'CUT' ? 24 : null, version: 4 },
  lines: [
    { workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, style: { id: 's1', code: 'GIA-01', name: 'Giacca moto Demo' }, colourway: { id: 'cw1', code: 'NERO', name: 'Nero' }, size: '46', ratio: 1, quantity: 24 },
    { workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, style: { id: 's1', code: 'GIA-01', name: 'Giacca moto Demo' }, colourway: { id: 'cw1', code: 'NERO', name: 'Nero' }, size: '48', ratio: 2, quantity: 48 },
    { workOrder: { id: 'wo-45', number: 'WO-DEMO-0045' }, style: { id: 's1', code: 'GIA-01', name: 'Giacca moto Demo' }, colourway: { id: 'cw1', code: 'NERO', name: 'Nero' }, size: '50', ratio: 2, quantity: 48 },
    { workOrder: { id: 'wo-45', number: 'WO-DEMO-0045' }, style: { id: 's1', code: 'GIA-01', name: 'Giacca moto Demo' }, colourway: { id: 'cw1', code: 'NERO', name: 'Nero' }, size: '52', ratio: 1, quantity: 24 },
  ],
  parts: ['Corpo fodera', 'Manica'],
  plyRuns: [],
  next: { next: status === 'OPEN' ? 'START' : status === 'STARTED' ? 'FINISH' : 'NONE', refusal: null },
  ...extra,
})
const OPEN_CARD = card('OPEN', 'PLANNED')
const HELD_CARD = card('OPEN', 'PLANNED', { next: { next: 'NONE', refusal: { code: 'WORK_ORDER_ON_HOLD', message: '' } } })
const SPREADING = card('STARTED', 'SPREADING')
const CHECKED = card('STARTED', 'CHECKED')
const CUT_CARD = card('DONE', 'CUT')

const roll = (seq: number, ref: number, plies: number, extra: Partial<LayView['rolls'][number]> = {}): LayView['rolls'][number] => ({
  id: `lr-${seq}`,
  seq: seq * 10,
  code: ROLL(ref),
  lotCode: 'LOT-RIP-2026-07',
  plies,
  splices: 0,
  endLoss: '0',
  endReturned: '0',
  uom: 'M',
  used: (plies * 3.2).toFixed(4),
  shade: 'A',
  ...extra,
})
const lay = (status: LayView['lay']['status'], rolls: LayView['rolls'], extra: Partial<LayView> = {}): LayView => {
  const plies = rolls.reduce((sum, entry) => sum + entry.plies, 0)
  return {
    lay: { id: 'lay-1', seq: 1, of: 2, plies: 24, status, plyMetres: '3.2000', counted: status === 'CHECKED' || status === 'CUT' ? { left: plies, right: plies, checkedAt: AT } : null, cutAt: status === 'CUT' ? AT : null, version: 5 },
    cutOrder: { id: 'co-1', number: 'CO-2026-0042', ratio: '46:1 · 48:2 · 50:2 · 52:1', garmentsPerPly: 6 },
    ticket: { id: 't1', number: 'CTA-2026-00031', code: 'CTA-2026-00031', status: status === 'CUT' ? 'DONE' : 'STARTED' },
    rolls,
    spread: { plies, rolls: rolls.length, needed: Math.max(0, 24 - plies), used: (plies * 3.2).toFixed(4) },
    fabricUsed: null,
    refusal: null,
    can: { spread: status !== 'CUT', count: (status === 'SPREADING' || status === 'CHECKED') && plies > 0, fabricUsed: status === 'CUT' },
    ...extra,
  }
}
const PLANNED_LAY = lay('PLANNED', [roll(1, 9101, 14)])
const HALF = lay('SPREADING', [roll(1, 9101, 14, { splices: 1, endLoss: '0.3' }), roll(2, 9102, 6)])
const FULL = lay('SPREADING', [roll(1, 9101, 14, { splices: 1, endLoss: '0.3' }), roll(2, 9102, 10)])
const CUT_LAY = lay('CUT', FULL.rolls, { fabricUsed: { posted: false, uom: 'M', plies: 24, estimated: '76.8000', recorded: '77.4000', confirmed: null, confirmedAt: null } })
const POSTED_LAY = lay('CUT', FULL.rolls, { fabricUsed: { posted: true, uom: 'M', plies: 24, estimated: '76.8000', recorded: '77.4000', confirmed: '77.4000', confirmedAt: AT } })

const job = (status: PrintJob['status']): PrintJob => ({ id: 'job-1', status, lastError: status === 'FAILED' ? 'printer offline' : null })
const STICKERS: (readonly [string, string, string])[] = [
  ['Strato 1 · 46', 'Corpo fodera 1/1', 'CO-2026-0042 · Mat. 1 · 1/2'],
  ['Strato 1 · 46', 'Manica 1/2', 'CO-2026-0042 · Mat. 1 · 1/2'],
  ['Strato 1 · 46', 'Manica 2/2', 'CO-2026-0042 · Mat. 1 · 1/2'],
  ['Strato 1 · 48', 'Corpo fodera 1/2', 'CO-2026-0042 · Mat. 1 · 1/2'],
]

const recut = (id: string, number: string, status: 'OPEN' | 'STARTED', bundle: number, part: string | null, quantity: number, extra: Partial<Recut> = {}): Recut => ({
  id,
  number,
  code: number,
  status,
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042', dueDate: '2026-11-20', rush: false, style: { code: 'GIA-01', name: 'Giacca moto Demo' } },
  cell: { colourwayCode: 'NERO', size: '50' },
  bundle: { code: BUNDLE(bundle), part: null },
  part,
  quantity,
  lot: { code: 'LOT-RIP-2026-07', shade: 'A' },
  endBits: false,
  from: { it: 'Lotto LOT-RIP-2026-07', en: 'Lot LOT-RIP-2026-07' },
  printedAt: null,
  startedAt: status === 'STARTED' ? AT : null,
  version: 1,
  ...extra,
})
const RECUTS = [
  recut('r1', 'CTA-2026-00051', 'STARTED', 501, 'Manica', 2),
  recut('r2', 'CTA-2026-00052', 'OPEN', 502, 'Corpo fodera', 1, { workOrder: { id: 'wo-45', number: 'WO-DEMO-0045', dueDate: '2026-11-12', rush: true, style: { code: 'GIA-01', name: 'Giacca moto Demo' } }, cell: { colourwayCode: 'NERO', size: '52' } }),
  recut('r3', 'CTA-2026-00053', 'OPEN', 517, null, 1, { lot: null, endBits: true, from: { it: 'Ritagli', en: 'End bits' } }),
]
const recutCard = (ticket: Recut, next: RecutCard['next']['next'], refusal: RecutCard['next']['refusal'] = null): RecutCard => ({ ticket, next: { next, refusal } })
const PRINTED: RecutPrinted = {
  ticket: { ...RECUTS[1]!, printedAt: AT },
  label: { heading: 'Stabilimento Demo · Buono di ritaglio', title: 'Corpo fodera × 1 serie · GIA-01 NERO 52', fields: [{ label: 'Ordine di lavoro', value: 'WO-DEMO-0045' }, { label: 'Unire al fascio', value: BUNDLE(502) }, { label: 'Tagliare da', value: 'Lotto LOT-RIP-2026-07' }, { label: 'Consegna', value: '2026-11-12' }] },
  job: job('QUEUED'),
  problem: null,
}

const LINE = { id: 'line-2', code: 'L2', name: 'Linea 2' }
const trolleyBundle = (ref: number, size: string, quantity: number, receivedAt: string | null = null): Trolley['bundles'][number] => ({ id: `cl-${ref}`, bundle: { id: `b-${ref}`, code: BUNDLE(ref), part: null, quantity }, workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' }, cell: { colourwayCode: 'NERO', size }, receivedAt })
const trolley = (code: string, status: Trolley['status'], bundles: Trolley['bundles'], line = LINE): Trolley => ({ id: `ci-${code}`, trolleyCode: code, status, line, sentAt: status === 'LOADING' ? null : AT, receivedAt: status === 'RECEIVED' ? AT : null, counts: { bundles: bundles.length, received: bundles.filter((entry) => entry.receivedAt).length, missing: 0 }, bundles, version: 2 })
const LOADING = trolley('T-3', 'LOADING', [trolleyBundle(601, '46', 12), trolleyBundle(602, '48', 12), trolleyBundle(603, '48', 12)])
const SENT = trolley('T-5', 'SENT', [trolleyBundle(611, '50', 12), trolleyBundle(612, '50', 12), trolleyBundle(613, '52', 12), trolleyBundle(614, '52', 12)])
const OPEN_TROLLEYS: OpenTrolleys = { here: null, rows: [LOADING, SENT, trolley('T-8', 'LOADING', [trolleyBundle(620, '46', 10)], { id: 'line-1', code: 'L1', name: 'Linea 1' })] }
const AT_LINE: OpenTrolleys = { here: LINE, rows: [SENT, LOADING] }
const FUSING: BundleProcesses = { bundle: { id: 'b-604', code: BUNDLE(604) }, processes: [{ id: 'sp-1', kind: 'FUSING', words: { it: 'termoadesivatura', en: 'fusing' }, status: 'WAITING', version: 1 }], next: { processId: 'sp-1', move: 'start', words: { it: 'Inizia: termoadesivatura', en: 'Start: fusing' } }, toSewing: { it: `Il fascio ${BUNDLE(604)} attende: termoadesivatura. Va al cucito dopo.`, en: `Bundle ${BUNDLE(604)} waits for: fusing. It goes to sewing after.` } }

const may = { trolleys: true, secondary: true }
const cutter = (step: FabricStep, extra: Partial<FabricCutViewModel> = {}): FabricCutViewModel => ({ frame: frame(), online: true, step, done: null, may, ...extra })
const offline = { frame: frame({ online: false, pending: 1 }), online: false }
const atLine = (step: FabricStep, extra: Partial<FabricCutViewModel> = {}): FabricCutViewModel => ({ frame: lineFrame(), online: true, step, done: null, may, ...extra })
const spread = (layView: LayView | null, extra: Partial<Extract<FabricStep, { kind: 'spread' }>> = {}): FabricStep => ({ kind: 'spread', card: SPREADING, lay: layView, asOf: null, draft: null, field: 'plies', ...extra })
const trolleyStep = (code: string, value: Trolley | null, next: 'LOAD' | 'RECEIVE' | 'NONE', extra: Partial<Extract<FabricStep, { kind: 'trolley' }>> = {}): FabricStep => ({ kind: 'trolley', code, trolley: value, next, asOf: null, kept: [], picked: null, missing: [], process: null, ...extra })
const refused = (code: string) => ({ kind: 'refused' as const, code, message: '', fix: null })
const draft = rollDraftOf(ROLL(9103), 4)

export const designScreen = defineDesignScreen<FabricCutViewModel>({
  screen: 'SCR-182',
  title: 'Fabric cutting (floor.fabriccut)',
  view: onFloor(FabricCutView),
  cases: [
    // ---- the start: tickets to cut, recuts, to sewing ----
    { id: 'start', label: 'Start: scan the cut ticket (cutter)', model: cutter({ kind: 'start', tickets: TICKETS, asOf: null, recuts: 3 }), note: 'The ticket scan first; Recut tickets with what waits; Send to sewing; the site\'s tickets to cut, oldest first, keys in the list\'s footer.' },
    { id: 'start-empty', label: 'Nothing to cut, no recuts', model: cutter({ kind: 'start', tickets: [], asOf: null, recuts: 0 }) },
    { id: 'start-reading', label: 'Reading the tickets', model: cutter({ kind: 'start', tickets: null, asOf: null, recuts: null }) },
    { id: 'start-offline', label: 'Offline: from this tablet', model: cutter({ kind: 'start', tickets: TICKETS, asOf: AT, recuts: 3 }, offline) },
    { id: 'start-wrong', label: 'A roll label scanned on the start', model: cutter({ kind: 'start', tickets: TICKETS, asOf: null, recuts: 3, wrong: { why: 'notTicket', code: ROLL(9101) } }) },
    { id: 'start-not-found', label: 'No such ticket at this site', model: cutter({ kind: 'start', tickets: TICKETS, asOf: null, recuts: 3, wrong: { why: 'notFound', code: 'CTA-2026-09999' } }) },
    { id: 'start-no-trolleys', label: 'A role that sends no trolleys', model: cutter({ kind: 'start', tickets: TICKETS, asOf: null, recuts: 1 }, { may: { trolleys: false, secondary: false } }), note: 'Send to sewing is held with the reason (production.trolleys).' },
    { id: 'no-permission', label: 'No permission', model: cutter({ kind: 'noPermission' }) },
    { id: 'loading', label: 'Reading a ticket', model: cutter({ kind: 'loading', code: 'CTA-2026-00031' }) },
    { id: 'error', label: 'Server not answering', model: cutter({ kind: 'problem', problem: { kind: 'unavailable' }, code: null }) },
    { id: 'refused-void', label: 'Refused: the ticket is void', model: cutter({ kind: 'problem', problem: refused('TICKET_VOID'), code: 'CTA-2026-00029' }) },
    // ---- the ticket's card ----
    { id: 'ticket', label: 'Cut ticket: to start', model: cutter({ kind: 'ticket', card: OPEN_CARD, asOf: null }), note: 'The ratio as size chips, the plies big, marker, material, parts, work orders, due. Start cutting = the start scan as a tap (Enter).' },
    { id: 'ticket-offline', label: 'Cut ticket offline: start held', model: cutter({ kind: 'ticket', card: OPEN_CARD, asOf: AT }, offline) },
    { id: 'ticket-on-hold', label: 'A work order on hold: not now', model: cutter({ kind: 'ticket', card: HELD_CARD, asOf: null }) },
    { id: 'ticket-started', label: 'A ticket being cut: on to its step', model: cutter({ kind: 'ticket', card: SPREADING, asOf: null }) },
    // ---- spread ----
    { id: 'spread-planned', label: 'Spread: the office planned roll one', model: cutter(spread(PLANNED_LAY), { done: { kind: 'started', code: 'CTA-2026-00031', ticks: 'recorded' } }), note: 'The office\'s allocation counts as spread once the first roll is scanned: scan it to confirm or correct it.' },
    { id: 'spread', label: 'Spread: under way', model: cutter(spread(HALF)), note: 'The running sums; the lay report roll by roll; Undo last roll; Count both ends once plies are spread.' },
    { id: 'spread-roll', label: 'A roll scanned: plies as needed', model: cutter(spread(HALF, { draft })), note: 'One pad, four figures: plies (default what is still needed), splices, end loss, the roll end back. Add roll = Enter, or the same roll scanned again.' },
    { id: 'spread-roll-loss', label: 'A roll: the end loss in metres', model: cutter(spread(HALF, { draft: { ...draft, plies: 3, pliesTouched: true, splices: 1, endLoss: 0.25 }, field: 'endLoss' })) },
    { id: 'spread-roll-short', label: 'Refused: the roll is too short', model: cutter(spread(HALF, { draft: { ...draft, plies: 4, pliesTouched: true } }), { notice: refused('ROLL_SHORT') }) },
    { id: 'spread-mixed', label: 'Refused: another shade', model: cutter(spread(HALF), { notice: refused('MIXED_SHADE') }) },
    { id: 'spread-warning', label: 'The roll end back differs', model: cutter(spread(HALF, { warnings: ['END_DIFFERS'] }), { done: { kind: 'roll', code: ROLL(9102), count: 6, ticks: 'recorded' } }) },
    { id: 'spread-full', label: 'Every ply spread', model: cutter(spread(FULL)) },
    { id: 'spread-offline', label: 'Offline: a roll kept on the tablet', model: cutter(spread(applyKeptRoll(HALF, rollDraftOf(ROLL(9103), 4)), { asOf: AT }), { ...offline, done: { kind: 'roll', code: ROLL(9103), count: 4, ticks: 'saved' } }) },
    { id: 'spread-reading', label: 'Reading the lay', model: cutter(spread(null)) },
    { id: 'spread-wrong', label: 'A bundle scanned on the lay', model: cutter(spread(HALF, { wrong: { why: 'notRoll', code: BUNDLE(501) } })) },
    // ---- check ----
    { id: 'count', label: 'Count the plies at both ends', model: cutter({ kind: 'count', card: SPREADING, lay: FULL, left: 24, right: 24, differ: null }), note: 'Each end starts at the plies spread; Both ends match (Enter).' },
    { id: 'count-differ', label: 'A difference: hard stop', model: cutter({ kind: 'count', card: SPREADING, lay: FULL, left: 24, right: 23, differ: { left: 24, right: 23 } }), note: 'The design\'s refusal "Left 24, right 23. Recount before cutting."; nothing is stored.' },
    { id: 'count-offline', label: 'Offline: the count queues', model: cutter({ kind: 'count', card: SPREADING, lay: FULL, left: 24, right: 24, differ: null }, offline) },
    // ---- cut ----
    { id: 'cut', label: 'Cut: scan the ticket when done', model: cutter({ kind: 'cut', card: CHECKED }, { done: { kind: 'count', code: 'CTA-2026-00031', count: 24, ticks: 'recorded' } }), note: 'The time since the start scan; the end scan or Cut done.' },
    { id: 'cut-offline', label: 'Cut offline: the end scan waits', model: cutter({ kind: 'cut', card: CHECKED }, offline) },
    { id: 'cut-other', label: 'Another ticket scanned', model: cutter({ kind: 'cut', card: CHECKED, wrong: { why: 'otherTicket', code: 'CTA-2026-00032' } }) },
    // ---- ply stickers ----
    { id: 'stickers', label: 'Ply stickers: to print', model: cutter({ kind: 'stickers', card: CUT_CARD, run: null, stickers: null, job: null, notPrinted: false }, { done: { kind: 'cut', code: 'CTA-2026-00031', ticks: 'recorded' } }) },
    { id: 'stickers-printed', label: 'Ply stickers printed', model: cutter({ kind: 'stickers', card: { ...CUT_CARD, plyRuns: [run()] }, run: run(), stickers: STICKERS, job: job('PRINTED'), notPrinted: false }), note: 'LabelPreview of the run with its print state.' },
    { id: 'stickers-no-printer', label: 'No label printer here', model: cutter({ kind: 'stickers', card: CUT_CARD, run: run({ status: 'PLANNED', printedAt: null }), stickers: STICKERS, job: null, notPrinted: true }) },
    { id: 'stickers-failed', label: 'The printer failed', model: cutter({ kind: 'stickers', card: CUT_CARD, run: run(), stickers: STICKERS.slice(0, 1), job: job('FAILED'), notPrinted: false }) },
    { id: 'stickers-no-parts', label: 'No parts on the pattern: printing held', model: cutter({ kind: 'stickers', card: { ...CUT_CARD, parts: [] }, run: null, stickers: null, job: null, notPrinted: false }), note: 'The API would refuse NO_PARTS; the screen says it before the press (no typing on the floor).' },
    { id: 'stickers-offline', label: 'Offline: printing held', model: cutter({ kind: 'stickers', card: CUT_CARD, run: null, stickers: null, job: null, notPrinted: false }, offline) },
    // ---- fabric used ----
    { id: 'fabric', label: 'Fabric used: confirm the lay report', model: cutter({ kind: 'fabric', card: CUT_CARD, lay: CUT_LAY, value: 77.4 }), note: 'Estimate 76,8 m, the lay report 77,4 m; the difference in words; Confirm posts it.' },
    { id: 'fabric-less', label: 'Corrected: less than the estimate', model: cutter({ kind: 'fabric', card: CUT_CARD, lay: CUT_LAY, value: 75.9 }) },
    { id: 'fabric-saved', label: 'Fabric used confirmed', model: cutter({ kind: 'fabric', card: CUT_CARD, lay: POSTED_LAY, value: 77.4, saved: true }, { done: { kind: 'fabric', code: 'CTA-2026-00031', ticks: 'recorded' } }) },
    { id: 'fabric-posted', label: 'Confirmed already: correct it', model: cutter({ kind: 'fabric', card: CUT_CARD, lay: POSTED_LAY, value: 77.4 }) },
    { id: 'fabric-offline', label: 'Offline: the confirmation waits', model: cutter({ kind: 'fabric', card: CUT_CARD, lay: CUT_LAY, value: 77.4 }, offline) },
    { id: 'fabric-over', label: 'Refused: more than the work orders need', model: cutter({ kind: 'fabric', card: CUT_CARD, lay: CUT_LAY, value: 82 }, { notice: refused('OVER_ISSUE') }) },
    // ---- recut tickets ----
    { id: 'recuts', label: 'Recut tickets waiting', model: cutter({ kind: 'recuts', list: { rows: RECUTS, counts: { open: 2, started: 1 } }, asOf: null }), note: 'Bundle, part, size, shade lot or end bits; started first, then due.' },
    { id: 'recuts-empty', label: 'No recuts waiting', model: cutter({ kind: 'recuts', list: { rows: [], counts: { open: 0, started: 0 } }, asOf: null }) },
    { id: 'recuts-offline', label: 'Recuts offline: from this tablet', model: cutter({ kind: 'recuts', list: { rows: RECUTS, counts: { open: 2, started: 1 } }, asOf: AT }, offline) },
    { id: 'recut', label: 'A recut to start', model: cutter({ kind: 'recut', card: recutCard(RECUTS[1]!, 'START'), printed: null }), note: 'The new panels join the original bundle; cut from the same shade lot.' },
    { id: 'recut-started', label: 'A recut being cut', model: cutter({ kind: 'recut', card: recutCard(RECUTS[0]!, 'FINISH'), printed: null }) },
    { id: 'recut-printed', label: 'Its ticket printed', model: cutter({ kind: 'recut', card: recutCard(PRINTED.ticket, 'START'), printed: PRINTED }) },
    { id: 'recut-ends', label: 'Cut from end bits', model: cutter({ kind: 'recut', card: recutCard(RECUTS[2]!, 'START'), printed: null }) },
    { id: 'recut-held', label: 'Held: its work order is on hold', model: cutter({ kind: 'recut', card: recutCard(RECUTS[1]!, 'NONE', { code: 'WORK_ORDER_ON_HOLD', message: '' }), printed: null }) },
    { id: 'recut-done', label: 'A recut done', model: cutter({ kind: 'recuts', list: { rows: RECUTS.slice(1), counts: { open: 2, started: 0 } }, asOf: null }, { done: { kind: 'recutDone', code: 'CTA-2026-00051', line: BUNDLE(501), ticks: 'recorded' } }) },
    // ---- send to sewing ----
    { id: 'trolleys', label: 'Send to sewing: open trolleys', model: cutter({ kind: 'trolleys', open: OPEN_TROLLEYS, asOf: null }) },
    { id: 'trolleys-none', label: 'No trolley open', model: cutter({ kind: 'trolleys', open: { here: null, rows: [] }, asOf: null }) },
    { id: 'trolley-new', label: 'A new trolley: scan its first bundle', model: cutter(trolleyStep('T-9', null, 'LOAD')) },
    { id: 'trolley-loading', label: 'Loading: a bundle picked', model: cutter(trolleyStep('T-3', LOADING, 'LOAD', { picked: BUNDLE(602) }), { done: { kind: 'load', code: BUNDLE(603), line: 'T-3', ticks: 'recorded' } }), note: 'Send 3 bundles to line L2 (Enter); Take off the bundle picked.' },
    { id: 'trolley-process', label: 'A bundle waits for fusing', model: cutter(trolleyStep('T-3', LOADING, 'LOAD', { process: FUSING }), { notice: refused('PROCESS_PENDING') }), note: 'The secondary process as a route step: one tap here, then the bundle goes on.' },
    { id: 'trolley-warning', label: 'Planned on another line', model: cutter(trolleyStep('T-3', LOADING, 'LOAD', { warnings: ['PLANNED_ON_OTHER_LINE'] })) },
    { id: 'trolley-offline', label: 'Offline: bundles kept on the tablet', model: cutter(trolleyStep('T-3', LOADING, 'LOAD', { kept: [BUNDLE(604), BUNDLE(605)], asOf: AT }), { ...offline, done: { kind: 'load', code: BUNDLE(605), line: 'T-3', ticks: 'saved' } }) },
    { id: 'trolley-sent', label: 'Sent: back on the list', model: cutter({ kind: 'trolleys', open: OPEN_TROLLEYS, asOf: null }, { done: { kind: 'send', code: 'T-3', count: 3, line: 'L2', ticks: 'recorded' } }) },
    { id: 'line-trolleys', label: 'At the line: trolleys coming first (team leader)', model: atLine({ kind: 'trolleys', open: AT_LINE, asOf: null }) },
    { id: 'line-receive', label: 'At the line: one bundle not here', model: atLine(trolleyStep('T-5', SENT, 'RECEIVE', { missing: [BUNDLE(613)] })), note: 'Tap a bundle that is not here; Received (or the label scanned again) confirms the receipt with the difference.' },
    { id: 'line-received', label: 'Received at the line', model: atLine(trolleyStep('T-5', { ...SENT, status: 'RECEIVED', receivedAt: AT, counts: { bundles: 4, received: 3, missing: 1 } }, 'NONE')) },
    { id: 'line-other', label: 'Refused: it goes to another line', model: atLine(trolleyStep('T-5', SENT, 'RECEIVE'), { notice: refused('OTHER_LINE') }) },
  ],
})
