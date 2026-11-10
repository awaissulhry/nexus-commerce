import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { CALLOUT_NUMBER_MAX, CALLOUT_TEXT_MAX, CALLOUTS_MAX, CAPTION_MAX, PATTERN_FILE_FORMATS, PATTERN_FILE_KINDS, PATTERN_NOTE_MAX, PICTURE_KINDS, PICTURES_MAX } from './rules'

/**
 * A style's pictures, the gallery and the pattern files (B-W2b-236; PRD-016, PRD-218): what apps/factory-api's
 * modules/product/images accepts and answers, and what the web's typed client reads. No money, no person. A picture's or a
 * pattern file's change sends ITS `version` (COL-078). A file is uploaded through the files platform first (a picture: a
 * PHOTO of the Style; a pattern file: a DOCUMENT of the revision, sent in parts), then named here.
 *
 * A look is the picture's address on the API (`GET /product/pictures/<file id>`, its bytes through the API and kept by the
 * browser: a stored file never changes), so a gallery costs no call to the file store per read.
 */

const version = () => z.number().int().min(1)
const share = () => z.string().regex(/^(0(\.[0-9]{1,4})?|1(\.0{1,4})?)$/)

export const callout = input({
  n: z.number().int().min(1).max(CALLOUT_NUMBER_MAX),
  /** Across the picture, from "0" (left) to "1" (right), at most 4 decimals. */
  x: share(),
  /** Down the picture, from "0" (top) to "1" (bottom). */
  y: share(),
  text: z.string().min(1).max(CALLOUT_TEXT_MAX),
})
const callouts = () => z.array(callout).max(CALLOUTS_MAX)
const caption = () => z.string().trim().min(1).max(CAPTION_MAX).nullable()

const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })
const colourwayRef = output({ id: id(), code: z.string(), name: z.string() })
const look = output({ url: z.string() })

/** One picture of the style, in the gallery's order. */
export const pictureView = output({
  id: id(),
  version: z.number().int(),
  kind: z.enum(PICTURE_KINDS),
  seq: z.number().int(),
  isMain: z.boolean(),
  caption: z.string().nullable(),
  callouts: z.array(output({ n: z.number().int(), x: z.string(), y: z.string(), text: z.string() })),
  /** The revision it shows; null: the style's, whatever the revision. */
  revision: revisionRef.nullable(),
  /** The colourway it shows; null: none in particular. */
  colourway: colourwayRef.nullable(),
  file: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string() }),
  /** The picture's address (the API's own path); null: its file is not available (waiting for its scan, held). */
  look: look.nullable(),
  /** The tech pack's PDF can draw it (an available JPEG or PNG of at most 4 MiB; the first 12 are drawn). */
  printable: z.boolean(),
  /** It shows a revision that is no longer a draft: only its place and the main mark move (`frozen` says why). */
  frozen: z.string().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type PictureView = z.infer<typeof pictureView>

/** The Sketches and pictures section of a style. */
export const stylePicturesView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  pictures: z.array(pictureView),
  /** The style's picture files (JPEG, PNG, WebP; available) not yet in the gallery, newest first, at most 50. */
  unused: z.array(output({ fileId: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), createdAt: instant() })),
  revisions: z.array(revisionRef),
  colourways: z.array(colourwayRef.extend({ status: z.string() })),
  /** Why nothing may be added or changed now (the style's edit rule, an archived style), or null. */
  refusal: z.string().nullable(),
  limits: output({ pictures: z.number().int(), callouts: z.number().int(), caption: z.number().int(), calloutText: z.number().int(), types: z.array(z.string()) }),
  at: instant(),
})
export type StylePicturesView = z.infer<typeof stylePicturesView>

export const LIMITS = { pictures: PICTURES_MAX, callouts: CALLOUTS_MAX, caption: CAPTION_MAX, calloutText: CALLOUT_TEXT_MAX } as const

/** A file of the style (uploaded as a PHOTO of the Style, or one of its picture files) made a picture, at the end. */
export const addPictureBody = input({
  fileId: id(),
  kind: z.enum(PICTURE_KINDS),
  revisionId: id().nullable().default(null),
  colourwayId: id().nullable().default(null),
  caption: caption().default(null),
  callouts: callouts().default([]),
})
export type AddPictureBody = z.output<typeof addPictureBody>

/** A change to one picture: only what it names (null clears a caption, a revision, a colourway). */
export const updatePictureBody = input({
  version: version(),
  kind: z.enum(PICTURE_KINDS).optional(),
  revisionId: id().nullable().optional(),
  colourwayId: id().nullable().optional(),
  caption: caption().optional(),
  callouts: callouts().optional(),
})
export type UpdatePictureBody = z.output<typeof updatePictureBody>

