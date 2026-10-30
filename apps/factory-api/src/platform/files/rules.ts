import type { Issue } from '@nexus/factory-domain/core/errors'
import { defineMachine } from '@nexus/factory-domain/state/machine'
import { toUtcIso } from '@nexus/factory-domain/core/time'
// B-W2a-42: the virus scan's reasons (held for the scan, a virus found, the scan failed).
import { SCAN_QUARANTINE_REASONS } from './scan/rules'

/**
 * The rules of files on R2 (plan A1 §3.6; PLAN §2.8; features COL-045, COL-050), pure: what each kind may hold and how
 * big, how a name and a storage key are made, who may see a file, how long it is kept and when it may go. The service
 * (files.ts) applies them before any write; the database's guard trigger (…_files_guards) holds the same invariants for
 * every login. Pure TypeScript with no I/O, so it can move to factory-domain/src/files with the files lane.
 */

export const FILE_KINDS = ['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE'] as const
export type FileKind = (typeof FILE_KINDS)[number]
export const FILE_STATUSES = ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]
export const FILE_AUDIENCES = ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'] as const
export type FileAudience = (typeof FILE_AUDIENCES)[number]
export const QUARANTINE_REASONS = ['size_mismatch', 'type_mismatch', 'checksum_mismatch', ...SCAN_QUARANTINE_REASONS] as const
export const FILE_SCAN_STATUSES = ['NOT_SCANNED', 'PENDING', 'CLEAN', 'INFECTED', 'FAILED'] as const
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number]

const MIB = 1_048_576
const PDF = 'application/pdf'
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const
const OFFICE_DOCUMENTS = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
] as const

/**
 * What each kind may hold, and its size limit. Nothing a browser would run or render as a page (HTML, SVG, scripts)
 * is accepted at all; every download is an attachment anyway.
 */
export const KIND_RULES: Readonly<Record<FileKind, { readonly contentTypes: readonly string[]; readonly maxBytes: number }>> = Object.freeze({
  ATTACHMENT: { contentTypes: [PDF, ...IMAGES, ...OFFICE_DOCUMENTS, 'text/csv', 'text/plain'], maxBytes: 25 * MIB },
  DOCUMENT: { contentTypes: [PDF, ...OFFICE_DOCUMENTS, 'text/csv'], maxBytes: 25 * MIB },
  PHOTO: { contentTypes: [...IMAGES], maxBytes: 15 * MIB },
  CERTIFICATE: { contentTypes: [PDF, 'image/jpeg', 'image/png'], maxBytes: 20 * MIB },
  // FatturaPA XML, its signed .p7m form, and PDF copies of invoices, DDTs and signed quotes.
  FISCAL_ARCHIVE: { contentTypes: [PDF, 'application/xml', 'text/xml', 'application/pkcs7-mime'], maxBytes: 20 * MIB },
})

/** The largest file of any kind (the local store's body limit). */
export const MAX_FILE_BYTES = Math.max(...Object.values(KIND_RULES).map((rule) => rule.maxBytes))

/** How long fiscal documents are kept at least (c.c. art. 2220; DPR 600/1973 art. 22). */
export const FISCAL_RETENTION_YEARS = 10
/** A presigned upload lives 5 minutes, a presigned download 60 seconds (A1 §3.6). */
export const UPLOAD_URL_SECONDS = 300
export const DOWNLOAD_URL_SECONDS = 60

const SHA256 = /^[0-9a-f]{64}$/
/** A record's model name, as on audit rows. */
export const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

/** `Image/JPEG; charset=x` → `image/jpeg`. */
export function normaliseContentType(value: string): string {
  return value.split(';')[0]!.trim().toLowerCase()
}

/** The problems of an announced upload against its kind's rules (empty when it may be uploaded). */
export function uploadProblems(input: { kind: FileKind; contentType: string; sizeBytes: number; sha256: string }): Issue[] {
  const rule = KIND_RULES[input.kind]
  const problems: Issue[] = []
  if (!rule.contentTypes.includes(normaliseContentType(input.contentType))) {
    problems.push({ path: 'body/contentType', message: `A ${input.kind} file may be ${rule.contentTypes.join(', ')}.` })
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > rule.maxBytes) {
    problems.push({ path: 'body/sizeBytes', message: `A ${input.kind} file holds 1 byte to ${rule.maxBytes / MIB} MiB.` })
  }
  if (!SHA256.test(input.sha256)) problems.push({ path: 'body/sha256', message: 'Expected the SHA-256 of the content, 64 lower-case hex digits.' })
  return problems
}

/** The name as stored: no folders, no control characters, at most 200 characters; null when nothing is left. */
export function cleanFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200).trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? null : cleaned
}

/** `Content-Disposition` of a download: always an attachment, with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** The audiences, with OFFICE always in, once each, in a fixed order. */
export function normaliseVisibility(visibility: readonly FileAudience[] | undefined): FileAudience[] {
  const wanted = new Set<FileAudience>(['OFFICE', ...(visibility ?? [])])
  return FILE_AUDIENCES.filter((audience) => wanted.has(audience))
}

export interface Sharing {
  readonly visibility: readonly FileAudience[]
  readonly companyId: string | null
  readonly floorSiteId: string | null
  readonly partyId: string | null
}

