import { defineDesignScreen } from '../design/design-screen'
import { openPictureState, pickPicture, refusedWith, saveStarted, type OrderPictureState, type PictureChoice } from './order-picture'
import { RecordPictureLab, type RecordPictureLabModel } from './view/RecordPictureLab'

/**
 * owb-b4 w4.3 — the picture parts on the design index (`/design/record-picture-parts`): every size (the change log's line and the
 * message among them, the floor's basket from its host's address) and the window "The picture of the order" — the design now,
 * a file chosen, Save held while nothing changed, a stale version, a save out, no file yet, an upload refused. Made-up data only.
 */

/** A made-up garment picture (a plain drawing, no real product). */
const DEMO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320"><rect width="240" height="320" fill="#eef2f6"/><path d="M80 40h80l40 40-24 24-16-16v200H80V88l-16 16-24-24z" fill="#b91c1c"/><path d="M104 40h32v260h-32z" fill="#111827"/></svg>')}`

const FILES: readonly PictureChoice[] = [
  { fileId: 'f-mock', name: 'mockup-race-suit.pdf', kind: 'mockup', small: { url: DEMO, expiresAt: '2099-01-01T00:00:00.000Z' } },
  { fileId: 'f-photo', name: 'sample-photo.jpg', kind: 'image', small: { url: DEMO, expiresAt: '2099-01-01T00:00:00.000Z' } },
  { fileId: 'f-pdf', name: 'logo-placement.pdf', kind: 'pdf', small: null },
]

const atDesign: OrderPictureState = openPictureState({ fileId: null, version: 3 }, FILES)
const windowCase = (state: OrderPictureState, canUpload = true): RecordPictureLabModel => ({ show: 'window', state, canUpload, demo: DEMO })

export const designScreen = defineDesignScreen<RecordPictureLabModel>({
  screen: 'record-picture-parts',
  title: 'Picture parts — sizes and the window “The picture of the order” (owb-)',
  view: RecordPictureLab,
  cases: [
    { id: 'sizes', label: 'Every size: cell, log line, message, line, phone, large line, board; the floor’s basket', model: { show: 'sizes', demo: DEMO }, note: 'The log line is 30 px and the message 40 px; the basket is drawn from the address its host’s read gave (a site-stamped file).' },
    { id: 'window-design', label: 'The window: the design now, nothing chosen — Save says why it waits', model: windowCase(atDesign), note: '“A picture from your computer or phone” first, then the choices. Save is held: “This is the picture now. Choose another one first.”' },
    { id: 'window-chosen', label: 'The window: a file chosen, Save ready', model: windowCase(pickPicture(atDesign, 'f-photo')) },
    { id: 'window-file-now', label: 'The window: a file is the picture now; “Use the design” goes back', model: windowCase(pickPicture(openPictureState({ fileId: 'f-mock', version: 4 }, FILES), 'design')) },
    { id: 'window-saving', label: 'The window: saving — Save and Cancel wait and say why', model: windowCase(saveStarted(pickPicture(atDesign, 'f-photo'))) },
    { id: 'window-stale', label: 'The window: someone changed the picture meanwhile (409)', model: windowCase(refusedWith(pickPicture(atDesign, 'f-photo'), 'STALE')), note: 'Save stays held: close the window and open it again.' },
    { id: 'window-not-allowed', label: 'The window: not an allowed file (422)', model: windowCase(refusedWith(pickPicture(atDesign, 'f-pdf'), 'NOT_ALLOWED')) },
    { id: 'window-empty', label: 'The window: no file yet, no upload (the host gave no upload port)', model: windowCase(openPictureState({ fileId: null, version: 1 }, []), false) },
    { id: 'window-open', label: 'The window opened for real (a centred dialog; a sheet on a phone)', model: { show: 'window-open', state: pickPicture(atDesign, 'f-photo'), canUpload: true, demo: DEMO } },
  ],
})