export const pictureVersionBody = input({ version: version() })
export const pictureVersionQuery = input({ version: z.coerce.number().int().min(1) })

/** The gallery's new order: every picture of the style, once, first first. */
export const orderPicturesBody = input({ ids: z.array(id()).min(1).max(PICTURES_MAX) })
export type OrderPicturesBody = z.output<typeof orderPicturesBody>

/** The styles list's Gallery view: the main picture of each style asked for (the page on screen). */
export const galleryLooksBody = input({ styleIds: z.array(id()).min(1).max(60) })
export const galleryLooksView = output({
  looks: z.array(
    output({
      styleId: id(),
      /** The main picture; null: the style has none (or its file is not available yet). */
      picture: output({ id: id(), kind: z.enum(PICTURE_KINDS), caption: z.string().nullable(), look: look.nullable() }).nullable(),
      /** How many pictures the style has. */
      pictures: z.number().int(),
      /** The style's active colourways with their library colour (a swatch), in the style's order. */
      colourways: z.array(output({ code: z.string(), name: z.string(), hex: z.string().nullable() })),
    }),
  ),
  at: instant(),
})
export type GalleryLooksView = z.infer<typeof galleryLooksView>

// ---- pattern files ------------------------------------------------------------------------------------------------------

const sizes = () => z.array(z.string().trim().min(1).max(40)).max(60)
const note = () => z.string().trim().min(1).max(PATTERN_NOTE_MAX).nullable()

export const patternFileView = output({
  id: id(),
  version: z.number().int(),
  kind: z.enum(PATTERN_FILE_KINDS),
  /** null: another format (the file's name says it). */
  format: z.enum(PATTERN_FILE_FORMATS).nullable(),
  /** The sizes it is for, in the range's order; empty: every size. */
  sizes: z.array(z.string()),
  note: z.string().nullable(),
  file: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), versionNo: z.number().int() }),
  /** The versions of the file (its series), newest first; `current` is the one the row names. */
  versions: z.array(output({ fileId: id(), versionNo: z.number().int(), name: z.string(), sizeBytes: z.number().int(), status: z.string(), createdAt: instant(), current: z.boolean() })),
  /** Why it cannot change (a pattern or CAD file of a revision that is no longer a draft), or null. */
  frozen: z.string().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type PatternFileView = z.infer<typeof patternFileView>

/** Files & patterns › Pattern files of one revision. */
export const patternFilesView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES), sizes: z.array(z.string()) }),
  revision: revisionRef,
  files: z.array(patternFileView),
  /** Why nothing may be added now (the style's edit rule, an archived style), or null; a PATTERN or CAD file on a released revision says it in `kinds`. */
  refusal: z.string().nullable(),
  /** Per kind: why a new file of it cannot be added to this revision, or null. */
  kinds: z.record(z.enum(PATTERN_FILE_KINDS), z.string().nullable()),
  at: instant(),
})
export type PatternFilesView = z.infer<typeof patternFilesView>

/** A file of the revision (sent in parts as a DOCUMENT of the StyleRevision) named as a pattern file. */
export const addPatternFileBody = input({
  fileId: id(),
  kind: z.enum(PATTERN_FILE_KINDS),
  format: z.enum(PATTERN_FILE_FORMATS).nullable().default(null),
  sizes: sizes().default([]),
  note: note().default(null),
})
export type AddPatternFileBody = z.output<typeof addPatternFileBody>

export const updatePatternFileBody = input({
  version: version(),
  kind: z.enum(PATTERN_FILE_KINDS).optional(),
  format: z.enum(PATTERN_FILE_FORMATS).nullable().optional(),
  sizes: sizes().optional(),
  note: note().optional(),
})
export type UpdatePatternFileBody = z.output<typeof updatePatternFileBody>

/** The row names a newer version of its file (uploaded with the files platform's new version, in the same series). */
export const patternFileVersionBody = input({ version: version(), fileId: id() })
export type PatternFileVersionBody = z.output<typeof patternFileVersionBody>

/** Several rows removed at once (the list's selection): each with its version. */
export const removePatternFilesBody = input({ items: z.array(input({ id: id(), version: version() })).min(1).max(100) })
export type RemovePatternFilesBody = z.output<typeof removePatternFilesBody>

export const patternDownloadQuery = input({ fileId: id().optional() })
export const downloadView = output({ download: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) })
