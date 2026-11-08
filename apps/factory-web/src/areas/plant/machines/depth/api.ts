import { z } from 'zod'
import { MACHINE_STATUSES } from '@nexus/factory-domain/plant/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema } from '../../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../../record-panels/store'
import { machineSchema } from '../../_shared/api'

/**
 * Every call of machines in depth (B-W2b-136 on the routes of apps/factory-api modules/plant/machines: contract-depth.ts):
 * the register's depth (tiles, next check, CE on file, tag printed), the tiles as filters, the status wall, Change status,
 * the status history, Documents & CE, and the QR tags sent to a label printer (POST /print/jobs/:id/retry for a failed
 * one). The answers are checked (zod; unknown fields dropped); the API's English is never drawn: the screens say their own
 * words from codes (`refusal/<CODE>`).
 */

const seg = (value: string) => encodeURIComponent(value)
const words = z.record(z.string(), z.string())
const status = z.enum(MACHINE_STATUSES)
export type DepthMachineStatus = z.infer<typeof status>
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const classSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable() })

export const PRINT_STATES = ['QUEUED', 'SENT', 'PRINTED', 'FAILED'] as const
export type PrintState = (typeof PRINT_STATES)[number]
export const DUE_STATES = ['OVERDUE', 'DUE_SOON', 'PLANNED', 'ENDED'] as const

// ---- the register's depth --------------------------------------------------------------------------------------------------

const depthRow = z.object({
  id: z.string(),
  ceOnFile: z.boolean(),
  manuals: z.number(),
  nextCheck: z.object({ planId: z.string(), nextDueOn: z.string(), state: z.enum(DUE_STATES), days: z.number(), checkType: z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words }) }).nullable(),
  tag: z.object({ state: z.enum(PRINT_STATES), jobId: z.string(), at: z.string(), printedAt: z.string().nullable() }).nullable(),
})
export type MachineDepth = z.infer<typeof depthRow>
const depthAnswer = z.object({ tiles: z.object({ checksOverdue: z.number(), noCe: z.number() }), machines: z.array(depthRow), today: z.string() })
export type DepthAnswer = z.infer<typeof depthAnswer>

/** GET /plant/machines/depth: the two tiles, and the facts of the machines named (at most 200). */
export const readDepth = (api: ApiClient, siteId: string | null, ids: readonly string[], signal?: AbortSignal) =>
  api.get('/plant/machines/depth', { query: { ...(siteId ? { siteId } : {}), ...(ids.length > 0 ? { ids: ids.slice(0, 200).join(',') } : {}) }, schema: depthAnswer, signal })

export type Need = 'CE' | 'CHECKS'

/** GET /plant/machines/attention: the machines a tile names (no CE declaration; a check overdue). */
export const readNeeding = (api: ApiClient, query: { siteId: string | null; need: Need; cursor?: string | null; limit: number }, signal?: AbortSignal) =>
  api.get('/plant/machines/attention', {
    query: { need: query.need, limit: String(query.limit), ...(query.siteId ? { siteId: query.siteId } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) },
    schema: z.object({ machines: z.array(machineSchema), nextCursor: z.string().nullable() }),
    signal,
  })

// ---- the status wall -------------------------------------------------------------------------------------------------------

const wallTile = z.object({ id: z.string(), assetNumber: z.string(), siteCode: z.string(), class: classSchema, station: place.nullable(), status, statusSince: z.string(), locked: z.boolean() })
export type WallTile = z.infer<typeof wallTile>
const wallAnswer = z.object({
  lines: z.array(z.object({ line: place.nullable(), siteCode: z.string(), machines: z.array(wallTile) })),
  counts: z.object({ RUNNING: z.number(), DOWN: z.number(), UNDER_MAINTENANCE: z.number(), DO_NOT_USE: z.number(), locked: z.number() }),
  truncated: z.boolean(),
  at: z.string(),
})
export type WallAnswer = z.infer<typeof wallAnswer>

/** GET /plant/machines/wall. */
export const readWall = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/plant/machines/wall', { query: siteId ? { siteId } : {}, schema: wallAnswer, signal })

// ---- Change status and the history ----------------------------------------------------------------------------------------

export const SETTABLE = ['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'] as const
export type Settable = (typeof SETTABLE)[number]

/** POST /plant/machines/:id/status (the key is kept by the caller: a release asks a fresh code and runs again with it). */
export const changeStatus = (api: ApiClient, id: string, body: { version: number; to: Settable; reason: string }, idempotencyKey: string) =>
  api.post(`/plant/machines/${seg(id)}/status`, { body, schema: z.object({ machine: machineSchema, replayed: z.boolean() }), idempotencyKey }).then((answer) => answer.machine)

const eventSchema = z.object({ id: z.string(), at: z.string(), from: status.nullable(), to: status, reason: z.string().nullable() })
export type StatusEvent = z.infer<typeof eventSchema>
const historyAnswer = z.object({
  from: z.string(),
  to: z.string(),
  now: z.string(),
  registeredAt: z.string(),
  before: z.object({ status, reason: z.string().nullable() }).nullable(),
  current: z.object({ status, reason: z.string().nullable(), since: z.string() }),
  events: z.array(eventSchema),
  latest: z.array(eventSchema),
})
export type HistoryAnswer = z.infer<typeof historyAnswer>

/** GET /plant/machines/:id/status-history?from=&days=. */
export const readHistory = (api: ApiClient, id: string, from: string, days: number, signal?: AbortSignal) =>
  api.get(`/plant/machines/${seg(id)}/status-history`, { query: { from, days: String(days) }, schema: historyAnswer, signal })

// ---- Documents & CE --------------------------------------------------------------------------------------------------------

