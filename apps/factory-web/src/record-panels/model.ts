/**
 * The record modules' shared pure part (A2 §2.1; COL-045, COL-050): the API's file and thread words the clients read (api.ts),
 * a record's file as the files-in-depth parts draw it, the followers the Follow control draws, the upload rules (kinds, audiences,
 * types, sizes) and the live refresh of a record's thread. B-TH-280: the old record panels' view model (their thread, files,
 * history and tasks panels, the composer and the history rules) went with the panels; the office's docked thread
 * (areas/_shared/record-thread, lib/record-thread) draws a record's thread now. No React, no API.
 *
 * The API's words (enums, limits) are mirrored here from their source, named on each line; an answer that does not
 * match them is a `contract` error in the client (api.ts), never half-read.
 */

// B-TH-084: the design files the API takes (download-only), as factory-domain lists them.
import { ARTWORK_TYPES, DESIGN_TYPE_BY_EXTENSION, DESIGN_TYPES } from '@nexus/factory-domain/files/design'
import type { FollowReason } from '@nexus/factory-domain/threads/followers'

/** apps/factory-api platform/files/rules.ts FILE_KINDS (B-W2b-96: AUDIO, a voice note of a machine request or job, QHS-189). */
export const FILE_KINDS = ['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE', 'AUDIO'] as const
export type FileKind = (typeof FILE_KINDS)[number]
/** platform/files/rules.ts FILE_STATUSES. */
export const FILE_STATUSES = ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]
/** platform/files/rules.ts FILE_AUDIENCES (COL-050). */
export const FILE_AUDIENCES = ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'] as const
export type FileAudience = (typeof FILE_AUDIENCES)[number]
/** platform/files/rules.ts QUARANTINE_REASONS (B-W2a-42: held for the virus scan, a virus found, the scan failed). */
export const QUARANTINE_REASONS = ['size_mismatch', 'type_mismatch', 'checksum_mismatch', 'scan_pending', 'virus_found', 'scan_failed'] as const
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number]
/** factory-domain threads/rules.ts. */
export const MESSAGE_DIRECTIONS = ['INTERNAL_NOTE', 'OUTBOUND', 'INBOUND'] as const
export const MESSAGE_AUDIENCES = ['OFFICE', 'PARTNER'] as const
export const MESSAGE_CHANNELS = ['APP', 'EMAIL', 'PORTAL'] as const
export const AUTHOR_KINDS = ['USER', 'WORKER', 'PARTY', 'SYSTEM'] as const
export const THREAD_STATUSES = ['OPEN', 'CLOSED'] as const
/** factory-domain email/rules.ts OUTBOUND_STATUSES (B-TH-048: WITHDRAWN, a mail taken back in its 10 seconds after Send). */
export const EMAIL_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'WITHDRAWN'] as const
/** factory-domain threads/timeline.ts TIMELINE_KINDS, plus "all". */
export const TIMELINE_KINDS = ['message', 'change', 'file'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]
export type TimelineFilter = 'all' | TimelineKind

const MIB = 1_048_576
const PDF = 'application/pdf'
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
/** platform/files/rules.ts KIND_RULES.AUDIO. */
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav']
const OFFICE_DOCUMENTS = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
]

/**
 * What each kind of file may hold and how big (platform/files/rules.ts KIND_RULES): the file picker's `accept` list and
 * the size check before anything is sent. The API checks again; nothing a browser would run is accepted at all.
 */
