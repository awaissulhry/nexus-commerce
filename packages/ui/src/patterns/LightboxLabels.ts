import { MODAL_LABELS, type ModalLabels } from '../components/ModalLabels'

/**
 * `Lightbox`'s words (B-W2b-F41): the title and counter, the Previous / Next buttons and why they are held, the strip,
 * the keys line and the dialog's close button. English by default; `place` is 1-based.
 */
export interface LightboxLabels {
  /** The dialog's title when the page passes none: "Photo 2 of 4". */
  title: (place: number, total: number) => string
  /** The counter under the photo: "2 of 4". */
  counter: (place: number, total: number) => string
  /** "Previous photo" */
  previous: string
  /** "Next photo" */
  next: string
  /** Why Previous and Next are held with one photo. */
  only: string
  /** Why Previous is held on the first photo. */
  first: string
  /** Why Next is held on the last photo. */
  last: string
  /** The strip of thumbnails' name: "Photos". */
  photos: string
  /** A thumbnail's name: "Photo 2 of 4", "Photo 2 of 4, shown now". */
  thumb: (place: number, total: number, current: boolean) => string
  /** The keys line: "← → move · Esc close". */
  move: string
  close: string
  /** The dialog's own words (its close button). */
  modal: ModalLabels
}

export const LIGHTBOX_LABELS: LightboxLabels = {
  title: (place, total) => `Photo ${place} of ${total}`,
  counter: (place, total) => `${place} of ${total}`,
  previous: 'Previous photo',
  next: 'Next photo',
  only: 'This is the only photo.',
  first: 'This is the first photo.',
  last: 'This is the last photo.',
  photos: 'Photos',
  thumb: (place, total, current) => `Photo ${place} of ${total}${current ? ', shown now' : ''}`,
  move: 'move',
  close: 'close',
  modal: MODAL_LABELS,
}
