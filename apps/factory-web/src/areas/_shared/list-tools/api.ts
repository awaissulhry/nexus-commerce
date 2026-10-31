import { z } from 'zod'
import { EXPORT_FORMATS, EXPORT_STATUSES } from '@nexus/factory-domain/views/exports'
import { VIEW_AUDIENCES } from '@nexus/factory-domain/views/rules'
import { DENSITIES } from '@nexus/factory-domain/views/state'
import { BULK_REFUSALS } from '@nexus/factory-domain/views/bulk/rules'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { ToolsError, type BulkApplyAsk, type BulkPreviewAsk, type ExportAsk, type ExportJob, type SavedView, type ToolsProblem, type ViewDraft, type ViewsAnswer } from '../../../list-frame/tools/transport'

/**
 * Every call of the list tools (B-W2a-23; apps/factory-api platform/views and platform/exports), with the answer's shape
 * checked (zod; unknown fields are dropped). An error becomes the tools' own problem (list-frame/tools ToolsError): the
 * screens say their own words, never the API's.
 */

const layout = z.object({ order: z.array(z.string()), hidden: z.array(z.string()), pinned: z.array(z.string()) })
const state = z.object({ query: z.string(), columns: layout.optional(), density: z.enum(DENSITIES).optional() })
const role = z.object({ id: z.string(), name: z.string() })

export const savedViewSchema = z.object({
  id: z.string(),
  listKey: z.string(),
  name: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  mine: z.boolean(),
  audience: z.enum(VIEW_AUDIENCES),
  roleId: z.string().nullable(),
  roleName: z.string().nullable(),
  roleDefault: z.boolean(),
  state,
  changeHeld: z.string().nullable(),
  version: z.number(),
})

export const viewsAnswerSchema = z.object({
  views: z.array(savedViewSchema),
  roleDefaultId: z.string().nullable(),
  roles: z.array(role),
  allRoles: z.array(role),
  can: z.object({ save: z.boolean(), manage: z.boolean(), export: z.boolean() }),
  exports: z.object({ formats: z.array(z.enum(EXPORT_FORMATS)) }).nullable(),
})

const column = z.object({ key: z.string(), label: z.string() })
export const exportJobSchema = z.object({
  id: z.string(),
  listKey: z.string(),
  format: z.enum(EXPORT_FORMATS),
  status: z.enum(EXPORT_STATUSES),
  title: z.string(),
  viewName: z.string().nullable(),
  columns: z.array(column),
  omitted: z.array(column),
  rowsDone: z.number(),
  rowCount: z.number().nullable(),
  failureReason: z.string().nullable(),
  file: z.object({ id: z.string(), name: z.string(), sizeBytes: z.number() }).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** B-W2b-13: how many selected rows were asked (null: the whole view). */
  selected: z.number().nullable().optional(),
})

const presigned = z.object({ url: z.string() })

// B-W2b-13 (PLT-182, PLT-166): platform/views/bulk — a bulk edit's preview and its write (also one cell, and Undo).
const bulkValue = z.union([z.string(), z.number(), z.null()])
const refusal = z.object({ code: z.enum(BULK_REFUSALS), field: z.string().nullable().optional(), status: z.string().nullable().optional() })
export const bulkPreviewSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      version: z.number(),
      changes: z.array(z.object({ field: z.string(), now: bulkValue, next: bulkValue })),
      refusal: refusal.nullable(),
    }),
  ),
})
export const bulkApplySchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      ok: z.boolean(),
      refusal: refusal.nullable(),
      before: z.record(z.string(), bulkValue),
      after: z.record(z.string(), bulkValue),
      version: z.number(),
    }),
  ),
})
const SHARING = ['body/roleId', 'body/audience', 'body/roleDefault']