// B-TH-084 (B-TH-231's mirror of the API): design files download-only — Illustrator, EPS, Photoshop as a file or a document, a ZIP a document.
export const KIND_RULES: Readonly<Record<FileKind, { readonly contentTypes: readonly string[]; readonly maxBytes: number }>> = {
  ATTACHMENT: { contentTypes: [PDF, ...IMAGES, ...OFFICE_DOCUMENTS, 'text/csv', 'text/plain', ...ARTWORK_TYPES], maxBytes: 25 * MIB },
  DOCUMENT: { contentTypes: [PDF, ...OFFICE_DOCUMENTS, 'text/csv', ...DESIGN_TYPES], maxBytes: 25 * MIB },
  PHOTO: { contentTypes: IMAGES, maxBytes: 15 * MIB },
  CERTIFICATE: { contentTypes: [PDF, 'image/jpeg', 'image/png'], maxBytes: 20 * MIB },
  FISCAL_ARCHIVE: { contentTypes: [PDF, 'application/xml', 'text/xml', 'application/pkcs7-mime'], maxBytes: 20 * MIB },
  AUDIO: { contentTypes: AUDIO_TYPES, maxBytes: 10 * MIB },
}

/** B-W2b-96 (QHS-189): the records a voice note is added to; elsewhere the panel does not offer AUDIO (it still lists one). */
export const AUDIO_RECORD_TYPES: readonly string[] = ['MaintenanceRequest', 'MaintenanceJob']

// ── a record, its party, a file ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PanelRecord {
  /** The record's model name, as the API names it (`Certificate`, `Quote`). */
  type: string
  id: string
  /** The record's company (its files are filed under it); null for tenant-wide master data. */
  companyId: string | null
  /** The record's site, when it sits on one: a file shared with the floor is shared with this site's floor. */
  siteId?: string | null
}

/** The record's customer, supplier or brand: the only party its shared files may reach (an upload offers Partner / Link with one). */
export interface PanelParty {
  id: string
  name: string
  emails: readonly string[]
}

export interface PanelPerson {
  id: string
  name: string
}

export interface PanelFile {
  id: string
  name: string
  kind: FileKind
  contentType: string
  sizeBytes: number
  status: FileStatus
  visibility: readonly FileAudience[]
  /** The party it is shared with (portal, link). */
  partyId: string | null
  retainUntil: string | null
  legalHold: boolean
  quarantineReason: QuarantineReason | null
  availableAt: string | null
  createdAt: string
  /** B-W2b-177 (on B-W2b-160): the version in its series, the series' first version, when a later one replaced it; the row's version. */
  versionNo?: number
  seriesId?: string | null
  supersededAt?: string | null
  version?: number
}

// ── followers on the record (B-W2a-40; COL-011; the Follow control of the docked thread's Head) ────────────

/** A part that loads on its own. */
export type PanelRead<T> = { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; data: T }

export interface PanelFollower {
  userId: string
  name: string
  me: boolean
  // B-TH-065: the domain's list (ADDED: a colleague added by hand).
  reason: FollowReason
  muted: boolean
  since: string
  addedBy: string | null
}

export interface PanelFollowers {
  count: number
  me: { following: boolean; muted: boolean }
  list: readonly PanelFollower[]
  /** Colleagues who may read the record and do not follow it yet (to add one). */
  candidates: readonly PanelPerson[]
  /** threads.post: may add a colleague. */
  canAdd: boolean
  problem?: string | null
  busy?: boolean
  /** The list open at once (design fixtures). */
  open?: boolean
}

/**
 * Record types whose files (all, or some kinds) only their own module uploads (apps/factory-api platform/files/owned.ts
 * MODULE_OWNED_FILES): the generic upload answers 409 for them, so the panel does not offer those kinds. `all`: every kind.
 */
export const MODULE_OWNED_KINDS: Readonly<Record<string, readonly FileKind[] | 'all'>> = {
  ComplianceDocument: 'all',
  Certificate: ['CERTIFICATE'],
  Parcel: 'all',
  Ddt: ['FISCAL_ARCHIVE'],
  PrivacyNotice: 'all',
  PrivacyDpia: 'all',
}

/** The kinds of this record type's files that only its module uploads. */
export function ownedKinds(recordType: string): readonly FileKind[] {
  const owned = Object.hasOwn(MODULE_OWNED_KINDS, recordType) ? MODULE_OWNED_KINDS[recordType] : undefined
  return owned === undefined ? [] : owned === 'all' ? FILE_KINDS : owned
}

