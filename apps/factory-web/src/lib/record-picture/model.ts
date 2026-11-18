/**
 * F-SA-211 (sales page plan N8, picks P13, P18, R9; 12-lists-board §2; review R-2) — the ONE picture part of every list, board and
 * record page that shows a record's style picture (factory-web lib, so every lane mounts the same part: the Orders sheet, Incoming,
 * Quotes, the Sales board, the week board, the customer's Work tab, the order page's lines, later Production's lists). It replaces
 * three copies (two caches, three word sets). The pure part: the sizes, the fit, the cache rule, the batch rule and the names.
 *
 * Brand wall: the part reads only the walled batch routes (POST /sales/{orders,quotes,inquiries}/pictures, B-SA-011): a record the
 * reader may not see is simply absent from the answer (the part draws its neutral placeholder — never "no right"). Office only.
 */

/**
 * The record kinds a picture is read for (the batch route of each: orders, quotes, inquiries; F-SA-283: work orders — Production ›
 * Work orders and the planning board, by the production lane's yes, R9; never a floor or TV screen).
 */
export type PictureSource = 'order' | 'quote' | 'request' | 'workorder'

/** Where the part is drawn: a list cell, a board card, a phone card, an order line (small or large). */
export type PictureSize = 'cell' | 'board' | 'phone' | 'line' | 'lineLarge'

/** The edge of each size, in CSS pixels (the board card's grows to 72 from 1680 px wide: record-picture.css). */
export const PICTURE_PX: Readonly<Record<PictureSize, number>> = Object.freeze({ cell: 36, board: 64, phone: 48, line: 40, lineLarge: 56 })
export const BOARD_WIDE = Object.freeze({ px: 72, fromWidth: 1680 })

/**
 * How the picture fills its square: a list cell crops (today's look); a card or a line fits — a garment photo is portrait, and
 * cropping a 64–72 px square cuts the collar and the hem.
 */
export const PICTURE_FIT: Readonly<Record<PictureSize, 'cover' | 'contain'>> = Object.freeze({ cell: 'cover', board: 'contain', phone: 'contain', line: 'contain', lineLarge: 'contain' })

/** The most ids one batch read takes (the API's PICTURES_MAX). */
export const BATCH_MAX = 200
/** Asks of one source made within this window go out as ONE call. */
export const BATCH_WAIT_MS = 30
/** A failed read is asked again only at a mount after this long (no retry storm). */
export const RETRY_AFTER_MS = 30_000
/** An address is used until shortly before it expires (the API's live 60 seconds). */
export const EXPIRY_MARGIN_MS = 5_000

/** The picture a row already names (its list read's own field; `small`: the ~320 px preview exists). */
export interface RowPicture {
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly fileId: string | null
  readonly small: boolean
}

/** One record of the batch answer (B-SA-011's one shape). */
export interface PictureAnswer {
  readonly id: string
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly styleCount: number
  readonly fileId: string | null
  readonly contentType: string | null
  readonly small: { readonly url: string; readonly expiresAt: string } | null
}

/** "+N" beside the picture: the record's other styles. */
export const moreOf = (styleCount: number | null | undefined): number => Math.max(0, (styleCount ?? 1) - 1)

/** The style in words ("STY-01 Demo jacket"), or null without a style. */
export const styleWords = (picture: Pick<RowPicture, 'styleCode' | 'styleName'> | null | undefined): string | null => (picture ? `${picture.styleCode} ${picture.styleName}`.trim() : null)

/** A row names a small preview to read (a file this reader may open, and its preview made). */
export const wantsSmall = (picture: RowPicture | null | undefined): boolean => !!picture && picture.fileId !== null && picture.small

/** Until when an address is used. */
export const untilOf = (expiresAt: string): number => Date.parse(expiresAt) - EXPIRY_MARGIN_MS

/** The cache key of a record. */
export const recordKey = (source: PictureSource, recordId: string): string => `${source}:${recordId}`

/** A row's picture from the batch answer (the week board's cards name none of their own). */
export const rowPictureOf = (answer: PictureAnswer): RowPicture => ({ styleId: answer.styleId, styleCode: answer.styleCode, styleName: answer.styleName, fileId: answer.fileId, small: answer.small !== null })

/** The ids of one batch read: each once, in the order asked, at most BATCH_MAX per call. */
export function batchesOf(ids: readonly string[], max = BATCH_MAX): string[][] {
  const unique = [...new Set(ids)]
  const out: string[][] = []
  for (let at = 0; at < unique.length; at += max) out.push(unique.slice(at, at + max))
  return out
}

/** Incoming's fallback for a request that names no style: the kind of its files with their count (photos first when as many). */
export function fallbackOf(files: { readonly photos: number; readonly documents: number } | null | undefined): { readonly kind: 'photos' | 'documents'; readonly count: number } | null {
  if (!files || files.photos + files.documents === 0) return null
  return files.photos >= files.documents ? { kind: 'photos', count: files.photos } : { kind: 'documents', count: files.documents }
}

/** What the part draws: the picture (a button that opens it large), the file kinds (a door), a placeholder, or the wait. */
export type PictureFace = 'picture' | 'files' | 'none' | 'reading'

/**
 * The face of a record: a style named → its picture (the viewer offers Open style even without a file); none named yet but the
 * read still out (the week board) → reading; else the file kinds when the request has files, else the placeholder.
 */
export function faceOf(picture: RowPicture | null | undefined, fallback: { readonly photos: number; readonly documents: number } | null | undefined): PictureFace {
  if (picture) return 'picture'
  if (picture === undefined) return 'reading'
  return fallbackOf(fallback) ? 'files' : 'none'
}
