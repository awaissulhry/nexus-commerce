/**
 * PhotoCapture's rules (gap D21, "Photo capture with markup") — pure, so they are tested without a browser.
 *
 * - The steps: `capture` (the camera, or a file) → `markup` (arrows and circles on the photo) → the app gets the photo;
 *   with `markup` off, `capture` → `review`. Retake goes back to `capture`.
 * - Marks are data in normalised coordinates (0..1 of the photo's width and height), so they mean the same spot at any
 *   size; a circle's radius is a share of the photo's WIDTH. `markInPixels` turns one into the photo's pixels.
 * - Keyboard marking: a crosshair moved by the arrows (Shift moves further), Enter or Space sets the start (an arrow) or
 *   the centre (a circle), the second press draws the mark, Escape cancels the mark under way (`keyStep`).
 * - A tap (a drag shorter than `MIN_MARK`) still draws: a circle of the default size around it, or an arrow pointing at
 *   it from the side with more room — a gloved finger rarely drags.
 * - Every word has an English default here; the app passes its own (`PhotoCaptureWords`).
 */

export type PhotoStep = 'capture' | 'markup' | 'review'
export type PhotoTool = 'arrow' | 'circle'
export type PhotoGuide = 'frame' | 'silhouette' | 'none'
/** Why the camera is not showing a picture. */
export type CameraProblem = 'denied' | 'unavailable' | 'busy' | 'failed'
export type CameraState = 'idle' | 'starting' | 'live' | CameraProblem
export type PhotoSource = 'camera' | 'file' | 'given'

/** A point on the photo: 0..1 of its width (x) and height (y), from the top left. */
export interface PhotoPoint {
  x: number
  y: number
}

/** One mark on the photo. A circle's `radius` is a share of the photo's width. */
export type PhotoMark = { kind: 'arrow'; from: PhotoPoint; to: PhotoPoint } | { kind: 'circle'; center: PhotoPoint; radius: number }

/** What "Use photo" gives the app: it uploads it (files, the floor's offline queue); the part sends nothing. */
export interface CapturedPhoto {
  /** The photo alone (JPEG, long edge at most `maxSize`; re-encoded, so a file's metadata — place, device — is gone). */
  photo: Blob
  /** The marks as data, in the order they were drawn. */
  marks: readonly PhotoMark[]
  /** The photo with the marks drawn in (JPEG, same size), or null when there are no marks. */
  marked: Blob | null
  width: number
  height: number
  source: PhotoSource
}

/** The keyboard's mark under way: where the crosshair is, and the start (arrow) or centre (circle) once set. */
export interface KeyDraft {
  cursor: PhotoPoint
  anchor: PhotoPoint | null
}

export interface PhotoCaptureWords {
  startCamera: string
  takePhoto: string
  useFile: string
  cancel: string
  tryAgain: string
  facesHint: string
  guideFrame: string
  guideSilhouette: string
  videoLabel: string
  cameraOff: string
  cameraStarting: string
  cameraLive: string
  cameraDenied: string
  cameraUnavailable: string
  cameraBusy: string
  cameraFailed: string
  shotTaken: string
  fileRead: string
  fileUnreadable: string
  tools: string
  toolArrow: string
  toolCircle: string
  toolPicked: string
  undo: string
  clear: string
  undoNothing: string
  clearNothing: string
  retake: string
  usePhoto: string
  preparing: string
  prepareFailed: string
  surface: string
  photoAlt: string
  instructions: string
  cursorAt: string
  startArrow: string
  startCircle: string
  tooShort: string
  markCancelled: string
  added: string
  removed: string
  cleared: string
  markArrow: string
  markCircle: string
  marksNone: string
  marksOne: string
  marksOther: string
  posTopLeft: string
  posTop: string
  posTopRight: string
  posLeft: string
  posCentre: string
  posRight: string
  posBottomLeft: string
  posBottom: string
  posBottomRight: string
}

