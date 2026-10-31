import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The print platform's events (plan A1 §3.4, §3.9; GAP-007). apps/factory-api's platform/print emits
 * `print.job_queued` when a job is queued (or queued again): the worker's print.dispatch handler hands it to the site's
 * print relay. `print.job_changed` follows every later move (sent, printed, failed), so the printer queue refreshes on
 * the office screens and the floor devices of the job's site.
 */
const status = z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED'])

export const events = [
  defineEvent({
    type: 'print.job_queued',
    context: 'print',
    description: 'A print job was queued for a printer; the worker hands it to the site\'s print relay.',
    payload: z.strictObject({ jobId: z.uuid(), printerId: z.uuid(), payloadKind: z.enum(['ZPL', 'PDF']) }),
    live: { permission: 'print.view', floor: 'print.view', fields: ['jobId', 'printerId'] },
  }),
  defineEvent({
    type: 'print.job_changed',
    context: 'print',
    description: 'A print job moved: handed to the relay, printed, or failed.',
    payload: z.strictObject({ jobId: z.uuid(), printerId: z.uuid(), status, attempts: z.number().int().min(0) }),
    live: { permission: 'print.view', floor: 'print.view', fields: ['jobId', 'printerId', 'status'] },
  }),
] as const
