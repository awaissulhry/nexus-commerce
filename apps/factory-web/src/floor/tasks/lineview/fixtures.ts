import { defineDesignScreen } from '../../../lib/design/design-screen'
import { BOARD } from '../../../lib/line-board/fixtures'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { BehalfOptions, BlockRow, Conflict, ConflictDecisions, CorrectionRecord, CorrectionRow, FloorLine, Handover, LineCall, Operators, RefusalTile, ScrapRow } from './api'
import { EMPTY_BEHALF, EMPTY_HANDOVER, EMPTY_OVERRIDE, lineCan, waitingItems, type BehalfDraft } from './model'
import { LineViewScreen, type LineStep, type LineViewModel } from './view/LineViewScreen'

/**
 * SCR-168's cases (B-W2b-70; design floor.supervisor; Owner answer F2): My line now with Calls, Waiting for you and Stations
 * (busy, empty, offline as of, parts that could not be read, updates waiting behind Show, a role that may not answer), each
 * decision (scrap over the limit, a time block, a sync conflict side by side, a correction of a report with its one record,
 * the reject tiles, the PIN, a wrong PIN, one's own, refused, the next item), Reassign, the handover note, scan on behalf from the station to the override. Made-up plant,
 * stations and people: no output per station, no figure per person, no money.
 */

const AT = '2026-10-29T09:12:00.000Z'
const LINE_PLACE = { id: 'line-1', code: 'L1', name: 'Linea giacche' }
const station = (n: number) => ({ id: `0190f0e2-0000-7000-9173-${String(100 + n).padStart(12, '0')}`, code: `CUC-${String(n).padStart(2, '0')}`, name: `Cucitura ${n}` })

const call = (n: number, status: LineCall['status'], code: string, labelIt: string, labelEn: string, kind: LineCall['type']['kind'], sentAt: string, ask: Pick<LineCall, 'reasonCode' | 'requestedQuantity'> = { reasonCode: null, requestedQuantity: null }): LineCall => ({ id: `call-${n}`, version: 1, status, type: { id: `type-${code}`, code, kind, labelIt, labelEn, labelI18n: {}, icon: null, colour: null }, station: station(n), sentAt, ...ask })
// B-W2b-81 (MES-137): the material call says why and how much.
const CALLS = [call(3, 'SENT', 'MATERIAL', 'Materiale', 'Material', 'MATERIAL', '2026-10-29T09:30:00.000Z', { reasonCode: 'MATERIAL_SHORT', requestedQuantity: '4' }), call(7, 'ON_THE_WAY', 'MAINTENANCE', 'Manutenzione', 'Maintenance', 'MAINTENANCE', '2026-10-29T09:20:00.000Z')]

const reasons = [{ code: 'STAIN', quantity: 3, labelIt: 'Macchia', labelEn: 'Stain', labelI18n: {}, icon: null, colour: null }, { code: 'HOLE', quantity: 2, labelIt: 'Foro', labelEn: 'Hole', labelI18n: {}, icon: null, colour: null }]
const SCRAP: ScrapRow = { scanId: 'scan-1', at: AT, workOrder: { id: 'wo-1', number: 'WO-0041' }, bundle: { id: 'bn-1', code: 'B-000123' }, operation: { seq: 30, name: 'Cucitura maniche' }, station: { id: 'st-3', code: 'CUC-03' }, line: { id: 'line-1', code: 'L1' }, goodQuantity: 15, scrapQuantity: 5, reworkQuantity: 0, reasons, approval: { limit: 3 }, own: false }
const BLOCK: BlockRow = { id: 'block-1', version: 2, line: LINE_PLACE, station: station(5), code: { code: 'WAIT_MATERIAL', labelIt: 'Attesa materiale', labelEn: 'Waiting for material' }, startedAt: '2026-10-29T08:10:00.000Z', endedAt: '2026-10-29T08:55:00.000Z', minutes: 45, own: false }
const side = (name: string, n: number, serverTime: string, good: number) => ({ deviceName: name, station: station(n), serverTime, good, scrap: 0, rework: 0 })
const CONFLICT: Conflict = { id: 'refused-1', state: 'OPEN', workOrder: { number: 'WO-0041' }, bundle: { code: 'B-000124' }, operation: { seq: 20, name: 'Preparazione' }, refused: side('Tablet CUC-02', 2, '2026-10-29T09:02:00.000Z', 20), recorded: { ...side('Tablet CUC-04', 4, '2026-10-29T08:58:00.000Z', 19), corrected: false }, version: 1 }

