/**
 * owb-b4 w4.3 (design § 5zi E "The picture of an order", § 5zj A "ONE window, and the picture itself is the door to it"; owb-b23
 * "Shapes": POST …/picture `{ fileId, version }`) — the window "The picture of the order", its pure side: what the window holds, what
 * each choice says, why Save waits, and a refusal in words. The window's choices: "Use the design" (back to the default: the design of
 * the first line) and the order's files that may be its picture — an image or a PDF (its first page) the customer can open, never a
 * file for the office only, a priced file or a size sheet (the host's walled read lists only those; the server refuses any other with
 * a 422). Choose, then Save; the save sends the record's version back (a 409 when someone changed it meanwhile).
 *
 * Who may open it is the host's: the customer decides, sales or the owner set it for the customer; the designer and the floor never
 * (design § 5zj A). Owner after the base: S1 (PL-split § 3); S2 mounts it. Pure: no React, no API.
 */

/** A word of the record-picture catalogue (`window.*`). */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** What a file is, in its words: an image, a PDF (its first page), a mockup (front and back). */
export type PictureFileKind = 'image' | 'pdf' | 'mockup'

/** One file of the order that may be its picture (the host's walled read). */
export interface PictureChoice {
  readonly fileId: string
  readonly name: string
  readonly kind: PictureFileKind
  /** Its small preview's address (the read's own, about 60 s); null: none (a PDF's first page not drawn yet: its mark). */
  readonly small: { readonly url: string; readonly expiresAt: string } | null
}

/** Why a save or an upload was refused. */
export type PictureRefusal = 'STALE' | 'GONE' | 'NOT_ALLOWED' | 'UPLOAD_FAILED' | 'FAILED'

/** The window's state. `picked` null = "Use the design". */
export interface OrderPictureState {
  /** The saved picture (null: the design) and the record's version the window opened with. */
  readonly now: { readonly fileId: string | null; readonly version: number }
  readonly choices: readonly PictureChoice[]
  readonly picked: string | null
  readonly busy: 'idle' | 'saving' | 'uploading'
  readonly refused: PictureRefusal | null
}

/** The value of the "Use the design" choice (a file id is never this word). */
export const DESIGN_CHOICE = 'design'

/** The files a picture may be (the upload field's `accept`): PNG, JPG, WebP, PDF. */
export const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf'

/** A file the upload may take: its type, else its name's ending (a browser that names no type). */
export function isPictureFile(file: { readonly type: string; readonly name: string }): boolean {
  if (file.type) return PICTURE_ACCEPT.split(',').includes(file.type)
  return /\.(png|jpe?g|webp|pdf)$/i.test(file.name)
}

/** What a picked file is, by its type or name. */
export const pictureKindOf = (file: { readonly type: string; readonly name: string }): PictureFileKind => (file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'pdf' : 'image')

/** The window as it opens: the saved picture picked, nothing busy, nothing refused. */
export function openPictureState(now: OrderPictureState['now'], choices: readonly PictureChoice[]): OrderPictureState {
  return { now, choices, picked: now.fileId, busy: 'idle', refused: null }
}

// ---- moves (each a pure step; the container holds the state) ---------------------------------------------------------------------

/** A choice picked (a file id, or DESIGN_CHOICE). An old refusal goes, but a stale version stays: the save cannot go on. */
export function pickPicture(state: OrderPictureState, value: string): OrderPictureState {
  return { ...state, picked: value === DESIGN_CHOICE ? null : value, refused: state.refused === 'STALE' ? 'STALE' : null }
}

/** An upload starts. */
export const uploadStarted = (state: OrderPictureState): OrderPictureState => ({ ...state, busy: 'uploading', refused: state.refused === 'STALE' ? 'STALE' : null })

/** An upload answered: the file joins the choices (first) and is picked. */
export function uploadDone(state: OrderPictureState, choice: PictureChoice): OrderPictureState {
  return { ...state, choices: [choice, ...state.choices.filter((each) => each.fileId !== choice.fileId)], picked: choice.fileId, busy: 'idle' }
}

