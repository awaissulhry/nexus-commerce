import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { COLOURWAY_IDS, demoStyle, recordModel, REV, STYLE_ID } from '../../demo/fixtures'
import { demoPicture } from '../../gallery/fixtures'
import type { StyleRecordViewModel } from '../record-model'
import { StyleRecordView } from '../view/StyleRecordView'
import type { PictureView, StylePicturesView } from './api'
import { NO_GALLERY, type GalleryModel } from './gallery-model'

/**
 * SCR-304 (new id, B-W2b-236) — Style › Overview & variants › Sketches and pictures of DEMO-JKT-01 (design products.styles
 * rec:Style style.ov.gallery; PRD-016): flats, photos per colourway and image pages with numbered callouts, the main picture
 * marked, made-up data only (the pictures are plain shapes drawn here). Cases: the product office with every kind, the
 * lightbox, the callouts editor, Add pictures (sending), details, remove the main picture, a released revision's frozen
 * page, sales reading, the edit rule holding, archived, offline, empty, loading, a failed read.
 */

const uid = (n: number) => `0190f0e2-3040-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()
const LOOK = (url: string) => ({ url })
const REVISION3 = { id: REV.r3, revision: 3, status: 'DRAFT' as const }
const REVISION2 = { id: REV.r2, revision: 2, status: 'RELEASED' as const }
const CW = {
  black: { id: COLOURWAY_IDS.BLK, code: 'NERO', name: 'Nero' },
  grey: { id: COLOURWAY_IDS.ANT, code: 'ANTR', name: 'Antracite' },
  red: { id: COLOURWAY_IDS.RED, code: 'ROSSO', name: 'Rosso corsa' },
}

function picture(n: number, kind: PictureView['kind'], caption: string | null, picture: string, extra: Partial<PictureView> = {}): PictureView {
  return {
    id: uid(n),
    version: 2,
    kind,
    seq: n - 1,
    isMain: false,
    caption,
    callouts: [],
    revision: null,
    colourway: null,
    file: { id: uid(100 + n), name: `${(caption ?? 'foto').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, contentType: 'image/png', sizeBytes: 820_000, status: 'AVAILABLE' },
    look: LOOK(picture),
    printable: true,
    frozen: null,
    createdAt: at(2 + n, 10),
    updatedAt: at(5 + n, 15),
    ...extra,
  }
}

const PICTURES: PictureView[] = [
  picture(1, 'SKETCH', 'Davanti', demoPicture('#e9e9e9', 'jacket', 'davanti'), { isMain: true }),
  picture(2, 'SKETCH', 'Dietro', demoPicture('#e9e9e9', 'jacket', 'dietro')),
  picture(3, 'PHOTO', 'Nero, davanti', demoPicture('#1F1F1F'), { colourway: CW.black }),
  picture(4, 'PHOTO', null, demoPicture('#B3122E'), { colourway: CW.red, file: { id: uid(104), name: 'rosso-campionario.webp', contentType: 'image/webp', sizeBytes: 1_250_000, status: 'AVAILABLE' }, printable: false }),
  picture(5, 'PAGE', 'Collo e polsi', demoPicture('#4A4D52', 'page'), {
    revision: REVISION3,
    callouts: [
      { n: 1, x: '0.5', y: '0.24', text: 'Collo coreano con chiusura a strappo, 30 mm' },
      { n: 2, x: '0.33', y: '0.58', text: 'Doppia impuntura, 4 mm' },
      { n: 3, x: '0.68', y: '0.72', text: 'Polsino regolabile con zip YKK n. 5' },
    ],
  }),
  picture(6, 'PAGE', 'Tasca interna (rev. 2)', demoPicture('#4A4D52', 'page'), { revision: REVISION2, frozen: 'frozen', callouts: [{ n: 1, x: '0.45', y: '0.5', text: 'Tasca impermeabile termosaldata' }] }),
]

function view(extra: Partial<StylePicturesView> = {}): StylePicturesView {
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE' },
    pictures: PICTURES,
    unused: [
      { fileId: uid(201), name: 'antracite-dettaglio-spalla.jpg', contentType: 'image/jpeg', sizeBytes: 640_000, createdAt: at(8, 11) },
      { fileId: uid(202), name: 'campione-cliente.png', contentType: 'image/png', sizeBytes: 300_000, createdAt: at(7, 16) },
    ],
    revisions: [REVISION3, REVISION2, { id: REV.r1, revision: 1, status: 'OBSOLETE' }],
    colourways: [
      { ...CW.black, status: 'ACTIVE' },
      { ...CW.grey, status: 'ACTIVE' },
      { ...CW.red, status: 'ACTIVE' },
    ],
    refusal: null,
    limits: { pictures: 60, callouts: 60, caption: 200, calloutText: 500, types: ['image/jpeg', 'image/png', 'image/webp'] },
    at: at(10, 9),
    ...extra,
  }
}

