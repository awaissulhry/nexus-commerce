import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The guided first load's calls (B-W2a-41; PLT-185; apps/factory-api platform/imports/guided): the five steps of one
 * company with their reconciliation, and a step's "Done". Mirrors platform/imports/guided/contract.ts and factory-domain
 * imports/first-load.ts (FIRST_LOAD_STEPS, STEP_STATES); the web never imports the API's source. Each answer is checked.
 */

// factory-domain imports/first-load.ts FIRST_LOAD_STEPS, STEP_STATES.
export const FIRST_LOAD_STEPS = ['customers', 'suppliers', 'materials', 'openingStock', 'openOrders'] as const
export type FirstLoadStep = (typeof FIRST_LOAD_STEPS)[number]
export const STEP_STATES = ['done', 'ready', 'mismatch', 'running', 'todo', 'waiting', 'held'] as const
export type StepState = (typeof STEP_STATES)[number]

const issue = z.object({ path: z.string(), message: z.string() })

/** platform/imports/guided/contract.ts reconciliationView. `value` (minor units) only with the cost grain. */
export const reconciliationSchema = z.object({
  rows: z.number(),
  loaded: z.number(),
  refused: z.number(),
  skipped: z.number(),
  roles: z.object({ customers: z.number(), suppliers: z.number() }).optional(),
  quantities: z.array(z.object({ unit: z.string(), sheet: z.string(), loaded: z.string() })).optional(),
  value: z.object({ sheet: z.number(), loaded: z.number(), atStandard: z.number(), rowsAtStandard: z.number(), tolerance: z.number(), currency: z.string() }).optional(),
})
export type Reconciliation = z.infer<typeof reconciliationSchema>

/** platform/imports/guided/contract.ts firstLoadStepView. */
export const firstLoadStepSchema = z.object({
  step: z.enum(FIRST_LOAD_STEPS),
  importerKey: z.string().nullable(),
  state: z.enum(STEP_STATES),
  waitingFor: z.enum(FIRST_LOAD_STEPS).nullable(),
  job: z.object({ id: z.string(), fileName: z.string(), companyId: z.string().nullable(), appliedAt: z.string().nullable(), rowCount: z.number() }).nullable(),
  runningJobId: z.string().nullable(),
  reconciliation: reconciliationSchema.nullable(),
  matches: z.boolean().nullable(),
  differences: z.array(issue),
  done: z.object({ at: z.string(), byId: z.string().nullable(), nothing: z.boolean(), stillMatches: z.boolean().nullable() }).nullable(),
  canImport: z.boolean(),
  canMarkDone: z.boolean(),
})
export type FirstLoadStepView = z.infer<typeof firstLoadStepSchema>

export const firstLoadSchema = z.object({ companyId: z.string(), steps: z.array(firstLoadStepSchema), complete: z.boolean() })
export type FirstLoad = z.infer<typeof firstLoadSchema>

/** GET /imports/first-load?companyId=. */
export const readFirstLoad = (api: ApiClient, companyId: string): Promise<FirstLoad> => api.get('/imports/first-load', { query: { companyId }, schema: firstLoadSchema })

/** POST /imports/first-load/:step/done: the step matched (its applied import), or nothing to load (a reason). */
export const markFirstLoadDone = (api: ApiClient, step: FirstLoadStep, body: { companyId: string; jobId?: string; nothing?: boolean; reason?: string }): Promise<FirstLoad> =>
  api.post(`/imports/first-load/${encodeURIComponent(step)}/done`, { body, idempotencyKey: newIdempotencyKey(), schema: firstLoadSchema })
