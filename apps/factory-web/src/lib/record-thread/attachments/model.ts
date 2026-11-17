/**
 * B-TH-206 — files straight into the message (threads plan T6; picture 4, approved 2026-11-17): the office drops, pastes or picks
 * files on the box, each with its progress; a refused file says why; "From this record" re-sends a file of the record; Send waits
 * while files upload ("Waiting for 2 files"). A file takes the audience of its message: in an Office note it is office only, in a
 * reply it is shared with the record's customer — and only with that customer (B-TH-003, the API). An office-only file in a reply
 * is named: share it with the customer (files.manage) or take it off; the mail carries at most 10 MB together. Pure.
 *
 * B-TH-283 (B-TH-083, N11): a file goes up as a measurement sheet — a PDF or a photo, from the paper clip's "Measurement sheet…" or
 * dropped on the box's measurement side — filed as body data (only holders of sales.measurements.view open it). B-TH-237: a message
 * in the portal shares its files with the customer like a reply (no mail limit: nothing is mailed). Not drawn until the back end has
 * it: resumable big uploads and expiring links (later). B-TH-084 (G12): design files (Illustrator, EPS, Photoshop; a ZIP as a document) are taken,
 * download-only; SVG, HTML and scripts never, with the way out named ("send a PDF or PNG").
 */

// B-TH-084: the design files the API takes, as factory-domain lists them.
import { ARTWORK_TYPES, DESIGN_TYPE_BY_EXTENSION, isPageType, ZIP_TYPES } from '@nexus/factory-domain/files/design'

const MIB = 1_048_576

/** At most this many files in one message (threads rules MAX_ATTACHMENTS). */
export const MAX_FILES = 20
/** A photo's limit and any other file's (platform/files/rules.ts KIND_RULES: PHOTO 15 MB, ATTACHMENT 25 MB). */
export const PHOTO_MAX = 15 * MIB
export const FILE_MAX = 25 * MIB
/** A mail carries at most this much together (email-out: MAX_EMAIL_ATTACHMENT_BYTES). */
export const MAIL_MAX = 10 * MIB

const PHOTOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const ACCEPTED = [
  'application/pdf',
  ...PHOTOS,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'text/plain',
  // B-TH-084: design files, download-only.
  ...ARTWORK_TYPES,
  ...ZIP_TYPES,
]
const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  docx: ACCEPTED[5],
  xlsx: ACCEPTED[6],
  odt: ACCEPTED[7],
  ods: ACCEPTED[8],
  csv: 'text/csv',
  txt: 'text/plain',
  // B-TH-084: a design file named but not typed by the browser.
  ...DESIGN_TYPE_BY_EXTENSION,
}
const SCRIPTS = /\.(svg|svgz|html?|xhtml|js|mjs|exe|sh|bat|cmd|ps1|php)$/i

