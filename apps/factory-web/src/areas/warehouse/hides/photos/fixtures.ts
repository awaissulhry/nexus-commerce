import { at, uid, WORK_ORDERS } from '../../../_shared/stock/fixtures'
import type { HidePhotoView, HidePhotosState, PhotoLightboxModel, PhotoUpload, RecordPhotosModel } from './model'

/**
 * Made-up photos of a hide for the design cases (B-W2b-131; the record's Photos, the grid's Photo column, the hd-photo
 * Lightbox): drawn images (an SVG of a hide's outline with a word on it, no real photo), one taken at the cutting table for
 * an invented work order, one at an incoming inspection, one added in the office. Nothing here is a real file, person or
 * number. Design-only.
 */

/** A made-up image: a hide's outline in leather tones with a caption (an inline SVG; no pixels of a real hide). */
export function drawnHide(caption: string, tone = '#8a5a3b'): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">` +
    `<rect width="640" height="480" fill="#efe6dc"/>` +
    `<path d="M120 90 C200 40 440 40 520 90 C590 160 600 320 520 390 C440 450 200 450 120 390 C40 320 50 160 120 90 Z" fill="${tone}"/>` +
    `<circle cx="250" cy="200" r="14" fill="#3b2416" opacity="0.6"/><path d="M360 300 l60 20" stroke="#3b2416" stroke-width="6" opacity="0.5"/>` +
    `<text x="320" y="455" font-family="sans-serif" font-size="26" text-anchor="middle" fill="#3b2416">${caption}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const photo = (n: number, over: Partial<HidePhotoView>): HidePhotoView => ({
  fileId: uid('6363', n),
  originalName: `pelle-${n}.jpg`,
  contentType: 'image/jpeg',
  createdAt: at(29, 9, n * 5),
  place: null,
  floor: false,
  workOrder: null,
  src: drawnHide(`Foto ${n}`),
  broken: false,
  ...over,
})

/** Three photos of one hide, newest first: the cutting table (WO-D-0031), the incoming inspection, the office. */
export const HIDE_PHOTOS: HidePhotoView[] = [
  photo(3, { createdAt: at(29, 10, 12), place: 'CUTTING_TABLE', floor: true, workOrder: { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number }, src: drawnHide('Tavolo di taglio', '#7a4a2e') }),
  photo(2, { createdAt: at(28, 11, 40), place: 'INSPECTION', floor: true, src: drawnHide('Controllo in arrivo', '#93613f') }),
  photo(1, { createdAt: at(28, 9, 5), src: drawnHide('Ufficio', '#a0704c') }),
]

export const photosOf = (hideId: string, photos: readonly HidePhotoView[] = HIDE_PHOTOS, over: Partial<HidePhotosState> = {}): HidePhotosState => ({
  canRead: true,
  byHide: { [hideId]: photos },
  loading: false,
  problem: null,
  ...over,
})

export function recordPhotos(hideId: string, over: Partial<RecordPhotosModel> = {}, photos: readonly HidePhotoView[] = HIDE_PHOTOS): RecordPhotosModel {
  return { state: photosOf(hideId, photos), lightbox: null, uploads: [], ...over }
}

export const lightboxOn = (hideId: string, hideCode: string, index = 1, photos: readonly HidePhotoView[] = HIDE_PHOTOS): PhotoLightboxModel => ({ hideId, hideCode, photos, index })

export const UPLOADING: PhotoUpload[] = [
  { key: 'u1', name: 'fiore-macchia.jpg', phase: 'sending', problem: null },
  { key: 'u2', name: 'scansione.pdf', phase: 'failed', problem: 'hd.photos.problem.notImage' },
]
