/**
 * SCR-006 — the record panels' pure part (A2 §2.1; features COL-001, COL-002, COL-003, COL-024, COL-045, COL-050,
 * COL-078): the view model every record page's panels draw, and the rules the composer, the files list and the live
 * refresh follow. No React, no API: the tests hold it, the view draws it, the container (RecordPanels.tsx) fills it.
 *
 * The API's words (enums, limits) are mirrored here from their source, named on each line; an answer that does not
 * match them is a `contract` error in the client (api.ts), never half-read.
 */

/** apps/factory-api platform/files/rules.ts FILE_KINDS. */
export const FILE_KINDS = ['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE'] as const
export type FileKind = (typeof FILE_KINDS)[number]
/** platform/files/rules.ts FILE_STATUSES. */
export const FILE_STATUSES = ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]
/** platform/files/rules.ts FILE_AUDIENCES (COL-050). */
export const FILE_AUDIENCES = ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'] as const
export type FileAudience = (typeof FILE_AUDIENCES)[number]
/** platform/files/rules.ts QUARANTINE_REASONS. */
export const QUARANTINE_REASONS = ['size_mismatch', 'type_mismatch', 'checksum_mismatch'] as const
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number]
/** factory-domain threads/rules.ts. */
export const MESSAGE_DIRECTIONS = ['INTERNAL_NOTE', 'OUTBOUND', 'INBOUND'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]
export const MESSAGE_AUDIENCES = ['OFFICE', 'PARTNER'] as const
export const MESSAGE_CHANNELS = ['APP', 'EMAIL', 'PORTAL'] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]
export const AUTHOR_KINDS = ['USER', 'WORKER', 'PARTY', 'SYSTEM'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]
export const THREAD_STATUSES = ['OPEN', 'CLOSED'] as const
export type ThreadStatus = (typeof THREAD_STATUSES)[number]
/** factory-domain email/rules.ts OUTBOUND_STATUSES. */
export const EMAIL_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const
export type EmailStatus = (typeof EMAIL_STATUSES)[number]
/** factory-domain threads/timeline.ts TIMELINE_KINDS, plus "all". */
export const TIMELINE_KINDS = ['message', 'change', 'file'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]
export type TimelineFilter = 'all' | TimelineKind
export const TIMELINE_FILTERS: readonly TimelineFilter[] = ['all', ...TIMELINE_KINDS]

/** factory-domain threads/rules.ts MAX_BODY_LENGTH, MAX_MENTIONS, MAX_ATTACHMENTS. */
export const MAX_BODY_LENGTH = 20_000
export const MAX_MENTIONS = 20
export const MAX_ATTACHMENTS = 20
/** factory-domain email/rules.ts MAX_RECIPIENTS, MAX_SUBJECT_LENGTH, MAX_ATTACHMENT_BYTES. */
export const MAX_RECIPIENTS = 50
export const MAX_SUBJECT_LENGTH = 200
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024

const MIB = 1_048_576
const PDF = 'application/pdf'
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
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
export const KIND_RULES: Readonly<Record<FileKind, { readonly contentTypes: readonly string[]; readonly maxBytes: number }>> = {
  ATTACHMENT: { contentTypes: [PDF, ...IMAGES, ...OFFICE_DOCUMENTS, 'text/csv', 'text/plain'], maxBytes: 25 * MIB },
  DOCUMENT: { contentTypes: [PDF, ...OFFICE_DOCUMENTS, 'text/csv'], maxBytes: 25 * MIB },
  PHOTO: { contentTypes: IMAGES, maxBytes: 15 * MIB },
  CERTIFICATE: { contentTypes: [PDF, 'image/jpeg', 'image/png'], maxBytes: 20 * MIB },
  FISCAL_ARCHIVE: { contentTypes: [PDF, 'application/xml', 'text/xml', 'application/pkcs7-mime'], maxBytes: 20 * MIB },
}

/** How long fiscal documents are kept at least (c.c. art. 2220; DPR 600/1973 art. 22), as the API sets it. */
export const FISCAL_RETENTION_YEARS = 10

