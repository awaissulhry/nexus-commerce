import type { Issue } from '../../core/errors'

/**
 * Markup of photos and PDFs (COL-055; B-W2b-177 on the B-W2b-153 schema; QHS-063 and PRD-226 point here), pure. The shapes
 * are the design system's own marks (packages/ui PhotoCapture, gap D21: arrows and circles in coordinates 0..1 of the
 * picture or the page, a circle's radius a share of the width), so the office draws them with the DS part and any screen
 * can draw them back.
 *
 *   picture   (JPEG, PNG, WebP) a markup makes the series' next version: the picture with the marks drawn in (JPEG or PNG,
 *             made by the browser), uploaded like any version; the marks and the note are kept beside it (FileMarkup with
 *             resultFileId). The marked version is current once its upload is confirmed.
 *   PDF       a markup is an overlay on one page (1..10 000): the PDF itself never changes.
 *   other     nothing to mark up (a spreadsheet, a pattern, a voice note).
 *
 * Only the current version is marked up (the database checks it), 1..200 marks at most 64 KB, a note of at most 2000 signs.
 */

export const MARKUP_MAX_SHAPES = 200
export const MARKUP_MAX_BYTES = 65_536
export const MARKUP_NOTE_MAX = 2000
export const MARKUP_MAX_PAGE = 10_000

/** What the browser may send as the marked picture. */
export const MARKED_PICTURE_TYPES = ['image/jpeg', 'image/png'] as const
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export interface MarkPoint {
  readonly x: number
  readonly y: number
}

/** One mark, as the DS PhotoCapture gives it. */
export type MarkupShape = { readonly kind: 'arrow'; readonly from: MarkPoint; readonly to: MarkPoint } | { readonly kind: 'circle'; readonly center: MarkPoint; readonly radius: number }

export type MarkupTarget = 'picture' | 'pdf'

/** What a file of this type is marked up as, or null when it cannot be. */
export function markupTargetOf(contentType: string): MarkupTarget | null {
  const type = contentType.toLowerCase().split(';', 1)[0]!.trim()
  if (type === 'application/pdf') return 'pdf'
  return PICTURE_TYPES.includes(type) ? 'picture' : null
}

const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const point = (value: unknown): value is MarkPoint => typeof value === 'object' && value !== null && unit((value as MarkPoint).x) && unit((value as MarkPoint).y)

/** Whether one value is a mark the DS can draw (only its own fields). */
export function isMarkupShape(value: unknown): value is MarkupShape {
  if (typeof value !== 'object' || value === null) return false
  const shape = value as Record<string, unknown>
  const keys = Object.keys(shape).sort().join(',')
  if (shape.kind === 'arrow') return keys === 'from,kind,to' && point(shape.from) && point(shape.to)
  if (shape.kind === 'circle') return keys === 'center,kind,radius' && point(shape.center) && typeof shape.radius === 'number' && shape.radius > 0 && shape.radius <= 1
  return false
}

/** The note as kept: trimmed, null when blank. */
export const cleanNote = (note: string | null | undefined): string | null => {
  const trimmed = (note ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export interface MarkupDraft {
  readonly target: MarkupTarget | null
  readonly page: number | null
  readonly shapes: readonly unknown[]
  readonly note: string | null
  /** The marked picture announced with a picture's markup (its type), or null. */
  readonly resultType: string | null
}

/** What is wrong with a markup, by field; none: it may be kept. */
export function markupProblems(draft: MarkupDraft): Issue[] {
  const issues: Issue[] = []
  if (draft.target === null) issues.push({ path: 'params/fileId', message: 'Only a picture (JPEG, PNG, WebP) or a PDF can be marked up.' })
  if (draft.shapes.length === 0) issues.push({ path: 'body/shapes', message: 'Draw at least one arrow or circle.' })
  if (draft.shapes.length > MARKUP_MAX_SHAPES) issues.push({ path: 'body/shapes', message: `At most ${MARKUP_MAX_SHAPES} marks.` })
  const bad = draft.shapes.findIndex((shape) => !isMarkupShape(shape))
  if (bad >= 0) issues.push({ path: `body/shapes/${bad}`, message: 'A mark is an arrow (from, to) or a circle (center, radius), in 0..1 of the picture.' })
  if (JSON.stringify(draft.shapes).length > MARKUP_MAX_BYTES) issues.push({ path: 'body/shapes', message: 'The marks are too large to keep.' })
  const note = cleanNote(draft.note)
  if (note !== null && note.length > MARKUP_NOTE_MAX) issues.push({ path: 'body/note', message: `A note of at most ${MARKUP_NOTE_MAX} signs.` })
  if (draft.target === 'pdf') {
    if (draft.page === null || !Number.isInteger(draft.page) || draft.page < 1 || draft.page > MARKUP_MAX_PAGE) issues.push({ path: 'body/page', message: 'A PDF is marked up on one page: its number.' })
    if (draft.resultType !== null) issues.push({ path: 'body/result', message: 'A PDF is never changed: its markup is an overlay, with no new version.' })
  }
  if (draft.target === 'picture') {
    if (draft.page !== null) issues.push({ path: 'body/page', message: 'A picture has no pages.' })
    if (draft.resultType === null) issues.push({ path: 'body/result', message: 'A marked picture is kept as a new version: announce it.' })
    else if (!(MARKED_PICTURE_TYPES as readonly string[]).includes(draft.resultType.toLowerCase())) issues.push({ path: 'body/result/contentType', message: 'The marked picture is a JPEG or a PNG.' })
  }
  return issues
}

/** The file name of a marked picture: "front (marked).jpg". */
export function markedNameOf(originalName: string, contentType: string): string {
  const extension = contentType.toLowerCase() === 'image/png' ? '.png' : '.jpg'
  const base = originalName.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/ \(marked\)$/, '')
  return `${base} (marked)${extension}`.slice(0, 500)
}
