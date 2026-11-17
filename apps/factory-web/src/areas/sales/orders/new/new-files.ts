import { isPageType, ZIP_TYPES } from '@nexus/factory-domain/files/design'
import { contentTypeOf, uploadProblem, type FileKind } from '../../../../record-panels/model'

/**
 * B-TH-231 — Sales › Orders › New order's fold "Customer files" (threads plan O-SAL-ORD-NEW.form-F08; ORD-G05): the customer's
 * files (photos, a PDF, a measurement sheet, a design file) dropped, pasted or browsed while the order is typed. A file cannot
 * exist before its order, so the page HOLDS them ("Added when you confirm") and uploads them to the new order right after
 * "Confirm order", for the office only; a measurement sheet is ticked as one (B-TH-083: opened only with
 * sales.measurements.view). When some do not attach, the order stays made and the page says so — "Order SO-… made; 2 files
 * did not attach · Retry" — and Retry sends only those. Pure: no React, no API.
 */

/** At most this many files are held (the thread's own limit, threads rules MAX_ATTACHMENTS). */
export const MAX_HELD = 20

export type HeldState = 'held' | 'attaching' | 'attached' | 'failed'

export interface HeldFile {
  /** This page's key for the row (the File itself stays in the container). */
  readonly key: string
  readonly name: string
  readonly sizeBytes: number
  readonly contentType: string
  /** What the API files it as: a picture a PHOTO, a ZIP a DOCUMENT, anything else an ATTACHMENT. */
  readonly kind: FileKind
  /** "This is a measurement sheet". */
  readonly sheet: boolean
  /** Why it is not taken (keys of orders-new-files: `problem.*`), or null. */
  readonly problem: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
  readonly state: HeldState
}

const PICTURES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']

/** The kind a held file is uploaded as (the API's: platform/files/rules.ts KIND_RULES). */
export function heldKindOf(contentType: string): FileKind {
  if (PICTURES.includes(contentType)) return 'PHOTO'
  if (ZIP_TYPES.includes(contentType)) return 'DOCUMENT'
  return 'ATTACHMENT'
}

/** A sheet may be ticked on a PDF or a photo of one (a measurement sheet is never a design file, a sheet or a text). */
export const takesSheetTick = (file: Pick<HeldFile, 'contentType' | 'problem'>): boolean => file.problem === null && (file.contentType === 'application/pdf' || PICTURES.includes(file.contentType))

/** The dropped files added to the held ones (a file of the same name and size once; at most MAX_HELD), each checked as the API will. */
export function holdFiles(held: readonly HeldFile[], dropped: readonly { readonly name: string; readonly type?: string; readonly size: number }[], keyOf: (index: number) => string): { held: HeldFile[]; leftOut: number } {
  const next = [...held]
  let leftOut = 0
  dropped.forEach((file, index) => {
    if (next.some((one) => one.name === file.name && one.sizeBytes === file.size && one.state !== 'attached')) return
    if (next.filter((one) => one.state !== 'attached').length >= MAX_HELD) {
      leftOut += 1
      return
    }
    const contentType = (file.type || contentTypeOf(file.name)).split(';')[0]!.trim().toLowerCase()
    const kind = heldKindOf(contentType)
    const refused = uploadProblem({ name: file.name, type: contentType, size: file.size }, kind)
    // The words are this fold's own (orders-new-files: problem.page | type | empty | size): SVG, HTML and scripts name the way out.
    const problem = isPageType(contentType) || /\.(svg|svgz|html?|xhtml|js|mjs)$/i.test(file.name) ? { key: 'problem.page' } : refused ? { key: refused.key.replace('files.problem.', 'problem.'), ...(refused.params ? { params: refused.params } : {}) } : null
    next.push({ key: keyOf(index), name: file.name, sizeBytes: file.size, contentType, kind, sheet: false, problem, state: 'held' })
  })
  return { held: next, leftOut }
}

/** The files that go when the order is made (or on Retry): taken, and not attached yet. */
export const toAttach = (held: readonly HeldFile[]): HeldFile[] => held.filter((file) => file.problem === null && file.state !== 'attached')

/** The order is made: how its files went. `failed` > 0 keeps the page on "Order … made; N files did not attach · Retry". */
export function attachOutcome(held: readonly HeldFile[]): { readonly attached: number; readonly failed: number; readonly refused: number } {
  return {
    attached: held.filter((file) => file.state === 'attached').length,
    failed: held.filter((file) => file.state === 'failed').length,
    refused: held.filter((file) => file.problem !== null).length,
  }
}

/** The fold's title count: the files that will go (refused ones are listed with their reason, not counted). */
export const heldCount = (held: readonly HeldFile[]): number => held.filter((file) => file.problem === null).length

/** Confirm waits while files are being attached (the page never leaves half way). */
export const attaching = (held: readonly HeldFile[]): boolean => held.some((file) => file.state === 'attaching')
