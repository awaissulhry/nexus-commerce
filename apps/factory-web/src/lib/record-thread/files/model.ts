import type { ApiFile } from '../../../record-panels/api'
import type { FileAudience, FileKind, QuarantineReason } from '../../../record-panels/model'
import type { ViewerFile } from '../popups/model'
import type { FileSource } from './use-on' // B-TH-231

/**
 * B-TH-210 — the thread's files line (threads plan T2; features T2-F01, F02, F04, F05, F06, F09): "Files (12)" with the
 * three newest as small pictures, the strip below on demand (64 px, newest first, version and audience marks, a held file's
 * lock), and "All files" (T9). The line is absent with no files. The pure part, shared with the Files view (T9). No React,
 * no API.
 *
 * Not drawn until the back end has it: pins (N4, B-TH-091), the measurement-sheet lock (N11, B-TH-083), "files not kept on
 * arrival" (thread-G10). Small previews come with B-TH-063: until a file has one, its kind's icon (never the original).
 *
 * Brand wall (W25, W26): the line lists only this record's files (POST /files files the API lets the reader see; the count
 * is "files you can see", never a total) with their audience; "Customer" / "Supplier" marks a file shared with THIS
 * record's party only (B-TH-003 refuses any other); a file shared with another party is flagged to the office, never
 * named as this customer's.
 */

/** One file of the record as the thread draws it (from GET /files?recordType&recordId). */
export interface ThreadFile {
  readonly id: string
  readonly recordType: string
  readonly recordId: string
  readonly name: string
  readonly contentType: string
  readonly kind: FileKind
  readonly sizeBytes: number
  readonly status: 'PENDING_UPLOAD' | 'AVAILABLE' | 'QUARANTINED' | 'DELETED'
  readonly quarantineReason: QuarantineReason | null
  readonly visibility: readonly FileAudience[]
  /** The party a PARTNER file is shared with (B-TH-003: always the record's). */
  readonly partyId: string | null
  readonly createdAt: string
  readonly versionNo?: number
  readonly seriesId?: string | null
  readonly supersededAt?: string | null
  readonly retainUntil?: string | null
  readonly legalHold?: boolean
  /** The small preview's address (B-TH-063), or null: the kind's icon. Never the original's. */
  readonly previewUrl: string | null
  /** The message the file came with, when it came with one ("Go to message"). */
  readonly messageId?: string | null
  /** Where it came from, when the API says so (WALL-G13, B-TH-029): the Files view groups by it. */
  readonly origin?: FileOrigin | null
  // ---- B-TH-231
  /** A copy carried from another record names its source file (B-TH-024): "Copied from …". */
  readonly sourceFileId?: string | null
  /** The source's record, name and version (null: the reader may not open that record). */
  readonly source?: FileSource | null
  /** B-TH-083: a measurement sheet this reader may not open — no name; "Measurement sheet — you cannot open it". */
  readonly locked?: 'MEASUREMENTS'
  // ---- end B-TH-231
  /** B-TH-283 (B-TH-083): a measurement sheet this reader opens (sales.measurements.view): body data, each opening recorded. */
  readonly sheet?: boolean
}

export type FileOrigin = 'party' | 'ours' | 'made' | 'floor'

/** The record's party, as the marks name it: "Customer" or "Supplier". */
export interface FilesParty {
  readonly id: string
  readonly role: 'customer' | 'supplier' | 'partner'
}

/** A file as the API answers it, with the small preview the container found for it. */
export function fromApiFile(file: ApiFile, previewUrl: string | null = null, extra: Pick<ThreadFile, 'messageId' | 'origin'> = {}): ThreadFile {
  return {
    id: file.id,
    recordType: file.recordType,
    recordId: file.recordId,
    name: file.originalName,
    contentType: file.contentType,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    status: file.status,
    quarantineReason: file.quarantineReason,
    visibility: file.visibility,
    partyId: file.partyId ?? null,
    createdAt: file.createdAt,
    ...(file.versionNo !== undefined ? { versionNo: file.versionNo } : {}),
    seriesId: file.seriesId ?? null,
    supersededAt: file.supersededAt ?? null,
    retainUntil: file.retainUntil,
    ...(file.legalHold !== undefined ? { legalHold: file.legalHold } : {}),
    previewUrl,
    // B-TH-231: the copy's source; B-TH-083: a sheet locked for this reader.
    ...(file.sourceFileId ? { sourceFileId: file.sourceFileId, source: file.origin ? { recordType: file.origin.recordType, recordId: file.origin.recordId, name: file.origin.originalName, versionNo: file.origin.versionNo } : null } : {}),
    ...(file.locked ? { locked: file.locked } : {}),
    // B-TH-283: a sheet the reader may open says so (the API answers its category only to who opens it).
    ...(file.category === 'MEASUREMENTS' && !file.locked ? { sheet: true } : {}),
    ...extra,
  }
}