// ── the view model ────────────────────────────────────────────────────────────────────────────────────────────────

export type PanelTab = 'thread' | 'files' | 'history'
export const PANEL_TABS: readonly PanelTab[] = ['thread', 'files', 'history']

export interface PanelRecord {
  /** The record's model name, as the API names it (`Certificate`, `Quote`). */
  type: string
  id: string
  /** The record's company (its files are filed under it); null for tenant-wide master data. */
  companyId: string | null
  /** The record's site, when it sits on one: a file shared with the floor is shared with this site's floor. */
  siteId?: string | null
}

/** The record's customer, supplier or brand: the only party its shared messages and files may reach. */
export interface PanelParty {
  id: string
  name: string
  /** Its known addresses, for the email's To line (the parties module fills them; W0 has none). */
  emails: readonly string[]
}

/** What the person may do here: from their permissions over the record (the API checks each call again). */
export interface PanelAbilities {
  /** threads.post: write an internal note. */
  post: boolean
  /** email.send: send a mail to the record's party. */
  email: boolean
  /** threads.manage: close or reopen the thread. */
  manage: boolean
  /** files.read: the files and their downloads. */
  readFiles: boolean
  /** files.upload. */
  upload: boolean
  /** files.manage: share a file beyond the office when it is uploaded. */
  share: boolean
}

export interface PanelPerson {
  id: string
  name: string
}

export interface MessageAttachment {
  id: string
  name: string
  sizeBytes: number
  contentType: string
  status: FileStatus
}

export interface PanelEmail {
  to: readonly string[]
  subject: string
  status: EmailStatus
}

export interface PanelMessage {
  id: string
  direction: MessageDirection
  channel: MessageChannel
  authorKind: AuthorKind
  /** Null: a system message, or a writer the reader may not see. */
  authorName: string | null
  /** ISO instant (UTC). */
  at: string
  body: string
  /** The people a note mentioned, by name; null for a person the panel does not know ("someone"). */
  mentions: readonly (string | null)[]
  attachments: readonly MessageAttachment[]
  /** For a mail the office sent: to whom, its subject and where it is. */
  email: PanelEmail | null
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
}

/** An upload this screen is making, before its file is on the list. */
export interface PanelUpload {
  key: string
  name: string
  sizeBytes: number
  phase: 'hashing' | 'uploading' | 'confirming' | 'failed'
  /** Why it failed: a message key of the `records` catalogue. */
  problem?: string
}

export type PanelTimelineEntry =
  | {
      kind: 'message'
      id: string
      at: string
      direction: MessageDirection
      channel: MessageChannel
      authorName: string | null
      excerpt: string
      attachmentCount: number
    }
  | {
      kind: 'change'
      id: string
      at: string
      /** The command (`compliance.certificates.issue`). */
      action: string
      /** Who did it: a name when the panel knows the person, else null (the audience says who). */
      actorName: string | null
      actorAudience: 'OFFICE' | 'FLOOR' | 'PARTNER' | 'LINK' | 'SYSTEM'
      status: { from: string | null; to: string | null } | null
      fields: readonly string[]
      /** The values, only when the API gave them (audit.read over the row; money only with its grain). */
      values: { before: unknown; after: unknown } | null
      reason: string | null
    }
  | {
      kind: 'file'
      id: string
      at: string
      name: string
      fileKind: FileKind
      status: FileStatus
      visibility: readonly FileAudience[]
    }

/** A list that loads: null while it is read the first time. */
export interface Loaded<T> {
  items: readonly T[] | null
  /** More (older) entries exist. */
  more: boolean
  /** The read failed: a message key. */
  problem?: string | null
}

