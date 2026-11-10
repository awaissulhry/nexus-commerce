import type { Issue } from '../../core/errors'

/**
 * A style's pictures and pattern files (B-W2b-236; PRD-016, PRD-218; design products.styles sec:styles.gallery,
 * rec:Style › Overview › "Sketches and pictures", › Files & patterns › "Pattern files per revision and size range"), pure.
 * B-W2b-206's tables hold them: `StyleImage` (a SKETCH, a PHOTO or an image PAGE with numbered callouts; the style's, one
 * revision's or one colourway's; one main picture per style) and `StyleRevisionFile` (a PATTERN, MARKER, CAD or OTHER file
 * of one revision, its format and the sizes it is for). The database checks every rule here once more; these say them in
 * words first, so a person never meets a database refusal.
 *
 *   pictures     JPEG, PNG or WebP files of the style (StoredFile recordType "Style"), at most PICTURES_MAX per style; a
 *                picture of a revision that is no longer a draft keeps its file, kind, caption and callouts (only its place
 *                and the main mark move); the first picture of a style is its main picture, and when the main one is
 *                removed the next in order takes its place (a style with pictures always has one main picture)
 *   callouts     at most 60, numbered 1 to 999 once each, placed by x and y as a share of the width and the height
 *                ("0" to "1", at most 4 decimals: decimal strings, never floats), each with a text of 1 to 500 characters
 *   pattern      a PATTERN or CAD file is the specification: added, changed or removed only on a DRAFT revision; a MARKER or
 *   files        OTHER file may be added to a released revision too (markers are made for production); the sizes are codes
 *                of the style's range, each once (none: every size); a new version of the file is a new file of the same
 *                series (the files platform's versions), named by the row while the row may change
 *   tech pack    its PDF draws the AVAILABLE JPEG and PNG pictures of at most 4 MiB, the first 12 (B-W2b-230): a picture
 *                that is not drawn says so beside it
 */

// ---- pictures -----------------------------------------------------------------------------------------------------------

export const PICTURE_KINDS = ['SKETCH', 'PHOTO', 'PAGE'] as const
export type PictureKind = (typeof PICTURE_KINDS)[number]

/** What a picture may be: a browser shows it and the files platform can strip it for outside eyes (no HEIC). */
export const PICTURE_TYPES: readonly string[] = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])
export const isPictureType = (contentType: string): boolean => PICTURE_TYPES.includes(contentType.split(';')[0]!.trim().toLowerCase())

/** The most pictures a style keeps (a gallery, not a photo library). */
export const PICTURES_MAX = 60
export const CAPTION_MAX = 200
export const CALLOUTS_MAX = 60
export const CALLOUT_TEXT_MAX = 500
export const CALLOUT_NUMBER_MAX = 999

/** The tech pack's PDF (B-W2b-230, modules/product/techpack/documents.ts): JPEG or PNG, at most 4 MiB, the first 12. */
export const TECH_PACK_PICTURE_TYPES: readonly string[] = Object.freeze(['image/jpeg', 'image/png'])
export const TECH_PACK_PICTURE_MAX_BYTES = 4 * 1024 * 1024
export const TECH_PACK_PICTURES_MAX = 12

/** Whether the tech pack's PDF can draw this file (its order among the printable ones decides the first 12). */
export const printableInTechPack = (file: { readonly contentType: string; readonly sizeBytes: number; readonly status: string }): boolean =>
  file.status === 'AVAILABLE' && TECH_PACK_PICTURE_TYPES.includes(file.contentType) && file.sizeBytes <= TECH_PACK_PICTURE_MAX_BYTES

/** One numbered callout on a picture: x and y as a share of the width and the height (decimal strings). */
export interface Callout {
  readonly n: number
  readonly x: string
  readonly y: string
  readonly text: string
}

const SHARE = /^(0(\.[0-9]{1,4})?|1(\.0{1,4})?)$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A text the database takes (factory_styles_text_ok): not blank, at most `max` characters, no control character (no line break). */
export const textOk = (value: string, max: number): boolean => value.trim() !== '' && value.length <= max && !CONTROL.test(value)