export const PHOTO_CAPTURE_WORDS: PhotoCaptureWords = {
  startCamera: 'Start camera',
  takePhoto: 'Take photo',
  useFile: 'Use a file',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  facesHint: 'Keep faces out of the picture',
  guideFrame: 'Fit the item inside the frame',
  guideSilhouette: 'Stand inside the outline',
  videoLabel: 'Camera view',
  cameraOff: 'The camera is off. Start it, or use a file.',
  cameraStarting: 'Starting the camera…',
  cameraLive: 'Camera on. Take the photo when the item is in the frame.',
  cameraDenied: 'The camera is blocked for this page. Allow it in the browser, or use a file.',
  cameraUnavailable: 'There is no camera here. Use a file instead.',
  cameraBusy: 'Another app is using the camera. Close it, or use a file.',
  cameraFailed: 'The camera did not start. Try again, or use a file.',
  shotTaken: 'Photo taken.',
  fileRead: 'Photo loaded.',
  fileUnreadable: 'That file could not be read as a photo. Choose another one.',
  tools: 'Mark with',
  toolArrow: 'Arrow',
  toolCircle: 'Circle',
  toolPicked: '{tool} picked.',
  undo: 'Undo mark',
  clear: 'Clear marks',
  undoNothing: 'There is no mark to undo',
  clearNothing: 'There are no marks to clear',
  retake: 'Retake',
  usePhoto: 'Use photo',
  preparing: 'Preparing the photo…',
  prepareFailed: 'The photo could not be prepared. Try again.',
  surface: 'Mark the photo',
  photoAlt: 'The photo to mark',
  instructions:
    'Drag on the photo to draw, or tap to mark a spot. With the keyboard: the arrow keys move the crosshair (Shift moves further), Enter sets the start, Enter again draws the mark, Escape cancels it.',
  cursorAt: 'Crosshair: {at}',
  startArrow: 'Arrow start set at {at}. Move to where it points and press Enter.',
  startCircle: 'Circle centre set at {at}. Move to its edge and press Enter.',
  tooShort: 'Move the crosshair away from the start first.',
  markCancelled: 'Mark cancelled.',
  added: 'Added: {mark}.',
  removed: 'Removed: {mark}.',
  cleared: 'All marks removed.',
  markArrow: 'Arrow {n} from {from} to {to}',
  markCircle: 'Circle {n} around {at}',
  marksNone: 'No marks yet',
  marksOne: '{count} mark',
  marksOther: '{count} marks',
  posTopLeft: 'top left',
  posTop: 'top',
  posTopRight: 'top right',
  posLeft: 'left',
  posCentre: 'centre',
  posRight: 'right',
  posBottomLeft: 'bottom left',
  posBottom: 'bottom',
  posBottomRight: 'bottom right',
}

/** `{name}` → its value; a name with no value stays as written, so a missing one shows. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** The longest side of a photo the part gives back, in px. */
export const PHOTO_MAX_SIZE = 2048
/** JPEG quality of what the part gives back. */
export const PHOTO_QUALITY = 0.85
/** A drag shorter than this (a share of the width) is a tap. */
export const MIN_MARK = 0.03
/** The circle a tap draws (radius, a share of the width). */
export const DEFAULT_RADIUS = 0.08
/** How far a tapped arrow's tail sits from its tip (a share of the width). */
export const TAP_ARROW = 0.15
/** One arrow-key step of the crosshair, and one with Shift (shares of the width and height). */
export const KEY_STEP = 0.02
export const KEY_STEP_BIG = 0.1
export const CENTRE: PhotoPoint = Object.freeze({ x: 0.5, y: 0.5 })

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5)
export const clampPoint = (point: PhotoPoint): PhotoPoint => ({ x: clamp01(point.x), y: clamp01(point.y) })

/** After a shot or a file: mark it, or (markup off) look at it once more. */
export const stepAfterShot = (markup: boolean): PhotoStep => (markup ? 'markup' : 'review')

/** The camera's error (a `DOMException` from `getUserMedia`, or none at all) in the part's terms. */
export function cameraProblemOf(error: unknown): CameraProblem {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError' || name === 'TypeError' || name === 'NotSupportedError') return 'unavailable'
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'busy'
  return 'failed'
}