export interface RecordPanelsViewModel {
  record: PanelRecord
  /** The record's name as its page shows it ("Certificate 0000-17092-A"), for the panel's accessible name. */
  title: string
  party: PanelParty | null
  can: PanelAbilities
  /** The tab open at first. Default thread. */
  tab?: PanelTab
  /** Null: the record has no message yet. */
  thread: { status: ThreadStatus; version: number } | null
  messages: Loaded<PanelMessage>
  files: Loaded<PanelFile>
  uploads: readonly PanelUpload[]
  timeline: Loaded<PanelTimelineEntry>
  timelineFilter: TimelineFilter
  /** Who a note may mention (the person themself left out). */
  people: readonly PanelPerson[]
  /** The person signed in (their own messages say "you"). */
  me?: string | null
  /** A notice over the panels: a message key of the `records` catalogue, with its tone. */
  notice?: { key: string; tone: 'success' | 'info' | 'warning' | 'danger' } | null
  /** A PDF open in the viewer: the file and its bytes (or address). */
  preview?: { fileId: string; name: string; src: string | Uint8Array } | null
  /** The composer opens on this mode (design fixtures). */
  composerMode?: ComposerMode
  /** Text already in the composer (design fixtures). */
  composerText?: string
  /** The composer is sending. */
  sending?: boolean
}

// ── the composer (COL-003: internal note vs external message; COL-024: mail as the person) ──────────────────────────

export type ComposerMode = 'note' | 'email'

/**
 * The composer's modes, in order. An internal note needs threads.post; a message to the party needs a party on the
 * record AND email.send — never one without the other, so a note can never be mistaken for a message that leaves.
 */
export function composerModes(input: { can: Pick<PanelAbilities, 'post' | 'email'>; party: PanelParty | null }): ComposerMode[] {
  const modes: ComposerMode[] = []
  if (input.can.post) modes.push('note')
  if (input.can.email && input.party !== null) modes.push('email')
  return modes
}

/** Why the composer is not offered at all (a message key), or null when it is. */
export function composerAbsentReason(input: { can: Pick<PanelAbilities, 'post' | 'email'>; party: PanelParty | null }): string | null {
  if (composerModes(input).length > 0) return null
  return input.can.email && input.party === null ? 'composer.absent.noParty' : 'composer.absent.noPermission'
}

/** The addresses typed in a To line (commas, semicolons, spaces or new lines between them). */
export function parseAddresses(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  for (const part of parts) {
    const address = part.replace(/^<|>$/g, '').toLowerCase()
    if (/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(address) && address.length <= 254) {
      if (!valid.includes(address)) valid.push(address)
    } else invalid.push(part)
  }
  return { valid, invalid }
}

export interface ComposerDraft {
  mode: ComposerMode
  body: string
  /** Email: the To line as typed. */
  to: string
  subject: string
  mentions: readonly string[]
  attachments: readonly string[]
}

/**
 * Why the send is held (a message key and its parameters), or null when it may go. First that applies: the thread is
 * closed, it is sending, the text is empty or too long, (email) no or a wrong address, too many addresses, no subject on
 * a first mail (an answer takes the last mail's), a subject too long, attachments too large together; too many mentions
 * or files.
 */
export function composerHeld(
  draft: ComposerDraft,
  context: {
    threadClosed: boolean
    sending: boolean
    files: readonly Pick<PanelFile, 'id' | 'sizeBytes'>[]
    /** The thread has a mail already, whose subject an answer without one takes ("Re: …"). */
    hasMail?: boolean
  },
): { key: string; params?: Record<string, string | number> } | null {
  if (context.threadClosed) return { key: 'composer.held.closed' }
  if (context.sending) return { key: 'composer.held.sending' }
  const length = [...draft.body].length
  if (draft.body.trim() === '') return { key: draft.mode === 'note' ? 'composer.held.emptyNote' : 'composer.held.emptyEmail' }
  if (length > MAX_BODY_LENGTH) return { key: 'composer.held.tooLong', params: { count: length - MAX_BODY_LENGTH } }
  if (draft.attachments.length > MAX_ATTACHMENTS) return { key: 'composer.held.tooManyFiles', params: { max: MAX_ATTACHMENTS } }
  if (draft.mode === 'note') {
    if (draft.mentions.length > MAX_MENTIONS) return { key: 'composer.held.tooManyMentions', params: { max: MAX_MENTIONS } }
    return null
  }
  const { valid, invalid } = parseAddresses(draft.to)
  if (invalid.length > 0) return { key: 'composer.held.badAddress', params: { address: invalid[0] } }
  if (valid.length === 0) return { key: 'composer.held.noRecipient' }
  if (valid.length > MAX_RECIPIENTS) return { key: 'composer.held.tooManyRecipients', params: { max: MAX_RECIPIENTS } }
  if (draft.subject.trim() === '' && !context.hasMail) return { key: 'composer.held.noSubject' }
  if ([...draft.subject].length > MAX_SUBJECT_LENGTH) return { key: 'composer.held.subjectTooLong', params: { max: MAX_SUBJECT_LENGTH } }
  const bytes = draft.attachments.reduce((sum, id) => sum + (context.files.find((file) => file.id === id)?.sizeBytes ?? 0), 0)
  if (bytes > MAX_EMAIL_ATTACHMENT_BYTES) return { key: 'composer.held.attachmentsTooLarge' }
  return null
}

