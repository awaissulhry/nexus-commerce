import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ARRIVAL_STATES, READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Material readiness and the shortage list (B-W2a-22; PLN-086, PLN-085; design warehouse.picking "readiness", planning.mrp
 * "Short on open work orders"), computed now from the site's live plan. Quantities are decimal strings with four
 * decimals in the item's base unit; dates are calendar days. No money, no person.
 */

const quantity = () => z.string()
const uom = z.enum(UOMS)
const workOrderRef = output({ id: id(), number: z.string(), status: z.string(), kind: z.string(), dueDate: businessDate().nullable(), startedAt: instant().nullable(), style: output({ id: id(), code: z.string(), name: z.string() }) })
const materialRef = output({ itemId: id(), itemColourId: id().nullable(), label: z.string(), uom })

/** B-W2b-20: one arrival of a material for a work order (a purchase order line or the firm planned order). */
export const materialArrival = output({
  kind: z.enum(['PURCHASE_ORDER', 'FIRM']),
  purchaseOrderLineId: id().nullable(),
  purchaseOrderNumber: z.string().nullable(),
  /** Its purchase order is a DRAFT (not sent to the supplier yet). */
  draft: z.boolean(),
  date: businessDate().nullable(),
  /** For this work order (LATE purchase lines: what the material's plan does not count of them). */
  quantity: quantity(),
  /** IN_TIME · OVERDUE (due before today, not received) · LATE (after the need). */
  state: z.enum(ARRIVAL_STATES),
})

const materialReadiness = output({
  itemId: id(),
  itemColourId: id().nullable(),
  label: z.string(),
  uom,
  word: z.enum(READINESS_WORDS),
  date: businessDate().nullable(),
  needed: quantity(),
  issued: quantity(),
  reserved: quantity(),
  inStock: quantity(),
  onOrder: quantity(),
  firm: quantity(),
  short: quantity(),
  purchaseOrderLineIds: z.array(id()),
  reason: z.string(),
  /** B-W2b-20: the first day it is needed (the work order's scheduled start on the planning board, else its order line's date). */
  neededOn: businessDate().nullable(),
  /** B-W2b-20: what arrives for it, by date. */
  arrivals: z.array(materialArrival),
})

export const workOrderReadiness = output({
  workOrder: workOrderRef,
  /** One word: NOT_ENOUGH · DELAYED · REQUESTED · EXPECTED (with `date`) · NOT_BOOKED · RECEIVED · NOT_PLANNED. */
  word: z.enum(READINESS_WORDS),
  /** The word in English, with the date for EXPECTED ("Expected 2026-11-03"). */
  label: z.string(),
  date: businessDate().nullable(),
  reason: z.string(),
  materials: z.array(materialReadiness),
})

const counts = output(Object.fromEntries(READINESS_WORDS.map((word) => [word, z.number().int()])) as Record<(typeof READINESS_WORDS)[number], z.ZodNumber>)

export const readinessContract = defineContract({
  querystring: input({
    siteId: id(),
    /** Comma-separated work order ids (at most 100); left out: every open work order of the site. */
    workOrderIds: z.string().max(3700).optional(),
  }),
  response: { 200: output({ siteId: id(), asOf: businessDate(), latestRunId: id().nullable(), counts, workOrders: z.array(workOrderReadiness) }) },
})

export const workOrderReadinessContract = defineContract({
  params: input({ workOrderId: id() }),
  response: { 200: output({ siteId: id(), asOf: businessDate(), latestRunId: id().nullable(), readiness: workOrderReadiness }) },
})

export const SHORTAGE_FIXES = ['BUY', 'EXPEDITE', 'MOVE_FIRM'] as const

const fix = output({
  /** BUY: draft a purchase order line from the plan's line (POST /purchasing/from-plan); EXPEDITE: chase the purchase order; MOVE_FIRM: move the firm planned order earlier. */
  kind: z.enum(SHORTAGE_FIXES),
  /** BUY, MOVE_FIRM: the latest plan's line. */
  requirementId: id().nullable(),
  /** EXPEDITE: the purchase order and line to chase. */
  purchaseOrder: output({ id: id(), number: z.string(), lineId: id(), dueDate: businessDate() }).nullable(),
  words: z.string(),
})

export const shortagesContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      siteId: id(),
      asOf: businessDate(),
      latestRunId: id().nullable(),
      rows: z.array(
        output({
          workOrder: workOrderRef,
          material: materialRef,
          word: z.enum(['NOT_ENOUGH', 'DELAYED']),
          /** What is not there in time for the work order (base unit). */
          short: quantity(),
          neededBy: businessDate(),
          /** The purchase order line it waits for, when one comes (late). */
          expected: output({ date: businessDate(), purchaseOrderNumber: z.string() }).nullable(),
          reason: z.string(),
          fixes: z.array(fix),
        }),
      ),
    }),
  },
})
