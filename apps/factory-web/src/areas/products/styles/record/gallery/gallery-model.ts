import type { Callout, PictureKind } from '@nexus/factory-domain/product/images/rules'
import { calloutProblems, CAPTION_MAX, captionProblem, inGalleryOrder, isPictureType, nextCalloutNumber, shareOf } from '@nexus/factory-domain/product/images/rules'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { storeUrl } from '../../../../../record-panels/store'
import type { PictureView, StylePicturesView } from './api'

/**
 * Style › Overview › Sketches and pictures (B-W2b-236; PRD-016; design products.styles rec:Style style.ov.gallery: "Front,
 * back, detail flats · Photos per colourway · Image pages with numbered callouts"; "Upload, reorder, set main picture,
 * Lightbox"; empty "No pictures" + Upload), pure: the section's state, what the person may do and why not, the words of
 * a refusal, the callouts as the editor holds them (percentages typed, decimal shares sent), and the order a move sends.
 */

export type GalleryPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: StylePicturesView } | { status: 'error'; problem: string }

export type GalleryDialog =
  | { kind: 'add' }
  | { kind: 'edit'; pictureId: string }
  | { kind: 'callouts'; pictureId: string }
  | { kind: 'remove'; pictureId: string }
  | { kind: 'view'; pictureId: string }

