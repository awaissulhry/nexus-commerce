import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * The release check's W2a parts (B-W2a-46; MES-004; design production.workorders wo-release "material available or
 * expected (W2a readiness)", wo-grid "Readiness (W2a word)", wo-side "holds (W2a)"): the plan's readiness beside the
 * checks, the holds that block the release, and the readiness word of many work orders for the list. Quantities are decimal
 * strings in the material's base unit; no money, no person. `reason` sentences are English (screens say them from `word`).
 */

const word = z.enum(READINESS_WORDS)

export const readinessPartSchema = output({
  word,
  /** EXPECTED: the latest arrival; DELAYED: when the late supply comes (or was due). */
  date: businessDate().nullable(),
  reason: z.string(),
  materials: z.array(
    output({
      itemId: id(),
      itemColourId: id().nullable(),
      label: z.string(),
      uom: z.enum(UOMS),
      word: word.exclude(['NOT_PLANNED']),
      date: businessDate().nullable(),
      needed: z.string(),
      reserved: z.string(),
      inStock: z.string(),
      onOrder: z.string(),
      short: z.string(),
      reason: z.string(),
    }),
  ),
})

/** A hold that blocks the release (a quality hold, or the work order's own ON_HOLD under another record). */
export const blockingHoldSchema = output({ holdId: id().nullable(), reason: z.string(), placedAt: instant() })

/** The work order's own hold (wave 5 columns): why, since when, and the status it goes back to. */
export const workOrderHoldSchema = output({ reason: z.string().nullable(), at: instant().nullable(), fromStatus: z.string().nullable(), recordType: z.string().nullable(), recordId: id().nullable() })

export const listReadinessContract = defineContract({
  querystring: input({
    /** Comma-separated work order ids (at most 100); ids the caller may not see are left out. */
    ids: z.string().min(36).max(3700),
  }),
  response: {
    200: output({
      workOrders: z.array(
        output({
          workOrderId: id(),
          word,
          date: businessDate().nullable(),
          /** Materials that are not there in time (NOT_ENOUGH, DELAYED, REQUESTED, NOT_BOOKED). */
          open: z.number().int(),
          /** Each material's word (the record's Materials tab). */
          materials: z.array(output({ itemId: id(), itemColourId: id().nullable(), word: word.exclude(['NOT_PLANNED']), date: businessDate().nullable() })),
          asOf: businessDate(),
        }),
      ),
    }),
  },
})
