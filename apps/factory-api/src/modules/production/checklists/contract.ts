import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CHECKLIST_OUTCOMES, STEP_CODE } from '@nexus/factory-domain/production/checklists/rules'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'

/**
 * Steps in an operation (B-W2b-47; MES-102). No field carries money. On a tablet a tick's `by` is the viewer's own name, or
 * every name on a team leader's tablet where the site names workers; else null ("another person"). A refusal by a rule is a
 * 409 whose issues are `refusal/<CODE>` (CHECKLIST_STEP_UNKNOWN, CHECKLIST_REPORTED, or the scans' codes), with `fix`.
 */

const outcome = z.enum(CHECKLIST_OUTCOMES)
const operationRef = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })

const checklist = {
  /** B-W2b-214: `icon` (the steps panel's picture, factory-domain instructions INSTRUCTION_ICONS) and `critical` come from a work instruction's step; typed lines have neither. */
  steps: z.array(output({ code: z.string(), words: z.string(), required: z.boolean(), icon: z.string().nullable(), critical: z.boolean(), tick: output({ outcome, at: instant(), mine: z.boolean(), by: z.string().nullable() }).nullable() })),
  /** The required steps with no tick: Finish is held until 0. */
  open: z.number().int(),
}

export const stateContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(64).optional(), bundleId: id().optional(), workOrderOperationId: id().optional() }),
  response: { 200: output({ bundle: output({ id: id(), code: z.string() }), operation: operationRef, ...checklist }) },
})

export const tickBody = input({
  /** The tablet's id for the tick (A1 §3.8): one tick, once, also from the offline queue. */
  clientEventId: z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
  /** The scanned ticket, or the bundle's id: exactly one. */
  code: z.string().trim().min(1).max(64).optional(),
  bundleId: id().optional(),
  workOrderOperationId: id(),
  stepCode: z.string().regex(STEP_CODE),
  /** Default DONE; NOT_APPLICABLE: the step does not apply to this bundle (a size without the pocket). */
  outcome: outcome.optional(),
  /** The tablet's clock when it happened (offline). */
  occurredAt: instant().optional(),
})

const tickAnswer = output({ tick: output({ id: id(), stepCode: z.string(), outcome, at: instant() }), checklist: output(checklist) })

export const tickContract = defineContract({ body: tickBody, response: { 200: tickAnswer, 201: tickAnswer } })

export const workOrderChecklistsContract = defineContract({
  params: input({ workOrderId: id() }),
  querystring: input({ bundleId: id() }),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string() }),
      /** The operations with steps or ticks, in their order. */
      operations: z.array(
        output({
          operation: operationRef,
          steps: z.array(output({ code: z.string(), words: z.string(), required: z.boolean() })),
          open: z.number().int(),
          /** Every tick, oldest first: who (where the site names workers and its PERFORMANCE gate is on; else `byHidden`) and when; the latest of a step stands. */
          ticks: z.array(output({ id: id(), stepCode: z.string(), outcome, at: instant(), deviceTime: instant().nullable(), by: z.string().nullable(), byHidden: z.boolean(), station: z.string().nullable() })),
        }),
      ),
    }),
  },
})