export const DOCUMENT_GROUPS = ['MACHINE_CE', 'MANUAL', 'PHOTO', 'OTHER'] as const
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number]

const documentSchema = z.object({
  id: z.string(),
  group: z.enum(DOCUMENT_GROUPS),
  kind: z.string(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  status: z.string(),
  scanStatus: z.string(),
  onTablets: z.boolean(),
  createdAt: z.string(),
  availableAt: z.string().nullable(),
  version: z.number(),
})
export type MachineDocument = z.infer<typeof documentSchema>
const documentsAnswer = z.object({ documents: z.array(documentSchema), ceOnFile: z.boolean(), canManage: z.boolean() })
export type DocumentsAnswer = z.infer<typeof documentsAnswer>

/** GET /plant/machines/:id/documents. */
export const readDocuments = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/plant/machines/${seg(id)}/documents`, { schema: documentsAnswer, signal })

/** The file kind a picked file goes as, in its group (a PDF is a document; an image a photo). */
export function kindFor(group: DocumentGroup, contentType: string): 'DOCUMENT' | 'CERTIFICATE' | 'PHOTO' {
  if (group === 'PHOTO') return 'PHOTO'
  if (group === 'OTHER' && contentType.startsWith('image/')) return 'PHOTO'
  if (group === 'MACHINE_CE' && contentType.startsWith('image/')) return 'CERTIFICATE'
  return 'DOCUMENT'
}

/**
 * Upload a document: announced to the machine with its group (and whether the site's tablets see it), its bytes sent to
 * the store, then confirmed. One key per upload: a retry after a network failure is the same file.
 */
export async function uploadDocument(api: ApiClient, id: string, file: File, choice: { group: DocumentGroup; onTablets: boolean }, key: string = newIdempotencyKey()): Promise<MachineDocument> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'application/pdf'
  const announced = await api.post(`/plant/machines/${seg(id)}/documents`, {
    body: { group: choice.group, kind: kindFor(choice.group, contentType), originalName: file.name || 'document.pdf', contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes), onTablets: choice.onTablets },
    schema: z.object({ document: documentSchema, upload: presignedSchema }),
    idempotencyKey: `${key}:announce`,
  })
  await putToStore(announced.upload, bytes)
  return (await api.post(`/plant/machines/${seg(id)}/documents/${seg(announced.document.id)}/complete`, { schema: z.object({ document: documentSchema }), idempotencyKey: `${key}:complete` })).document
}

/** GET …/documents/:fileId/download, then the bytes (the address lives 60 s: read at once). */
export async function documentBytes(api: ApiClient, id: string, fileId: string): Promise<{ bytes: Uint8Array; fileName: string; contentType: string }> {
  const answer = await api.get(`/plant/machines/${seg(id)}/documents/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema, fileName: z.string(), contentType: z.string() }) })
  return { bytes: await readFromStore(answer.download), fileName: answer.fileName, contentType: answer.contentType }
}

/** POST …/documents/:fileId/remove. */
export const removeDocument = (api: ApiClient, id: string, fileId: string, body: { version: number; reason: string }) =>
  api.post(`/plant/machines/${seg(id)}/documents/${seg(fileId)}/remove`, { body, schema: z.object({ removed: z.string() }), idempotencyKey: newIdempotencyKey() })

// ---- QR tags ---------------------------------------------------------------------------------------------------------------

const printerSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), siteId: z.string(), siteCode: z.string(), labelWidthMm: z.number(), labelHeightMm: z.number(), dpi: z.number() })
export type LabelPrinter = z.infer<typeof printerSchema>
const tagJob = z.object({ machineId: z.string(), jobId: z.string(), printerId: z.string(), printerCode: z.string(), state: z.enum(PRINT_STATES), copies: z.number(), lastError: z.string().nullable(), at: z.string(), printedAt: z.string().nullable(), version: z.number() })
export type TagJob = z.infer<typeof tagJob>
const refusedTag = z.object({ machineId: z.string(), assetNumber: z.string(), code: z.string(), message: z.string() })
export type RefusedTag = z.infer<typeof refusedTag>

/** GET /plant/machines/tags/printers (print.labels). */
export const readTagPrinters = (api: ApiClient, siteId: string | null, signal?: AbortSignal) =>
  api.get('/plant/machines/tags/printers', { query: siteId ? { siteId } : {}, schema: z.object({ printers: z.array(printerSchema) }), signal }).then((answer) => answer.printers)

/** POST /plant/machines/tags/print: one job per machine; a retired one or one of another site is refused in words. */
export const printTags = (api: ApiClient, body: { printerId: string; machineIds: readonly string[]; copies: number; language: 'it' | 'en' }, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/plant/machines/tags/print', { body: { ...body, machineIds: [...body.machineIds] }, schema: z.object({ jobs: z.array(tagJob), refused: z.array(refusedTag) }), idempotencyKey })

/** GET /plant/machines/tags/jobs?ids=: the newest tag job of each. */
export const readTagJobs = (api: ApiClient, ids: readonly string[], signal?: AbortSignal) =>
  ids.length === 0 ? Promise.resolve([] as TagJob[]) : api.get('/plant/machines/tags/jobs', { query: { ids: ids.slice(0, 200).join(',') }, schema: z.object({ jobs: z.array(tagJob) }), signal }).then((answer) => answer.jobs)

/** POST /print/jobs/:id/retry (print.labels): a failed tag queued again. */
export const retryTagJob = (api: ApiClient, jobId: string, version: number) =>
  api.post(`/print/jobs/${seg(jobId)}/retry`, { body: { version }, schema: z.object({ job: z.object({ id: z.string(), status: z.enum(PRINT_STATES), version: z.number() }) }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.job)
