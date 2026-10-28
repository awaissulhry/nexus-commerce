import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { ROW_ACTIONS } from '@nexus/factory-domain/imports/importer'
import { CSV_ENCODINGS, IMPORT_LIMITS, IMPORT_MODES, IMPORT_STATUSES, ROW_OUTCOMES } from '@nexus/factory-domain/imports/job'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { presignedView } from '../files/contract'

/**
 * The import routes' contracts (plan A1 W0-22; feature PLT-176). The sheet is never sent through the API: POST
 * /imports announces it (as a file upload does) and answers the job with a presigned upload; the client sends the
 * bytes there and confirms the upload with POST /files/:fileId/complete, which starts the dry run. The plan's rows
 * carry the before and after values as free JSON whose money values are marked: a caller without a column's grain gets
 * the row without that value.
 */

const issue = z.object({ path: z.string(), message: z.string() })
const rowIssue = z.object({ column: z.string().optional(), message: z.string() })
const mapping = z.record(z.string().min(1).max(200), z.string().max(64).nullable())

export const jobView = output({
  id: id(),
  companyId: id().nullable(),
  importerKey: z.string(),
  importerLabel: z.string().nullable(),
  fileId: id(),
  fileName: z.string(),
  fileStatus: z.string(),
  sheetName: z.string().nullable(),
  encoding: z.enum(CSV_ENCODINGS).nullable(),
  numberFormat: z.enum(NUMBER_FORMATS),
  mapping: mapping.nullable(),
  /** What the dry run read: format, sheet, encoding, delimiter, headers, mapped and ignored columns (never cell values). */
  layout: z.unknown().nullable(),
  status: z.enum(IMPORT_STATUSES),
  mode: z.enum(IMPORT_MODES),
  rowCount: z.number().int(),
  createCount: z.number().int(),
  updateCount: z.number().int(),
  unchangedCount: z.number().int(),
  errorCount: z.number().int(),
  appliedCount: z.number().int(),
  skippedCount: z.number().int(),
  issues: z.array(issue).nullable(),
  error: z.string().nullable(),
  plannedAt: instant().nullable(),
  applyRequestedAt: instant().nullable(),
  appliedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
})
export type JobView = z.infer<typeof jobView>

export const rowView = output({
  rowNumber: z.number().int(),
  action: z.enum(ROW_ACTIONS),
  /** The key columns' values, as a JSON array. */
  key: z.string().nullable(),
  recordId: id().nullable(),
  errors: z.array(rowIssue).nullable(),
  /** UPDATE: the current values of the columns that change (money only with its grain). */
  before: grainedJson(),
  /** CREATE: every given value; UPDATE: the new values (money only with its grain). */
  after: grainedJson(),
  outcome: z.enum(ROW_OUTCOMES).nullable(),
  note: z.string().nullable(),
  appliedAt: instant().nullable(),
})
export type RowView = z.infer<typeof rowView>

const columnView = z.object({
  name: z.string(),
  label: z.string(),
  aliases: z.array(z.string()),
  required: z.boolean(),
  /** The money grain a column carries: only a person holding it may import it. */
  grain: z.enum(GRAINS).nullable(),
  /** What the column takes ("a number with up to 6 decimals"). */
  describe: z.string().nullable(),
  values: z.array(z.string()).nullable(),
  description: z.string().nullable(),
})

export const importersContract = defineContract({
  response: {
    200: output({
      importers: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          description: z.string().nullable(),
          columns: z.array(columnView),
          keyColumns: z.array(z.string()),
          maxRows: z.number().int(),
        }),
      ),
    }),
  },
})

export const createImportContract = defineContract({
  body: input({
    importerKey: z.string().min(3).max(100),
    /** The company whose records it writes; null or left out for tenant-wide master data. */
    companyId: id().nullable().optional(),
    /** DRY_RUN (default): stop at the plan for a review. APPLY: apply the valid rows when planned (needs imports.apply). */
    mode: z.enum(IMPORT_MODES).optional(),
    /** The Excel sheet to read; default the first. */
    sheetName: z.string().trim().min(1).max(100).nullable().optional(),
    /** The CSV encoding; default detected. */
    encoding: z.enum(CSV_ENCODINGS).nullable().optional(),
    /** How numbers are written: it (1.234,56, the default) or en (1,234.56). */
    numberFormat: z.enum(NUMBER_FORMATS).optional(),
    /** Header overrides: { "<header in the sheet>": "<column>" | null to ignore it }. */
    mapping: mapping.optional(),
    /** The sheet, announced as a file upload: a .csv (text/csv) or .xlsx, at most IMPORT_LIMITS.maxBytes. */
    file: input({
      originalName: z.string().min(1).max(500),
      contentType: z.string().min(1).max(200),
      sizeBytes: z.number().int().min(1).max(IMPORT_LIMITS.maxBytes),
      sha256: z.string(),
    }),
  }),
  response: { 201: output({ job: jobView, upload: presignedView }) },
})

const importParams = input({ importId: id() })
const oneJob = { 200: output({ job: jobView }) }

export const listImportsContract = defineContract({
  querystring: input({
    status: z.enum(IMPORT_STATUSES).optional(),
    importerKey: z.string().max(100).optional(),
    /** Jobs created before this one (paging, newest first). */
    before: id().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  response: { 200: output({ jobs: z.array(jobView) }) },
})

export const getImportContract = defineContract({ params: importParams, response: oneJob })

export const listRowsContract = defineContract({
  params: importParams,
  querystring: input({
    action: z.enum(ROW_ACTIONS).optional(),
    outcome: z.enum(ROW_OUTCOMES).optional(),
    /** Rows after this row number (paging, in sheet order). */
    after: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
  response: { 200: output({ rows: z.array(rowView), nextAfter: z.number().int().nullable() }) },
})

/** The error file: one line per problem of every ERROR row (row, column, message), as CSV. Never a cell value. */
export const errorsFileContract = defineContract({ params: importParams, response: {} })

export const applyImportContract = defineContract({
  params: importParams,
  body: input({ version: z.number().int().min(1) }),
  response: oneJob,
})

export const cancelImportContract = defineContract({
  params: importParams,
  body: input({ version: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(500).optional() }),
  response: oneJob,
})
