import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import { fromScanReason, type PickerReason } from './model'
import { ReasonPickerView, type ReasonPickerModel, type ReasonPickerViewModel } from './view/ReasonPicker'

/**
 * SCR-091's cases (design floor.reasons; the DS icon reason grid): count mode from Operation (scrap, rework), pick mode
 * for "Put it last" on My work over the office's PAUSE list (B-W2a-18), the defect library's example photos (B-W2a-26),
 * page 2, "Other needs a photo", and every state (loading, failed, offline with nothing kept, offline from this tablet,
 * empty). Made-up data only: a "Demo" plant, made-up codes and words; the example photos are drawings, never real ones.
 */

const STATION = 'SEW-04 · Linea 2 St 4'
const SUBJECT = 'BN-DEMO-000123 · Op 20 Cucire fianchi'

const reason = (list: string, code: string, labelIt: string, labelEn: string, sortOrder: number, extra: Partial<PickerReason> = {}): PickerReason => ({
  id: code,
  list,
  code,
  labelIt,
  labelEn,
  labelI18n: {},
  icon: null,
  colour: null,
  photo: null,
  needsDetail: false,
  sortOrder,
  ...extra,
})

// The scans' own scrap and rework reasons, as the bundle card carries them (words only: the standard codes' own look).
const SCRAP = [
  fromScanReason({ kind: 'SCRAP', code: 'LEATHER_FLAW', label: { it: 'Difetto della pelle', en: 'Leather flaw' }, sortOrder: 10 }),
  fromScanReason({ kind: 'SCRAP', code: 'CUT_WRONG', label: { it: 'Taglio sbagliato', en: 'Cut wrong' }, sortOrder: 20 }),
  fromScanReason({ kind: 'SCRAP', code: 'STITCHING', label: { it: 'Cucitura irrecuperabile', en: 'Stitching beyond repair' }, sortOrder: 30 }),
  fromScanReason({ kind: 'SCRAP', code: 'STAIN', label: { it: 'Macchia', en: 'Stain' }, sortOrder: 40 }),
  fromScanReason({ kind: 'SCRAP', code: 'TEAR', label: { it: 'Strappo o foro', en: 'Tear or hole' }, sortOrder: 50 }),
  fromScanReason({ kind: 'SCRAP', code: 'MACHINE', label: { it: 'Danno della macchina', en: 'Machine damage' }, sortOrder: 60 }),
  fromScanReason({ kind: 'SCRAP', code: 'DEMO_BURN', label: { it: 'Bruciatura (demo)', en: 'Burn mark (demo)' }, sortOrder: 70 }),
  fromScanReason({ kind: 'SCRAP', code: 'OTHER', label: { it: 'Altro', en: 'Other' }, sortOrder: 90 }),
]
const REWORK = [
  fromScanReason({ kind: 'REWORK', code: 'RESTITCH', label: { it: 'Cucitura da rifare', en: 'Stitching to redo' }, sortOrder: 10 }),
  fromScanReason({ kind: 'REWORK', code: 'ALIGNMENT', label: { it: 'Pezzi non allineati', en: 'Panels not aligned' }, sortOrder: 20 }),
  fromScanReason({ kind: 'REWORK', code: 'HARDWARE', label: { it: 'Zip o accessorio', en: 'Zip or hardware' }, sortOrder: 30 }),
  fromScanReason({ kind: 'REWORK', code: 'PROTECTOR', label: { it: 'Protezione da sistemare', en: 'Protector to refit' }, sortOrder: 40 }),
  fromScanReason({ kind: 'REWORK', code: 'CLEANING', label: { it: 'Da pulire', en: 'Needs cleaning' }, sortOrder: 50 }),
  fromScanReason({ kind: 'REWORK', code: 'OTHER', label: { it: 'Altro', en: 'Other' }, sortOrder: 90 }),
]

