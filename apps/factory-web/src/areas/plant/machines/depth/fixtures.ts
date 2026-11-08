import { STEP_UP_CLOSED } from '../../_shared/parts'
import { at, MACHINE_LIST, MACHINES, SITE, uid } from '../../_shared/fixtures'
import type { HistoryAnswer, LabelPrinter, MachineDepth, MachineDocument, TagJob, WallAnswer } from './api'
import type { RecordDepth } from '../view-model'
import type { TagsDialogState } from './view/TagsDialog'

/**
 * Made-up data of machines in depth (B-W2b-136) for the design cases of SCR-150, SCR-150-record and SCR-150-wall: never a
 * real machine, printer, file or person. The demo day is 30 October 2026 (Europe/Rome), a Friday.
 */

export const TODAY = '2026-10-30'
export const MONDAY = '2026-10-26'

const check = (code: string, labelIt: string, labelEn: string, nextDueOn: string, state: 'OVERDUE' | 'DUE_SOON' | 'PLANNED', days: number) => ({ planId: uid('7171', code.length), nextDueOn, state, days, checkType: { code, labelIt, labelEn, labelI18n: {} } })

export const FACTS: Record<string, MachineDepth> = {
  [MACHINES.sew1.id]: { id: MACHINES.sew1.id, ceOnFile: true, manuals: 2, nextCheck: null, tag: { state: 'PRINTED', jobId: uid('7272', 1), at: at(3, 9), printedAt: at(3, 9, 2) } },
  [MACHINES.sew2.id]: { id: MACHINES.sew2.id, ceOnFile: true, manuals: 1, nextCheck: null, tag: { state: 'FAILED', jobId: uid('7272', 2), at: at(29, 15), printedAt: null } },
  [MACHINES.sew3.id]: { id: MACHINES.sew3.id, ceOnFile: false, manuals: 0, nextCheck: null, tag: null },
  [MACHINES.sew4.id]: { id: MACHINES.sew4.id, ceOnFile: true, manuals: 1, nextCheck: null, tag: { state: 'QUEUED', jobId: uid('7272', 4), at: at(30, 9, 30), printedAt: null } },
  [MACHINES.cutTable.id]: { id: MACHINES.cutTable.id, ceOnFile: true, manuals: 1, nextCheck: check('EARTHING', 'Verifica messa a terra', 'Earthing check', '2027-03-02', 'PLANNED', 123), tag: null },
  [MACHINES.press.id]: { id: MACHINES.press.id, ceOnFile: true, manuals: 1, nextCheck: check('PRESS_GUARDS', 'Protezioni della trancia', 'Press guards', '2026-10-20', 'OVERDUE', -10), tag: { state: 'PRINTED', jobId: uid('7272', 6), at: at(5, 11), printedAt: at(5, 11, 1) } },
  [MACHINES.heat.id]: { id: MACHINES.heat.id, ceOnFile: false, manuals: 0, nextCheck: check('PRESSURE_VESSEL', 'Recipiente a pressione', 'Pressure vessel', '2026-11-12', 'DUE_SOON', 13), tag: null },
  [MACHINES.compressor.id]: { id: MACHINES.compressor.id, ceOnFile: false, manuals: 1, nextCheck: check('PRESSURE_VESSEL', 'Recipiente a pressione', 'Pressure vessel', '2027-06-01', 'PLANNED', 214), tag: null },
}
export const DEPTH_TILES = { checksOverdue: 1, noCe: 3 }

// ---- the status wall --------------------------------------------------------------------------------------------------------

const tile = (machine: (typeof MACHINE_LIST)[number]) => ({ id: machine.id, assetNumber: machine.assetNumber, siteCode: machine.siteCode, class: machine.class, station: machine.station, status: machine.status, statusSince: machine.statusSince, locked: machine.locked })

export const WALL: WallAnswer = {
  lines: [
    { line: MACHINES.sew1.line, siteCode: SITE.code, machines: [MACHINES.sew1, MACHINES.sew2, MACHINES.sew3, MACHINES.sew4].map(tile) },
    { line: MACHINES.cutTable.line, siteCode: SITE.code, machines: [MACHINES.cutTable, MACHINES.press].map(tile) },
    { line: null, siteCode: SITE.code, machines: [MACHINES.heat, MACHINES.compressor].map(tile) },
  ],
  counts: { RUNNING: 5, DOWN: 1, UNDER_MAINTENANCE: 1, DO_NOT_USE: 1, locked: 1 },
  truncated: false,
  at: at(30, 9, 42),
}

// ---- documents ----------------------------------------------------------------------------------------------------------------

const doc = (n: number, over: Partial<MachineDocument>): MachineDocument => ({
  id: uid('7373', n),
  group: 'MANUAL',
  kind: 'DOCUMENT',
  originalName: 'manuale-uso.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2_480_000,
  status: 'AVAILABLE',
  scanStatus: 'NOT_SCANNED',
  onTablets: true,
  createdAt: at(2, 10),
  availableAt: at(2, 10, 1),
  version: 1,
  ...over,
})