/** A save starts. */
export const saveStarted = (state: OrderPictureState): OrderPictureState => ({ ...state, busy: 'saving', refused: null })

/** A save or an upload was refused. */
export const refusedWith = (state: OrderPictureState, refusal: PictureRefusal): OrderPictureState => ({ ...state, busy: 'idle', refused: refusal })

/** The refusal of a failed save, by the API error's kind (lib/api/errors `ApiErrorKind`; anything else: it failed). */
export function saveRefusalOf(kind: string | null | undefined): PictureRefusal {
  if (kind === 'conflict') return 'STALE'
  if (kind === 'not_found' || kind === 'forbidden') return 'GONE'
  if (kind === 'invalid') return 'NOT_ALLOWED'
  return 'FAILED'
}

// ---- the view model ---------------------------------------------------------------------------------------------------------------

/** One choice of the window, as the view draws it (a radio). */
export interface PictureOption {
  /** The radio's value: DESIGN_CHOICE or the file id. */
  readonly value: string
  readonly choice: PictureChoice | null
  /** Its words: "Use the design"; null for a file (its own name says it). */
  readonly words: Phrase | null
  readonly hint: Phrase
  readonly checked: boolean
  /** The saved picture: it says "The picture now". */
  readonly isNow: boolean
}

export interface OrderPictureView {
  readonly options: readonly PictureOption[]
  /** What the saved picture is, in words. */
  readonly now: Phrase
  /** Why Save waits (the DS Button's held reason); null: it saves. */
  readonly saveHeld: Phrase | null
  /** Why the window cannot close now (a save is out); null: it closes. */
  readonly closeHeld: Phrase | null
  /** A refusal in words; null: none. */
  readonly refusal: Phrase | null
  readonly busy: OrderPictureState['busy']
  /** No file of the order may be its picture yet. */
  readonly noFiles: boolean
}

const KIND_WORDS: Readonly<Record<PictureFileKind, string>> = Object.freeze({ image: 'window.kind.image', pdf: 'window.kind.pdf', mockup: 'window.kind.mockup' })
const REFUSAL_WORDS: Readonly<Record<PictureRefusal, string>> = Object.freeze({ STALE: 'window.refused.stale', GONE: 'window.refused.gone', NOT_ALLOWED: 'window.refused.notAllowed', UPLOAD_FAILED: 'window.refused.upload', FAILED: 'window.refused.failed' })

/** Why Save waits, in order: a stale version (close and open again), a save out, an upload out, the picked one is the saved one. */
export function saveHeldOf(state: OrderPictureState): Phrase | null {
  if (state.refused === 'STALE') return { key: 'window.held.stale' }
  if (state.refused === 'GONE') return { key: 'window.held.gone' }
  if (state.busy === 'saving') return { key: 'window.held.saving' }
  if (state.busy === 'uploading') return { key: 'window.held.uploading' }
  if (state.picked === state.now.fileId) return { key: 'window.held.same' }
  return null
}

export function orderPictureViewOf(state: OrderPictureState): OrderPictureView {
  const design: PictureOption = { value: DESIGN_CHOICE, choice: null, words: { key: 'window.design' }, hint: { key: 'window.designHint' }, checked: state.picked === null, isNow: state.now.fileId === null }
  const files = state.choices.map((choice): PictureOption => ({ value: choice.fileId, choice, words: null, hint: { key: KIND_WORDS[choice.kind] }, checked: state.picked === choice.fileId, isNow: state.now.fileId === choice.fileId }))
  const saved = state.now.fileId === null ? null : state.choices.find((choice) => choice.fileId === state.now.fileId)
  const now: Phrase = state.now.fileId === null ? { key: 'window.now.design' } : saved ? { key: 'window.now.file', params: { name: saved.name } } : { key: 'window.now.other' }
  return {
    options: [design, ...files],
    now,
    saveHeld: saveHeldOf(state),
    closeHeld: state.busy === 'saving' ? { key: 'window.held.closeSaving' } : null,
    refusal: state.refused ? { key: REFUSAL_WORDS[state.refused] } : null,
    busy: state.busy,
    noFiles: state.choices.length === 0,
  }
}