/** A share from 0 to 1 as the database keeps it ("0.4213"): a number or a text in, at most 4 decimals out; null when it is none. */
export function shareOf(value: number | string): string | null {
  const number = typeof value === 'number' ? value : Number(value.trim())
  if (!Number.isFinite(number) || number < 0 || number > 1) return null
  const fixed = (Math.round(number * 10_000) / 10_000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return SHARE.test(fixed) ? fixed : null
}

/** Why the callouts cannot be kept, at `body/callouts/<i>/<field>`, or nothing (the database's factory_style_callouts_problem). */
export function calloutProblems(callouts: readonly Callout[], path = 'body/callouts'): Issue[] {
  const problems: Issue[] = []
  if (callouts.length > CALLOUTS_MAX) problems.push({ path, message: `A picture has at most ${CALLOUTS_MAX} callouts.` })
  const seen = new Set<number>()
  callouts.forEach((callout, index) => {
    const at = `${path}/${index}`
    if (!Number.isInteger(callout.n) || callout.n < 1 || callout.n > CALLOUT_NUMBER_MAX) problems.push({ path: `${at}/n`, message: `A callout is numbered with a whole number from 1 to ${CALLOUT_NUMBER_MAX}.` })
    else if (seen.has(callout.n)) problems.push({ path: `${at}/n`, message: `Callout ${callout.n} is there twice: number each callout once.` })
    seen.add(callout.n)
    if (!SHARE.test(callout.x)) problems.push({ path: `${at}/x`, message: 'Place the callout with x from "0" to "1" (at most 4 decimals).' })
    if (!SHARE.test(callout.y)) problems.push({ path: `${at}/y`, message: 'Place the callout with y from "0" to "1" (at most 4 decimals).' })
    if (!textOk(callout.text, CALLOUT_TEXT_MAX)) problems.push({ path: `${at}/text`, message: `Give callout ${callout.n} a text of 1 to ${CALLOUT_TEXT_MAX} characters on one line.` })
  })
  return problems
}

/** The callouts in number order, their text trimmed (what is stored). */
export const orderedCallouts = (callouts: readonly Callout[]): Callout[] => [...callouts].map((callout) => ({ n: callout.n, x: callout.x, y: callout.y, text: callout.text.trim() })).sort((a, b) => a.n - b.n)

/** The number a new callout takes: one after the highest (1 for the first). */
export const nextCalloutNumber = (callouts: readonly Pick<Callout, 'n'>[]): number => Math.min(CALLOUT_NUMBER_MAX, callouts.reduce((top, callout) => Math.max(top, callout.n), 0) + 1)

/** Callouts as the database row holds them (JSON), read loosely: a row that does not have the shape is left out. */
export function calloutsOf(value: unknown): Callout[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    return typeof row['n'] === 'number' && typeof row['x'] === 'string' && typeof row['y'] === 'string' && typeof row['text'] === 'string' ? [{ n: row['n'], x: row['x'], y: row['y'], text: row['text'] }] : []
  })
}

/** A revision as the pictures and pattern files see it. */
export interface RevisionFacts {
  readonly id: string
  readonly revision: number
  readonly status: 'DRAFT' | 'RELEASED' | 'OBSOLETE'
}

/** Whether a picture keeps its file, kind, caption and callouts: it shows a revision that is no longer a draft. */
export const pictureFrozen = (revision: Pick<RevisionFacts, 'status'> | null): boolean => revision !== null && revision.status !== 'DRAFT'

/**
 * The style's edit rule a picture write asks (B-W2b-221 EDIT_KINDS): a picture of a draft revision is a write to the draft
 * (DRAFT); the style's own or a colourway's picture, its order and the main mark are the style's details (DETAILS: pictures
 * show what is made, they do not define it).
 */
export const pictureEditKind = (revision: Pick<RevisionFacts, 'status'> | null): 'DETAILS' | 'DRAFT' => (revision !== null && revision.status === 'DRAFT' ? 'DRAFT' : 'DETAILS')

/** Why a picture's file, kind, caption, callouts, revision or colourway cannot change, in words, or null. */
export function pictureChangeRefusal(revision: RevisionFacts | null): string | null {
  if (!pictureFrozen(revision)) return null
  return `This picture shows revision ${revision!.revision}, which is ${revision!.status === 'RELEASED' ? 'released' : 'obsolete'}: it keeps what it shows. Move it or make it the main picture; for a change, add the picture to the draft revision.`
}

