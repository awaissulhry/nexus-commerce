import { z } from 'zod'
import { businessDate, id, instant, output } from '@nexus/factory-domain/core/contracts'
import { MATERIAL_START_STATES } from '@nexus/factory-domain/planning/schedule-depth/material'

/**
 * The material parts of the planning board's answers (B-W2b-312; PLN-134; design planning.board "Material-aware (W2b):
 * 'Leather arrives 14 Nov. Earliest start with material: 15 Nov' → Snap to 15 Nov / Keep my date"). Their own file: the
 * board's contract (B-W2a-34's) and this step's both use them, and neither imports the other. No money, no person.
 */

const materialDay = output({
  itemId: id(),
  itemColourId: id().nullable(),
  label: z.string(),
  /** The day it arrives (null: not covered). */
  arrives: businessDate().nullable(),
  /** Due before today and not received yet (counted from today). */
  overdue: z.boolean(),
  purchaseOrderNumber: z.string().nullable(),
  /** What brings it last: PURCHASE_ORDER, FIRM (a firm planned order); null when in hand or not covered. */
  source: z.enum(['PURCHASE_ORDER', 'FIRM']).nullable(),
  /** The first day it can be used: the day after it arrives, or its delay days at the site later. */
  usableFrom: businessDate().nullable(),
})

/** When a work order may start with every material: IN_HAND · ARRIVES · NOT_COVERED (short, nothing ordered) · NOT_PLANNED. */
export const materialStartView = output({
  state: z.enum(MATERIAL_START_STATES),
  /** The latest arrival. */
  arrives: businessDate().nullable(),
  /** The first day its work may start with every material that has a day; null: nothing holds it, or no day is known. */
  startDay: businessDate().nullable(),
  /** That day's first working instant on the lane of its first operation with work left (never before now). */
  earliestStart: instant().nullable(),
  /** The material that sets the day. */
  setBy: materialDay.nullable(),
  /** Short with nothing ordered for it. */
  notCovered: z.array(output({ itemId: id(), itemColourId: id().nullable(), label: z.string() })),
  words: z.string(),
})

/** A start against the material (the drop's check, a move's answer). */
export const materialCheckView = output({
  state: z.enum(MATERIAL_START_STATES),
  /** The start asked (or moved to). */
  startAt: instant(),
  /** In time: nothing holds it, or it starts on or after the earliest start with material. */
  inTime: z.boolean(),
  /** The earliest start with material on that lane; null when nothing holds it or no day is known. */
  earliestStart: instant().nullable(),
  /** "Snap to 15 Nov": the start to offer when it is not in time and a day is known. */
  snapTo: instant().nullable(),
  /** "Leather BLK arrives 14 Nov (SEED-PO-0001). Earliest start with material: 15 Nov 06:00." */
  words: z.string(),
})
