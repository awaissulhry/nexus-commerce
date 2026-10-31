import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EXPORT_FORMATS, EXPORT_LIMITS, EXPORT_LOCALES, EXPORT_STATUSES } from '@nexus/factory-domain/views/exports'
import { BULK_LIMITS } from '@nexus/factory-domain/views/bulk/rules'
import { LIST_KEY, VIEW_LIMITS } from '@nexus/factory-domain/views/state'
import { presignedView } from '../files/contract'

/**
 * The export of a list (B-W2a-23; PLT-179; design shell.lists toolbar Export ▾, pop:export-job): a person asks for the
 * file of the view they are looking at (its address terms and its visible columns, with their headings in their
 * language); the worker reads the list with their live rights and keeps the file for EXPORT_LIMITS.keepDays days. Only
 * the person who asked sees the job and downloads the file. W2b (B-W2b-11): every W1/W2a list and every report
 * exports; XLSX_REIMPORT writes the importer's columns (the request's columns are then not used); a long export's link
 * is e-mailed.
 */

const column = output({ key: z.string(), label: z.string() })

export const exportJobView = output({
  id: id(),
  listKey: z.string(),
  format: z.enum(EXPORT_FORMATS),
  status: z.enum(EXPORT_STATUSES),
  /** The list's name, as the screen called it (the file is named after it). */
  title: z.string(),
  /** The saved view it was made from, by name (null: the list as it was). */
  viewName: z.string().nullable(),
  columns: z.array(column),
  /** Left out by the person's rights (a money grain they do not hold), as the file says above its header. */
  omitted: z.array(column),
  rowsDone: z.number().int(),
  /** How many rows in all: while it runs, the count made before the run (PLT-184 JobProgress "n of m"; null while it is
   * counted); once DONE, the rows of the file. */
  rowCount: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  file: output({ id: id(), name: z.string(), sizeBytes: z.number().int() }).nullable(),
  createdAt: instant(),
  startedAt: instant().nullable(),
  finishedAt: instant().nullable(),
  expiresAt: instant().nullable(),
  /** When the link was e-mailed to the person (a long export, platform/exports/mail.ts); null: not mailed. */
  emailedAt: instant().nullable(),
  /** B-W2b-13: how many rows were selected (the selection row's Export N); null: the whole view. */
  selected: z.number().int().nullable(),
  version: z.number().int(),
})
export type ExportJobView = z.infer<typeof exportJobView>

export const requestExportContract = defineContract({
  body: input({
    listKey: z.string().regex(LIST_KEY).max(VIEW_LIMITS.listKey),
    format: z.enum(EXPORT_FORMATS),
    /** The screen's address terms (the frame's view query: `late=true&q=rossi`). */
    query: z.string().max(VIEW_LIMITS.query),
    /** The visible columns, left to right, with the headings the screen shows. */
    columns: z
      .array(input({ key: z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(VIEW_LIMITS.columnId), label: z.string().trim().max(EXPORT_LIMITS.label) }))
      .min(1)
      .max(EXPORT_LIMITS.columns),
    title: z.string().trim().min(1).max(EXPORT_LIMITS.title),
    locale: z.enum(EXPORT_LOCALES),
    viewName: z.string().trim().min(1).max(VIEW_LIMITS.name).optional(),
    /** B-W2b-13 (Z16:02): only these rows of the view (the list frame's row ids, the selection row's Export N). */
    ids: z
      .array(id())
      .min(1)
      .max(BULK_LIMITS.rows)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Each row once.' })
      .optional(),
  }),
  response: { 201: output({ job: exportJobView }) },
})
export type RequestExportBody = z.infer<typeof requestExportContract.body>

export const listExportsContract = defineContract({
  querystring: input({ listKey: z.string().regex(LIST_KEY).max(VIEW_LIMITS.listKey).optional() }),
  response: { 200: output({ jobs: z.array(exportJobView) }) },
})

export const exportParams = input({ exportId: id() })

export const getExportContract = defineContract({
  params: exportParams,
  response: { 200: output({ job: exportJobView }) },
})

export const downloadExportContract = defineContract({
  params: exportParams,
  response: { 200: output({ download: presignedView }) },
})
