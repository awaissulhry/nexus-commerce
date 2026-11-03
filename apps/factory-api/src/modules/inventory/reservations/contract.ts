import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { MAX_RESERVATION_LINES, RESERVATION_KINDS, RESERVATION_STATUSES } from '@nexus/factory-domain/inventory/reservations/rules'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import { LOT_QUALITY_STATUSES } from '@nexus/factory-domain/inventory/stock/overview'
import { notMoney } from '@nexus/factory-domain/money/marked'
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
    /**
     * B-W2b-100 (SCM-206): hides of another shade lot than the demand's (or of the out-of-shade group) are reserved anyway, with
     * this reason (inventory.shade.override). Without it such a line is refused (`refusal/SHADE_LOT` | `OUT_OF_SHADE`).
     */
    shadeOverrideReason: z.string().max(500).optional(),
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

// ---- B-W2b-100: find hides for a job (SCM-257, SCM-206) -------------------------------------------------------------------

const foundHide = output({
  hideId: id(),
  hideCode: z.string(),
  lotId: id(),
  lotCode: z.string(),
  shadeGroupId: id().nullable(),
  /** The shade group's label, else the W1 shade text; null: not sorted. */
  shadeLabel: z.string().nullable(),
  outOfShade: z.boolean(),
  /** Its grade by record, else its W1 text. */
  grade: z.string().nullable(),
  state: z.string(),
  /** On hand at the site, base unit. */
  left: z.string(),
  /** The lot's area up to and with this hide, in the lot's order (largest first). */
  running: z.string(),
  /** In the proposal (the first lot's hides that reach the need). */
  proposed: z.boolean(),
  locationCodes: z.array(z.string()),
  /** Its remnant tag (RM-…) when it is a tagged remnant in stock. */
  remnant: output({ id: id(), code: z.string() }).nullable(),
})
const words = output({ it: z.string(), en: z.string() })

export const findHidesContract = defineContract({
  querystring: input({
    /** Without a work order: the site (default the only one the caller reaches). */
    siteId: id().optional(),
    /** By a work order: its leather line, its need and its shade lot. */
    workOrderId: id().optional(),
    /** The article (required without a work order; picks the leather when the work order plans several). */
    itemId: id().optional(),
    itemColourId: id().optional(),
    shadeGroupId: id().optional(),
    /** The lowest grade taken (its tile order); ungraded hides only without it. */
    minGradeId: id().optional(),
    /** The area needed (replaces the work order's need), in `uom` (default the base unit). */
    area: quantity().optional(),
    uom: z.enum(AREA_UOMS).optional(),
  }),
  response: {
    200: output({
      site: output({ id: id() }),
      item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.string() }),
      colour: named.nullable(),
      /** By a work order: what it plans, holds (issued net of returns) and still has reserved of the leather, base unit. */
      workOrder: output({ id: id(), number: z.string(), planned: z.string().nullable(), issued: z.string().nullable(), reserved: z.string().nullable() }).nullable(),
      /** The leathers the work order plans by the hide (to pick one when there are several). */
      leathers: z.array(output({ itemId: id(), itemColourId: id().nullable() })),
      need: output({ baseArea: z.string().nullable(), source: z.enum(['ASKED', 'WORK_ORDER']).nullable() }),
      rule: z.enum(SHADE_RULES),
      /** The shade lots the work order holds or has reserved already. */
      ordersShadeLots: z.array(output({ lotCode: z.string(), shadeLabel: z.string().nullable() })),
      lots: z.array(
        output({
          key: z.string(),
          lotId: id(),
          lotCode: z.string(),
          shadeGroupId: id().nullable(),
          shadeLabel: z.string().nullable(),
          words,
          count: z.number().int(),
          /** The lot's area at the site (base unit): an area, not money. */
          total: notMoney(z.string()),
          covers: z.boolean(),
          ordersOwn: z.boolean(),
          /** Taking it would mix shades in the order. */
          shadeWarning: z.boolean(),
          hides: z.array(foundHide),
        }),
      ),
      outOfShade: z.array(foundHide),
      proposal: output({ lotKey: z.string(), hideIds: z.array(id()), count: z.number().int(), area: z.string(), covers: z.boolean(), words }).nullable(),
    }),
  },
})
