import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../lib/api/client'
import {
  AUTHOR_KINDS,
  EMAIL_STATUSES,
  FILE_AUDIENCES,
  FILE_KINDS,
  FILE_STATUSES,
  MESSAGE_AUDIENCES,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  QUARANTINE_REASONS,
  THREAD_STATUSES,
  type FileAudience,
  type FileKind,
  type TimelineFilter,
  timelineKinds,
} from './model'

/**
 * The record panels' calls to the factory API (apps/factory-api CLAUDE.md "Record threads", "Files on R2", "Email out"),
 * through the ONE client (lib/api/client.ts). Each answer is checked against the shape the panel reads; fields it does
 * not read are ignored, so a new field on the API never breaks a panel. Writes carry an Idempotency-Key, so a retry after
 * a lost answer never posts twice.
 */

const recordPath = (type: string, id: string) => `/threads/${encodeURIComponent(type)}/${encodeURIComponent(id)}`

export const threadSchema = z.object({
  id: z.string(),
  partyId: z.string().nullable(),
  status: z.enum(THREAD_STATUSES),
  version: z.number().int(),
})

export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(FILE_KINDS),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(FILE_STATUSES),
  // B-TH-231 (B-TH-083): a measurement sheet this reader may not open (no name).
  locked: z.literal('MEASUREMENTS').optional(),
})

/** B-TH-236 (B-TH-050): a message another points at ("In reply to Anna, 14 Nov: …"); the author is null for a floor worker kept back. */
const linkedSchema = z.object({ id: z.string(), authorName: z.string().nullable(), excerpt: z.string(), at: z.string() })

export const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  audience: z.enum(MESSAGE_AUDIENCES),
  channel: z.enum(MESSAGE_CHANNELS),
  author: z.object({ kind: z.enum(AUTHOR_KINDS), id: z.string().nullable().optional(), name: z.string().nullable() }),
  authorHidden: z.boolean().default(false),
  forFloor: z.boolean().default(false),
  body: z.string(),
  bodyHtml: z.string().nullable(),
  mentions: z.array(z.string()).optional(),
  attachments: z.array(attachmentSchema),
  // B-TH-231 (B-TH-029): files of the message the reader may not see, counted ("One file you cannot open").
  hiddenAttachments: z.number().int().optional(),
  // ---- B-TH-236 (B-TH-049, B-TH-050): the price typed in the amount field (office, price grain only: the API drops it otherwise),
  // what the message answers or corrects, and the newest message that corrects it ("Corrected below").
  amount: z.object({ value: z.number().int(), currency: z.string() }).nullable().optional(),
  replyTo: linkedSchema.nullable().optional(),
  corrects: linkedSchema.nullable().optional(),
  correctedBy: z.object({ id: z.string(), at: z.string() }).nullable().optional(),
  // ---- end B-TH-236
  at: z.string(),
})
export type ApiMessage = z.infer<typeof messageSchema>

export const fileSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  recordType: z.string(),
  recordId: z.string(),
  kind: z.enum(FILE_KINDS),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(FILE_STATUSES),
  visibility: z.array(z.enum(FILE_AUDIENCES)),
  partyId: z.string().nullable().optional(),
  retainUntil: z.string().nullable(),
  legalHold: z.boolean().optional(),
  quarantineReason: z.enum(QUARANTINE_REASONS).nullable(),
  availableAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
  // B-W2b-177 (on B-W2b-160): the version in its series.
  versionNo: z.number().int().optional(),
  seriesId: z.string().nullable().optional(),
  supersededAt: z.string().nullable().optional(),
  // ---- B-TH-231: a copy names its source (B-TH-024); B-TH-083: what the file is, and a sheet this reader may not open.
  sourceFileId: z.string().nullable().optional(),
  origin: z.object({ fileId: z.string(), recordType: z.string(), recordId: z.string(), originalName: z.string(), versionNo: z.number().int() }).nullable().optional(),
  category: z.string().nullable().optional(),
  locked: z.literal('MEASUREMENTS').optional(),
  // ---- end B-TH-231
})
export type ApiFile = z.infer<typeof fileSchema>

export const presignedSchema = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
export type Presigned = z.infer<typeof presignedSchema>

const emailSchema = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  to: z.array(z.string()),
  subject: z.string(),
  status: z.enum(EMAIL_STATUSES),
  // ---- B-TH-236 (B-TH-048): until when its sender may still take it back ("Sending… · Undo"), and who sent it (the Undo is theirs).
  cc: z.array(z.string()).optional(),
  undoUntil: z.string().nullable().optional(),
  sentById: z.string().nullable().optional(),
  // ---- end B-TH-236
})
export type ApiEmail = z.infer<typeof emailSchema>

