import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import { presignedSchema, type Presigned } from '../../record-panels/api'
import { readFromStore } from '../../record-panels/store'

/**
 * Files by link (B-W2b-163 on the API; design links.file SCR-272, links.document's W2b parts; COL-051, MES-274). Two
 * sources, one page:
 *
 *   GET  /link/files                          a set of files (DOCUMENT_VIEW or SECURE_FILE of a StoredFile): what was
 *                                             sent, the password and receipt state, the files once unlocked
 *   POST /link/password {password}            the password sent apart → an unlock key for 30 minutes (400 wrong, at
 *                                             `body/password`; 429 held, issues `password/HELD` + `retryAfter`)
 *   POST /link/files/:fileId/download         one file, logged (a use on SECURE_FILE) → a presigned GET for 60 s
 *   GET  /link/files/:fileId/preview          a PDF or a picture in the page (DOCUMENT_VIEW, `preview: 'inline'` rows)
 *   POST /link/files/received {typedName?}    "I received these files" (SECURE_FILE), once (409 `refusal/RECEIVED`)
 *
 *   GET  /people/payroll/link/files           the payroll file a labour consultant downloads (DOCUMENT_VIEW of a
 *   POST /people/payroll/link/files/:id/download   PayrollExport, B-W2b-54): hours only — pay figures never go by link
 *
 * The token travels only in `x-factory-link` (the client the link landing made); the unlock key only in
 * `x-factory-link-unlock`, kept in the page's memory, never in an address or in storage. Every write carries its own
 * Idempotency-Key (a link write without one is refused).
 */

export const UNLOCK_HEADER = 'x-factory-link-unlock'

const unlockHeaders = (unlock: string | null): Record<string, string> | undefined => (unlock ? { [UNLOCK_HEADER]: unlock } : undefined)

const newerSchema = z.object({ versionNo: z.number().nullable(), replacedAt: z.string(), sharedFileId: z.string().nullable() })

export const setFileSchema = z.object({
  id: z.string(),
  position: z.number(),
  name: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  contentType: z.string(),
  preview: z.enum(['inline']).nullable(),
  available: z.boolean(),
  /** The API also sends its English words (`words`): the page says its own from the number and the day. */
  newer: newerSchema.nullable(),
})
export type SetFile = z.infer<typeof setFileSchema>

export const fileSetSchema = z.object({
  link: z.object({
    purpose: z.string(),
    expiresAt: z.string(),
    usesLeft: z.number(),
    password: z.object({ asked: z.boolean(), unlocked: z.boolean(), heldUntil: z.string().nullable() }),
    receipt: z.object({ asked: z.boolean(), at: z.string().nullable(), name: z.string().nullable() }),
  }),
  sender: z.object({ companyName: z.string() }),
  count: z.number(),
  files: z.array(setFileSchema),
})
export type FileSet = z.infer<typeof fileSetSchema>

/** `GET /link/files` (reading uses nothing). */
export function readFileSet(api: ApiClient, unlock: string | null, signal?: AbortSignal): Promise<FileSet> {
  return api.get('/link/files', { schema: fileSetSchema, headers: unlockHeaders(unlock), signal })
}

const unlockSchema = z.object({ unlock: z.string(), unlockedUntil: z.string() })
export type Unlocked = z.infer<typeof unlockSchema>

/** `POST /link/password`: the right one answers the unlock key. */
export function sendPassword(api: ApiClient, password: string, idempotencyKey: string = newIdempotencyKey()): Promise<Unlocked> {
  return api.post('/link/password', { body: { password }, schema: unlockSchema, idempotencyKey })
}

const setDownloadSchema = z.object({ fileId: z.string(), name: z.string(), usesLeft: z.number(), download: presignedSchema })
const previewSchema = z.object({ fileId: z.string(), mode: z.literal('inline'), preview: presignedSchema })

/** One file of a set: the logged download (`usesLeft` after it) and its presigned GET. */
export interface Downloaded {
  readonly fileId: string
  readonly usesLeft: number
  readonly download: Presigned
}

export async function downloadSetFile(api: ApiClient, fileId: string, unlock: string | null, idempotencyKey: string): Promise<Downloaded> {
  const answer = await api.post(`/link/files/${encodeURIComponent(fileId)}/download`, { body: {}, schema: setDownloadSchema, headers: unlockHeaders(unlock), idempotencyKey })
  return { fileId: answer.fileId, usesLeft: answer.usesLeft, download: answer.download }
}

/** `GET /link/files/:fileId/preview` (DOCUMENT_VIEW): a presigned inline GET; reading it uses nothing. */
export async function previewSetFile(api: ApiClient, fileId: string, unlock: string | null, signal?: AbortSignal): Promise<Presigned> {
  const answer = await api.get(`/link/files/${encodeURIComponent(fileId)}/preview`, { schema: previewSchema, headers: unlockHeaders(unlock), signal })
  return answer.preview
}

const receiptSchema = z.object({ receipt: z.object({ at: z.string(), name: z.string().nullable() }) })

/** `POST /link/files/received`: the typed name is optional. */
export async function confirmReceipt(api: ApiClient, typedName: string | null, unlock: string | null, idempotencyKey: string): Promise<{ at: string; name: string | null }> {
  const answer = await api.post('/link/files/received', { body: typedName ? { typedName } : {}, schema: receiptSchema, headers: unlockHeaders(unlock), idempotencyKey })
  return answer.receipt
}

// ---- the payroll file (B-W2b-54's routes) ---------------------------------------------------------------------------

export const PAYROLL_FILE_KINDS = ['DATA', 'SUMMARY'] as const

export const payrollFilesSchema = z.object({
  /** The company's legal name. */
  sender: z.string(),
  month: z.string(),
  /** The API's Italian label: the page writes the month in the reader's language from `month`. */
  label: z.string(),
  number: z.string().nullable(),
  revision: z.number(),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number() }),
  files: z.array(z.object({ id: z.string(), kind: z.enum(PAYROLL_FILE_KINDS), name: z.string(), sizeBytes: z.number(), sha256: z.string() })),
})
export type PayrollFiles = z.infer<typeof payrollFilesSchema>

export function readPayrollFiles(api: ApiClient, signal?: AbortSignal): Promise<PayrollFiles> {
  return api.get('/people/payroll/link/files', { schema: payrollFilesSchema, signal })
}

const payrollDownloadSchema = z.object({ fileId: z.string(), fileName: z.string(), usesLeft: z.number(), download: presignedSchema })

export async function downloadPayrollFile(api: ApiClient, fileId: string, idempotencyKey: string): Promise<Downloaded> {
  const answer = await api.post(`/people/payroll/link/files/${encodeURIComponent(fileId)}/download`, { body: {}, schema: payrollDownloadSchema, idempotencyKey })
  return { fileId: answer.fileId, usesLeft: answer.usesLeft, download: answer.download }
}

/** The bytes behind a presigned GET (the store's request, not an API call). */
export const presignedBytes = (presigned: Presigned): Promise<Uint8Array> => readFromStore(presigned)