// The office's PAUSE list (B-W2a-18's standard reasons): icons and colours from the DS sets.
const PAUSE = [
  reason('PAUSE', 'MATERIAL_WAIT', 'Attesa materiale', 'Waiting for material', 10, { icon: 'package', colour: '#b87503' }),
  reason('PAUSE', 'MACHINE', 'Macchina ferma', 'Machine stopped', 20, { icon: 'alert', colour: '#e5484d' }),
  reason('PAUSE', 'INSTRUCTIONS', 'Attesa istruzioni', 'Waiting for instructions', 30, { icon: 'flag', colour: '#1f6fde' }),
  reason('PAUSE', 'BREAK', 'Pausa', 'Break', 40, { icon: 'clock', colour: '#059669' }),
  reason('PAUSE', 'OTHER', 'Altro', 'Other', 90, { icon: 'camera', colour: '#5b6573', needsDetail: true }),
]

/** A made-up example "photo": a drawn leather swatch with the mark the defect names. */
const drawing = (mark: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 90'><rect width='120' height='90' fill='sienna'/><path d='M0 30 Q60 10 120 40 M0 70 Q50 50 120 75' stroke='saddlebrown' stroke-width='3' fill='none'/>${mark}</svg>`,
  )}`

// The defect library's picker (B-W2a-26): pictures where the office added one, else its icon.
const DEFECTS = [
  reason('DEFECT', 'DEMO_HOLE', 'Foro', 'Hole', 10, { photo: drawing("<circle cx='60' cy='45' r='9' fill='black'/>"), colour: '#e5484d' }),
  reason('DEFECT', 'DEMO_SCRATCH', 'Graffio', 'Scratch', 20, { photo: drawing("<path d='M25 62 L95 24' stroke='wheat' stroke-width='4' stroke-linecap='round'/>"), colour: '#b87503' }),
  reason('DEFECT', 'DEMO_STAIN', 'Macchia', 'Stain', 30, { photo: drawing("<ellipse cx='62' cy='48' rx='24' ry='15' fill='darkolivegreen' opacity='0.75'/>"), colour: '#0e7490' }),
  reason('DEFECT', 'DEMO_SEAM', 'Cucitura aperta', 'Open seam', 40, { icon: 'alert', colour: '#e5484d' }),
  reason('DEFECT', 'DEMO_ZIP', 'Zip difettosa', 'Faulty zip', 50, { icon: 'box', colour: '#6366f1' }),
  reason('DEFECT', 'OTHER', 'Altro', 'Other', 90, { icon: 'camera', needsDetail: true }),
]

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.operation', { station: { name: STATION, site: 'Stabilimento Demo Nord' }, ...extra })

const model = (picker: Partial<ReasonPickerModel> & Pick<ReasonPickerModel, 'purpose' | 'reasons'>, extra: Partial<ReasonPickerViewModel> = {}): ReasonPickerViewModel => ({
  frame: frame(),
  picker: { subject: SUBJECT, ...picker },
  ...extra,
})

const PUT_LAST = 'WO-DEMO-0042 · Op 20 Cucire fianchi'

export const designScreen = defineDesignScreen<ReasonPickerViewModel>({
  screen: 'SCR-091',
  title: 'Floor reason picker',
  view: onFloor(ReasonPickerView),
  cases: [
    {
      id: 'scrap',
      label: 'Scrap from Operation (count)',
      model: model({ purpose: 'scrap', reasons: SCRAP, counts: {}, of: 20 }),
      note: 'Operation › Scrap opens it: what this is for first ("Scrap · the bundle · Op 20"), then the tiles. Each tap adds one piece with that reason and takes it from Good; − on the tile takes it back. The scan list keeps words only: the standard codes have their own icon, a code the office added has its kind\'s.',
    },
    {
      id: 'scrap-counted',
      label: '2 scrap counted',
      model: model({ purpose: 'scrap', reasons: SCRAP, counts: { LEATHER_FLAW: 1, STAIN: 1 }, of: 20 }),
      note: 'The running count in the card ("2 of 20 counted") and on each tile. Done goes back to the counts; Operation\'s Finish stays one tap away (scan → Scrap → tile → Finish).',
    },
    {
      id: 'scrap-at-most',
      label: 'A tap past what the bundle holds',
      model: model({ purpose: 'scrap', reasons: SCRAP, counts: { LEATHER_FLAW: 18, STAIN: 2 }, of: 20, problem: 'atMost' }),
      note: 'Every piece already has a reason: the tap is refused with an amber flash and the words; nothing is counted.',
    },
    { id: 'rework', label: 'Rework from Operation (count)', model: model({ purpose: 'rework', reasons: REWORK, counts: { RESTITCH: 1 }, of: 20 }), note: 'The rework list, the same way. The pieces reach the office\'s Production › Scrap & rework list with their reason.' },
    {
      id: 'put-last',
      label: 'Put it last (pick one) — My work',
      model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: PAUSE, value: null }, { frame: frame({ titleKey: 'tile.mywork' }) }),
      note: 'My work › I can\'t find it › Put it last: one reason from the office\'s PAUSE list (icons and colours from Production › Floor rules & codes). Done waits for a pick, with the words.',
    },
    {
      id: 'put-last-picked',
      label: 'Put it last: reason picked',
      model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: PAUSE, value: 'MATERIAL_WAIT' }, { frame: frame({ titleKey: 'tile.mywork' }) }),
      note: 'The picked tile: primary border, thick bar, tinted ground and a tick — never colour alone. The card says the choice.',
    },
    {
      id: 'pause',
      label: 'Pause (pick one)',
      model: model({ purpose: 'pause', reasons: PAUSE, value: 'MACHINE' }),
      note: 'The pause list as the W2b timing will open it (Operation › Pause): the picker is ready; Operation has no timing to pause in W2a, so it does not offer Pause yet.',
    },
    {
      id: 'other-photo',
      label: '"Other" needs a photo',
      model: model({ purpose: 'pause', reasons: PAUSE, value: 'OTHER', withPhotos: true }),
      note: 'A host that keeps a photo marks "Other" (the office\'s "asks for a note") with a camera: no typing on the floor; the camera opens after Done (DS PhotoCapture).',
    },
    {
      id: 'defects-photos',
      label: 'Defects with example photos',
      model: model({ purpose: 'defect', reasons: DEFECTS, counts: { DEMO_HOLE: 2 }, of: 24, withPhotos: true }),
      note: 'The defect library\'s picker (B-W2a-26): the office\'s example picture where it has one, else its icon. Made-up drawings here.',
    },
    {
      id: 'more',
      label: 'More than nine: page 2',
      model: model({ purpose: 'scrap', reasons: [...SCRAP, ...REWORK.map((entry) => ({ ...entry, list: 'SCRAP', id: `X_${entry.code}`, code: `X_${entry.code}`, sortOrder: entry.sortOrder + 100 }))], counts: {}, of: 20 }),
      note: 'Nine tiles a page (3 × 3 on the tablet, 2 a row on a phone); More reasons and Back turn the page.',
    },
    { id: 'loading', label: 'Loading the reasons', model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: [], state: 'loading' }, { frame: frame({ titleKey: 'tile.mywork' }) }) },
    { id: 'error', label: 'Could not load', model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: [], state: 'error' }, { frame: frame({ titleKey: 'tile.mywork' }) }), note: 'In words, with Try again; Done is held with its reason.' },
    {
      id: 'offline-kept',
      label: 'Offline: the reasons from this tablet',
      model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: PAUSE, value: null, asOf: '2026-10-29T06:02:00.000Z' }, { frame: frame({ titleKey: 'tile.mywork', online: false, pending: 1 }) }),
      note: 'Read earlier in this visit: offered as of then. The office\'s changes reach the tablet at the next read.',
    },
    {
      id: 'offline-none',
      label: 'Offline: never read on this tablet',
      model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: [], state: 'offline' }, { frame: frame({ titleKey: 'tile.mywork', online: false }) }),
      note: 'Held with the reason: the first read needs the network.',
    },
    {
      id: 'empty',
      label: 'No reasons set up',
      model: model({ purpose: 'putLast', subject: PUT_LAST, reasons: [], value: null }, { frame: frame({ titleKey: 'tile.mywork' }) }),
      note: 'Who fixes it, in words: Production › Floor rules & codes.',
    },
  ],
})