const ready = (value: StylePicturesView = view(), extra: Partial<GalleryModel> = {}): GalleryModel => ({ ...NO_GALLERY, canManage: true, canArrange: true, part: { status: 'ready', value }, ...extra })
const overview = (gallery: GalleryModel, role: 'owner' | 'production' | 'sales' | 'product' = 'owner', extra: Partial<StyleRecordViewModel> = {}): StyleRecordViewModel => recordModel(role, { tab: 'overview', gallery, ...extra })

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-304',
  title: 'Style studio: Overview › Sketches and pictures',
  view: StyleRecordView,
  cases: [
    { id: 'owner', label: 'Sketches, photos per colourway, image pages with callouts', model: overview(ready()), note: 'The front flat is the main picture (the list, the gallery and the public DoC page show it). The red WebP photo is not in the tech pack PDF (JPEG or PNG ≤ 4 MB). Revision 2’s page is frozen.' },
    { id: 'viewer', label: 'A picture full size with its numbered callouts', model: overview(ready(view(), { dialog: { kind: 'view', pictureId: uid(5) } })) },
    { id: 'viewer-frozen', label: 'A released revision’s page full size', model: overview(ready(view(), { dialog: { kind: 'view', pictureId: uid(6) } })) },
    { id: 'callouts', label: 'Callouts editor: click to place, type the text', model: overview(ready(view(), { dialog: { kind: 'callouts', pictureId: uid(5) } })) },
    { id: 'add', label: 'Add pictures: kind, colourway, revision; the style’s picture files', model: overview(ready(view(), { dialog: { kind: 'add' } })) },
    { id: 'add-sending', label: 'Add pictures: sending 2 of 3', model: overview(ready(view(), { dialog: { kind: 'add' }, upload: { state: 'sending', done: 2, of: 3, problem: null } })) },
    { id: 'add-failed', label: 'Add pictures: one was refused', model: overview(ready(view(), { dialog: { kind: 'add' }, upload: { state: 'failed', done: 1, of: 3, problem: 'gallery.add.failed' } })) },
    { id: 'edit', label: 'Picture details', model: overview(ready(view(), { dialog: { kind: 'edit', pictureId: uid(3) } })) },
    { id: 'remove-main', label: 'Remove the main picture: the next one takes the mark', model: overview(ready(view(), { dialog: { kind: 'remove', pictureId: uid(1) } })) },
    { id: 'notice', label: 'The main picture changed', model: overview(ready(view(), { notice: { key: 'gallery.notice.main', tone: 'success' } })) },
    { id: 'refused', label: 'A change refused (someone changed it meanwhile)', model: overview(ready(view(), { notice: { key: 'gallery.problem.moved', tone: 'danger' } })) },
    { id: 'sales', label: 'Sales reads (changes held with the reason)', model: overview(ready(view(), { canManage: false, canArrange: false }), 'sales') },
    { id: 'no-upload', label: 'May arrange, may not send files', model: overview(ready(view(), { canManage: false, canArrange: true })) },
    { id: 'rule', label: 'The style’s edit rule holds changes', model: overview(ready(view({ refusal: 'Style DEMO-JKT-01 is discontinued: nothing of it changes in this state.' }))) },
    { id: 'archived', label: 'Archived style', model: overview(ready(view({ style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ARCHIVED' } })), 'owner', { style: { status: 'ready', value: demoStyle({ status: 'ARCHIVED' }) } }) },
    { id: 'offline', label: 'Offline: changes wait for the connection', model: overview(ready(view(), { offline: true })) },
    { id: 'not-available', label: 'A picture still waiting for its check', model: overview(ready(view({ pictures: [PICTURES[0]!, { ...PICTURES[2]!, look: null, file: { ...PICTURES[2]!.file, status: 'QUARANTINED' }, printable: false }] }))) },
    { id: 'empty', label: 'No pictures', model: overview(ready(view({ pictures: [], unused: [] }))) },
    { id: 'loading', label: 'Loading', model: overview({ ...NO_GALLERY, part: { status: 'loading' } }) },
    { id: 'error', label: 'The pictures could not be read', model: overview({ ...NO_GALLERY, part: { status: 'error', problem: 'gallery.problem.read' } }) },
  ],
})
