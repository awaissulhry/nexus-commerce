import { formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { HidePhoto } from './api'

/**
 * A hide's photos (B-W2b-131; MES-060; design warehouse.hides "Photos", pop-up hd-photo), pure: where a photo was taken in
 * words (a key of `warehouse-lots`), its caption, the newest first, the state a screen draws (still reading, read, none to
 * read without files.read, failed) and the Lightbox's model. A view draws these; the hook (use-hide-photos.ts) fills them.
 */

/** The photo kinds a hide takes from the office (the files platform's PHOTO kind: images only) and their largest size. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic'
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024

/** A photo with its image address once read (null: not read yet, or `broken`: it could not be read). */
export interface HidePhotoView extends HidePhoto {
  src: string | null
  broken: boolean
}

/** What the screen knows of the photos of a set of hides. */
export interface HidePhotosState {
  /** files.read over these hides: false → no photo is read and the screen says why; null: not asked yet. */
  canRead: boolean | null
  /** Each hide's photos, newest first (a hide asked and without photos: an empty list). */
  byHide: Readonly<Record<string, readonly HidePhotoView[]>>
  loading: boolean
  /** The read failed: a key of `stock` (problem.*). */
  problem: string | null
}

export const NO_PHOTOS: HidePhotosState = Object.freeze({ canRead: null, byHide: Object.freeze({}), loading: false, problem: null })

/** One hide's photos in the Lightbox (design hd-photo: the photo's place and time; ← / → between photos). */
export interface PhotoLightboxModel {
  hideId: string
  /** The hide's tag, for the title ("Hide HD-… · photo 2 of 3"). */
  hideCode: string
  photos: readonly HidePhotoView[]
  index: number
}

export interface PhotoLightboxActions {
  onIndex?: (index: number) => void
  onClose?: () => void
}

/** A photo being added from the office: its name and where it is (a key of `warehouse-lots` when it failed). */
export interface PhotoUpload {
  key: string
  name: string
  phase: 'sending' | 'failed'
  problem: string | null
}

/** One hide's photos on its record (Defects & photos): what was read, the Lightbox, the photos being added. */
export interface RecordPhotosModel {
  state: HidePhotosState
  lightbox: PhotoLightboxModel | null
  uploads: readonly PhotoUpload[]
}

export interface RecordPhotosActions extends PhotoLightboxActions {
  /** Opens the Lightbox on the hide's photo at `index` (newest first). */
  onOpen?: (index: number) => void
  onUpload?: (files: File[]) => void
  onDismissUpload?: (key: string) => void
  onRetry?: () => void
}

/** Where a photo was taken, in words (a key of `warehouse-lots`): the cutting table, the incoming inspection, else who added it. */
export function photoPlaceKey(photo: Pick<HidePhoto, 'place' | 'floor'>): string {
  if (photo.place === 'CUTTING_TABLE') return 'hd.photos.place.CUTTING_TABLE'
  if (photo.place === 'INSPECTION') return 'hd.photos.place.INSPECTION'
  return photo.floor ? 'hd.photos.place.floor' : 'hd.photos.place.office'
}

type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** "Cutting table · WO-D-0031 · 29/10/2026, 09:07": where, for which work order, when (the site's zone). */
export function photoCaption(photo: HidePhoto, t: Words, place: { locale: Locale; timeZone: string }): string {
  return [t(photoPlaceKey(photo)), photo.workOrder?.number ?? null, formatDateTime(photo.createdAt, place)].filter(Boolean).join(' · ')
}

/** Newest first (the route's order; kept when photos of several reads are joined). */
export function newestFirst<T extends Pick<HidePhoto, 'createdAt' | 'fileId'>>(photos: readonly T[]): T[] {
  return [...photos].sort((a, b) => (a.createdAt === b.createdAt ? (a.fileId < b.fileId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
}

/** The photo a grid's Thumbnail shows: the newest one, or null. */
export const latestPhoto = <T>(photos: readonly T[] | undefined): T | null => photos?.[0] ?? null

/** The photos a Lightbox can show: those whose image was read (it shows nothing for an address it does not have). */
export const shownPhotos = (photos: readonly HidePhotoView[]): HidePhotoView[] => photos.filter((photo) => photo.src !== null && !photo.broken)

/** A photo the person chose to add, checked before a byte leaves (a key of `warehouse-lots`), or null when it may go. */
export function photoFileProblem(file: { type: string; size: number }, maxBytes: number): string | null {
  if (!file.type.startsWith('image/')) return 'hd.photos.problem.notImage'
  if (file.size <= 0) return 'hd.photos.problem.empty'
  if (file.size > maxBytes) return 'hd.photos.problem.tooBig'
  return null
}
