import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BASKET_FLAG_KINDS, BASKET_SIGNAL_LIMITS, isLateDays, LATE_REASONS, LATE_STATES } from '@nexus/factory-domain/production/baskets/signals'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'

/**
 * The team leader's signals on baskets (owb- order workflow, S5 fl3 step 3; `_owb-fl-common.md` § 3 "fl3"): Do this first
 * (BasketFlag FIRST) and Will be late (the base's FloorLateWarning, answered by the office in fl4's From the floor). floor.lead
 * on the floor; offline as production.baskets.flag / production.baskets.late with the same body. No money, no person, no
 * customer name in any answer.
 */

const clientEventId = z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.')
const bundleIds = z.array(id()).min(1).max(BASKET_SIGNAL_LIMITS.bundles)

export const flagsBody = input({
  bundleIds,
  kind: z.enum(BASKET_FLAG_KINDS),
  /** true: set (one open FIRST per basket; a basket that has one stays); false: clear the open one. */
  on: z.boolean(),
  /** The phone's id for the act (A1 §3.8): one act, once, also from the offline queue. */
  clientEventId,
  occurredAt: instant().optional(),
})
export type FlagsBody = z.infer<typeof flagsBody>

const flagsAnswer = output({
  /** Baskets whose flag changed; `stay`: already so (set and set, or clear and clear). */
  changed: z.number().int(),
  stay: z.number().int(),
  flags: z.array(output({ bundleId: id(), code: z.string(), first: z.boolean() })),
  replayed: z.boolean(),
})
export const flagsContract = defineContract({ body: flagsBody, response: { 200: flagsAnswer } })

export const lateBody = input({
  bundleIds,
  /** Late by 1, 2, 3 or 5 days. */
  days: z.number().int().refine(isLateDays, { message: 'Late by 1, 2, 3 or 5 days.' }),
  reason: z.enum(LATE_REASONS),
  clientEventId,
  occurredAt: instant().optional(),
})
export type LateBody = z.infer<typeof lateBody>

const lateAnswer = output({
  /** One warning per work order of the baskets: it names its basket when it is about one, else the whole work order. */
  warnings: z.array(
    output({
      id: id(),
      workOrderId: id(),
      bundleId: id().nullable(),
      basketCodes: z.array(z.string()),
      days: z.number().int(),
      reason: z.enum(LATE_REASONS),
      state: z.enum(LATE_STATES),
    }),
  ),
  replayed: z.boolean(),
})
export const lateContract = defineContract({ body: lateBody, response: { 201: lateAnswer, 200: lateAnswer } })
