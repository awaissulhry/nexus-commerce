import type { HelpRead } from '../help/api'

/**
 * owb-fl8 step 3 — the Photo button of every basket (design § 5zf B "Photo: one button on every basket. The photo goes to the
 * office"; § 5zf D: the office reads it under "From the floor" and only sales shares it). Today's floor photo note
 * (A/production/floornotes): the picture goes up first (announce, PUT, confirm: online), then the note names it (the queue kind
 * `production.floorNote.post`). The queue keeps no bytes, so with no network the window says "Needs the network". Pure.
 */

export const PHOTO_NOTE_KIND = 'production.floorNote.post'

/** "Other" with a photo: the photo says what (floornotes rules: Other needs words or a photo). */
export const PHOTO_TILE_CODE = 'OTHER'

/** Why the photo cannot go now: no network (the window says it in words), else null. */
export const photoHeld = (online: boolean): 'offline' | null => (online ? null : 'offline')

/** The queued note that names the photo: this basket, its work order. */
export function photoNotePayload(read: Pick<HelpRead, 'basket'>, fileId: string): Record<string, unknown> {
  return { workOrderId: read.basket.workOrderId, tileCode: PHOTO_TILE_CODE, fileIds: [fileId], bundleId: read.basket.id }
}
