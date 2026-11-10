import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { OpenItem } from '../scans/timing'
import type { DueInstruction, FloorInstruction, FloorSpec, InstructionStep, NewerSpec } from './api'
import { EMPTY_PROBLEM, type ProblemDraft } from './model'
import { InstructionsView, type InstructionsStep, type InstructionsViewModel, type OpenWork, type SentProblem } from './view/InstructionsView'

/**
 * SCR-174's cases (B-W2b-232; design floor.instructions; MES-110, MES-119, PRD-195, PRD-258, PRD-259). For this work (ready, the
 * bundle in hand and "New for you", a version picked with no bundle in hand, a work order's label, another factory's ticket, held
 * by the notice, offline), opening (loading, not on this tablet, not found, refused, the office not answering, no permission), How
 * to do it (a first time with a photo, a step with no picture, critical and safety, several pictures, a video being read, another
 * language, the last step with Seen open, a changed version with its note, Seen saved / recorded / refused, nothing due, opened by
 * Start, offline as of, a picture that failed, the Photo pop-up, no instruction yet), Spec for this size (normal, no measures, not
 * kept offline), Spec changed (newer, finish old, rework, held, withdrawn), Report a spec problem (empty, Other without words, a
 * photo, offline, the camera, sent, saved on the tablet, the photo going up or failed, refused). Made-up data of a "Demo" plant:
 * never money, never a person's name on a spec problem.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 123 })
const OTHER = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 131 })
const FOREIGN = formatScanId({ type: 'BUNDLE', tenantTag: tenantTag('0190f0e2-0000-7000-8000-000000000001'), ref: 9 })
const WORK_ORDER_LABEL = formatScanId({ type: 'WORK_ORDER', tenantTag: TAG, ref: 42 })
const AT = '2026-11-10T08:41:00.000Z'
const STATION = 'SEW-04 · Linea 2 St 4'

const PHOTO = (shade: string) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 30'%3E%3Crect width='40' height='30' fill='%23${shade}'/%3E%3Cpath d='M6 22 L18 10 L26 18 L34 8' stroke='%23fff' stroke-width='2' fill='none'/%3E%3C/svg%3E`

const step = (code: string, words: string, extra: Partial<InstructionStep> = {}): InstructionStep => ({ code, words, shownIn: 'it', critical: false, safety: null, icon: null, requiredTick: false, media: [], ...extra })

const STEPS: readonly InstructionStep[] = [
  step('ALIGN', 'Allinea i due pannelli del davanti sulle tacche, dritto filo verso l’alto.', { icon: 'layers', media: [{ id: 'm-1', kind: 'PHOTO', caption: 'Le tacche combaciano' }] }),
  step('ZIP_GUARD', 'Cuci la paramontura della zip a 3 mm dal bordo, punto 3,5.', { icon: 'needle', critical: true, safety: 'Tieni le dita lontane dal piedino durante la cucitura della zip.', requiredTick: true }),
  step('SEAM_CHECK', 'Controlla la cucitura: nessun punto saltato, filo tirato giusto.', { icon: 'eye', media: [{ id: 'm-2', kind: 'PHOTO', caption: 'Cucitura giusta' }, { id: 'm-3', kind: 'PHOTO', caption: 'Punto saltato: da rifare' }] }),
  step('PACK_BUNDLE', 'Rimetti i pezzi nel fascio con il cartellino sopra.', { icon: 'package', media: [{ id: 'm-4', kind: 'VIDEO', caption: 'Come richiudere il fascio' }] }),
]

const ANSWER: FloorInstruction = {
  bundle: { id: 'b-123', code: BUNDLE, quantity: 20 },
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' },
  operation: { id: 'op-20', seq: 20, code: 'SEW-ASM', name: 'Assemblare il davanti' },
  language: 'it',
  instruction: {
    id: 'wi-7',
    number: 'WI-DEMO-0007',
    forRevision: false,
    version: { id: 'v-4', number: 4, publishedAt: '2026-11-09T15:00:00.000Z', changeNote: 'La cucitura della zip passa da 5 a 3 mm dal bordo.', acknowledgementRequired: true },
    steps: [...STEPS],
  },
  settings: [{ seq: 20, machineClass: { code: 'LOCK', labelIt: 'Lineare a punto annodato', labelEn: 'Lockstitch' }, stitchType: '301', needle: '90/14 SD', thread: 'Poliestere 40', stitchesPerCm: '3,5', tension: null, foot: 'Piedino zip', notes: null }],
  acknowledgement: { due: 'FIRST', seenAt: null },
}

const SPEC: FloorSpec = {
  bundle: { id: 'b-123', code: BUNDLE, quantity: 20, part: null },
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042', batchNumber: 'B-26-041', releasedAt: '2026-11-03T07:00:00.000Z' },
  style: { id: 's-1', code: 'GIA-01', name: 'Giacca Demo', ppeCategory: 'CAT_II', ppeStandard: 'EN 17092-4', ppeClass: 'A' },
  revision: { id: 'r-2', revision: 2, status: 'RELEASED', releasedAt: '2026-10-28T09:00:00.000Z' },
  colourway: { code: 'NERO', name: 'Nero' },
  size: {
    code: '52',
    label: 'L',
    measures: [
      { point: 'Torace', min: '104', max: '108', unit: 'cm' },
      { point: 'Vita', min: '92', max: '96', unit: 'cm' },
      { point: 'Lunghezza manica', min: '64', max: '64', unit: 'cm' },
      { point: 'Lunghezza dietro', min: '72', max: null, unit: 'cm' },
    ],
  },
  materials: [
    { seq: 10, placement: 'Esterno', item: { code: 'PEL-120', name: 'Pelle bovina 1,2 mm', nameI18n: { en: 'Cowhide 1.2 mm' } }, colour: { code: 'NERO', name: 'Nero' }, perGarment: '1.85', uom: 'M2' },
    { seq: 20, placement: 'Fodera', item: { code: 'FOD-110', name: 'Fodera termica', nameI18n: { en: 'Thermal lining' } }, colour: null, perGarment: '1.2', uom: 'M' },
    { seq: 30, placement: 'Spalla', item: { code: 'PRO-300', name: 'Protezione spalla livello 2', nameI18n: {} }, colour: null, perGarment: '2', uom: 'PCS' },
  ],
  label: { code: 'LBL-01', name: 'Etichetta giacca', revision: 2, languages: ['it', 'en'] },
  operations: [
    { id: 'op-10', seq: 10, code: 'CUT', name: 'Taglio pelle', current: false },
    { id: 'op-20', seq: 20, code: 'SEW-ASM', name: 'Assemblare il davanti', current: true },
    { id: 'op-30', seq: 30, code: 'SEW-SLV', name: 'Attaccare maniche', current: false },
    { id: 'op-40', seq: 40, code: 'QC', name: 'Controllo finale', current: false },
  ],
}

const newer = (extra: Partial<NewerSpec['newer']> = {}): NewerSpec => ({
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' },
  revision: { revision: 2, status: 'OBSOLETE' },
  newer: { state: 'NEWER_RELEASED', banner: true, newPages: false, message: '', newer: { id: 'r-3', revision: 3, releasedOn: '2026-11-09' }, decision: null, ...extra },
})

const SRC: Readonly<Record<string, string | null | undefined>> = { 'm-1': PHOTO('678'), 'm-2': PHOTO('586'), 'm-3': PHOTO('a55') }

const IN_HAND: readonly OpenItem[] = [
  { bundleId: 'b-123', bundleCode: BUNDLE, operation: { id: 'op-20', seq: 20, code: 'SEW-ASM', name: 'Assemblare il davanti' }, state: 'PAUSED', pausedAt: '2026-11-10T07:58:00.000Z', runningSince: null, pausedAtClockOut: false },
  { bundleId: 'b-131', bundleCode: OTHER, operation: { id: 'op-30', seq: 30, code: 'SEW-SLV', name: 'Attaccare maniche' }, state: 'PAUSED', pausedAt: '2026-11-10T08:12:00.000Z', runningSince: null, pausedAtClockOut: false },
]

const DUE: readonly DueInstruction[] = [
  { instructionId: 'wi-7', number: 'WI-DEMO-0007', forRevision: false, operation: { id: 'lib-asm', code: 'SEW-ASM', name: 'Assemblare il davanti' }, versionId: 'v-4', versionNumber: 4, publishedAt: '2026-11-09T15:00:00.000Z', reason: 'CHANGED' },
  { instructionId: 'wi-9', number: 'WI-DEMO-0009', forRevision: true, operation: { id: 'lib-pck', code: 'PACK', name: 'Imballare' }, versionId: 'v-9', versionNumber: 1, publishedAt: '2026-11-08T10:00:00.000Z', reason: 'FIRST' },
]

const frame = (extra: Partial<InstructionsViewModel['frame']> = {}) => signedInFrame('tile.instructions', { station: { name: STATION, site: 'Stabilimento Demo Nord' }, ...extra })

const model = (step: InstructionsStep, extra: Partial<InstructionsViewModel> = {}): InstructionsViewModel => ({ frame: frame(extra.online === false ? { online: false, pending: 1 } : {}), step, online: true, src: SRC, ...extra })

const work = (extra: Partial<OpenWork> = {}): OpenWork => ({
  answer: ANSWER,
  asOf: null,
  spec: SPEC,
  specAsOf: null,
  specProblem: null,
  newer: null,
  tab: 'steps',
  index: 0,
  shown: [0],
  media: {},
  zoom: null,
  due: 'FIRST',
  seen: null,
  busy: false,
  from: 'operation',
  ...extra,
})

const open = (extra: Partial<OpenWork> = {}): InstructionsStep => ({ kind: 'open', work: work(extra) })
const problem = (draft: Partial<ProblemDraft> = {}, extra: Partial<OpenWork> = {}): InstructionsStep => ({ kind: 'problem', work: work(extra), draft: { ...EMPTY_PROBLEM, ...draft } })
const sent = (extra: Partial<SentProblem> = {}): InstructionsStep => ({ kind: 'sent', work: work(), sent: { ticks: 'recorded', refusal: null, photo: 'none', ...extra } })
const ALL = [0, 1, 2, 3]
const PHOTO_BLOB = { id: 'photo-1', blob: new Blob([], { type: 'image/jpeg' }), name: 'WO-DEMO-0042-op20-spec-problem.jpg' }
const CHANGED: FloorInstruction = { ...ANSWER, acknowledgement: { due: 'CHANGED', seenAt: '2026-10-30T07:10:00.000Z' } }
const NOT_DUE: FloorInstruction = { ...ANSWER, acknowledgement: { due: null, seenAt: '2026-11-09T16:05:00.000Z' } }
const NONE: FloorInstruction = { ...ANSWER, instruction: null, acknowledgement: null }
const OTHER_LANGUAGE: FloorInstruction = { ...ANSWER, language: 'ro', instruction: { ...ANSWER.instruction!, steps: STEPS.map((entry) => ({ ...entry, shownIn: 'it' })) } }

export const designScreen = defineDesignScreen<InstructionsViewModel>({
  screen: 'SCR-174',
  title: 'Floor › Spec & instructions',
  view: onFloor(InstructionsView),
  cases: [
    { id: 'ready', label: 'For this work: scan a bundle', model: model({ kind: 'scan' }), note: 'Opened from the tile with nothing in hand: the ticket is the only input. A scanner reads it anywhere on the screen.' },
    { id: 'ready-in-hand', label: 'Your work here and New for you', model: model({ kind: 'scan' }, { inHand: IN_HAND, due: DUE }), note: 'Two paused bundles of this person on this tablet (one running would open by itself); the versions waiting for their Seen (GET …/floor/mine). Keys in the list footer.' },
    { id: 'ready-prompt', label: 'A new version picked, no bundle in hand', model: model({ kind: 'scan', prompt: { operation: 'PACK · Imballare', version: 1 } }, { due: DUE }), note: 'The floor reads an instruction only for a bundle (its size and operation): the person scans one at that operation.' },
    { id: 'wrong-label', label: 'A work order’s label scanned', model: model({ kind: 'scan', problem: { kind: 'wrongLabel', type: 'workOrder', code: WORK_ORDER_LABEL } }), note: 'A work order has many sizes; a printed instruction has no QR yet (B-W2b-230): the bundle’s ticket opens the version in force.' },
    { id: 'other-factory', label: 'Another factory’s ticket', model: model({ kind: 'scan', problem: { kind: 'unknownCode', reason: 'otherFactory', code: FOREIGN } }) },
    { id: 'held-notice', label: 'Held: read the notice first', model: model({ kind: 'scan' }, { held: true }), note: 'Seen names the person: the worker notice holds the page as it holds Operation.' },
    { id: 'offline-scan', label: 'No network: For this work', model: model({ kind: 'scan' }, { online: false, inHand: IN_HAND.slice(0, 1) }) },
    { id: 'loading', label: 'Opening', model: model({ kind: 'loading', code: BUNDLE }) },
    { id: 'not-on-tablet', label: 'Offline: not on this tablet', model: model({ kind: 'notOnTablet', code: BUNDLE }, { online: false }) },
    { id: 'not-found', label: 'Bundle not found here', model: model({ kind: 'failed', code: BUNDLE, problem: { kind: 'notFound' } }) },
    { id: 'refused', label: 'Refused: nothing to do here', model: model({ kind: 'failed', code: BUNDLE, problem: { kind: 'refused', code: 'NO_OPERATION_HERE', message: 'No operation of this bundle is done here.', fix: null } }), note: 'A refusal code the Operation screen knows speaks its words; another speaks the page’s general words.' },
    { id: 'error', label: 'The office does not answer', model: model({ kind: 'failed', code: BUNDLE, problem: { kind: 'unavailable' } }) },
    { id: 'no-permission', label: 'No permission', model: model({ kind: 'noPermission' }) },
    { id: 'first-time', label: 'First time: step 1 of 4 with its photo', model: model(open()), note: 'MES-110 opened it before Start. Seen is the main action, held until every step was on screen ("Look at every step first").' },
    { id: 'step-critical', label: 'A critical step with no picture, safety, tick', model: model(open({ index: 1, shown: [0, 1] })), note: 'No photo: the step’s icon instead. The tick happens on the Operation screen before Finish.' },
    { id: 'step-pictures', label: 'A step with two photos', model: model(open({ index: 2, shown: [0, 1, 2], media: { 2: 1 } })) },
    { id: 'step-video', label: 'A video being read', model: model(open({ index: 3, shown: [0, 1, 2, 3] }), { src: { ...SRC, 'm-4': null } }), note: 'A muted looping video with its caption once read; read through the floor’s own route and kept as a blob for the visit.' },
    { id: 'other-language', label: 'Not written in the person’s language', model: model(open({ answer: OTHER_LANGUAGE })), note: 'The worker’s language is Romanian, the step is written in Italian: the tablet says so and reads it aloud in Italian.' },
    { id: 'seen-ready', label: 'Every step looked at: Seen open', model: model(open({ index: 3, shown: ALL }), { src: { ...SRC, 'm-4': undefined } }) },
    { id: 'changed', label: 'A changed version with its note', model: model(open({ answer: CHANGED, due: 'CHANGED' })), note: 'CHANGED: the person saw version 3; the office’s change note says what changed.' },
    { id: 'seen-saved', label: 'Seen saved on this tablet', model: model(open({ shown: ALL, due: null, seen: { ticks: 'saved', refusal: null } }), { online: false }) },
    { id: 'seen-recorded', label: 'Seen recorded', model: model(open({ shown: ALL, due: null, seen: { ticks: 'recorded', refusal: null } })) },
    { id: 'seen-refused', label: 'Seen refused: not the version in force', model: model(open({ shown: ALL, seen: { ticks: 'refused', refusal: 'NOT_PUBLISHED' } })) },
    { id: 'not-due', label: 'Nothing waits: looked up again', model: model(open({ answer: NOT_DUE, due: null, from: null })), note: 'No Seen asked: the main action goes back. The date it was seen is a fact on the card.' },
    { id: 'from-start', label: 'Opened by Start', model: model(open({ from: 'start' })), note: 'Back returns to the bundle; the next Start goes (it opens once per visit).' },
    { id: 'offline-open', label: 'Offline: from this tablet', model: model(open({ asOf: AT, index: 3, shown: ALL }), { online: false, src: { 'm-1': PHOTO('678') } }) },
    { id: 'media-failed', label: 'A picture could not be opened', model: model(open({ index: 0 }), { src: {}, failed: ['m-1'] }) },
    { id: 'zoom', label: 'Photo pop-up at 150 %', model: model(open({ zoom: { mediaId: 'm-1', level: 1.5 } })), note: 'pop:instructions.zoom: + / − (keys too), Close, Esc.' },
    { id: 'no-instruction', label: 'No instruction yet', model: model(open({ answer: NONE, due: null })) },
    { id: 'spec', label: 'Spec for this size', model: model(open({ tab: 'spec' })), note: 'The frozen spec: revision, colourway, size, label, measures, materials per garment, machine settings, the routing. Never a cost.' },
    { id: 'spec-no-measures', label: 'Spec: no measures for the size', model: model(open({ tab: 'spec', spec: { ...SPEC, size: { ...SPEC.size, measures: [] }, label: null } })) },
    { id: 'spec-offline', label: 'Spec not kept offline', model: model(open({ tab: 'spec', spec: null, specProblem: 'offline', asOf: AT }), { online: false }) },
    { id: 'banner-newer', label: 'Spec changed: a newer revision', model: model(open({ newer: newer() })), note: 'PRD-195: keep to the frozen revision until the office decides (B-W2b-220).' },
    { id: 'banner-finish', label: 'Spec changed: finish on the old revision', model: model(open({ newer: newer({ decision: { disposition: 'FINISH_OLD', changeOrder: 'ECO-DEMO-0003' } }) })) },
    { id: 'banner-rework', label: 'Spec changed: rework to the new pages', model: model(open({ newer: newer({ newPages: true, decision: { disposition: 'REWORK', changeOrder: 'ECO-DEMO-0003' } }), tab: 'spec' })), note: 'The new pages apply but the floor reads only the frozen spec: the tablet says to ask for them.' },
    { id: 'banner-hold', label: 'Spec changed: held, stop', model: model(open({ newer: newer({ decision: { disposition: 'HOLD', changeOrder: 'ECO-DEMO-0004' } }) })) },
    { id: 'banner-withdrawn', label: 'Spec changed: revision withdrawn', model: model(open({ newer: { ...newer(), newer: { state: 'WITHDRAWN', banner: true, newPages: false, message: '', newer: null, decision: null } } })) },
    { id: 'problem', label: 'Report a spec problem', model: model(problem()), note: 'PRD-259: type → photo (optional) → Send. Three taps on the usual path.' },
    { id: 'problem-other', label: 'Something else, no words yet', model: model(problem({ problem: 'OTHER' })) },
    { id: 'problem-photo', label: 'A photo taken', model: model(problem({ problem: 'WRONG_MEASUREMENT', photo: PHOTO_BLOB, note: 'La manica misura 66, la scheda dice 64.' })) },
    { id: 'problem-offline', label: 'Offline: the report waits, the photo is held', model: model(problem({ problem: 'UNCLEAR' }), { online: false }) },
    { id: 'problem-camera', label: 'The camera', model: model(problem({ problem: 'MATERIAL_DIFFERS', capture: true })) },
    { id: 'sent', label: 'Sent and recorded', model: model(sent()) },
    { id: 'sent-saved', label: 'Saved on this tablet', model: model(sent({ ticks: 'saved', photo: 'none' }), { online: false }) },
    { id: 'sent-photo', label: 'The photo going up', model: model(sent({ photo: 'sending' })) },
    { id: 'sent-photo-failed', label: 'The photo did not go up', model: model(sent({ photo: 'failed' })) },
    { id: 'sent-refused', label: 'Not taken by the office', model: model(sent({ ticks: 'refused', refusal: 'UNAVAILABLE' })) },
  ],
})
