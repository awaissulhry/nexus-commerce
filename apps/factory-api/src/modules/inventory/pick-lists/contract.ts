import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { QUALITY_STATES } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { STOP_SOURCES } from '@nexus/factory-domain/inventory/pick-lists/walk'
import { substitutionView } from '../substitutions/contract'

/**
 * The pick list by bin (B-W2b-298; SCM-212): one work order's pick list or one walk for several, as stops in the order of the
 * site's bins. Quantities are decimal text in the material's base unit; no money; never a person.
 */

const place = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  labelCode: z.string().nullable(),
  /** Its codes from the top of the site's tree down to it. */
  path: z.array(z.string()),
  /** Its turn in the walk (0 = first). */
  rank: z.number().int(),
  blocked: z.boolean(),
})

const stop = output({
  /** Its turn in the walk (1 = first). */
  turn: z.number().int(),
  workOrderId: id(),
  workOrderNumber: z.string(),
  /** The work order's line it serves (material and colour). */
  lineKey: z.string(),
  itemId: id(),
  itemCode: z.string(),
  itemName: z.string(),
  colourCode: z.string().nullable(),
  baseUom: z.string(),
  tracking: z.string(),
  location: place,
  lotId: id().nullable(),
  lotCode: z.string().nullable(),
  hideId: id().nullable(),
  hideCode: z.string().nullable(),
  quantity: z.string(),
  source: z.enum(STOP_SOURCES),
  reservationId: id().nullable(),
  substitutionId: id().nullable(),
  quality: z.enum(QUALITY_STATES),
  issuable: z.boolean(),
  /** Why it is not taken now (on hold, no chromium VI test, a blocked place), in words; null: take it. */
  words: z.string().nullable(),
})

const line = output({
  key: z.string(),
  itemId: id(),
  itemCode: z.string(),
  itemName: z.string(),
  tracking: z.string(),
  baseUom: z.string(),
  itemColourId: id().nullable(),
  colourCode: z.string().nullable(),
  planned: z.string(),
  issued: z.string(),
  toIssue: z.string(),
  reserved: z.string(),
  short: z.string(),
  substituted: z.string(),
  toPick: z.string(),
  covered: z.boolean(),
  held: z.array(output({ reason: z.string(), words: z.string(), lotCode: z.string(), onHand: z.string() })),
  substitutes: z.array(substitutionView),
})

const workOrder = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), siteId: id(), companyId: id(), dueDate: z.string().nullable(), style: output({ id: id(), code: z.string(), name: z.string() }), issuable: z.boolean() }),
  /** Where its kit is staged (B-W2b-15), and whether someone checked it complete. */
  kit: output({
    location: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
    checkedAt: instant().nullable(),
    /** B-W2b-310: the kit record's version (0: none yet), for the tablet's stage and complete. */
    version: z.number().int(),
  }),
  /** Its open PICK task of the warehouse inbox (B-W2b-292), or null. */
  task: output({ id: id(), status: z.string(), version: z.number().int() }).nullable(),
  lines: z.array(line),
})

const walk = output({
  asOf: instant(),
  workOrders: z.array(workOrder),
  /** Every stop, in walking order. */
  stops: z.array(stop),
  /** The places the walk passes, in order, with their stops. */
  places: z.array(place.extend({ stops: z.number().int() })),
})

export const workOrderContract = defineContract({ params: input({ workOrderId: id() }), response: { 200: walk } })
export const walkContract = defineContract({ querystring: input({ workOrderIds: z.string().trim().min(1).max(800) }), response: { 200: walk } })
