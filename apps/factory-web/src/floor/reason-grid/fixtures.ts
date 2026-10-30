import { defineDesignScreen } from '../../lib/design/design-screen'
import { onFloor } from '../frame/fixtures'
import { ReasonGridLabView, type LabReason, type ReasonGridLabModel } from './view/ReasonGridLabView'

/**
 * SCR-246 — the floor's icon reason grid (DS part D20, B-W2a-24; NEW id: the DS part has no screen of its own; the
 * reason picker SCR-091 (B-W2a-74) and every floor step that asks why use it: pause, scrap, defects, machine symptom,
 * hide grade — B-W2a-73…76 — and Plant › Machine requests "Report a problem"). Floor tier, tablet first. Made-up
 * reasons; the example photos are drawings, never real photos. In the browser the grid works for real (kept in the view
 * only): tap or arrows to pick, a tap adds one and − takes one off, More reasons / Back turn the page.
 */

/** A made-up example "photo": a drawn leather swatch with the mark the reason names. */
const drawing = (mark: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 90'><rect width='120' height='90' fill='sienna'/><path d='M0 30 Q60 10 120 40 M0 70 Q50 50 120 75' stroke='saddlebrown' stroke-width='3' fill='none'/>${mark}</svg>`,
  )}`
const HOLE = drawing("<circle cx='60' cy='45' r='9' fill='black'/>")
const SCRATCH = drawing("<path d='M25 62 L95 24' stroke='wheat' stroke-width='4' stroke-linecap='round'/>")
const STAIN = drawing("<ellipse cx='62' cy='48' rx='24' ry='15' fill='darkolivegreen' opacity='0.75'/>")
const CLEAN = drawing('')
const MARKS = drawing("<circle cx='30' cy='22' r='3' fill='wheat'/><circle cx='88' cy='66' r='3' fill='wheat'/>")
const LINING = drawing("<rect x='12' y='12' width='96' height='66' fill='none' stroke='wheat' stroke-width='3' stroke-dasharray='6 5'/>")

const stops: LabReason[] = [
  { id: 'material', icon: 'package', tone: 'warning' },
  { id: 'machine', icon: 'wrench', tone: 'danger' },
  { id: 'help', icon: 'hand', tone: 'primary' },
  { id: 'quality', icon: 'clipboard', tone: 'info' },
  { id: 'break', icon: 'coffee' },
  { id: 'meeting', icon: 'users' },
  { id: 'other', icon: 'help', photoNeeded: true },
]

const defects: LabReason[] = [
  { id: 'hole', icon: 'circleDot', tone: 'danger', hint: true },
  { id: 'scratch', icon: 'spline', tone: 'warning', hint: true },
  { id: 'pinhole', icon: 'zap', tone: 'warning', notHere: true },
  { id: 'stain', icon: 'droplets', tone: 'info', hint: true },
  { id: 'seam', icon: 'scissors', tone: 'danger' },
  { id: 'size', icon: 'ruler', tone: 'primary' },
  { id: 'lining', icon: 'layers', tone: 'info' },
  { id: 'fade', icon: 'sun', tone: 'warning' },
  { id: 'split', icon: 'split', tone: 'danger' },
  { id: 'rivet', icon: 'hammer' },
  { id: 'zip', icon: 'unlink' },
  { id: 'cut', icon: 'scissors', tone: 'warning' },
  { id: 'other', icon: 'help', photoNeeded: true },
]

const symptoms: LabReason[] = [
  { id: 'noise', icon: 'noise', tone: 'warning' },
  { id: 'needle', icon: 'pin', tone: 'danger' },
  { id: 'thread', icon: 'unlink', tone: 'warning' },
  { id: 'oil', icon: 'droplet', tone: 'danger' },
  { id: 'power', icon: 'power', tone: 'danger' },
  { id: 'jam', icon: 'ban', tone: 'warning' },
  { id: 'other', icon: 'help', photoNeeded: true },
]

const grades: LabReason[] = [
  { id: 'gradeA', photo: CLEAN, tone: 'success', hint: true },
  { id: 'gradeB', photo: MARKS, tone: 'primary', hint: true },
  { id: 'gradeC', photo: LINING, tone: 'warning', hint: true },
  { id: 'hole', photo: HOLE, tone: 'danger', hint: true },
  { id: 'scratch', photo: SCRATCH, tone: 'warning', hint: true },
  { id: 'stain', photo: STAIN, tone: 'info', hint: true },
  { id: 'reject', icon: 'ban', tone: 'danger', hint: true },
]

export const designScreen = defineDesignScreen<ReasonGridLabModel>({
  screen: 'SCR-246',
  title: 'Icon reason grid (DS part D20, floor)',
  view: onFloor(ReasonGridLabView),
  cases: [
    {
      id: 'pick',
      label: 'Pick one: why did you stop',
      model: { question: 'stop', mode: 'pick', reasons: stops, value: null },
      note: 'Icons first, a colour and a word on each tile; one tap picks (no long press). Tab reaches the group once; arrows move and pick (↑ ↓ by row). Confirm is held until a reason is chosen, with the words.',
    },
    {
      id: 'picked',
      label: 'Picked',
      model: { question: 'stop', mode: 'pick', reasons: stops, value: 'machine' },
      note: 'The picked tile: a primary border, a thick bar, a tinted ground and a tick — never colour alone.',
    },
    {
      id: 'count',
      label: 'Count: defects in a bundle',
      model: { question: 'defects', mode: 'count', reasons: defects, counts: { hole: 2, seam: 1 }, max: 24 },
      note: 'Each tap adds one, the count is big on the tile, − takes one off, the total is written under the grid. Never more than the bundle (24): the 25th tap says so.',
    },
    {
      id: 'more',
      label: 'More than nine: page 2',
      model: { question: 'scrap', mode: 'pick', reasons: defects, value: 'other' },
      note: 'Nine a page; the picked reason ("Other") opens page 2. Back and More reasons turn the page and the focus goes to the first tile. "Other" needs a photo (no typing on the floor): the camera opens after Confirm.',
    },
    {
      id: 'held',
      label: 'A reason not used here',
      model: { question: 'scrap', mode: 'pick', reasons: defects, value: null },
      note: '"Pinhole" is not checked at this station: in view, focusable, its reason on the tile and for a screen reader; a tap says it and picks nothing.',
    },
    {
      id: 'photos',
      label: 'Example photos: hide grade',
      model: { question: 'grade', mode: 'pick', reasons: grades, value: 'gradeB' },
      note: 'Tiles with an example photo instead of an icon (made-up drawings here). The word names the tile; the picture only helps.',
    },
    {
      id: 'symptom',
      label: 'Machine symptom',
      model: { question: 'symptom', mode: 'pick', reasons: symptoms, value: null },
      note: 'The same part for a machine\'s symptom (floor.machine, Plant › Machine requests "Report a problem"): then the photo or a note.',
    },
    {
      id: 'empty',
      label: 'No reasons for this station',
      model: { question: 'scrap', mode: 'pick', reasons: [], value: null },
      note: 'Nothing set up: the words say where the office sets it; Confirm is held with the same words.',
    },
  ],
})
