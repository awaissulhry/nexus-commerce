import { defineDesignScreen } from '../../lib/design/design-screen'
import type { MeasurePage } from './api'
import { EMPTY_FORM, type MeasureViewModel } from './model'
import { MeasureView } from './view/MeasureView'

/**
 * SCR-195 Send measurements — made-up data only (PLAN §3.1): an invented factory ("Officina Demo"), an invented rider and
 * order, invented numbers. One case per state a rider can meet: the notice before any field (not ticked, ticked, not
 * published), each step, its checks, a hint that never blocks, the guide pop-up, the photos (none, taken, on their way,
 * failed, the camera sheet), check and send, the draft kept with us (restored, saving, failed, finish later), the refusals
 * (a field, the server), sent, and the link's own states (loading, error, gone, used).
 */

const svg = (body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="#e9e6df"/>${body}</svg>`)}`
const PERSON = svg('<circle cx="150" cy="70" r="30" fill="#6b6b6b"/><rect x="105" y="105" width="90" height="140" rx="20" fill="#3d3d3d"/><rect x="115" y="240" width="28" height="140" fill="#3d3d3d"/><rect x="157" y="240" width="28" height="140" fill="#3d3d3d"/><text x="150" y="395" font-size="12" text-anchor="middle" fill="#555">foto demo</text>')
const SIDE = svg('<circle cx="150" cy="70" r="28" fill="#6b6b6b"/><rect x="128" y="105" width="44" height="140" rx="16" fill="#3d3d3d"/><rect x="134" y="240" width="30" height="140" fill="#3d3d3d"/><text x="150" y="395" font-size="12" text-anchor="middle" fill="#555">foto demo</text>')

const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const w = (it: string, en: string) => ({ it, en })

const PAGE: MeasurePage = {
  sender: { companyId: id(1), companyName: 'Officina Demo' },
  rider: { name: 'Marco Esempio' },
  garment: { code: 'SUIT', name: w('Tuta in pelle', 'Leather suit') },
  order: { number: 'SO-2026-0042' },
  notice: { id: id(2), label: '2026-10', publishedAt: '2026-10-01T08:00:00.000Z' },
  noticeRead: { noticeId: id(2), at: '2026-11-09T09:12:00.000Z' },
  photos: 'REQUIRED',
  points: [
    { code: 'chest', name: w('Torace', 'Chest'), seq: 1, zone: 'UPPER', required: true, minCm: '70.00', maxCm: '150.00', howTo: 'Intorno alla parte più ampia del torace.' },
    { code: 'waist', name: w('Vita', 'Waist'), seq: 2, zone: 'UPPER', required: true, minCm: '60.00', maxCm: '140.00', howTo: 'Intorno alla vita naturale.' },
    { code: 'shoulder_width', name: w('Spalle', 'Shoulders'), seq: 3, zone: 'UPPER', required: true, minCm: '35.00', maxCm: '60.00', howTo: null },
    { code: 'sleeve', name: w('Manica', 'Sleeve'), seq: 4, zone: 'ARMS', required: true, minCm: '50.00', maxCm: '80.00', howTo: 'Dalla punta della spalla al polso, braccio piegato in avanti.' },
    { code: 'wrist', name: w('Polso', 'Wrist'), seq: 5, zone: 'ARMS', required: false, minCm: '13.00', maxCm: '25.00', howTo: null },
    { code: 'hips', name: w('Fianchi', 'Hips'), seq: 6, zone: 'LEGS', required: true, minCm: '75.00', maxCm: '150.00', howTo: null },
    { code: 'inside_leg', name: w('Interno gamba', 'Inside leg'), seq: 7, zone: 'LEGS', required: true, minCm: '60.00', maxCm: '100.00', howTo: 'Dal cavallo alla caviglia, senza scarpe.' },
    { code: 'knee', name: w('Ginocchio', 'Knee'), seq: 8, zone: 'LEGS', required: false, minCm: '30.00', maxCm: '55.00', howTo: null },
    { code: 'riding_reach', name: w('Allungo in sella', 'Reach on the bike'), seq: 9, zone: 'RIDING', required: false, minCm: null, maxCm: null, howTo: 'In posizione di guida, dalla spalla al pugno.' },
  ],
  link: { expiresAt: '2026-11-30T22:59:00.000Z', usesLeft: 1, live: true },
  locale: 'it',
}
const NOT_READ: MeasurePage = { ...PAGE, noticeRead: null }

const FILLED = {
  units: 'cm' as const,
  basics: { height: '178', weight: '74', age: '34' },
  values: { chest: '101', waist: '85', shoulder_width: '46', sleeve: '64,5', wrist: '17', hips: '98', inside_leg: '82', knee: '39', riding_reach: '71' },
  fit: { fit: 'SNUG' as const, posture: 'Carenato, braccia lunghe.', asymmetry: '' },
  photos: { FRONT: id(10), SIDE: id(11), BACK: id(12) },
}
const TILES = { FRONT: { state: 'ready' as const, src: PERSON }, SIDE: { state: 'ready' as const, src: SIDE }, BACK: { state: 'ready' as const, src: PERSON } }

function model(overrides: Partial<MeasureViewModel> = {}): MeasureViewModel {
  return {
    link: 'valid',
    page: PAGE,
    problem: null,
    step: 'start',
    form: EMPTY_FORM,
    issues: {},
    notice: 'idle',
    tiles: {},
    photoFor: null,
    guideFor: null,
    pointAt: null,
    typedName: '',
    draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
    send: 'idle',
    done: null,
    timeZone: 'Europe/Rome',
    ...overrides,
  }
}

const saved = { status: { kind: 'saved' as const, at: '2026-11-09T09:42:00.000Z' }, restoredAt: null, later: false }

export const designScreen = defineDesignScreen<MeasureViewModel>({
  screen: 'SCR-195',
  title: 'Send measurements (a rider’s measurement link)',
  view: MeasureView,
  cases: [
    { id: 'start', label: 'Before you start · the notice not yet ticked', model: model({ page: NOT_READ }), note: 'Who asks and for which garment, what it takes, until when; the short notice (what, why, how long, who) and the full notice in a new tab; every field and Continue held until the tick.' },
    { id: 'start-check', label: 'Continue without the tick', model: model({ page: NOT_READ, issues: { notice: 'REQUIRED' } }), note: 'Says the tick comes first; the focus goes to it.' },
    { id: 'start-read', label: 'The notice read', model: model({ draft: saved }), note: 'The tick kept with its time (it cannot be taken back here); the steps open.' },
    { id: 'no-notice', label: 'Held: no privacy notice published', model: model({ page: { ...NOT_READ, notice: null } }), note: 'The sender has not published its notice: the form stays shut, said in words.' },
    { id: 'basics', label: 'About you', model: model({ step: 'basics', form: { ...EMPTY_FORM, basics: { height: '178', weight: '', age: '' } }, draft: saved }) },
    { id: 'basics-checks', label: 'About you · checked on leaving each field', model: model({ step: 'basics', form: { ...EMPTY_FORM, basics: { height: '17', weight: 'settanta', age: '' } }, issues: { 'body/basics/height': 'OUT_OF_LIMITS', 'body/basics/weight': 'NOT_A_NUMBER', 'body/basics/age': 'REQUIRED' } }) },
    { id: 'inches', label: 'About you · inches and pounds', model: model({ step: 'basics', form: { ...EMPTY_FORM, units: 'in', basics: { height: '70', weight: '163', age: '34' } }, draft: saved }) },
    { id: 'points', label: 'Measurements · by body zone', model: model({ step: 'points', form: { ...FILLED, values: { chest: '101', waist: '85' }, photos: {} }, pointAt: 2, draft: saved }), note: 'Upper body · Arms · Legs · Riding position; a picture of where the tape goes per point; "Point 3 of 9"; Enter → next point, Shift+Enter → previous.' },
    { id: 'points-hint', label: 'Measurements · a hint that never blocks', model: model({ step: 'points', form: { ...FILLED, basics: { height: '172', weight: '74', age: '34' }, values: { ...FILLED.values, chest: '140', sleeve: '45' }, photos: {} }, draft: saved }), note: '"Chest 140 cm is unusual for a height of 172 cm: check it. You can still send it."' },
    { id: 'points-checks', label: 'Measurements · a required point missing', model: model({ step: 'points', form: { ...FILLED, values: { chest: '101' }, photos: {} }, issues: { 'body/values/waist': 'REQUIRED', 'body/values/sleeve': 'REQUIRED' } }) },
    { id: 'guide', label: 'How to measure (pop-up)', model: model({ step: 'points', form: { ...FILLED, photos: {} }, guideFor: 'inside_leg' }), note: 'The picture large and the steps in words; Esc closes and gives the focus back.' },
    { id: 'fit', label: 'How you like it', model: model({ step: 'fit', form: { ...FILLED, photos: {} }, draft: saved }) },
    { id: 'photos', label: 'Photos · none yet (needed)', model: model({ step: 'photos', form: { ...FILLED, photos: {} }, draft: saved }) },
    { id: 'photos-taken', label: 'Photos · taken', model: model({ step: 'photos', form: FILLED, tiles: TILES, draft: saved }) },
    { id: 'photos-sending', label: 'Photos · one on its way, one failed', model: model({ step: 'photos', form: { ...FILLED, photos: { FRONT: id(10) } }, tiles: { FRONT: TILES.FRONT, SIDE: { state: 'uploading', src: SIDE }, BACK: { state: 'failed', src: PERSON } } }), note: 'Take it again held while sending; Try again for the failed one.' },
    { id: 'photos-read-failed', label: 'Photos · one kept with us but not shown now', model: model({ step: 'photos', form: FILLED, tiles: { FRONT: TILES.FRONT, SIDE: TILES.SIDE, BACK: { state: 'failed', src: null } } }), note: 'A resumed draft whose photo the store could not show: it is kept; Try again reads it again.' },
    { id: 'photos-optional', label: 'Photos · optional', model: model({ step: 'photos', page: { ...PAGE, photos: 'OPTIONAL' }, form: { ...FILLED, photos: {} } }) },
    { id: 'photo-dialog', label: 'Take the photo (camera sheet)', model: model({ step: 'photos', form: { ...FILLED, photos: {} }, photoFor: 'FRONT' }), note: 'The DS PhotoCapture with the silhouette guide; faces kept out; a file from the device works too.' },
    { id: 'review', label: 'Check and send', model: model({ step: 'review', form: FILLED, tiles: TILES, typedName: 'Marco Esempio', draft: saved }) },
    { id: 'review-hints', label: 'Check and send · values to check again', model: model({ step: 'review', form: { ...FILLED, basics: { height: '172', weight: '74', age: '34' }, values: { ...FILLED.values, chest: '140' } }, tiles: TILES }) },
    { id: 'sending', label: 'Sending', model: model({ step: 'review', form: FILLED, tiles: TILES, send: 'busy' }) },
    { id: 'refused-fields', label: 'Refused: something to fix', model: model({ step: 'photos', form: { ...FILLED, photos: { FRONT: id(10), SIDE: id(11) } }, tiles: { FRONT: TILES.FRONT, SIDE: TILES.SIDE }, problem: 'problem.fix', issues: { 'body/photos/BACK': 'PHOTO_REQUIRED' } }), note: 'The send took the rider to the first step to fix; each field says what.' },
    { id: 'refused-server', label: 'Refused: the server did not answer', model: model({ step: 'review', form: FILLED, tiles: TILES, problem: 'problem.unavailable' }), note: 'Try again with the same key: nothing is sent twice.' },
    { id: 'notice-changed', label: 'Refused: the notice changed', model: model({ page: NOT_READ, problem: 'problem.noticeChanged' }) },
    { id: 'draft-restored', label: 'Draft restored', model: model({ step: 'points', form: { ...FILLED, photos: {} }, draft: { status: { kind: 'saved', at: '2026-11-08T18:05:00.000Z' }, restoredAt: '2026-11-08T18:05:00.000Z', later: false } }) },
    { id: 'draft-saving', label: 'Draft saving', model: model({ step: 'fit', form: { ...FILLED, photos: {} }, draft: { status: { kind: 'saving' }, restoredAt: null, later: false } }) },
    { id: 'draft-failed', label: 'Draft not saved', model: model({ step: 'fit', form: { ...FILLED, photos: {} }, draft: { status: { kind: 'failed' }, restoredAt: null, later: false } }) },
    { id: 'finish-later', label: 'Finish later', model: model({ step: 'points', form: { ...FILLED, photos: {} }, draft: { ...saved, later: true } }), note: 'Kept with us until the link’s day; nothing on the device.' },
    { id: 'done', label: 'Sent', model: model({ step: 'review', form: FILLED, typedName: 'Marco Esempio', done: { profileId: id(20), revision: 3, at: '2026-11-09T09:58:00.000Z', photos: 3 } }), note: 'Thank you; the fitter checks them; how long the photos are kept; the link is used.' },
    { id: 'done-no-photos', label: 'Sent without photos', model: model({ page: { ...PAGE, photos: 'OPTIONAL' }, step: 'review', form: { ...FILLED, photos: {} }, done: { profileId: id(20), revision: 2, at: '2026-11-09T09:58:00.000Z', photos: 0 } }) },
    { id: 'loading', label: 'Loading the form', model: model({ page: null }), note: 'Skeleton in the shape of the form; "Still loading…" after about a second.' },
    { id: 'error', label: 'Error reading the form', model: model({ page: null, problem: 'problem.read' }), note: 'Our words and Try again; never an empty form.' },
    { id: 'gone', label: 'The link no longer opens', model: model({ link: 'unavailable', page: null }) },
    { id: 'used', label: 'The link was used', model: model({ link: 'used', page: null }) },
  ],
})
