import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Import & export's calls (B-W0-28, SCR-017; apps/factory-api platform/imports): the importers this person may use,
 * the import jobs, a job's planned rows, start (the sheet announced as a file upload, its bytes sent straight to the
 * store, then confirmed: the worker reads it and plans the dry run), apply and cancel. Each answer is checked against
 * its shape. Mirrors platform/imports/contract.ts and factory-domain imports/{job,importer,cells}.ts (named per line);
 * the web never imports the API's source. Files (the template, the refused rows) are plain links, not calls.
 */

// factory-domain imports/job.ts IMPORT_STATUSES, IMPORT_MODES, ROW_OUTCOMES, CSV_ENCODINGS, IMPORT_LIMITS.maxBytes.
export const IMPORT_STATUSES = ['UPLOADED', 'PLANNED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED'] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]
export const IMPORT_MODES = ['DRY_RUN', 'APPLY'] as const
export const ROW_OUTCOMES = ['APPLIED', 'SKIPPED'] as const
export type RowOutcome = (typeof ROW_OUTCOMES)[number]
export const CSV_ENCODINGS = ['utf-8', 'windows-1252'] as const
export const IMPORT_MAX_BYTES = 10 * 1_048_576
// factory-domain imports/importer.ts ROW_ACTIONS; imports/cells.ts NUMBER_FORMATS.
export const ROW_ACTIONS = ['CREATE', 'UPDATE', 'UNCHANGED', 'ERROR'] as const
export type RowAction = (typeof ROW_ACTIONS)[number]
export const NUMBER_FORMATS = ['it', 'en'] as const
export type NumberFormat = (typeof NUMBER_FORMATS)[number]

const issue = z.object({ path: z.string(), message: z.string() })
const rowIssue = z.object({ column: z.string().optional(), message: z.string() })

/** platform/imports/contract.ts jobView. */
export const importJobSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  importerKey: z.string(),
  importerLabel: z.string().nullable(),
  fileId: z.string(),
  fileName: z.string(),
  fileStatus: z.string(),
  sheetName: z.string().nullable(),
  encoding: z.enum(CSV_ENCODINGS).nullable(),
  numberFormat: z.enum(NUMBER_FORMATS),
  mapping: z.record(z.string(), z.string().nullable()).nullable(),
  /** What the dry run read (format, sheet, headers, mapped and ignored columns); never cell values. */
  layout: z.unknown().nullable(),
  status: z.enum(IMPORT_STATUSES),
  mode: z.enum(IMPORT_MODES),
  rowCount: z.number(),
  createCount: z.number(),
  updateCount: z.number(),
  unchangedCount: z.number(),
  errorCount: z.number(),
  appliedCount: z.number(),
  skippedCount: z.number(),
  issues: z.array(issue).nullable(),
  error: z.string().nullable(),
  plannedAt: z.string().nullable(),
  applyRequestedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdById: z.string().nullable(),
})
export type ImportJob = z.infer<typeof importJobSchema>

/** platform/imports/contract.ts rowView. `before` / `after` are plain JSON (money only with its grain). */
export const importRowSchema = z.object({
  rowNumber: z.number(),
  action: z.enum(ROW_ACTIONS),
  key: z.string().nullable(),
  recordId: z.string().nullable(),
  errors: z.array(rowIssue).nullable(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  outcome: z.enum(ROW_OUTCOMES).nullable(),
  note: z.string().nullable(),
  appliedAt: z.string().nullable(),
})
export type ImportRow = z.infer<typeof importRowSchema>

const columnSchema = z.object({
  name: z.string(),
  label: z.string(),
  aliases: z.array(z.string()),
  required: z.boolean(),
  grain: z.string().nullable(),
  describe: z.string().nullable(),
  values: z.array(z.string()).nullable(),
  description: z.string().nullable(),
})
/** platform/imports/contract.ts importersContract: the importers whose own permissions this person holds. */
export const importerSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  columns: z.array(columnSchema),
  keyColumns: z.array(z.string()),
  maxRows: z.number(),
})
export type Importer = z.infer<typeof importerSchema>

