import { z } from 'zod'
import { defineEvent } from '../events/define'
import { GATE_KINDS, PASS_VIAS } from '../planning/milestones/rules'

/**
 * Time & action's events (B-W2b-263; PLN-186; the code is factory-domain planning/milestones). A module folder of its own, as
 * sales-sample-decisions and compliance-gates (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/planning/milestones emits it in the command that makes the change (a gate passed by its event: in the worker's
 * system command that follows `sample_round.decided` or `lot.released`).
 *
 *   order_gate.changed   a sales order's pre-production gate was added, changed, removed, passed (by a person, a sample
 *                        round's approval or the order's leather released) or started before (with a reason): Time & action
 *                        reads again (the tiles, the calendar, the order's row) and the planning board reads again (a drop
 *                        it held may now go)
 *
 * Live for planning.view. Ids, codes and states only: no words a person typed, no person.
 */
export const GATE_CHANGES = ['ADDED', 'EDITED', 'REMOVED', 'PASSED', 'STARTED_BEFORE'] as const

export const events = [
  defineEvent({
    type: 'order_gate.changed',
    context: 'planning-milestones',
    description: "A sales order's pre-production gate was added, changed, removed, passed (by a person, a sample round's approval or the leather's release) or started before with a reason.",
    payload: z.strictObject({
      gateId: z.uuid(),
      salesOrderId: z.uuid(),
      /** The order's number. */
      number: z.string(),
      partyId: z.uuid(),
      kind: z.enum(GATE_KINDS),
      change: z.enum(GATE_CHANGES),
      /** Who or what passed it (PASSED only; null otherwise). */
      via: z.enum(PASS_VIAS).nullable(),
      /** The gate's state after the change: passed, started before (both may be true), neither: it waits. */
      passed: z.boolean(),
      startedBefore: z.boolean(),
    }),
    live: { permission: 'planning.view', fields: ['gateId', 'salesOrderId', 'number', 'kind', 'change'] },
  }),
]