/**
 * The record's files a message may carry: AVAILABLE ones for a note; for a mail only those already shared with the
 * record's party (the portal or a link), because the mail hands the party its bytes (COL-050).
 */
export function attachableFiles(files: readonly PanelFile[], mode: ComposerMode, party: PanelParty | null): PanelFile[] {
  return files.filter((file) => {
    if (file.status !== 'AVAILABLE') return false
    if (mode === 'note') return true
    return party !== null && file.partyId === party.id && (file.visibility.includes('PARTNER') || file.visibility.includes('LINK'))
  })
}

// ── files: audiences, versions, retention ───────────────────────────────────────────────────────────────────────

export interface AudienceBadge {
  audience: FileAudience | 'OFFICE_ONLY'
  tone: 'neutral' | 'info' | 'warning'
  /** A message key of the `records` catalogue. */
  key: string
}

/**
 * Who sees a file (COL-050), as badges: "Office only" when nobody else does; otherwise the office and each audience
 * beyond it. A file a party sees (portal or link) is marked as leaving the office (warning tone), so a person never
 * attaches it to a note thinking it is internal.
 */
export function audienceBadges(visibility: readonly FileAudience[]): AudienceBadge[] {
  const shared = FILE_AUDIENCES.filter((audience) => audience !== 'OFFICE' && visibility.includes(audience))
  if (shared.length === 0) return [{ audience: 'OFFICE_ONLY', tone: 'neutral', key: 'files.audience.officeOnly' }]
  return [
    { audience: 'OFFICE', tone: 'neutral', key: 'files.audience.OFFICE' },
    ...shared.map((audience): AudienceBadge => ({ audience, tone: audience === 'FLOOR' ? 'info' : 'warning', key: `files.audience.${audience}` })),
  ]
}

export interface FileGroup {
  key: string
  /** The newest file of the name: the one in use. */
  latest: PanelFile
  /** Its older versions, newest first. */
  earlier: PanelFile[]
}

/**
 * The record's files as documents with versions: files of the same kind and name (case and spaces aside) are versions of
 * one document, the newest on top. DELETED files are left out (the history keeps them). The API keeps no version chain
 * of its own (one StoredFile per upload), so a new version is a new upload with the same name.
 */
export function fileGroups(files: readonly PanelFile[]): FileGroup[] {
  const groups = new Map<string, PanelFile[]>()
  for (const file of files) {
    if (file.status === 'DELETED') continue
    const key = `${file.kind}:${file.name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`
    groups.set(key, [...(groups.get(key) ?? []), file])
  }
  const newest = (a: PanelFile, b: PanelFile) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort(newest)
      return { key, latest: sorted[0], earlier: sorted.slice(1) }
    })
    .sort((a, b) => newest(a.latest, b.latest))
}

export interface RetentionFact {
  key: string
  tone: 'neutral' | 'warning'
  /** The date to show (ISO), when the fact has one. */
  until?: string
}

/**
 * What keeps a file from being deleted, read only (COL-045, PLAN §2.8): a legal hold; a retention date still ahead (a
 * fiscal archive file: ten years at least, c.c. art. 2220). Nothing when the file may go.
 */
