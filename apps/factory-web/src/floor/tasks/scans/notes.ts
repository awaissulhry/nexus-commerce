import { FLOOR_NOTE_LIMITS, FLOOR_NOTE_TILES, noteProblem, type FloorNoteTileCode } from '@nexus/factory-domain/production/floornotes/rules'

/**
 * Photo or comment on SCR-090 (design floor.operation "Photo or comment"; MES-101, COL-017): what differs from the plan, from
 * short tiles, a photo with the spot marked or a 15-second clip, and a few words; posted to the work order's thread. A picture
 * goes up first (announce, PUT, confirm), then the note names it: the note queues, a picture cannot (the queue keeps no bytes),
 * so offline the comment is saved on the tablet and the camera is held with the reason. The tiles are the API's fixed list, here
 * from the same rules, so they stand offline too. Pure. Nothing looks for faces: the reminder at the moment of the picture is
 * the guard, and the office deletes a picture that shows one.
 */

export { FLOOR_NOTE_LIMITS, FLOOR_NOTE_TILES }
export type { FloorNoteTileCode }

export type NoteCapture = 'photo' | 'clip'

export interface NoteFile {
  readonly id: string
  readonly kind: NoteCapture
  /** What the tablet shows until it is sent. */
  readonly name: string
}

export interface NoteDraft {
  readonly tile: FloorNoteTileCode | null
  readonly words: string
  readonly files: readonly NoteFile[]
  readonly capture: NoteCapture | null
  readonly busy: boolean
  /** The picture did not go up: try again. */
  readonly failed: boolean
}

export const NEW_NOTE: NoteDraft = Object.freeze({ tile: null, words: '', files: Object.freeze([]) as readonly NoteFile[], capture: null, busy: false, failed: false })

/** Why the note cannot be posted yet, or null. */
export function noteHeld(draft: NoteDraft): 'tile' | 'detail' | 'busy' | null {
  if (draft.busy) return 'busy'
  if (!draft.tile) return 'tile'
  return noteProblem({ tileCode: draft.tile, note: draft.words.trim() || null, files: draft.files.length }) ? 'detail' : null
}

export const moreFiles = (draft: Pick<NoteDraft, 'files'>): boolean => draft.files.length < FLOOR_NOTE_LIMITS.filesPerNote

/** The queued note's body (floor-sync `production.floorNote.post`). */
export function notePayload(draft: NoteDraft, target: { readonly workOrderId: string; readonly bundleId: string; readonly workOrderOperationId: string }): Record<string, unknown> {
  const words = draft.words.trim()
  return {
    workOrderId: target.workOrderId,
    tileCode: draft.tile,
    ...(words ? { note: words } : {}),
    ...(draft.files.length > 0 ? { fileIds: draft.files.map((file) => file.id) } : {}),
    bundleId: target.bundleId,
    workOrderOperationId: target.workOrderOperationId,
  }
}
