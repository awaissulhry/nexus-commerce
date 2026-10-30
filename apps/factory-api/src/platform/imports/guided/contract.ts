import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FIRST_LOAD_STEPS, STEP_STATES } from '@nexus/factory-domain/imports/first-load'

/**
 * The guided first load (B-W2a-41; PLT-185; design admin.import "First load, in order"). Office only. The value check of
 * opening stock is money of the cost grain: `value` is present only for a reader who holds it.
 */

const issue = z.object({ path: z.string(), message: z.string() })

export const reconciliationView = output({
  rows: z.number().int(),
  loaded: z.number().int(),
  refused: z.number().int(),
  skipped: z.number().int(),
  roles: output({ customers: z.number().int(), suppliers: z.number().int() }).optional(),
  quantities: z.array(output({ unit: z.string(), sheet: z.string(), loaded: z.string() })).optional(),
  /** Cost grain only (minor units). */
  value: output({ sheet: z.number().int(), loaded: z.number().int(), atStandard: z.number().int(), rowsAtStandard: z.number().int(), tolerance: z.number().int(), currency: z.string() }).optional(),
})

export const firstLoadStepView = output({
  step: z.enum(FIRST_LOAD_STEPS),
  /** The step's importer; null: none yet (open orders). */
  importerKey: z.string().nullable(),
  state: z.enum(STEP_STATES),
  /** The earlier step this one waits for. */
  waitingFor: z.enum(FIRST_LOAD_STEPS).nullable(),
  /** The applied import the step reads. */
  job: output({ id: id(), fileName: z.string(), companyId: id().nullable(), appliedAt: instant().nullable(), rowCount: z.number().int() }).nullable(),
  /** An import of the importer under way (uploaded, planned for review, applying). */
  runningJobId: id().nullable(),
  reconciliation: reconciliationView.nullable(),
  matches: z.boolean().nullable(),
  differences: z.array(issue),
  /** A person's "Done": when, by whom, whether it was "nothing to load", and whether the step still matches now. */
  done: output({ at: instant(), byId: id().nullable(), nothing: z.boolean(), stillMatches: z.boolean().nullable() }).nullable(),
  /** The reader may import this step's sheet (the importer's permission and imports.run). */
  canImport: z.boolean(),
  /** The reader may mark it done (imports.apply and the importer's permission). */
  canMarkDone: z.boolean(),
})
export type FirstLoadStepView = z.infer<typeof firstLoadStepView>

export const firstLoadContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ companyId: id(), steps: z.array(firstLoadStepView), complete: z.boolean() }) },
})

export const markDoneContract = defineContract({
  params: input({ step: z.enum(FIRST_LOAD_STEPS) }),
  body: input({
    companyId: id(),
    /** The applied import the step matched (default: the one the step reads now). */
    jobId: id().optional(),
    /** Nothing to load for this step (no import). */
    nothing: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  response: { 200: output({ companyId: id(), steps: z.array(firstLoadStepView), complete: z.boolean() }) },
})
export type MarkDoneBody = z.infer<typeof markDoneContract.body>
