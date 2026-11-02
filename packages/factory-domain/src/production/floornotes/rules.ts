/**
 * A comment or a photo from the floor (B-W2b-47; MES-101, COL-017; design floor.operation "Photo or comment": "Photo or a
 * 15-second clip, mark the spot, a comment from short tiles; posted to the work order's thread. 'Keep faces out of the
 * picture' with an outline guide (GDPR minimisation)"). Pure rules; apps/factory-api modules/production/floornotes applies
 * them. The note is an internal message of the work order's thread, so the office reads it where it reads the rest.
 *
 * Marking the spot happens on the tablet: the arrows and circles are drawn into the picture before its upload, so what
 * is stored is what was seen. A clip's length is the tablet's word (the API does not open a video); its size is held to
 * the PHOTO kind's limit. Nothing here looks for faces: finding a face in a picture of a worker is the very processing the
 * rule keeps out (GDPR arts. 5(1)(c), 9). The guard is the reminder at the moment of the picture; a picture that shows a
 * face is deleted by the office (files.delete).
 */

export const FLOOR_NOTE_TILE_CODES = ['MATERIAL_DIFFERS', 'MEASURE_DIFFERS', 'COLOUR_DIFFERS', 'STITCHING_DIFFERS', 'DAMAGED', 'PART_MISSING', 'OTHER'] as const
export type FloorNoteTileCode = (typeof FLOOR_NOTE_TILE_CODES)[number]

export interface FloorNoteTile {
  readonly code: FloorNoteTileCode
  readonly label: { readonly it: string; readonly en: string }
  /** "Other" says what in a few words, or shows it in a picture. */
  readonly needsDetail: boolean
}

/** The short tiles of what differs from the plan, fixed for now: the reason lists have no list for them. */
export const FLOOR_NOTE_TILES: readonly FloorNoteTile[] = Object.freeze([
  { code: 'MATERIAL_DIFFERS', label: { it: 'Materiale diverso', en: 'Material differs' }, needsDetail: false },
  { code: 'MEASURE_DIFFERS', label: { it: 'Misura diversa', en: 'Measurement differs' }, needsDetail: false },
  { code: 'COLOUR_DIFFERS', label: { it: 'Colore diverso', en: 'Colour differs' }, needsDetail: false },
  { code: 'STITCHING_DIFFERS', label: { it: 'Cucitura diversa', en: 'Stitching differs' }, needsDetail: false },
  { code: 'DAMAGED', label: { it: 'Danneggiato', en: 'Damaged' }, needsDetail: false },
  { code: 'PART_MISSING', label: { it: 'Manca un pezzo', en: 'A part is missing' }, needsDetail: false },
  { code: 'OTHER', label: { it: 'Altro', en: 'Other' }, needsDetail: true },
])

/** The reminder at the moment of the picture (design: "Keep faces out of the picture"; PLAN: photos never show faces). */
export const NO_FACES_REMINDER = Object.freeze({ code: 'NO_FACES', it: "Tieni i volti fuori dall'inquadratura.", en: 'Keep faces out of the picture.' })

export const FLOOR_NOTE_LIMITS = Object.freeze({ noteMax: 500, filesPerNote: 4, clipSeconds: 15 })

/** A clip, by its content type (platform/files keeps which types are taken). */
export const isClip = (contentType: string): boolean => contentType.trim().toLowerCase().startsWith('video/')

/** The note's text on the thread: what differs, where, and the worker's words. */
export function noteText(input: { readonly tileCode: FloorNoteTileCode; readonly note: string | null; readonly bundleCode: string | null; readonly operation: { readonly seq: number; readonly name: string } | null }): string {
  const tile = FLOOR_NOTE_TILES.find((entry) => entry.code === input.tileCode)!
  const place = [input.bundleCode, input.operation ? `Op ${input.operation.seq} ${input.operation.name}` : null].filter((part) => part !== null).join(' at ')
  return `${tile.label.en}${place ? ` (${place})` : ''}${input.note ? `: ${input.note}` : ''}`
}

/** Why the note cannot be posted as it is, in words (null: it can). */
export function noteProblem(input: { readonly tileCode: FloorNoteTileCode; readonly note: string | null; readonly files: number }): string | null {
  const tile = FLOOR_NOTE_TILES.find((entry) => entry.code === input.tileCode)!
  return tile.needsDetail && !input.note && input.files === 0 ? 'With "Other" say what differs in a few words, or add a photo.' : null
}
