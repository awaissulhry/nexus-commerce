import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { quickPlaceOf, saveHeldOf, usualPlaceOf, type Place } from './model'
import { PlaceScanCodeView, type PlaceScanCodeViewModel } from './view/PlaceScanCodeView'

/**
 * owb-ss4b step 4.4 — "Place the scan code" in the design index (`/design/SCR-owb-place-scan-code`): never placed (the usual place), a
 * saved place moved (Save the place), stopped at 20 mm (the line says why), a page across with two pages, a printed order (Print this
 * page again…), a reader who may not open the pages. The page is drawn blank (the index reads no file). Made-up data only.
 */

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const A4 = { src: BLANK, widthMm: 210, heightMm: 297, pages: 1 }
const ACROSS = { src: BLANK, widthMm: 297, heightMm: 210, pages: 2 }
const PIECES = [
  { salesOrderLineId: 'line-1', label: 'Race suit · DEMO-SUIT-01', fileId: 'file-1' },
  { salesOrderLineId: 'line-2', label: 'Gloves · DEMO-GLV-02', fileId: 'file-2' },
]
const SAVED = { salesOrderLineId: 'line-1', fileId: 'file-1', page: 1, xMm: 10, yMm: 10, sizeMm: 24, version: 2, placedAt: '2026-11-27T09:00:00.000Z', placedBy: { name: 'Dina Designer' } }
const model = (place: Place, over: Partial<PlaceScanCodeViewModel> = {}): PlaceScanCodeViewModel => {
  const base: PlaceScanCodeViewModel = { open: true, state: 'ready', readProblem: null, pieces: PIECES, pieceIndex: 0, page: 1, pageCount: 1, drawn: A4, drawFailed: false, place, saved: null, why: null, held: null, busy: false, savedNow: false, writeProblem: null, mayPrintAgain: false, ...over }
  return { ...base, held: saveHeldOf({ may: true, drawn: base.drawn !== null, place: base.place, saved: base.saved, busy: false }) }
}

export const designScreen = defineDesignScreen<PlaceScanCodeViewModel>({
  screen: 'SCR-owb-place-scan-code',
  title: 'Place the scan code — drag, pull the corner, mm, six quick places, never under 20 mm (owb-ss4b)',
  view: PlaceScanCodeView,
  cases: [
    { id: 'usual', label: 'Never placed: the usual place', model: model(usualPlaceOf(A4)), note: 'Top right, 20 mm, 10 mm in. Save the place keeps it.' },
    { id: 'moved', label: 'A saved place, moved', model: model(quickPlaceOf('BOTTOM_LEFT', 30, A4), { saved: SAVED }), note: 'Placed by Dina Designer; the act saves the new place.' },
    { id: 'stopped', label: 'Stopped at 20 mm', model: model({ xMm: 10, yMm: 10, sizeMm: 20 }, { saved: SAVED, why: { key: 'place.why.min', params: { min: 20 } } }) },
    { id: 'across', label: 'A page across, two pages', model: model(usualPlaceOf(ACROSS), { drawn: ACROSS, pageCount: 2, pieceIndex: 1 }) },
    { id: 'printed', label: 'A printed order: Print this page again…', model: model(usualPlaceOf(A4), { saved: { ...SAVED, ...usualPlaceOf(A4) }, mayPrintAgain: true, savedNow: true }) },
    { id: 'not-for-you', label: 'A reader who may not open the pages', model: { ...model(usualPlaceOf(A4)), state: 'failed', readProblem: 'place.notForYou' } },
  ],
})
