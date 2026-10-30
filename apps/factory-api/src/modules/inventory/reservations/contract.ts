import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { MAX_RESERVATION_LINES, RESERVATION_KINDS, RESERVATION_STATUSES } from '@nexus/factory-domain/inventory/reservations/rules'
import { LOT_QUALITY_STATUSES } from '@nexus/factory-domain/inventory/stock/overview'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * The reservations' contracts (B-W2a-11; SCM-205, SCM-209, SCM-210). Quantities are decimal strings with four decimals in
 * the item's base unit (a line may send another unit the item converts, with `uom`). No cost anywhere: a reservation
 * holds stock, it has no value of its own.
 */

const uom = z.enum(UOMS)
const named = output({ id: id(), code: z.string(), name: z.string() })
const status = z.enum(RESERVATION_STATUSES)
const person = output({ id: id(), name: z.string() }).nullable()

export const reservationView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  siteCode: z.string(),
  kind: z.enum(RESERVATION_KINDS),
  status,
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(ITEM_TRACKINGS) }),
  colour: named.nullable(),
  lot: output({ id: id(), code: z.string(), qualityStatus: z.enum(LOT_QUALITY_STATUSES) }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  quantity: z.string(),
  issuedQuantity: z.string(),
  /** What it still holds: quantity − issued while ACTIVE, else 0. */
  open: z.string(),
  demand: z.discriminatedUnion('type', [
    output({ type: z.literal('WorkOrder'), id: id(), number: z.string(), status: z.string() }),
    output({ type: z.literal('SalesOrderLine'), id: id(), orderId: z.string(), orderNumber: z.string(), seq: z.number().int(), status: z.string() }),
  ]),
  /** ACTIVE while its demand is done: it holds nothing any more; release it. */
  stale: z.boolean(),
  needDate: businessDate().nullable(),
  note: z.string().nullable(),
  issuedAt: instant().nullable(),
  releasedAt: instant().nullable(),
  releasedBy: person,
  releaseReason: z.string().nullable(),
  createdAt: instant(),
  createdBy: person,
  version: z.number().int(),
})

export type ReservationView = z.infer<typeof reservationView>

const figures = output({
  onHand: z.string(),
  /** The stock of lots that are not released. */
  held: z.string(),
  /** What ACTIVE reservations of open demands still hold. */
  reserved: z.string(),
  /** On hand − held − reserved; negative when over-reserved. */
  available: z.string(),
  overReserved: z.boolean(),
})

const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')

export const reserveContract = defineContract({
  body: input({
    siteId: id(),
    /** Exactly one of the two: a work order of the site, or a line of an open sales order of its company. */
    workOrderId: id().optional(),
    salesOrderLineId: id().optional(),
    /** Default the work order's due date, the order line's promised (else requested) date. */
    needDate: businessDate().optional(),
    note: z.string().trim().max(500).nullish(),
    lines: z
      .array(
        input({
          /** Name the stock once: a hide (reserved whole), a lot, or a material with its colour (any lot). */
          hideId: id().optional(),
          lotId: id().optional(),
          itemId: id().optional(),
          itemColourId: id().nullish(),
          /** Not for a hide. In `uom` (default the item's base unit). */
          quantity: quantity().optional(),
          uom: uom.optional(),
          baseQuantity: quantity().optional(),
        }),
      )
      .min(1)
      .max(MAX_RESERVATION_LINES),
  }),
  response: { 201: output({ reservations: z.array(reservationView) }) },
})

export const releaseContract = defineContract({
  body: input({
    reservations: z
      .array(input({ id: id(), version: z.number().int().min(1) }))
      .min(1)
      .max(MAX_RESERVATION_LINES),
    /** Why (SCM-210): required. */
    reason: z.string().trim().min(1).max(500),
  }),
  response: { 200: output({ reservations: z.array(reservationView) }) },
})

export const listReservationsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    workOrderId: id().optional(),
    salesOrderLineId: id().optional(),
    /** A comma list: ACTIVE,ISSUED,RELEASED. */
    status: z
      .string()
      .transform((value) => value.split(',').filter(Boolean))
      .pipe(z.array(status))
      .optional(),
    /** Only ACTIVE reservations whose demand is done. */
    stale: flag().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: { 200: output({ reservations: z.array(reservationView), nextCursor: id().nullable() }) },
})

export const reservationRecordContract = defineContract({
  params: input({ reservationId: id() }),
  response: { 200: output({ reservation: reservationView, stock: output({ site: figures, lot: figures.nullable() }) }) },
})

export const availabilityContract = defineContract({
  querystring: input({ siteId: id(), itemId: id(), itemColourId: id().optional() }),
  response: {
    200: output({
      site: output({ id: id(), code: z.string() }),
      item: output({ id: id(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(ITEM_TRACKINGS) }),
      colour: named.nullable(),
      figures,
      lots: z.array(figures.extend({ lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }) })),
      hides: z.array(
        output({
          hide: output({ id: id(), code: z.string() }),
          lotId: id().nullable(),
          onHand: z.string(),
          /** Its lot is not released. */
          held: z.boolean(),
          reservedFor: reservationView.shape.demand.nullable(),
        }),
      ),
      reservations: z.array(reservationView),
    }),
  },
})
