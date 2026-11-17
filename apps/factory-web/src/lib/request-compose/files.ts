import { isDesignType, isPageType } from '@nexus/factory-domain/files/design'
import { PORTAL_FILES_PER_RECORD, portalFileKindOf } from '@nexus/factory-domain/threads/partner/uploads'
import { contentTypeOf } from '../record-thread/attachments/model'

/**
 * B-TH-282 — customers attach files (threads plan TH-7; P-CUS-NEW.files "Attach like an e-mail", T6-F05 refused files, T6-F08 the
 * measurement-sheet tick, P-CUS-NEW.files-F05 design files; backend B-TH-083/084/085), pure: the files a customer adds to New order
 * (held in the page: a file cannot exist before its request, so they go up RIGHT AFTER Send) or to its request page's "Add files".
 * Each is checked as the API will (its kind from its type: a picture a photo up to 15 MB, a ZIP a document, anything else an
 * attachment up to 25 MB; SVG, HTML and scripts never, the way out named), a PDF or a photo may be ticked "This is a measurement
 * sheet" (body data: in the office only holders of the measurements right open it), a design file (Illustrator, EPS, Photoshop,
 * ZIP) is kept as it is, download-only. After the upload a file is sent, held for the virus scan (it reaches the office once the
 * scan says it is clean), or failed with its words (Retry). Uploads stay closed with the API's own sentence until the virus
 * scanner runs (production: B-TH-086, SPEND). No React, no API: shared by the portal's New order and its request page.
 */

const MIB = 1_048_576
/** The API's limits (platform/files/rules.ts KIND_RULES): a photo 15 MB, any other file 25 MB. */
export const PORTAL_PHOTO_MAX = 15 * MIB
export const PORTAL_FILE_MAX = 25 * MIB
/** At most this many files in one message (threads rules MAX_ATTACHMENTS). */
export const PORTAL_FILES_MAX = 20

export type HeldState = 'held' | 'uploading' | 'sent' | 'scanning' | 'failed'

export interface HeldFile {
  /** This page's key for the row (the File itself stays in the container). */
  readonly key: string
  readonly name: string
  readonly sizeBytes: number
  readonly contentType: string
  readonly kind: 'PHOTO' | 'DOCUMENT' | 'ATTACHMENT'
  /** "This is a measurement sheet" (a PDF or a photo). */
  readonly sheet: boolean
  /** A design file kept as it is: download-only, never previewed (B-TH-084). */
  readonly design: boolean
  /** Why it is not taken (a key of request-compose `files.problem.*`), or null. */
  readonly problem: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
  readonly state: HeldState
  /** The API's file, once announced (a retry sends the same file again). */
  readonly fileId?: string
  /** Why the upload failed, in the API's words (or ours), when it did. */
  readonly failure?: string
  /** Its bytes reached us (only carrying it into the thread failed): Retry carries it again, never uploads it twice. */
  readonly uploaded?: boolean
}

const PHOTOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const PAGE_NAME = /\.(svg|svgz|html?|xhtml|js|mjs|exe|sh|bat|cmd|ps1|php)$/i

/** Why a file is not taken, the API's own checks (the words name the limit and the way out), or null. */
export function heldProblem(file: { readonly name: string; readonly type?: string; readonly size: number }): HeldFile['problem'] {
  const type = contentTypeOf(file)
  if (PAGE_NAME.test(file.name) || isPageType(type) || /svg|html|javascript/.test(type)) return { key: 'files.problem.page' }
  if (type === 'application/octet-stream') return { key: 'files.problem.type' }
  if (file.size === 0) return { key: 'files.problem.empty' }
  const kind = portalFileKindOf(type)
  const max = kind === 'PHOTO' ? PORTAL_PHOTO_MAX : PORTAL_FILE_MAX
  if (file.size > max) return { key: 'files.problem.size', params: { max: Math.round(max / MIB) } }
  return null
}

/** A sheet may be ticked on a PDF or a photo of one (never a design file, a spreadsheet or a text). */
export const takesSheetTick = (file: Pick<HeldFile, 'contentType' | 'problem'>): boolean => file.problem === null && (file.contentType === 'application/pdf' || PHOTOS.includes(file.contentType))

/**
 * The dropped files added to the held ones: the same name and size once, at most PORTAL_FILES_MAX waiting (the rest left out and
 * said), each checked as the API will.
 */
export function holdFiles(held: readonly HeldFile[], dropped: readonly { readonly name: string; readonly type?: string; readonly size: number }[], keyOf: (index: number) => string): { held: HeldFile[]; leftOut: number } {
  const next = [...held]
  let leftOut = 0
  dropped.forEach((file, index) => {
    if (next.some((one) => one.name === file.name && one.sizeBytes === file.size && one.state !== 'sent')) return
    if (next.filter((one) => one.state !== 'sent' && one.problem === null).length >= PORTAL_FILES_MAX) {
      leftOut += 1
      return
    }
    const contentType = contentTypeOf(file).split(';')[0]!.trim().toLowerCase()
    const problem = heldProblem({ ...file, type: contentType })
    next.push({ key: keyOf(index), name: file.name, sizeBytes: file.size, contentType, kind: portalFileKindOf(contentType), sheet: false, design: isDesignType(contentType), problem, state: 'held' })
  })
  return { held: next, leftOut }
}

/** The files that go now (or on Retry): taken, not sent, not held for the scan, not already uploaded. */
export const toUpload = (held: readonly HeldFile[]): HeldFile[] => held.filter((file) => file.problem === null && !file.uploaded && (file.state === 'held' || file.state === 'failed'))

/** Retry: a file whose bytes arrived but whose message failed goes back to "sent", to be carried again. */
export const retryCarry = (held: readonly HeldFile[]): HeldFile[] => held.map((file) => (file.state === 'failed' && file.uploaded ? { ...file, state: 'sent' as const } : file))

/** The files the one message carries into the thread: sent (clean), not attached yet. */
export const toAttach = (held: readonly HeldFile[], attached: ReadonlySet<string>): string[] => held.flatMap((file) => (file.state === 'sent' && file.fileId && !attached.has(file.fileId) ? [file.fileId] : []))

/** How the files went: sent, held for the virus scan, failed (Retry), refused (listed with why). */
export function filesOutcome(held: readonly HeldFile[]): { readonly sent: number; readonly scanning: number; readonly failed: number; readonly refused: number; readonly waiting: number } {
  return {
    sent: held.filter((file) => file.state === 'sent').length,
    scanning: held.filter((file) => file.state === 'scanning').length,
    failed: held.filter((file) => file.state === 'failed').length,
    refused: held.filter((file) => file.problem !== null).length,
    waiting: held.filter((file) => file.problem === null && (file.state === 'held' || file.state === 'uploading')).length,
  }
}

/** The count a title says: the files that will go or went (refused ones are listed with their reason, not counted). */
export const heldCount = (held: readonly HeldFile[]): number => held.filter((file) => file.problem === null).length

/** The upload is under way (Send and Retry wait; the page never leaves half way). */
export const uploading = (held: readonly HeldFile[]): boolean => held.some((file) => file.state === 'uploading')

/** A completed upload's state from the file the API answers: AVAILABLE is sent; anything else waits for the scan. */
export const stateAfterUpload = (status: string): HeldState => (status === 'AVAILABLE' ? 'sent' : 'scanning')

/** The most of the customer's own uploads one record keeps (factory-domain threads/partner/uploads). */
export { PORTAL_FILES_PER_RECORD }
