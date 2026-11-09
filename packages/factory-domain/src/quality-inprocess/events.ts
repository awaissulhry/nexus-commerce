import { z } from 'zod'
import { defineEvent } from '../events/define'
import { IN_PROCESS_KINDS, IN_PROCESS_OUTCOMES, IN_PROCESS_STATUSES } from '../quality/inprocess/rules'

/**
 * In-process checks (B-W2b-99; QHS-039 … QHS-042, MES-127; design floor.inline "Live: first piece approved → the operation
 * screens of that run lift their hold"). apps/factory-api's modules/quality/inprocess emits them in the commands that make
 * the change. Their own module folder: the quality events file is other steps' (B-W2b-90, -93, -97 …).
 *
 *   in_process_check.changed      a check was opened, its results saved, decided, recorded in one step or cancelled
 *   in_process_check.first_piece  a first piece was decided or cancelled: whether its run still waits (the operation
 *                                 screens of the run lift or keep their hold)
 *
 * Reach the office (quality.inprocess.view) and the site's tablets: a check's changes the inspection tablets
 * (quality.inprocess.view), a first piece every tablet of the site (floor.work: the operation screen of any operator reads
 * the hold). Ids, kinds, outcomes and counts per line and operation only, never a person.
 */

const kind = z.enum(IN_PROCESS_KINDS)

// B-W2b-213: COUNTED (the units of its AQL sample inspected), DUE (the office moved by when it is due).
export const CHECK_CHANGES = ['OPENED', 'RESULTS', 'DECIDED', 'RECORDED', 'CANCELLED', 'COUNTED', 'DUE'] as const
export type CheckChange = (typeof CHECK_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'in_process_check.changed',
    context: 'quality-inprocess',
    description: 'An in-process check (first piece, cutting, roving, end of line) was opened, its results saved, decided, recorded in one step or cancelled.',
    payload: z.strictObject({
      checkId: z.uuid(),
      kind,
      change: z.enum(CHECK_CHANGES),
      status: z.enum(IN_PROCESS_STATUSES),
      outcome: z.enum(IN_PROCESS_OUTCOMES).nullable(),
      siteId: z.uuid(),
      lineId: z.uuid().nullable(),
      workOrderId: z.uuid().nullable(),
      bundleId: z.uuid().nullable(),
      workOrderOperationId: z.uuid().nullable(),
      pieces: z.number().int().min(0),
      defects: z.number().int().min(0),
    }),
    live: { permission: 'quality.inprocess.view', floor: 'quality.inprocess.view', fields: ['checkId', 'kind', 'change', 'status', 'outcome', 'lineId', 'workOrderId', 'workOrderOperationId'] },
  }),
  defineEvent({
    type: 'in_process_check.first_piece',
    context: 'quality-inprocess',
    description: 'A first piece was decided or cancelled: whether its run (the work order at its operation, or at all of them) still waits for an approved first piece.',
    payload: z.strictObject({
      checkId: z.uuid(),
      workOrderId: z.uuid(),
      workOrderOperationId: z.uuid().nullable(),
      bundleId: z.uuid(),
      status: z.enum(IN_PROCESS_STATUSES),
      outcome: z.enum(IN_PROCESS_OUTCOMES).nullable(),
      /** The run still waits (a rejected first piece, or a cancelled one with another still open). */
      held: z.boolean(),
    }),
    live: { permission: 'quality.inprocess.view', floor: 'floor.work', fields: ['checkId', 'workOrderId', 'workOrderOperationId', 'status', 'outcome', 'held'] },
  }),
] as const