/** A file's type as the browser says it, else from its name (a phone photo often comes without one). */
export function contentTypeOf(file: { name: string; type?: string }): string {
  if (file.type) return file.type
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  return BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** The kind the API files it as: a picture is a PHOTO (15 MB), a ZIP a DOCUMENT (B-TH-084), anything else an ATTACHMENT (25 MB). */
export const kindOf = (contentType: string): 'PHOTO' | 'ATTACHMENT' | 'DOCUMENT' => (PHOTOS.includes(contentType) ? 'PHOTO' : ZIP_TYPES.includes(contentType) ? 'DOCUMENT' : 'ATTACHMENT')

export interface Problem {
  key: string
  params?: Record<string, string | number>
}

/** Why a file is not taken (T6-F05: the reason names the limit and the way out), or null. */
export function refusalOf(file: { name: string; type?: string; size: number }): Problem | null {
  // B-TH-084: an SVG, HTML or script file is never taken — the words name the way out ("send a PDF or PNG").
  if (SCRIPTS.test(file.name) || isPageType(file.type ?? '') || /svg|html|javascript/.test(file.type ?? '')) return { key: 'refused.page' }
  const type = contentTypeOf(file)
  if (!ACCEPTED.includes(type)) return { key: 'refused.type' }
  if (file.size === 0) return { key: 'refused.empty' }
  const limit = kindOf(type) === 'PHOTO' ? PHOTO_MAX : FILE_MAX
  if (file.size > limit) return { key: kindOf(type) === 'PHOTO' ? 'refused.photoSize' : 'refused.fileSize', params: { limit: Math.round(limit / MIB) } }
  return null
}

/** Who sees a file of the message: the office only, or the office and the record's customer. */
export type DraftAudience = 'OFFICE' | 'PARTY'

/** The composer's audiences (composer/model COMPOSER_MODES): a note, a reply by e-mail, a message in the portal (B-TH-237). */
export type TrayMode = 'note' | 'reply' | 'portal'

/** B-TH-237: a reply by e-mail and a message in the portal both reach the customer. */
const reachesCustomer = (mode: TrayMode): boolean => mode === 'reply' || mode === 'portal'

// ---- B-TH-283 (B-TH-083): a measurement sheet is a PDF or a photo of one (never a design file, a sheet or a text).
const SHEET_TYPES = ['application/pdf', ...PHOTOS]
export const takesSheet = (contentType: string): boolean => SHEET_TYPES.includes(contentType)
// ---- end B-TH-283

export interface DraftFile {
  /** This screen's key for the row. */
  key: string
  name: string
  sizeBytes: number
  contentType: string
  /** Dropped, pasted or picked from the device; or a file of the record. */
  source: 'device' | 'record'
  phase: 'uploading' | 'done' | 'failed' | 'refused'
  /** The upload's share, 0–100, when the browser says it. */
  progress?: number
  /** The API's file, once announced (a record's file has it from the start). */
  fileId?: string
  audience: DraftAudience
  /** Why it was refused or failed. */
  problem?: Problem
  /** B-TH-283: it goes up as a measurement sheet (body data: only holders of the measurements right open it). */
  sheet?: boolean
}

/**
 * The audience a new upload takes: the message's (T6-F04). A reply's file is shared with the customer when the person may share
 * files (files.manage); otherwise it stays office only and the reply names it.
 */
export function uploadAudience(mode: TrayMode, canShare: boolean, hasParty: boolean): DraftAudience {
  return reachesCustomer(mode) && canShare && hasParty ? 'PARTY' : 'OFFICE'
}

/** The files a message carries as it goes: done ones. */
export const sendable = (files: readonly DraftFile[]): DraftFile[] => files.filter((file) => file.phase === 'done' && file.fileId)

/** An office-only file in a reply: named; Send waits until it is shared or taken off. */
export const officeInReply = (files: readonly DraftFile[], mode: TrayMode): DraftFile[] => (reachesCustomer(mode) ? files.filter((file) => file.phase === 'done' && file.audience === 'OFFICE') : [])

/** The bytes a mail would carry. */
export const mailBytes = (files: readonly DraftFile[]): number => files.filter((file) => file.phase === 'done' || file.phase === 'uploading').reduce((sum, file) => sum + file.sizeBytes, 0)

/**
 * Why Send waits because of the files (a key of record-thread-attach), or null: uploads still running, a failed upload, too many
 * files, an office-only file in a reply, more than 10 MB in a mail (an Office note has no mail limit). A refused file waits beside
 * the box with its reason and holds nothing.
 */
export function trayHeld(files: readonly DraftFile[], mode: TrayMode): Problem | null {
  const uploading = files.filter((file) => file.phase === 'uploading').length
  if (uploading > 0) return { key: 'held.waiting', params: { count: uploading } }
  const failed = files.filter((file) => file.phase === 'failed').length
  if (failed > 0) return { key: 'held.failed', params: { count: failed } }
  if (files.filter((file) => file.phase !== 'refused').length > MAX_FILES) return { key: 'held.tooMany', params: { max: MAX_FILES } }
  if (officeInReply(files, mode).length > 0) return { key: 'held.officeFile' }
  if (mode === 'reply' && mailBytes(files) > MAIL_MAX) return { key: 'held.mailLimit' }
  return null
}

/** One file of the record, as the picker shows it. */
export interface RecordFile {
  id: string
  name: string
  sizeBytes: number
  contentType: string
  /** The customer sees it already (portal or link, shared with this record's customer). */
  shared: boolean
  available: boolean
}

/**
 * "From this record" (T6-F03): in a reply the files the customer may already see come first, then the office's (picking one asks
 * to share it); in a note every file, as it is. Only files that are available; a search narrows by name.
 */
export function pickerGroups(files: readonly RecordFile[], query = ''): { shared: RecordFile[]; office: RecordFile[] } {
  const words = query.trim().toLowerCase()
  const shown = files.filter((file) => file.available && (words === '' || file.name.toLowerCase().includes(words)))
  return { shared: shown.filter((file) => file.shared), office: shown.filter((file) => !file.shared) }
}

/** A record's file as a row of the message. */
export function draftOfRecordFile(file: RecordFile, key: string): DraftFile {
  return { key, name: file.name, sizeBytes: file.sizeBytes, contentType: file.contentType, source: 'record', phase: 'done', fileId: file.id, audience: file.shared ? 'PARTY' : 'OFFICE' }
}

/**
 * The files a drop or paste adds: refused ones keep their reason; past 20 the rest is left out and said. B-TH-283: `sheet` — they go
 * up as measurement sheets; a file that cannot be one (not a PDF or a photo) is refused with why.
 */
export function addDropped(current: readonly DraftFile[], dropped: ReadonlyArray<{ name: string; type?: string; size: number }>, audience: DraftAudience, nextKey: () => string, sheet = false): { files: DraftFile[]; added: DraftFile[]; leftOut: number } {
  const room = Math.max(0, MAX_FILES - current.filter((file) => file.phase !== 'refused').length)
  const added: DraftFile[] = []
  let leftOut = 0
  for (const file of dropped) {
    const problem = refusalOf(file) ?? (sheet && !takesSheet(contentTypeOf(file)) ? { key: 'refused.sheetType' } : null)
    if (!problem && added.filter((item) => item.phase !== 'refused').length >= room) {
      leftOut += 1
      continue
    }
    added.push({
      key: nextKey(),
      name: file.name || 'Pasted image.png',
      sizeBytes: file.size,
      contentType: contentTypeOf(file),
      source: 'device',
      phase: problem ? 'refused' : 'uploading',
      audience,
      ...(problem ? { problem } : {}),
      ...(sheet && !problem ? { sheet: true } : {}),
    })
  }
  return { files: [...current, ...added], added, leftOut }
}

/** The kind word of a row. */
export function kindKey(contentType: string): string {
  if (contentType.startsWith('image/')) return 'kind.photo'
  if (contentType === 'application/pdf') return 'kind.pdf'
  return 'kind.file'
}