/** platform/imports/jobs.ts Layout (read from the job's `layout`). */
export const layoutSchema = z.object({
  format: z.enum(['csv', 'xlsx']),
  sheet: z.string().nullable(),
  sheets: z.array(z.string()),
  encoding: z.string().nullable(),
  delimiter: z.string().nullable(),
  headers: z.array(z.string()),
  columns: z.array(z.object({ index: z.number(), header: z.string(), column: z.string() })),
  ignored: z.array(z.object({ index: z.number(), header: z.string(), reason: z.string() })),
})
export type Layout = z.infer<typeof layoutSchema>

const oneJob = z.object({ job: importJobSchema })

export const listImporters = (api: ApiClient) => api.get('/imports/importers', { schema: z.object({ importers: z.array(importerSchema) }) }).then((answer) => answer.importers)

/** The import jobs this person may see, newest first (the All settings checklist reads the opening stock's). */
export const listImports = (api: ApiClient, query: { importerKey?: string; status?: string; limit?: number } = {}): Promise<ImportJob[]> =>
  api.get('/imports', { query: { importerKey: query.importerKey, status: query.status, limit: query.limit }, schema: z.object({ jobs: z.array(importJobSchema) }) }).then((answer) => answer.jobs)

export const getImport = (api: ApiClient, importId: string) => api.get(`/imports/${encodeURIComponent(importId)}`, { schema: oneJob }).then((answer) => answer.job)

export const listImportRows = (api: ApiClient, importId: string, query: { action?: RowAction; outcome?: RowOutcome; after?: number; limit?: number } = {}) =>
  api.get(`/imports/${encodeURIComponent(importId)}/rows`, { query, schema: z.object({ rows: z.array(importRowSchema), nextAfter: z.number().nullable() }) })

export const applyImport = (api: ApiClient, importId: string, version: number) =>
  api.post(`/imports/${encodeURIComponent(importId)}/apply`, { body: { version }, schema: oneJob, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.job)

export const cancelImport = (api: ApiClient, importId: string, body: { version?: number; reason?: string }) =>
  api.post(`/imports/${encodeURIComponent(importId)}/cancel`, { body, schema: oneJob }).then((answer) => answer.job)

export interface StartImport {
  importerKey: string
  companyId: string | null
  numberFormat: NumberFormat
  sheetName?: string | null
}

/** A sheet's content type from its name (a browser leaves it empty for .csv on some systems). */
export function sheetContentType(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return null
}

/** POST /imports: the job (DRY_RUN) and the presigned request for the sheet's bytes. */
export const startImport = (api: ApiClient, input: StartImport, file: { originalName: string; contentType: string; sizeBytes: number; sha256: string }, idempotencyKey: string) =>
  api.post('/imports', {
    body: {
      importerKey: input.importerKey,
      companyId: input.companyId,
      mode: 'DRY_RUN',
      numberFormat: input.numberFormat,
      ...(input.sheetName ? { sheetName: input.sheetName } : {}),
      file,
    },
    idempotencyKey,
    schema: z.object({ job: importJobSchema, upload: presignedSchema }),
  })

/** POST /files/<id>/complete: the store holds the sheet (file.available starts the dry run). */
export const completeSheet = (api: ApiClient, fileId: string) =>
  api.post(`/files/${encodeURIComponent(fileId)}/complete`, { body: {}, idempotencyKey: newIdempotencyKey(), schema: z.object({ file: z.object({ id: z.string(), status: z.string() }).passthrough() }) })

/**
 * The whole start: announce the sheet (its SHA-256 and size), send its bytes with the presigned PUT, confirm it. The job
 * comes back UPLOADED; the worker plans it. `put` is the store's request (record-panels/store.ts).
 */
export async function uploadSheet(
  api: ApiClient,
  input: StartImport,
  file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  put: (presigned: Presigned, body: ArrayBuffer) => Promise<void> = putToStore,
): Promise<ImportJob> {
  const contentType = sheetContentType(file.name)
  if (!contentType) throw new TypeError('Not a .csv or .xlsx file.')
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const { job, upload } = await startImport(api, input, { originalName: file.name, contentType, sizeBytes: file.size, sha256 }, newIdempotencyKey())
  await put(upload, bytes)
  await completeSheet(api, job.fileId)
  return job
}