export function cameraProblemWords(problem: CameraProblem, words: PhotoCaptureWords): string {
  if (problem === 'denied') return words.cameraDenied
  if (problem === 'unavailable') return words.cameraUnavailable
  if (problem === 'busy') return words.cameraBusy
  return words.cameraFailed
}

export const isCameraProblem = (state: CameraState): state is CameraProblem => state === 'denied' || state === 'unavailable' || state === 'busy' || state === 'failed'

/** A photo's size with its long edge at most `max` (never enlarged), in whole px. */
export function fitSize(width: number, height: number, max = PHOTO_MAX_SIZE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 }
  const limit = max > 0 ? max : PHOTO_MAX_SIZE
  const scale = Math.min(1, limit / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Distance between two points, in shares of the width (`aspect` = height / width). */
export function distance(a: PhotoPoint, b: PhotoPoint, aspect: number): number {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  return Math.hypot(b.x - a.x, (b.y - a.y) * ratio)
}

/** The mark a drag from `from` to `to` draws; a tap draws the default circle, or an arrow pointing at the spot. */
export function markFromDrag(tool: PhotoTool, from: PhotoPoint, to: PhotoPoint, aspect: number): PhotoMark {
  const start = clampPoint(from)
  const end = clampPoint(to)
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const tap = distance(start, end, ratio) < MIN_MARK
  if (tool === 'circle') return { kind: 'circle', center: start, radius: tap ? DEFAULT_RADIUS : Math.min(1, distance(start, end, ratio)) }
  if (!tap) return { kind: 'arrow', from: start, to: end }
  // The tip is the tapped spot; the tail comes from the side with more room.
  const tail = clampPoint({ x: start.x + (start.x < 0.5 ? TAP_ARROW : -TAP_ARROW), y: start.y + (start.y < 0.5 ? TAP_ARROW : -TAP_ARROW) / ratio })
  return { kind: 'arrow', from: tail, to: start }
}

export type KeyStepResult =
  | { kind: 'ignored' }
  | { kind: 'moved'; draft: KeyDraft; regionChanged: boolean }
  | { kind: 'anchored'; draft: KeyDraft }
  | { kind: 'mark'; draft: KeyDraft; mark: PhotoMark }
  | { kind: 'tooShort'; draft: KeyDraft }
  | { kind: 'cancelled'; draft: KeyDraft }

/**
 * One key on the markup surface. Arrows move the crosshair (Shift further), Home puts it back in the centre, Enter or
 * Space sets the anchor and then draws the mark, Escape cancels a mark under way (and is ignored when there is none, so a
 * dialog around the part can close).
 */
export function keyStep(draft: KeyDraft, key: string, options: { shift?: boolean; tool: PhotoTool; aspect: number }): KeyStepResult {
  const step = options.shift ? KEY_STEP_BIG : KEY_STEP
  const move = (dx: number, dy: number): KeyStepResult => {
    const cursor = clampPoint({ x: draft.cursor.x + dx, y: draft.cursor.y + dy })
    return { kind: 'moved', draft: { ...draft, cursor }, regionChanged: positionOf(cursor) !== positionOf(draft.cursor) }
  }
  if (key === 'ArrowLeft') return move(-step, 0)
  if (key === 'ArrowRight') return move(step, 0)
  if (key === 'ArrowUp') return move(0, -step)
  if (key === 'ArrowDown') return move(0, step)
  if (key === 'Home') return { kind: 'moved', draft: { ...draft, cursor: CENTRE }, regionChanged: positionOf(CENTRE) !== positionOf(draft.cursor) }
  if (key === 'Escape') return draft.anchor ? { kind: 'cancelled', draft: { ...draft, anchor: null } } : { kind: 'ignored' }
  if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
    if (!draft.anchor) return { kind: 'anchored', draft: { ...draft, anchor: draft.cursor } }
    if (distance(draft.anchor, draft.cursor, options.aspect) < MIN_MARK) return { kind: 'tooShort', draft }
    return { kind: 'mark', draft: { ...draft, anchor: null }, mark: markFromDrag(options.tool, draft.anchor, draft.cursor, options.aspect) }
  }
  return { kind: 'ignored' }
}