export function retentionFacts(file: Pick<PanelFile, 'kind' | 'retainUntil' | 'legalHold'>, now: Date): RetentionFact[] {
  const facts: RetentionFact[] = []
  if (file.legalHold) facts.push({ key: 'files.retention.legalHold', tone: 'warning' })
  if (file.retainUntil !== null && Date.parse(file.retainUntil) > now.getTime()) {
    facts.push({ key: file.kind === 'FISCAL_ARCHIVE' ? 'files.retention.fiscal' : 'files.retention.until', tone: 'neutral', until: file.retainUntil })
  }
  return facts
}

/** A file the viewer can show inline: an available PDF. */
export function canPreview(file: Pick<PanelFile, 'status' | 'contentType'>): boolean {
  return file.status === 'AVAILABLE' && file.contentType.split(';')[0].trim().toLowerCase() === PDF
}

/** The kinds a person may choose at upload, and the audiences, for this record and person. */
export function uploadChoices(input: { can: Pick<PanelAbilities, 'share'>; party: PanelParty | null; record: Pick<PanelRecord, 'siteId' | 'companyId'> }): {
  kinds: readonly FileKind[]
  audiences: FileAudience[]
} {
  const audiences: FileAudience[] = ['OFFICE']
  if (input.can.share) {
    if (input.record.siteId && input.record.companyId) audiences.push('FLOOR')
    if (input.party) audiences.push('PARTNER', 'LINK')
  }
  return { kinds: FILE_KINDS, audiences }
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
  p7m: 'application/pkcs7-mime',
}

/** The content type of a file the browser did not type (a .p7m, a .heic on some systems), from its extension. */
export function contentTypeOf(name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  return BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** The `accept` list of the file picker for a kind. */
export function acceptFor(kind: FileKind): string {
  const types = new Set(KIND_RULES[kind].contentTypes)
  const extensions = Object.entries(BY_EXTENSION).filter(([, type]) => types.has(type)).map(([extension]) => `.${extension}`)
  return [...types, ...extensions].join(',')
}

// ── the timeline (COL-002) ──────────────────────────────────────────────────────────────────────────────────────────

/** The `kinds` query of a filter chip. */
export function timelineKinds(filter: TimelineFilter): string | undefined {
  return filter === 'all' ? undefined : filter
}

const VERBS: Readonly<Record<string, string>> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  issue: 'issued',
  suspend: 'suspended',
  reinstate: 'reinstated',
  withdraw: 'withdrawn',
  archive: 'archived',
  postNote: 'noted',
  setStatus: 'statusChanged',
  send: 'sent',
  requestUpload: 'uploadStarted',
  completeUpload: 'uploaded',
  setVisibility: 'shared',
  setRetention: 'retentionChanged',
  assign: 'assigned',
  release: 'released',
  reject: 'rejected',
}

/** A change's action in words: the message key of its verb (`history.verb.issued`), `history.verb.changed` otherwise. */
export function changeVerbKey(action: string): string {
  const verb = action.slice(action.lastIndexOf('.') + 1)
  return `history.verb.${VERBS[verb] ?? 'changed'}`
}

/** A value of a change, in one short line (the API's before and after are JSON). */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

/** The fields a change shows with before → after: those whose values the API gave, each as one line. */
export function changedValues(entry: Extract<PanelTimelineEntry, { kind: 'change' }>): Array<{ field: string; before: string; after: string }> {
  if (!entry.values) return []
  const before = (entry.values.before ?? {}) as Record<string, unknown>
  const after = (entry.values.after ?? {}) as Record<string, unknown>
  if (typeof before !== 'object' || typeof after !== 'object') return []
  const fields = entry.fields.length > 0 ? entry.fields : [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return fields.filter((field) => field in before || field in after).map((field) => ({ field, before: valueText(before[field]), after: valueText(after[field]) }))
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
    case 'email.status_changed':
      return ['emails']
    default:
      return []
  }
}