export interface GalleryNotice {
  key: string
  tone: 'success' | 'info' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

/** What is being sent from this device (the add dialog's files). */
export interface GalleryUpload {
  state: 'idle' | 'sending' | 'failed'
  done: number
  of: number
  problem: string | null
}

export interface GalleryModel {
  part: GalleryPart
  /** product.styles.manage AND files.upload (the upload is the files platform's). */
  canManage: boolean
  /** product.styles.manage without files.upload: may arrange, not upload. */
  canArrange: boolean
  dialog: GalleryDialog | null
  busy: boolean
  notice: GalleryNotice | null
  upload: GalleryUpload
  offline?: boolean
}

export const NO_UPLOAD: GalleryUpload = { state: 'idle', done: 0, of: 0, problem: null }
export const NO_GALLERY: GalleryModel = { part: { status: 'idle' }, canManage: false, canArrange: false, dialog: null, busy: false, notice: null, upload: NO_UPLOAD }

/** Where a new picture goes and what it is. */
export interface PictureTarget {
  kind: PictureKind
  revisionId: string | null
  colourwayId: string | null
  caption: string | null
}

export interface PictureChanges {
  kind?: PictureKind
  caption?: string | null
  revisionId?: string | null
  colourwayId?: string | null
  callouts?: Callout[]
}

export interface GalleryActions {
  onRetry?: () => void
  onDialog?: (dialog: GalleryDialog | null) => void
  onUpload?: (files: File[], target: PictureTarget) => void
  onAddExisting?: (fileId: string, target: PictureTarget) => void
  onSave?: (pictureId: string, changes: PictureChanges) => void
  onMain?: (pictureId: string) => void
  onMove?: (pictureId: string, to: number) => void
  onRemove?: (pictureId: string) => void
  onDismissNotice?: () => void
}

/** Why the section's changes are held (a message key of `products-gallery`), or null. Arranging needs no upload right. */
export function galleryHeld(model: Pick<GalleryModel, 'canManage' | 'canArrange' | 'offline'>, view: StylePicturesView, what: 'upload' | 'arrange'): string | null {
  if (!model.canArrange) return 'gallery.held.noRight'
  if (what === 'upload' && !model.canManage) return 'gallery.held.noUpload'
  if (view.style.status === 'ARCHIVED') return 'gallery.held.archived'
  if (view.refusal) return 'gallery.held.rule'
  if (model.offline) return 'gallery.held.offline'
  return null
}

/** The draft revisions a picture may show (a released one keeps its pictures). */
export const draftRevisions = (view: StylePicturesView) => view.revisions.filter((revision) => revision.status === 'DRAFT')
export const activeColourways = (view: StylePicturesView) => view.colourways.filter((colourway) => colourway.status === 'ACTIVE')

/** The address an <img> shows the picture at (the API's own path, reached through this app's /api), or null. */
export function pictureSrc(picture: Pick<PictureView, 'look'>): string | null {
  if (!picture.look) return null
  // Design cases draw made-up pictures inline; the API's looks are always the store's addresses.
  if (picture.look.url.startsWith('data:image/')) return picture.look.url
  try {
    return storeUrl(picture.look.url)
  } catch {
    return null
  }
}

export const pictureOf = (view: StylePicturesView, id: string | null | undefined): PictureView | null => view.pictures.find((picture) => picture.id === id) ?? null
export const ordered = (view: StylePicturesView): PictureView[] => inGalleryOrder(view.pictures)

/** The ids in the gallery's order with `id` moved to place `to` (clamped), or null when nothing moves. */
export function movedOrder(view: StylePicturesView, id: string, to: number): string[] | null {
  const ids = ordered(view).map((picture) => picture.id)
  const from = ids.indexOf(id)
  const place = Math.max(0, Math.min(ids.length - 1, to))
  if (from < 0 || from === place) return null
  ids.splice(from, 1)
  ids.splice(place, 0, id)
  return ids
}

/** The picture's tags in words: its kind, its colourway, its revision (keys and params). */
export function pictureWhere(picture: PictureView): { kind: string; colourway: string | null; revision: number | null } {
  return { kind: `gallery.kind.${picture.kind}`, colourway: picture.colourway ? `${picture.colourway.code} · ${picture.colourway.name}` : null, revision: picture.revision?.revision ?? null }
}

/** A file the browser offers that the section takes (JPEG, PNG, WebP), else the key of why not. */
export const fileProblem = (file: Pick<File, 'type' | 'size'>, maxBytes: number): string | null =>
  !isPictureType(file.type) ? 'gallery.add.wrongType' : file.size > maxBytes ? 'gallery.add.tooBig' : null

export const PICTURE_MAX_BYTES = 15 * 1024 * 1024

// ---- the callouts editor ---------------------------------------------------------------------------------------------------

/** A callout as the editor holds it: its place in percent as typed ("42.5"), its text. */
export interface CalloutDraft {
  n: number
  x: string
  y: string
  text: string
}

const percent = (share: string): string => {
  const value = Math.round(Number(share) * 1000) / 10
  return Number.isFinite(value) ? String(value) : ''
}

export const draftsOf = (callouts: readonly Callout[]): CalloutDraft[] => [...callouts].sort((a, b) => a.n - b.n).map((callout) => ({ n: callout.n, x: percent(callout.x), y: percent(callout.y), text: callout.text }))

/** A new callout at a place on the picture (shares from a click, or the middle). */
export function addCallout(drafts: readonly CalloutDraft[], x = 0.5, y = 0.5): CalloutDraft[] {
  return [...drafts, { n: nextCalloutNumber(drafts), x: percent(String(Math.max(0, Math.min(1, x)))), y: percent(String(Math.max(0, Math.min(1, y)))), text: '' }]
}

/** What the editor sends, and each row's problem (a key) when it cannot. */
export function calloutsToSend(drafts: readonly CalloutDraft[]): { callouts: Callout[]; problems: Record<number, string> } {
  const problems: Record<number, string> = {}
  const callouts: Callout[] = []
  drafts.forEach((draft, index) => {
    const x = shareOf(Number(draft.x.replace(',', '.')) / 100)
    const y = shareOf(Number(draft.y.replace(',', '.')) / 100)
    if (draft.x.trim() === '' || draft.y.trim() === '' || x === null || y === null) problems[index] = 'gallery.callouts.place'
    callouts.push({ n: draft.n, x: x ?? '0', y: y ?? '0', text: draft.text.trim() })
  })
  for (const problem of calloutProblems(callouts)) {
    const index = Number(/^body\/callouts\/(\d+)/.exec(problem.path)?.[1] ?? -1)
    if (index < 0) continue
    problems[index] ??= problem.path.endsWith('/text') ? 'gallery.callouts.textProblem' : problem.path.endsWith('/n') ? 'gallery.callouts.number' : 'gallery.callouts.place'
  }
  return { callouts, problems }
}

/** A caption typed: trimmed, empty → none; the key of its problem. */
export function captionToSend(typed: string): { caption: string | null; problem: string | null } {
  const caption = typed.trim() === '' ? null : typed.trim()
  return { caption, problem: captionProblem(caption) ? 'gallery.edit.captionLong' : null }
}
export { CAPTION_MAX }

/** A refused write in the section's own words (a `products-gallery` key). */
export function galleryProblem(error: unknown): string {
  if (!isApiError(error)) return 'gallery.problem.write'
  if (error.kind === 'conflict') return error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version')) ? 'gallery.problem.moved' : 'gallery.problem.state'
  if (error.kind === 'forbidden') return 'gallery.held.noRight'
  if (error.kind === 'invalid') return 'gallery.problem.invalid'
  if (error.kind === 'not_found') return 'gallery.problem.gone'
  if (error.kind === 'unavailable' || error.code === 'network') return 'gallery.problem.offline'
  return 'gallery.problem.write'
}

/** A failed read in the section's own words. */
export function galleryReadProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'gallery.problem.readForbidden'
  if (isApiError(error) && (error.kind === 'unavailable' || error.code === 'network')) return 'gallery.problem.offline'
  return 'gallery.problem.read'
}