export type PhotoPosition = 'TopLeft' | 'Top' | 'TopRight' | 'Left' | 'Centre' | 'Right' | 'BottomLeft' | 'Bottom' | 'BottomRight'

/** Where a point is, roughly: the photo cut in thirds each way. */
export function positionOf(point: PhotoPoint): PhotoPosition {
  const col = point.x < 1 / 3 ? 0 : point.x < 2 / 3 ? 1 : 2
  const row = point.y < 1 / 3 ? 0 : point.y < 2 / 3 ? 1 : 2
  const names: PhotoPosition[][] = [
    ['TopLeft', 'Top', 'TopRight'],
    ['Left', 'Centre', 'Right'],
    ['BottomLeft', 'Bottom', 'BottomRight'],
  ]
  return names[row][col]
}

export const positionWords = (point: PhotoPoint, words: PhotoCaptureWords): string => words[`pos${positionOf(point)}`]

/** One mark in words, numbered from 1: "Arrow 1 from top left to centre", "Circle 2 around bottom right". */
export function describeMark(mark: PhotoMark, index: number, words: PhotoCaptureWords): string {
  const n = index + 1
  if (mark.kind === 'arrow') return fill(words.markArrow, { n, from: positionWords(mark.from, words), to: positionWords(mark.to, words) })
  return fill(words.markCircle, { n, at: positionWords(mark.center, words) })
}

/** "No marks yet" / "1 mark" / "3 marks". */
export function marksCount(count: number, words: PhotoCaptureWords): string {
  if (count <= 0) return words.marksNone
  return fill(count === 1 ? words.marksOne : words.marksOther, { count })
}

/** Stroke sizes in the photo's own px: thick enough to see on a tablet; a dark outline under a bright core. */
export function strokeOf(width: number, height: number): { core: number; outline: number; head: number } {
  const short = Math.max(1, Math.min(width, height))
  const core = Math.max(3, Math.round(short * 0.008))
  return { core, outline: core * 2, head: core * 5 }
}

/** The two ends of an arrowhead at `to`, `size` px long, 28° either side of the shaft. */
export function arrowHead(from: { x: number; y: number }, to: { x: number; y: number }, size: number): [{ x: number; y: number }, { x: number; y: number }] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = (28 * Math.PI) / 180
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ]
}

export type PixelMark = { kind: 'arrow'; from: { x: number; y: number }; to: { x: number; y: number } } | { kind: 'circle'; center: { x: number; y: number }; radius: number }

/** A mark in the photo's px (`width` × `height`). */
export function markInPixels(mark: PhotoMark, width: number, height: number): PixelMark {
  if (mark.kind === 'arrow') return { kind: 'arrow', from: { x: mark.from.x * width, y: mark.from.y * height }, to: { x: mark.to.x * width, y: mark.to.y * height } }
  return { kind: 'circle', center: { x: mark.center.x * width, y: mark.center.y * height }, radius: mark.radius * width }
}

/** The point under a pointer, from its place in the drawn photo's box. */
export function pointIn(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): PhotoPoint {
  if (!(box.width > 0) || !(box.height > 0)) return CENTRE
  return clampPoint({ x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height })
}

/** "Use photo" is held: the part's own state first, then the app's reason, then the app's rule over the marks. */
export function photoHeldReason(input: {
  heldReason?: string | null
  busy: boolean
  hasPhoto: boolean
  marks: readonly PhotoMark[]
  rule?: string | null | ((marks: readonly PhotoMark[]) => string | null | undefined)
  words: PhotoCaptureWords
}): string | null {
  if (input.heldReason) return input.heldReason
  if (input.busy) return input.words.preparing
  if (!input.hasPhoto) return input.words.cameraOff
  const rule = typeof input.rule === 'function' ? input.rule(input.marks) : input.rule
  return rule || null
}