/** The tools' problem of an API error (a 409's kind from what it refuses; a 400 on the sharing is the sharing's). */
export function toolsProblemOf(error: unknown, what: 'view' | 'export' = 'view'): ToolsProblem {
  if (!isApiError(error)) return 'failed'
  switch (error.kind) {
    case 'conflict':
      if (what === 'export') return /running/i.test(error.message) ? 'busy' : 'stale'
      if (/named/i.test(error.message)) return 'nameTaken'
      if (/keep \d+ views/i.test(error.message)) return 'tooMany'
      return 'stale'
    case 'invalid':
      return error.issues.some((issue) => SHARING.includes(issuePath(issue))) ? 'sharing' : 'invalid'
    case 'forbidden':
    case 'step_up':
    case 'signed_out':
      return 'forbidden'
    case 'not_found':
      return 'notFound'
    case 'unavailable':
    case 'rate_limited':
      return 'offline'
    default:
      return 'failed'
  }
}

const wrap = async <T>(work: Promise<T>, what: 'view' | 'export' = 'view'): Promise<T> => {
  try {
    return await work
  } catch (error) {
    throw new ToolsError(toolsProblemOf(error, what))
  }
}
const seg = encodeURIComponent

export const listViews = (api: ApiClient, listKey: string): Promise<ViewsAnswer> => wrap(api.get('/views', { query: { listKey }, schema: viewsAnswerSchema }))
export const createView = (api: ApiClient, listKey: string, draft: ViewDraft, idempotencyKey: string): Promise<SavedView> =>
  wrap(api.post('/views', { body: { listKey, ...draft }, idempotencyKey, schema: z.object({ view: savedViewSchema }) }).then((answer) => answer.view))
export const updateView = (api: ApiClient, view: SavedView, change: Partial<ViewDraft>, idempotencyKey: string): Promise<SavedView> =>
  wrap(api.request('PATCH', `/views/${seg(view.id)}`, { body: { version: view.version, ...change }, idempotencyKey, schema: z.object({ view: savedViewSchema }) }).then((answer) => answer.view))
export const removeView = (api: ApiClient, view: SavedView): Promise<void> =>
  wrap(api.request('DELETE', `/views/${seg(view.id)}`, { query: { version: view.version }, schema: z.object({ deleted: z.literal(true) }) }).then(() => undefined))

export const startExport = (api: ApiClient, ask: ExportAsk, locale: 'it' | 'en', idempotencyKey: string): Promise<ExportJob> =>
  wrap(api.post('/exports', { body: { ...ask, locale }, idempotencyKey, schema: z.object({ job: exportJobSchema }) }).then((answer) => answer.job), 'export')
export const readExport = (api: ApiClient, jobId: string): Promise<ExportJob> => wrap(api.get(`/exports/${seg(jobId)}`, { schema: z.object({ job: exportJobSchema }) }).then((answer) => answer.job), 'export')
export const listExports = (api: ApiClient, listKey: string): Promise<readonly ExportJob[]> => wrap(api.get('/exports', { query: { listKey }, schema: z.object({ jobs: z.array(exportJobSchema) }) }).then((answer) => answer.jobs), 'export')

export const previewBulk = (api: ApiClient, ask: BulkPreviewAsk) =>
  wrap(api.post('/views/bulk/preview', { body: { listKey: ask.listKey, ids: ask.ids, changes: ask.changes }, schema: bulkPreviewSchema }).then((answer) => answer.rows))
export const applyBulk = (api: ApiClient, ask: BulkApplyAsk, idempotencyKey: string) =>
  wrap(api.post('/views/bulk/apply', { body: { listKey: ask.listKey, rows: ask.rows, ...(ask.undo ? { undo: true } : {}) }, idempotencyKey, schema: bulkApplySchema }).then((answer) => answer.results))

/** The file of a finished export: its presigned GET (60 s, an attachment), under the web's `/api` when the store is local. */
export async function exportFileAddress(api: ApiClient, jobId: string): Promise<string> {
  const answer = await wrap(api.get(`/exports/${seg(jobId)}/download`, { schema: z.object({ download: presigned }) }), 'export')
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}