/** The problems of a sharing (empty when consistent): the trigger's invariants, said for the person. */
export function sharingProblems(sharing: Sharing, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const floor = sharing.visibility.includes('FLOOR')
  const party = sharing.visibility.includes('PARTNER') || sharing.visibility.includes('LINK')
  if (floor !== (sharing.floorSiteId !== null)) {
    problems.push({ path: `${at}/floorSiteId`, message: floor ? 'Name the site whose floor sees the file.' : 'Only a file shared with the floor names a site.' })
  }
  if (floor && sharing.companyId === null) problems.push({ path: `${at}/companyId`, message: 'A file shared with a floor belongs to that site\'s company.' })
  if (party !== (sharing.partyId !== null)) {
    problems.push({ path: `${at}/partyId`, message: party ? 'Name the party the file is shared with.' : 'Only a file shared with a portal or a link names a party.' })
  }
  return problems
}

/** `at` plus whole calendar years (UTC), for the retention date. */
export function addYears(at: Date, years: number): Date {
  const next = new Date(at.getTime())
  next.setUTCFullYear(next.getUTCFullYear() + years)
  return next
}

/** The retention a new file gets: a fiscal archive file is kept ten years from its upload (or longer when asked). */
export function retentionFor(kind: FileKind, requested: Date | null, now: Date): { retainUntil: Date | null; problems: Issue[] } {
  if (kind === 'FISCAL_ARCHIVE') {
    const least = addYears(now, FISCAL_RETENTION_YEARS)
    if (requested !== null && requested < least) {
      return { retainUntil: null, problems: [{ path: 'body/retainUntil', message: `A fiscal archive file is kept at least ${FISCAL_RETENTION_YEARS} years (until ${toUtcIso(least)} or later).` }] }
    }
    return { retainUntil: requested ?? least, problems: [] }
  }
  if (requested !== null && requested <= now) return { retainUntil: null, problems: [{ path: 'body/retainUntil', message: 'The retention date is in the future.' }] }
  return { retainUntil: requested, problems: [] }
}

/** What stops a delete now, in words for the person (empty when the file may go). */
export function deleteBlockers(file: { legalHold: boolean; retainUntil: Date | null }, now: Date): string[] {
  const blockers: string[] = []
  if (file.legalHold) blockers.push('the legal hold to be lifted')
  if (file.retainUntil !== null && file.retainUntil > now) blockers.push(`the retention period to end (${toUtcIso(file.retainUntil)})`)
  return blockers
}

/** The facts the move to DELETED needs: the file's retention as stored, and the command's time. */
export interface DeleteFacts {
  readonly legalHold: boolean
  readonly retainUntil: Date | null
  readonly now: Date
}

/** The file's states (A1 §2.5): the trigger allows the same moves. */
export const fileMachine = defineMachine<FileStatus, DeleteFacts>({
  name: 'file',
  states: FILE_STATUSES,
  transitions: { PENDING_UPLOAD: ['AVAILABLE', 'QUARANTINED', 'DELETED'], AVAILABLE: ['DELETED'], QUARANTINED: ['DELETED'] },
  guards: { DELETED: (facts) => deleteBlockers(facts, facts.now) },
})

/**
 * The storage key of a new file (A1 §3.6): `t/<tenantId>/c/<companyId>/<yyyy>/<random>` (`t/<tenantId>/tenant/…`
 * without a company), under `legal/` for the fiscal archive (the locked bucket). `random` is a UUIDv4 (122 random bits),
 * never the file's id: nothing about a key can be guessed from what a caller knows.
 */
export function storageKeyFor(input: { tenantId: string; companyId: string | null; kind: FileKind; now: Date; random: string }): string {
  const owner = input.companyId ? `c/${input.companyId}` : 'tenant'
  const key = `t/${input.tenantId}/${owner}/${input.now.getUTCFullYear()}/${input.random}`
  return input.kind === 'FISCAL_ARCHIVE' ? `legal/${key}` : key
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const KEY = new RegExp(`^(?:legal/)?t/${UUID}/(?:c/${UUID}|tenant)/\\d{4}/${UUID}$`)

/** A key storageKeyFor could have made (the stores refuse any other: no `..`, no stray prefix). */
export const isStorageKey = (key: string): boolean => KEY.test(key)
/** The key belongs to the locked legal store. */
export const isLegalKey = (key: string): boolean => key.startsWith('legal/')

/** A file as the audience check needs it. Absent columns (hidden from a role) count as not shared. */
export interface SeenFile {
  readonly id: string
  readonly recordType: string
  readonly recordId: string
  readonly visibility: readonly FileAudience[]
  readonly floorSiteId?: string | null
  readonly partyId?: string | null
}

export type Viewer =
  | { readonly audience: 'office' | 'system' }
  | { readonly audience: 'floor'; readonly siteId: string }
  | { readonly audience: 'partner'; readonly partyId: string }
  | { readonly audience: 'link'; readonly partyId: string; readonly record: { readonly type: string; readonly id: string } }
  | { readonly audience: 'platform' }

/**
 * Whether a viewer's audience sees the file (COL-050). The office sees every file (its company scope is can()'s);
 * a floor device the files shared with its site's floor; a portal session the files shared with its party's portal; a
 * link the files shared with its party's links that belong to the link's record (or are the link's record).
 * Row-level security already keeps the floor to its site and the partner role to its party; this adds the audience.
 */
export function audienceSees(viewer: Viewer, file: SeenFile): boolean {
  switch (viewer.audience) {
    case 'office':
    case 'system':
      return true
    case 'floor':
      return file.visibility.includes('FLOOR') && file.floorSiteId === viewer.siteId
    case 'partner':
      return file.visibility.includes('PARTNER') && file.partyId === viewer.partyId
    case 'link':
      return (
        file.visibility.includes('LINK') &&
        file.partyId === viewer.partyId &&
        ((viewer.record.type === 'StoredFile' && viewer.record.id === file.id) ||
          (viewer.record.type === file.recordType && viewer.record.id === file.recordId))
      )
    default:
      return false
  }
}
