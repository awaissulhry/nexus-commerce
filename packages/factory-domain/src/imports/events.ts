import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The import engine's events (plan A1 §3.3, §3.4; feature PLT-176). apps/factory-api's platform/imports emits them in
 * the transaction that moves an import job. `import.apply_requested` is also the worker's cue: its handler applies the
 * job's plan in batches (the dry run starts on the platform's own `file.available` for the job's sheet). Every one
 * reaches the import screens of the people who may see imports of the job's company, so the job's status and counts
 * refresh without polling. Payloads carry ids only.
 */

const live = { permission: 'imports.view', fields: ['jobId', 'importerKey'] } as const

export const events = [
  defineEvent({
    type: 'import.planned',
    context: 'imports',
    description: 'The dry run of an import finished: every row is planned (create, update, unchanged or error).',
    payload: z.strictObject({ jobId: z.uuid(), importerKey: z.string() }),
    live,
  }),
  defineEvent({
    type: 'import.apply_requested',
    context: 'imports',
    description: 'A person (or an import in apply mode) asked to apply an import plan; the worker applies it.',
    payload: z.strictObject({ jobId: z.uuid(), importerKey: z.string() }),
    live,
  }),
  defineEvent({
    type: 'import.applied',
    context: 'imports',
    description: 'Every valid row of an import plan was applied or skipped.',
    payload: z.strictObject({ jobId: z.uuid(), importerKey: z.string() }),
    live,
  }),
  defineEvent({
    type: 'import.failed',
    context: 'imports',
    description: 'An import stopped: its sheet could not be planned, or its apply failed (it can be applied again).',
    payload: z.strictObject({ jobId: z.uuid(), importerKey: z.string() }),
    live,
  }),
  defineEvent({
    type: 'import.cancelled',
    context: 'imports',
    description: 'An import was cancelled; rows already applied stay applied.',
    payload: z.strictObject({ jobId: z.uuid(), importerKey: z.string() }),
    live,
  }),
] as const