const CORRECTION: CorrectionRow = { id: 'request-1', version: 1, at: '2026-10-29T08:40:00.000Z', workOrder: { id: 'wo-1', number: 'WO-0041' }, bundle: { id: 'bn-2', code: 'B-000126' }, operation: { seq: 30, name: 'Cucitura maniche' }, station: { id: 'st-4', code: 'CUC-04' }, line: { id: 'line-1', code: 'L1' }, recorded: { good: 19, scrap: 1, rework: 0, at: '2026-10-29T08:12:00.000Z' }, asked: { good: 20, scrap: 0, rework: 0 }, own: false }
const RECORD: CorrectionRecord = { ...CORRECTION, status: 'PENDING', reason: 'La macchia è venuta via con la pulizia.', person: 'Bruna Demo', reasons: [], recordedReasons: [{ code: 'STAIN', quantity: 1, labelIt: 'Macchia', labelEn: 'Stain', labelI18n: {} }] }

const WAITING = waitingItems([SCRAP], [BLOCK], [CONFLICT, { ...CONFLICT, id: 'refused-2', state: 'WITH_OFFICE', bundle: { code: 'B-000125' } }], 'line-1', [CORRECTION])
const [FIRST] = waitingItems([], [BLOCK], [], 'line-1')
const SCRAP_ITEM = waitingItems([SCRAP], [], [], null)[0]!
const CONFLICT_ITEM = waitingItems([], [], [CONFLICT], null)[0]!
const CORRECTION_ITEM = waitingItems([], [], [], null, [CORRECTION])[0]!
const OWN_CORRECTION = { ...CORRECTION_ITEM, row: { ...CORRECTION, own: true } } as typeof CORRECTION_ITEM

const TILES: RefusalTile[] = [{ code: 'REWORK_INSTEAD', labelIt: 'Si può rilavorare', labelEn: 'Can be reworked', needsDetail: false }, { code: 'WRONG_COUNT', labelIt: 'Conteggio sbagliato', labelEn: 'Wrong count', needsDetail: false }, { code: 'WRONG_REASON', labelIt: 'Motivo sbagliato', labelEn: 'Wrong reason', needsDetail: false }, { code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true }]
const CORRECTION_TILES: RefusalTile[] = [{ code: 'RECORDED_RIGHT', labelIt: 'Il conteggio registrato è giusto', labelEn: 'The recorded count is right', needsDetail: false }, { code: 'COUNTS_WRONG', labelIt: 'I nuovi conteggi sono sbagliati', labelEn: 'The new counts are wrong', needsDetail: false }, { code: 'WRONG_REPORT', labelIt: 'Non è la segnalazione da correggere', labelEn: 'This is not the report to correct', needsDetail: false }, { code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true }]
const look = { icon: 'copy', tone: 'info' as const }
const DECISIONS: ConflictDecisions = [
  { decision: 'KEEP_RECORDED', look, signs: true, reasons: [{ code: 'SAME_WORK', look }, { code: 'SCANNED_TWICE', look }, { code: 'WRONG_TABLET', look }] },
  { decision: 'SEND_TO_OFFICE', look, signs: false, reasons: [{ code: 'COUNTS_WRONG', look }, { code: 'OTHER_STATION', look }] },
]

const LINE: FloorLine = {
  line: LINE_PLACE,
  day: '2026-10-29',
  asOf: AT,
  shift: 'Mattina',
  stations: BOARD.stations.map((entry, index) => ({ id: entry.id, code: entry.code, name: entry.name, signedIn: index !== 1 && index !== 5, reassign: index === 5 ? [{ assignmentId: 'assign-1', version: 3, workOrder: { number: 'WO-0041' }, operation: { seq: 30, name: 'Cucitura maniche' } }] : [] })),
  mayManage: true,
  mayWriteHandover: true,
}

const LEAD = lineCan(['floor.work', 'floor.lead', 'production.calls.answer', 'production.dispatch.manage', 'production.dispatch.handover', 'production.scan.behalf'])

const frame = (extra: Partial<LineViewModel['frame']> = {}) => signedInFrame('tile.lineview', { station: { name: 'L1 · Linea giacche', site: 'Stabilimento Demo Nord' }, ...extra })