/**
 * The kinds a person may choose at upload (those the record's module does not own: `owned` lists the others, which
 * are added on the record's own page), and the audiences, for this record and person.
 */
export function uploadChoices(input: { can: { readonly share: boolean /* files.manage: share beyond the office at upload */ }; party: PanelParty | null; record: Pick<PanelRecord, 'type' | 'siteId' | 'companyId'> }): {
  kinds: readonly FileKind[]
  owned: readonly FileKind[]
  audiences: FileAudience[]
} {
  const audiences: FileAudience[] = ['OFFICE']
  if (input.can.share) {
    if (input.record.siteId && input.record.companyId) audiences.push('FLOOR')
    if (input.party) audiences.push('PARTNER', 'LINK')
  }
  const owned = ownedKinds(input.record.type)
  const audio = AUDIO_RECORD_TYPES.includes(input.record.type)
  return { kinds: FILE_KINDS.filter((kind) => !owned.includes(kind) && (kind !== 'AUDIO' || audio)), owned, audiences }
}

/** The problem with a picked file before it is announced (a message key and parameters), or null. */
export function uploadProblem(file: { name: string; type: string; size: number }, kind: FileKind): { key: string; params?: Record<string, string | number> } | null {
  const rule = KIND_RULES[kind]
  const type = (file.type || contentTypeOf(file.name)).split(';')[0].trim().toLowerCase()
  if (!rule.contentTypes.includes(type)) return { key: 'files.problem.type' }
  if (file.size < 1) return { key: 'files.problem.empty' }
  if (file.size > rule.maxBytes) return { key: 'files.problem.size', params: { max: rule.maxBytes / MIB } }
  return null
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: PDF,
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  docx: OFFICE_DOCUMENTS[0],
  xlsx: OFFICE_DOCUMENTS[1],
  odt: OFFICE_DOCUMENTS[2],
  ods: OFFICE_DOCUMENTS[3],
  csv: 'text/csv',
  txt: 'text/plain',
  xml: 'application/xml',
  // B-TH-084: design files named but not typed by the browser.
  ...DESIGN_TYPE_BY_EXTENSION,
  p7m: 'application/pkcs7-mime',
  // B-W2b-96: voice notes.
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  wav: 'audio/wav',
}

/** The content type of a file the browser did not type (a .p7m, a .heic on some systems), from its extension. */
export function contentTypeOf(name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  return BY_EXTENSION[extension] ?? 'application/octet-stream'
}

// ── the timeline (COL-002) ──────────────────────────────────────────────────────────────────────────────────────────

/** The `kinds` query of a filter chip. */
export function timelineKinds(filter: TimelineFilter): string | undefined {
  return filter === 'all' ? undefined : filter
}

// ── live refresh (`GET /live`: thread.message_posted, file.available, email.status_changed) ─────────────────────────

export interface LiveChange {
  type: string
  fields: Readonly<Record<string, unknown>>
}

export type PanelPart = 'thread' | 'files' | 'timeline' | 'emails'

/**
 * Which parts of a record's panels a live message refreshes: none unless it names THIS record. A message posted → the
 * thread and the history; a file available → the files and the history; a mail's state → the mail states. A live
 * message is a hint: the panel reads the part again, it never takes data from the message.
 */
export function liveParts(change: LiveChange, record: Pick<PanelRecord, 'type' | 'id'>): PanelPart[] {
  if (change.fields.recordType !== record.type || change.fields.recordId !== record.id) return []
  switch (change.type) {
    case 'thread.message_posted':
      return ['thread', 'timeline', 'emails']
    case 'file.available':
      return ['files', 'timeline']
    // B-W2b-177: a markup drawn, a document's expiry reminder: the files (and their documents) are read again.
    case 'file.marked_up':
    case 'file.expiry_due':
      return ['files']
    case 'email.status_changed':
      return ['emails']
    default:
      return []
  }
}