const actorAudience = z.enum(['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM'])
export const timelineEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string(),
    at: z.string(),
    direction: z.enum(MESSAGE_DIRECTIONS),
    channel: z.enum(MESSAGE_CHANNELS),
    author: z.object({ kind: z.enum(AUTHOR_KINDS), id: z.string().nullable(), name: z.string().nullable() }),
    authorHidden: z.boolean().default(false),
    excerpt: z.string(),
    attachmentCount: z.number().int(),
  }),
  z.object({
    kind: z.literal('change'),
    id: z.string(),
    at: z.string(),
    action: z.string(),
    actor: z.object({ audience: actorAudience, id: z.string().nullable() }),
    actorHidden: z.boolean().default(false),
    status: z.object({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
    fields: z.array(z.string()),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('file'),
    id: z.string(),
    at: z.string(),
    fileKind: z.enum(FILE_KINDS),
    originalName: z.string(),
    status: z.enum(FILE_STATUSES),
    visibility: z.array(z.enum(FILE_AUDIENCES)),
  }),
])
export type ApiTimelineEntry = z.infer<typeof timelineEntrySchema>

export interface RecordKey {
  type: string
  id: string
}

/** GET /threads/<type>/<id>/emails: the mail sent from the thread and where each one is. */
export function listEmails(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<{ emails: ApiEmail[] }> {
  return api.get(`${recordPath(record.type, record.id)}/emails`, { query: { limit: 200 }, schema: z.object({ emails: z.array(emailSchema) }), signal })
}

/** GET /threads/<type>/<id>/timeline: the record's history, newest first, filtered by kind. */
export function readTimeline(api: ApiClient, record: RecordKey, filter: TimelineFilter, cursor?: string | null, signal?: AbortSignal): Promise<{ entries: ApiTimelineEntry[]; nextCursor: string | null }> {
  return api.get(`${recordPath(record.type, record.id)}/timeline`, {
    query: { kinds: timelineKinds(filter), cursor: cursor ?? undefined, limit: 50 },
    schema: z.object({ entries: z.array(timelineEntrySchema), nextCursor: z.string().nullable() }),
    signal,
  })
}

/**
 * GET /threads/<type>/<id>/people: who a note on the record may mention. T7 (production lane agreement): `tag`, a small label
 * the API gives (the record's production supervisor), tagged people first — kept here so MentionInput shows it.
 */
export function listPeople(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<{ people: Array<{ id: string; name: string; /* T7 */ tag?: string | undefined }> }> {
  return api.get(`${recordPath(record.type, record.id)}/people`, { schema: z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), /* T7 */ tag: z.string().optional() })) }), signal })
}

/** GET /files?recordType&recordId: the record's files. */
export function listFiles(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<{ files: ApiFile[] }> {
  return api.get('/files', { query: { recordType: record.type, recordId: record.id }, schema: z.object({ files: z.array(fileSchema) }), signal })
}

/** POST /threads/<type>/<id>/notes: an internal note (COL-003: never reaches a party). `forFloor`: a work order's, the tablets read it too. */
export function postNote(api: ApiClient, record: RecordKey, input: { body: string; mentions: readonly string[]; attachments: readonly string[]; forFloor?: boolean }): Promise<unknown> {
  return api.post(`${recordPath(record.type, record.id)}/notes`, {
    body: { body: input.body, mentions: [...input.mentions], attachments: [...input.attachments], ...(input.forFloor ? { forFloor: true } : {}) },
    idempotencyKey: newIdempotencyKey(),
  })
}

/** PUT /threads/<type>/<id>/status: close or reopen, with the version as read (COL-078). */
export function setThreadStatus(api: ApiClient, record: RecordKey, status: 'OPEN' | 'CLOSED', version: number): Promise<unknown> {
  return api.request('PUT', `${recordPath(record.type, record.id)}/status`, { body: { status, version }, idempotencyKey: newIdempotencyKey() })
}

export interface UploadAnnouncement {
  companyId: string | null
  record: RecordKey
  kind: FileKind
  name: string
  contentType: string
  sizeBytes: number
  sha256: string
  visibility: readonly FileAudience[]
  floorSiteId: string | null
  partyId: string | null
  /** B-TH-231 (B-TH-083): "This is a measurement sheet" (filed MEASUREMENTS: opened only with sales.measurements.view). */
  measurementSheet?: boolean
}

/** POST /files: announce an upload; the answer holds the presigned request to send the bytes with. */
export function requestUpload(api: ApiClient, input: UploadAnnouncement): Promise<{ file: ApiFile; upload: Presigned }> {
  const shared = input.visibility.filter((audience) => audience !== 'OFFICE')
  return api.post('/files', {
    body: {
      companyId: input.companyId,
      recordType: input.record.type,
      recordId: input.record.id,
      kind: input.kind,
      originalName: input.name,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      visibility: ['OFFICE', ...shared],
      ...(shared.includes('FLOOR') ? { floorSiteId: input.floorSiteId } : {}),
      ...(shared.includes('PARTNER') || shared.includes('LINK') ? { partyId: input.partyId } : {}),
      ...(input.measurementSheet ? { measurementSheet: true } : {}),
    },
    schema: z.object({ file: fileSchema, upload: presignedSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
}

/** POST /files/<id>/complete: the store holds it; AVAILABLE, or QUARANTINED with why. */
export function completeUpload(api: ApiClient, fileId: string): Promise<{ file: ApiFile }> {
  return api.post(`/files/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: fileSchema }), idempotencyKey: newIdempotencyKey() })
}

/** GET /files/<id>/download: a presigned GET that lives 60 seconds (always an attachment). */
export function downloadLink(api: ApiClient, fileId: string): Promise<{ download: Presigned }> {
  return api.get(`/files/${encodeURIComponent(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
}