const model = (step: LineStep, extra: Partial<LineViewModel> = {}): LineViewModel => ({
  frame: frame(extra.online === false ? { online: false, pending: 2 } : {}),
  can: LEAD,
  online: true,
  step,
  signer: 'Ada Demo',
  board: BOARD,
  line: LINE,
  canAnswer: true,
  calls: CALLS,
  callsPending: 0,
  callsUnknown: false,
  picked: CALLS[0]!.id,
  answers: [],
  waiting: WAITING,
  waitingPending: 0,
  waitingUnknown: false,
  tiles: TILES,
  correctionTiles: CORRECTION_TILES,
  decisions: DECISIONS,
  asOf: null,
  ticks: null,
  ...extra,
})

const OPERATORS: Operators = { clockedOnly: true, operators: [{ workerId: 'w-1', name: 'Bruna Demo', levelLabel: null, decision: 'ALLOW', overridable: false, words: null }, { workerId: 'w-2', name: 'Carlo Demo', levelLabel: null, decision: 'WARN', overridable: true, words: 'No skill recorded for this operation.' }, { workerId: 'w-3', name: 'Dario Demo', levelLabel: null, decision: 'HOLD', overridable: false, words: 'Not authorised on this machine.' }] }
const ROW = LINE.stations[5]!.reassign[0]!

const NOTE = (id: string, shiftLabel: string, shiftDate: string, version: number): Handover['notes'][number] => ({ id, shiftDate, shiftLabel, topics: [{ topic: 'MACHINES', labelIt: 'Macchine', labelEn: 'Machines' }, { topic: 'HALF_DONE_BUNDLES', labelIt: 'Fasci a metà', labelEn: 'Half-done bundles' }], text: 'Ago della 3 piegato; fascio 12 a metà.', writtenAt: AT, version })
const HANDOVER: Handover = { day: '2026-10-29', shift: 'Mattina', current: null, notes: [NOTE('note-1', 'Sera', '2026-10-28', 2)], mayWrite: true }

const OPTIONS: BehalfOptions = {
  subject: 'WORKER',
  stations: BOARD.stations.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name, lineId: BOARD.line.id })),
  people: [{ id: 'w-1', name: 'Bruna Demo' }, { id: 'w-2', name: 'Carlo Demo' }, { id: 'w-4', name: 'Elena Demo' }],
  reasons: [{ code: 'BADGE_MISSING', label: { it: 'Senza badge', en: 'No badge with them' }, needsNote: false }, { code: 'TABLET_DOWN', label: { it: 'Tablet fuori uso', en: 'The tablet was not working' }, needsNote: false }, { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true }],
}
const op = (id: string, seq: number, name: string, expected: number) => ({ id, seq, code: `OP${seq}`, name, scanRequired: true, workCentreKind: 'SEWING', final: false, sewn: true, state: 'OPEN' as const, expected, report: null })
const CARD = { scanned: 'B-000123', refusal: null, bundle: { id: 'bn-1', code: 'B-000123', status: 'ACTIVE' as const, quantity: 20, part: null, workOrderSizeId: 'size-1', colourwayCode: 'BLK', colourwayName: 'Nero', size: '50' }, workOrder: { id: 'wo-1', number: 'WO-0041', batchNumber: null, status: 'IN_PROGRESS', siteId: 'site-1', style: { code: 'GALE', name: 'Giacca demo' } }, station: null, operations: [op('op-30', 30, 'Cucitura maniche', 20)], next: null, choose: [], hint: null, reasons: [{ kind: 'SCRAP' as const, code: 'STAIN', label: { it: 'Macchia', en: 'Stain' }, sortOrder: 1 }, { kind: 'REWORK' as const, code: 'SEAM', label: { it: 'Cucitura', en: 'Seam' }, sortOrder: 2 }] }
const READY: BehalfDraft = { ...EMPTY_BEHALF, stationId: OPTIONS.stations[1]!.id, personId: 'w-1', card: CARD, operationId: 'op-30', good: 20 }
const behalf = (stage: Extract<LineStep, { kind: 'behalf' }>['stage'], draft: BehalfDraft = READY, extra: Partial<Extract<LineStep, { kind: 'behalf' }>> = {}): LineStep => ({ kind: 'behalf', stage, options: OPTIONS, draft, override: EMPTY_OVERRIDE, ...extra })
const HELD_REFUSAL = { kind: 'refused' as const, code: 'PREVIOUS_NOT_REPORTED', message: 'The operation before this one is not reported yet.', fix: 'Report it first, or ask another team leader.' }