export const DOCUMENTS: MachineDocument[] = [
  doc(1, { group: 'MACHINE_CE', originalName: 'dichiarazione-ce-CD-8700.pdf', sizeBytes: 412_000 }),
  doc(2, { originalName: 'manuale-uso-CD-8700.pdf' }),
  doc(3, { originalName: 'manuale-ricambi-CD-8700.pdf', sizeBytes: 5_310_000, onTablets: false }),
  doc(4, { group: 'PHOTO', kind: 'PHOTO', originalName: 'targhetta.jpg', contentType: 'image/jpeg', sizeBytes: 820_000, onTablets: false }),
  doc(5, { group: 'OTHER', originalName: 'schema-elettrico.pdf', sizeBytes: 690_000, onTablets: false, scanStatus: 'PENDING' }),
]

// ---- the status history -------------------------------------------------------------------------------------------------------

const event = (n: number, day: number, hour: number, minute: number, from: HistoryAnswer['events'][number]['from'], to: HistoryAnswer['events'][number]['to'], reason: string | null) => ({ id: uid('7474', n), at: at(day, hour, minute), from, to, reason })

const EVENTS = [
  event(1, 26, 7, 40, 'RUNNING', 'DOWN', 'Rottura ago (dato di prova)'),
  event(2, 26, 8, 10, 'DOWN', 'UNDER_MAINTENANCE', null),
  event(3, 26, 9, 5, 'UNDER_MAINTENANCE', 'RUNNING', null),
  event(4, 28, 13, 20, 'RUNNING', 'DO_NOT_USE', 'Protezione incrinata: in attesa del ricambio (dato di prova)'),
  event(5, 29, 10, 0, 'DO_NOT_USE', 'RUNNING', 'Ricambio montato, protezione controllata (dato di prova)'),
]

export const HISTORY: HistoryAnswer = {
  from: '2026-10-25T23:00:00.000Z',
  to: '2026-11-01T23:00:00.000Z',
  now: at(30, 9, 42),
  registeredAt: at(1, 8),
  before: { status: 'RUNNING', reason: null },
  current: { status: 'RUNNING', reason: 'Ricambio montato, protezione controllata (dato di prova)', since: at(29, 10) },
  events: EVENTS,
  latest: [...EVENTS].reverse(),
}

// ---- tags ---------------------------------------------------------------------------------------------------------------------

export const PRINTERS: LabelPrinter[] = [
  { id: uid('7575', 1), code: 'LBL-01', name: 'Etichettatrice reparto', siteId: SITE.id, siteCode: SITE.code, labelWidthMm: 100, labelHeightMm: 50, dpi: 203 },
  { id: uid('7575', 2), code: 'LBL-02', name: 'Etichettatrice magazzino', siteId: SITE.id, siteCode: SITE.code, labelWidthMm: 76, labelHeightMm: 51, dpi: 203 },
]

export const tagJob = (machineId: string, state: TagJob['state'], over: Partial<TagJob> = {}): TagJob => ({
  machineId,
  jobId: uid('7676', machineId.length + state.length),
  printerId: PRINTERS[0]!.id,
  printerCode: 'LBL-01',
  state,
  copies: 1,
  lastError: state === 'FAILED' ? 'Paper out' : null,
  at: at(30, 9, 30),
  printedAt: state === 'PRINTED' ? at(30, 9, 31) : null,
  version: 1,
  ...over,
})

export const tagMachine = (machine: (typeof MACHINE_LIST)[number], typeWords = 'Lockstitch') => ({ id: machine.id, assetNumber: machine.assetNumber, typeWords, placeWords: [machine.siteCode, machine.station?.code].filter(Boolean).join(' · '), siteId: machine.siteId, retired: machine.status === 'RETIRED' })

export const tagsState = (over: Partial<TagsDialogState> = {}): TagsDialogState => ({
  machines: [tagMachine(MACHINES.sew1), tagMachine(MACHINES.sew3), tagMachine(MACHINES.press, 'Clicking press')],
  printers: { status: 'ready', value: PRINTERS },
  printerId: PRINTERS[0]!.id,
  copies: 1,
  busy: false,
  problem: null,
  result: null,
  retrying: null,
  ...over,
})

/** A record's depth: Documents & CE, the week, the tag, no dialog open. */
export const recordDepth = (over: Partial<RecordDepth> = {}): RecordDepth => ({
  today: TODAY,
  facts: FACTS[MACHINES.sew1.id]!,
  documents: { loaded: { status: 'ready', value: { documents: DOCUMENTS, ceOnFile: true, canManage: true } }, upload: { group: 'MACHINE_CE', onTablets: true, busy: false, problem: null, done: null }, viewer: null, remove: null },
  history: { loaded: { status: 'ready', value: HISTORY }, week: MONDAY },
  tagJob: { status: 'ready', value: tagJob(MACHINES.sew1.id, 'PRINTED') },
  status: null,
  tags: null,
  stepUp: STEP_UP_CLOSED,
  canPrint: true,
  ...over,
})