/** A picture in the gallery's order (its place, then the oldest first). */
export interface PictureOrderFacts {
  readonly id: string
  readonly seq: number
  readonly isMain: boolean
  readonly createdAt: string
}

export const inGalleryOrder = <P extends PictureOrderFacts>(pictures: readonly P[]): P[] =>
  [...pictures].sort((a, b) => a.seq - b.seq || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** The main picture: the one marked, else none. */
export const mainOf = <P extends PictureOrderFacts>(pictures: readonly P[]): P | null => pictures.find((picture) => picture.isMain) ?? null

/** The picture that becomes the main one when `removedId` (the main one) goes: the first of the others in order, or none. */
export function mainAfterRemoval<P extends PictureOrderFacts>(pictures: readonly P[], removedId: string): P | null {
  const removed = pictures.find((picture) => picture.id === removedId)
  if (!removed?.isMain) return null
  return inGalleryOrder(pictures.filter((picture) => picture.id !== removedId))[0] ?? null
}

/** Why a new order cannot be kept (it must name every picture of the style once), or nothing. */
export function orderProblems(current: readonly string[], asked: readonly string[]): Issue[] {
  if (new Set(asked).size !== asked.length) return [{ path: 'body/ids', message: 'Name each picture once.' }]
  const have = new Set(current)
  const missing = current.filter((id) => !asked.includes(id))
  const unknown = asked.filter((id) => !have.has(id))
  if (unknown.length > 0) return [{ path: 'body/ids', message: `${unknown.length} picture(s) are not this style's: read the gallery again.` }]
  if (missing.length > 0) return [{ path: 'body/ids', message: `${missing.length} picture(s) of the style are missing from the order: read the gallery again.` }]
  return []
}

/** Why a caption cannot be kept, or null (null clears it). */
export const captionProblem = (caption: string | null | undefined): string | null =>
  caption === null || caption === undefined || textOk(caption, CAPTION_MAX) ? null : `A caption has 1 to ${CAPTION_MAX} characters on one line.`

// ---- pattern files ------------------------------------------------------------------------------------------------------

export const PATTERN_FILE_KINDS = ['PATTERN', 'MARKER', 'CAD', 'OTHER'] as const
export type PatternFileKind = (typeof PATTERN_FILE_KINDS)[number]
export const PATTERN_FILE_FORMATS = ['DXF_AAMA', 'LECTRA', 'GERBER', 'PDF'] as const
export type PatternFileFormat = (typeof PATTERN_FILE_FORMATS)[number]
export const PATTERN_NOTE_MAX = 500

/** The specification kinds: frozen with their revision (B-W2b-206's StyleRevisionFile_guard). */
export const SPEC_PATTERN_KINDS: readonly PatternFileKind[] = Object.freeze(['PATTERN', 'CAD'])

/** Whether a row of this kind on this revision can no longer be added, changed or removed. */
export const patternFrozen = (kind: PatternFileKind, revision: Pick<RevisionFacts, 'status'>): boolean => SPEC_PATTERN_KINDS.includes(kind) && revision.status !== 'DRAFT'

/** The style's edit rule a pattern-file write asks: a write to the draft (DRAFT), else (a marker on a released revision) DETAILS. */
export const patternEditKind = (revision: Pick<RevisionFacts, 'status'>): 'DETAILS' | 'DRAFT' => (revision.status === 'DRAFT' ? 'DRAFT' : 'DETAILS')

/** Why a pattern file of `kind` cannot be added, changed or removed on this revision, in words, or null. */
export function patternRefusal(kind: PatternFileKind, revision: RevisionFacts): string | null {
  if (!patternFrozen(kind, revision)) return null
  const what = kind === 'PATTERN' ? 'pattern' : 'CAD drawing'
  return `Revision ${revision.revision} is ${revision.status === 'RELEASED' ? 'released' : 'obsolete'}: its ${what} files are its specification and do not change. Start a new revision for a new ${what}; a marker can still be added.`
}

/** Why the sizes cannot be kept (codes of the style's range, each once; none: every size), or nothing. */
export function patternSizeProblems(sizes: readonly string[], range: readonly string[], path = 'body/sizes'): Issue[] {
  if (new Set(sizes).size !== sizes.length) return [{ path, message: 'Name each size once.' }]
  const outside = sizes.filter((size) => !range.includes(size))
  return outside.length > 0 ? [{ path, message: `Size(s) ${outside.join(', ')} are not in the style's range (${range.join(', ') || 'none'}).` }] : []
}

/** The sizes in the range's order. */
export const inRangeOrder = (sizes: readonly string[], range: readonly string[]): string[] => [...sizes].sort((a, b) => range.indexOf(a) - range.indexOf(b))

/** Why a note cannot be kept, or null (null clears it). */
export const noteProblem = (note: string | null | undefined): string | null =>
  note === null || note === undefined || textOk(note, PATTERN_NOTE_MAX) ? null : `A note has 1 to ${PATTERN_NOTE_MAX} characters on one line.`

/**
 * The type a pattern file is sent with (the files platform takes a CAD pattern only sent in parts: DXF and HP-GL; PDF and
 * pictures as documents), from its name first (a browser rarely knows a DXF), else what the browser said; null: the files
 * platform does not take it (a native Lectra or Gerber file: export it as DXF-AAMA or a PDF plot first).
 */
export function patternContentTypeOf(fileName: string, browserType: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase() ?? ''
  const byName: Record<string, string> = { dxf: 'application/dxf', plt: 'application/vnd.hp-hpgl', hpgl: 'application/vnd.hp-hpgl', hpg: 'application/vnd.hp-hpgl', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
  const named = byName[extension]
  if (named) return named
  const type = browserType.split(';')[0]!.trim().toLowerCase()
  return ['application/dxf', 'application/vnd.hp-hpgl', 'application/pdf', 'image/png', 'image/jpeg'].includes(type) ? type : null
}

/** The format a file's name suggests (a DXF is most likely the AAMA exchange; a plot or a PDF a PDF plot), or null. */
export function formatOfName(fileName: string): PatternFileFormat | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase() ?? ''
  if (extension === 'dxf') return 'DXF_AAMA'
  if (extension === 'pdf') return 'PDF'
  return null
}

// ---- Duplicate a style: its pictures (B-W2a-09's PICTURES part) -----------------------------------------------------------

/** A picture of the source as the copy reads it. */
export interface SourcePicture extends PictureOrderFacts {
  readonly kind: PictureKind
  readonly revisionId: string | null
  readonly colourwayId: string | null
  readonly fileId: string
  readonly caption: string | null
  readonly callouts: readonly Callout[]
}

/** A picture the copy gets: the source picture and where it lands. */
export interface CopiedPicture {
  readonly source: SourcePicture
  readonly revisionId: string | null
  readonly colourwayId: string | null
  readonly seq: number
  readonly isMain: boolean
}

/**
 * Which of the source's pictures a copy takes, in the gallery's order (B-W2b-236, SY3:01): the style's own; a copied
 * colourway's (on the copy's colourway); the source revision's (on the copy's revision 1 when the copy has one, else as the
 * copy's own picture). Pictures of an archived colourway (not copied) and of other revisions stay behind (`left`). The
 * source's main picture stays the main one when it is copied, else the first copied picture is.
 */
export function picturesToCopy(
  pictures: readonly SourcePicture[],
  colourwayMap: ReadonlyMap<string, string>,
  sourceRevisionId: string | null,
  copyRevisionId: string | null,
): { copied: CopiedPicture[]; left: number } {
  const kept: { source: SourcePicture; revisionId: string | null; colourwayId: string | null }[] = []
  let left = 0
  for (const picture of inGalleryOrder(pictures)) {
    if (picture.revisionId !== null && picture.revisionId !== sourceRevisionId) {
      left++
      continue
    }
    if (picture.colourwayId !== null && !colourwayMap.has(picture.colourwayId)) {
      left++
      continue
    }
    kept.push({ source: picture, revisionId: picture.revisionId === null ? null : copyRevisionId, colourwayId: picture.colourwayId === null ? null : colourwayMap.get(picture.colourwayId)! })
  }
  const main = kept.findIndex((entry) => entry.source.isMain)
  return { copied: kept.map((entry, seq) => ({ ...entry, seq, isMain: seq === (main >= 0 ? main : 0) })), left }
}