export const designScreen = defineDesignScreen<LineViewModel>({
  screen: 'SCR-168',
  title: 'Floor › Line view',
  view: onFloor(LineViewScreen),
  cases: [
    { id: 'now', label: 'My line now: calls, what waits, stations', model: model({ kind: 'now' }), note: 'Line totals only. Per station: a call, a machine down, material, nobody signed in (Owner answer F2).' },
    { id: 'quiet', label: 'A quiet line: "No open calls", "Nothing waits for you"', model: model({ kind: 'now' }, { calls: [], picked: null, waiting: [], board: { ...BOARD, stations: BOARD.stations.map((entry) => ({ ...entry, call: 'CLEAR', state: 'CLEAR', machineDown: false, material: false })) }, line: { ...LINE, stations: LINE.stations.map((entry) => ({ ...entry, signedIn: true, reassign: [] })) } }) },
    { id: 'updates', label: 'New rows wait behind Show: rows never move under the finger', model: model({ kind: 'now' }, { callsPending: 1, waitingPending: 2 }) },
    { id: 'saved', label: 'An answer saved on this tablet: held, says so', model: model({ kind: 'now' }, { answers: [{ clientEventId: 'q-1', callId: CALLS[0]!.id, step: 'ON_THE_WAY' }] }) },
    { id: 'on-the-way', label: 'A call already on the way: Solved is the main action', model: model({ kind: 'now' }, { picked: CALLS[1]!.id }) },
    { id: 'no-target', label: 'No target today, nothing checked yet', model: model({ kind: 'now' }, { board: { ...BOARD, output: { ...BOARD.output, target: null, targetSoFar: null, pace: 'NO_TARGET' }, quality: { dhu: null, defects: 0, units: 0 } } }) },
    { id: 'offline', label: 'Offline: the line as of; answers queue, decisions held', model: model({ kind: 'now' }, { online: false, asOf: AT }) },
    { id: 'parts-unknown', label: 'A part could not be read: said, never an empty list', model: model({ kind: 'now' }, { callsUnknown: true, calls: [], picked: null, waitingUnknown: true, waiting: [], line: null }) },
    { id: 'no-answer', label: 'A role that may not answer calls', model: model({ kind: 'now' }, { canAnswer: false }) },
    { id: 'after-decision', label: 'Nothing else waits after a decision', model: model({ kind: 'now', done: 'decided' }, { waiting: [] }) },
    { id: 'after-note', label: 'A note saved: its ticks', model: model({ kind: 'now', done: 'handover', queued: 'q-2' }, { ticks: 'saved' }) },
    { id: 'loading', label: 'Loading', model: model({ kind: 'loading' }, { board: null, line: null }) },
    { id: 'no-line', label: 'A tablet with no line', model: model({ kind: 'noLine' }, { board: null, line: null }) },
    { id: 'problem', label: 'The server does not answer', model: model({ kind: 'problem', problem: { kind: 'unavailable' } }, { board: null, line: null }) },
    { id: 'no-permission', label: 'No permission', model: model({ kind: 'problem', problem: { kind: 'forbidden', path: null, message: null } }, { board: null, line: null }) },

    { id: 'scrap', label: 'Scrap over the limit: Approve signs, Reject takes a reason', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'look' }) },
    { id: 'scrap-next', label: 'The next item opens after a decision', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'look', done: true }) },
    { id: 'scrap-own', label: 'Your own scan: held, another person decides', model: model({ kind: 'decide', item: { ...SCRAP_ITEM, row: { ...SCRAP, own: true } } as typeof SCRAP_ITEM, stage: 'look' }) },
    { id: 'scrap-offline', label: 'Offline: the decision is held with the reason', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'look' }, { online: false }) },
    { id: 'scrap-refused', label: 'Decided already (refused)', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'look', problem: { kind: 'refused', code: 'DECIDED_ALREADY', message: 'Decided already.', fix: null } }) },
    { id: 'reject', label: 'Reject: a reason tile', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'reject' }) },
    { id: 'reject-other', label: 'Reject: Other asks for words', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'reject', tile: 'OTHER', words: '' }) },
    { id: 'pin', label: 'Approve: the PIN signs', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'pin', act: { type: 'approve' } }) },
    { id: 'pin-wrong', label: 'A wrong PIN', model: model({ kind: 'decide', item: SCRAP_ITEM, stage: 'pin', act: { type: 'approve' }, pinProblem: 'wrong' }) },
    { id: 'block', label: 'A time block', model: model({ kind: 'decide', item: FIRST!, stage: 'look' }) },
    { id: 'block-reject', label: 'A time block: Reject says why', model: model({ kind: 'decide', item: FIRST!, stage: 'reject', words: '' }) },
    { id: 'conflict', label: 'A sync conflict: both reports side by side', model: model({ kind: 'decide', item: CONFLICT_ITEM, stage: 'look' }) },
    { id: 'conflict-keep', label: 'Keep the recorded one: a reason tile, then the PIN', model: model({ kind: 'decide', item: CONFLICT_ITEM, stage: 'keep' }) },
    { id: 'conflict-send', label: 'Send to the office: a reason tile', model: model({ kind: 'decide', item: CONFLICT_ITEM, stage: 'send', tile: 'COUNTS_WRONG' }) },

    { id: 'correction', label: 'A correction: old → new counts; its one record names the person where the scan does', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', record: RECORD }), note: 'The name is here only: never in the list (Owner answer W1), never with a figure about the person.' },
    { id: 'correction-station', label: 'A correction at a site that records the station only: nobody named', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', record: { ...RECORD, person: null } }) },
    { id: 'correction-next', label: 'A correction is the next item after a decision, its counts and reasons changed', model: model({ kind: 'decide', item: { ...CORRECTION_ITEM, row: { ...CORRECTION, asked: { good: 18, scrap: 1, rework: 1 } } } as typeof CORRECTION_ITEM, stage: 'look', done: true, record: { ...RECORD, asked: { good: 18, scrap: 1, rework: 1 }, reasons: [{ code: 'STAIN', quantity: 1, labelIt: 'Macchia', labelEn: 'Stain', labelI18n: {} }, { code: 'RESTITCH', quantity: 1, labelIt: 'Da ricucire', labelEn: 'To restitch', labelI18n: {} }] } }) },
    { id: 'correction-reading', label: 'A correction opening: held until its record is read', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look' }) },
    { id: 'correction-unread', label: 'A correction whose record could not be read: held, says so', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', recordUnread: true }) },
    { id: 'correction-own', label: 'Your own report or ask: held, another person decides (four eyes)', model: model({ kind: 'decide', item: OWN_CORRECTION, stage: 'look', record: { ...RECORD, own: true } }) },
    { id: 'correction-offline', label: 'A correction offline: the decision is held with the reason', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', record: RECORD }, { online: false }) },
    { id: 'correction-reject', label: 'Reject a correction: a reason tile', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'reject', record: RECORD }) },
    { id: 'correction-reject-other', label: 'Reject a correction: Other asks for words', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'reject', record: RECORD, tile: 'OTHER', words: '' }) },
    { id: 'correction-pin', label: 'Approve a correction: the PIN signs; the original stays', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'pin', record: RECORD, act: { type: 'approve' } }) },
    { id: 'correction-pin-reject', label: 'Reject a correction: the PIN signs here too', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'pin', record: RECORD, act: { type: 'reject', tile: 'RECORDED_RIGHT', words: null } }) },
    { id: 'correction-refused-self', label: 'Refused: the person took the report (four eyes)', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', record: RECORD, problem: { kind: 'refused', code: 'SELF_APPROVAL', message: 'Four eyes.', fix: null } }) },
    { id: 'correction-refused-counts', label: 'Refused: the next operation took more than this leaves', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', record: RECORD, problem: { kind: 'refused', code: 'LESS_THAN_TAKEN', message: 'Fewer than taken.', fix: null } }) },
    { id: 'correction-decided', label: 'Decided already by the office or another team leader', model: model({ kind: 'decide', item: CORRECTION_ITEM, stage: 'look', problem: { kind: 'refused', code: 'DECIDED_ALREADY', message: '', fix: null } }) },

    { id: 'reassign', label: 'Reassign: who may take it; no figure, one held, one with a warning', model: model({ kind: 'reassign', station: 'CUC-06', row: ROW, people: OPERATORS, chosen: null, reason: '' }) },
    { id: 'reassign-why', label: 'Reassign with a warning: a reason is asked', model: model({ kind: 'reassign', station: 'CUC-06', row: ROW, people: OPERATORS, chosen: OPERATORS.operators[1]!, reason: '' }) },
    { id: 'reassign-offline', label: 'Reassign offline: held', model: model({ kind: 'reassign', station: 'CUC-06', row: ROW, people: OPERATORS, chosen: null, reason: '' }, { online: false }) },
    { id: 'reassign-empty', label: 'Reassign: nobody can take it', model: model({ kind: 'reassign', station: 'CUC-06', row: ROW, people: { clockedOnly: false, operators: [] }, chosen: null, reason: '' }) },

    { id: 'handover', label: 'Handover note: last note above, topic tiles, short text', model: model({ kind: 'handover', lineId: 'line-1', shift: 'Mattina', note: HANDOVER, draft: { topics: ['MACHINES'], text: 'Macchina 3 ferma.' }, asOf: null }) },
    { id: 'handover-empty', label: 'Handover note: held until there is something to say', model: model({ kind: 'handover', lineId: 'line-1', shift: 'Mattina', note: { ...HANDOVER, notes: [] }, draft: EMPTY_HANDOVER, asOf: null }) },
    { id: 'handover-offline', label: 'Handover note offline: saves on the tablet', model: model({ kind: 'handover', lineId: 'line-1', shift: 'Mattina', note: HANDOVER, draft: EMPTY_HANDOVER, asOf: AT }, { online: false }) },

    { id: 'behalf-station', label: 'Scan on behalf: the station', model: model(behalf('station', EMPTY_BEHALF)) },
    { id: 'behalf-person', label: 'Scan on behalf: the person (where the site names workers)', model: model(behalf('person', { ...EMPTY_BEHALF, stationId: OPTIONS.stations[1]!.id })) },
    { id: 'behalf-scan', label: 'Scan on behalf: the bundle', model: model(behalf('scan', { ...EMPTY_BEHALF, stationId: OPTIONS.stations[1]!.id, personId: 'w-1' })) },
    { id: 'behalf-scan-offline', label: 'Scan on behalf offline', model: model(behalf('scan', { ...EMPTY_BEHALF, stationId: OPTIONS.stations[1]!.id, personId: 'w-1' }), { online: false }) },
    { id: 'behalf-operation', label: 'Scan on behalf: two operations open', model: model(behalf('operation', { ...READY, operationId: null, card: { ...CARD, operations: [op('op-30', 30, 'Cucitura maniche', 20), op('op-40', 40, 'Asole', 20)] } })) },
    { id: 'behalf-counts', label: 'Scan on behalf: counts', model: model(behalf('counts')) },
    { id: 'behalf-counts-over', label: 'Scan on behalf: too many pieces', model: model(behalf('counts', { ...READY, good: 19, scrap: { STAIN: 3 } })) },
    { id: 'behalf-reason', label: 'Scan on behalf: the reason', model: model(behalf('reason', { ...READY, reason: 'BADGE_MISSING' })) },
    { id: 'behalf-reason-other', label: 'Scan on behalf: Other asks for words', model: model(behalf('reason', { ...READY, reason: 'OTHER' })) },
    { id: 'behalf-refused', label: 'Scan on behalf refused: the person has not acknowledged the notice', model: model(behalf('reason', { ...READY, reason: 'BADGE_MISSING' }, { problem: { kind: 'refused', code: 'BEHALF_NO_NOTICE', message: 'Not acknowledged.', fix: null } })) },
    { id: 'behalf-override', label: 'A held check: another team leader signs', model: model(behalf('override', { ...READY, reason: 'BADGE_MISSING' }, { problem: HELD_REFUSAL })) },
    { id: 'behalf-override-pin', label: 'The other team leader\'s PIN', model: model(behalf('override', { ...READY, reason: 'BADGE_MISSING' }, { override: { reason: 'COUNTED_AGAIN', note: '', badge: 'BADGE-DEMO' } })) },
    { id: 'behalf-done', label: 'Entered: marked, Undo while its window is open', model: model(behalf('done', { ...READY, reason: 'BADGE_MISSING' }, { entered: { scanId: 'scan-9', clientScanId: 'c-9' } })) },
    { id: 'behalf-saved', label: 'Entered offline: saved on this tablet', model: model(behalf('done', { ...READY, reason: 'BADGE_MISSING' }, { queued: 'q-3' }), { online: false, ticks: 'saved' }) },
  ],
})
