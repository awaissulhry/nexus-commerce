import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HOLD_BRAND_WORDS_MAX, HOLD_LIFT_REASON_MAX, HOLD_NOTE_MAX, WORK_ORDER_HOLD_KINDS, WORK_ORDER_HOLD_STATUSES } from '@nexus/factory-domain/production/holds/kinds'
import { HOLD_LIMITS } from '@nexus/factory-domain/quality/holds/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * B-PR-21: the plain production hold on a work order (WorkOrderHold, 08-backend §4.5). Office routes; every write takes an
 * Idempotency-Key, a lift the hold's version read. Refusals in words: `body/<field>` (400), a status that takes no hold (409).
 * The office reads the office's note; the customer reads only `customerReads` (its words, else the reason's), never the note.
 */

const workOrderStatus = z.enum(WORK_ORDER_STATUSES)
const person = output({ id: id(), name: z.string() })

export const workOrderHoldView = output({
  id: id(),
  workOrderId: id(),
  kind: z.enum(WORK_ORDER_HOLD_KINDS),
  status: z.enum(WORK_ORDER_HOLD_STATUSES),
  reasonCode: z.string(),
  /** The reason in words (the PRODUCTION_HOLD list's; else its code). */
  reason: z.string(),
  /** The office's own words: never the floor's or the customer's to read. */
  note: z.string().nullable(),
  /** The words written for the customer (null: it reads the reason's words). */
  brandWords: z.string().nullable(),
  /** What the customer reads beside "On hold": its words, else the reason's. */
  customerReads: z.string(),
  /** BRAND: the customer's HOLD ask it answers. */
  requestId: id().nullable(),
  placedAt: instant(),
  /** An office person (null: no longer a user of the tenant). */
  placedBy: person.nullable(),
  liftedAt: instant().nullable(),
  liftedBy: person.nullable(),
  liftReason: z.string().nullable(),
  version: z.number().int(),
})

/** The work order as the hold left it: its status and, while ON_HOLD, the record it is held under. */
export const heldWorkOrderView = output({
  id: id(),
  number: z.string(),
  status: workOrderStatus,
  version: z.number().int(),
  hold: output({ reason: z.string().nullable(), at: instant().nullable(), fromStatus: workOrderStatus.nullable(), recordType: z.string().nullable(), recordId: id().nullable() }).nullable(),
})

const workOrderParams = input({ workOrderId: id() })
const holdParams = input({ workOrderId: id(), holdId: id() })

const placeFields = {
  /** A code of the PRODUCTION_HOLD list (the one dialog sends HOLD codes to /quality/holds). */
  reasonCode: z.string().min(1).max(40),
  note: z.string().max(HOLD_NOTE_MAX).nullable().optional(),
  brandWords: z.string().max(HOLD_BRAND_WORDS_MAX).nullable().optional(),
}

export const listContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: heldWorkOrderView,
      /** Its plain holds (PRODUCTION and BRAND): the standing ones first, then the lifted ones, newest first. */
      holds: z.array(workOrderHoldView),
      /** Its ACTIVE quality holds (read them in /quality/holds with quality.holds.view): counted here. */
      qualityHoldsActive: z.number().int(),
    }),
  },
})

export const placeContract = defineContract({
  params: workOrderParams,
  body: input({ ...placeFields, /** The work order's version read (optional). */ version: z.number().int().min(1).optional() }),
  response: { 201: output({ hold: workOrderHoldView, workOrder: heldWorkOrderView, /** It went ON_HOLD now (false: it was on hold already). */ held: z.boolean() }) },
})

/** Hold N on the work orders list with a production reason: one hold per work order, all or none, in one command. */
export const placeManyContract = defineContract({
  body: input({ ...placeFields, workOrderIds: z.array(id()).min(1).max(HOLD_LIMITS.subjects) }),
  response: {
    201: output({
      holds: z.array(workOrderHoldView),
      workOrders: z.array(output({ id: id(), number: z.string(), status: workOrderStatus, held: z.boolean() })),
    }),
  },
})

export const liftContract = defineContract({
  params: holdParams,
  body: input({ version: z.number().int().min(1), reason: z.string().max(HOLD_LIFT_REASON_MAX) }),
  response: {
    200: output({
      hold: workOrderHoldView,
      workOrder: heldWorkOrderView,
      /** It left ON_HOLD now (false: another hold still names it). */
      lifted: z.boolean(),
      /** The holds still standing on it, by kind (a quality hold is released in Quality). */
      stillHeldBy: output({ quality: z.number().int(), production: z.number().int() }),
    }),
  },
})