/** One document: its version in force (the newest) and its earlier versions, newest first. */
export interface FileSeries {
  readonly key: string
  readonly latest: ThreadFile
  readonly earlier: readonly ThreadFile[]
}

/** The record's files as documents with versions, newest document first; DELETED and still-uploading files left out. */
export function fileSeries(files: readonly ThreadFile[]): FileSeries[] {
  const groups = new Map<string, ThreadFile[]>()
  for (const file of files) {
    if (file.status === 'DELETED' || file.status === 'PENDING_UPLOAD') continue
    const key = file.versionNo !== undefined ? `series:${file.seriesId ?? file.id}` : `name:${file.kind}:${file.name.trim().toLocaleLowerCase()}`
    groups.set(key, [...(groups.get(key) ?? []), file])
  }
  const newest = (a: ThreadFile, b: ThreadFile) => (b.versionNo ?? 0) - (a.versionNo ?? 0) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort(newest)
      return { key, latest: sorted[0]!, earlier: sorted.slice(1) }
    })
    .sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt) || b.latest.id.localeCompare(a.latest.id))
}

/** Only this record's files: a file of another record (a tab with its own file API, R-1 to R-4) is never listed here. */
export function recordFiles(files: readonly ThreadFile[], record: { readonly type: string; readonly id: string }): ThreadFile[] {
  return files.filter((file) => file.recordType === record.type && file.recordId === record.id)
}

/** The chip: how many documents the reader can see, and the three newest (their small pictures). */
export function filesChip(series: readonly FileSeries[]): { readonly count: number; readonly newest: readonly ThreadFile[] } {
  return { count: series.length, newest: series.slice(0, 3).map((one) => one.latest) }
}

/** The version mark: "v3" on a document with earlier versions (or a number above 1); none for a single version. */
export function versionMark(series: Pick<FileSeries, 'latest' | 'earlier'>): number | null {
  const number = series.latest.versionNo ?? series.earlier.length + 1
  return series.earlier.length > 0 || number > 1 ? number : null
}

/** An audience mark: the system's four audiences, the party's by the record (Customer / Supplier), or a wrong party. */
export type AudienceMark = 'office' | 'floor' | 'customer' | 'supplier' | 'partner' | 'link' | 'otherParty'

/**
 * Who sees a file, as marks: Office when nobody else; Floor; Customer or Supplier (a PARTNER file shared with THIS record's
 * party; the word follows the party); Link. A PARTNER file shared with another party (none since B-TH-003) is flagged
 * "otherParty" for the office. At most two marks, then "+N".
 */
export function audienceMarks(file: Pick<ThreadFile, 'visibility' | 'partyId'>, party: FilesParty | null): { readonly marks: readonly AudienceMark[]; readonly more: number } {
  const marks: AudienceMark[] = []
  if (file.visibility.includes('FLOOR')) marks.push('floor')
  if (file.visibility.includes('PARTNER')) marks.push(party && file.partyId === party.id ? party.role : 'otherParty')
  if (file.visibility.includes('LINK')) marks.push('link')
  if (marks.length === 0) return { marks: ['office'], more: 0 }
  // A wrong party always shows: it is the one mark the office must not miss.
  const ordered = marks.includes('otherParty') ? ['otherParty' as const, ...marks.filter((mark) => mark !== 'otherParty')] : marks
  return { marks: ordered.slice(0, 2), more: Math.max(0, ordered.length - 2) }
}

/** The file as the viewer opens it (the container adds the signed addresses when it opens). B-TH-231: a locked sheet never opens. */
export function toViewerFile(file: ThreadFile, links: { readonly src: string | Uint8Array | null; readonly downloadHref: string | null } = { src: null, downloadHref: null }, lockedName = ''): ViewerFile {
  return {
    id: file.id,
    name: file.locked ? lockedName : file.name,
    contentType: file.contentType,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    status: file.status === 'QUARANTINED' ? 'QUARANTINED' : file.status === 'AVAILABLE' ? 'AVAILABLE' : 'PENDING_UPLOAD',
    quarantineReason: file.quarantineReason,
    src: links.src,
    downloadHref: links.downloadHref,
    mayOpen: !file.locked,
    messageId: file.messageId ?? null,
    versionNo: file.versionNo ?? null,
  }
}

/** Where the strip's open or closed state is remembered on this device (per person). */
export const stripKey = (personId: string | null) => `factory.thread.filesStrip.${personId ?? 'anyone'}`
