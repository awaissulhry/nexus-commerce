import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { KIT_LINE_STATUSES, MAX_LINES_PER_ACT, SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { presignedView } from '../../../platform/files/contract'

/**
 * The floor's subcontract kits (B-W2a-76; design floor.kits SCR-181; floor.ts). No fee, price or value anywhere: the floor
 * session holds no money grain. Pieces are whole garments; material quantities are decimal strings in their unit.
 */

const status = z.enum(SUBCONTRACT_ORDER_STATUSES)
const pieces = () => z.number().int().min(0).max(1_000_000)
const orderParams = input({ subcontractOrderId: id() })
const codeName = output({ code: z.string(), name: z.string() })
const place = output({ id: id(), code: z.string(), name: z.string() })
const codeRef = output({ id: id(), code: z.string() })

const row = output({
  id: id(),
  number: z.string(),
  status,
  workshop: codeName,
  workOrder: output({ number: z.string(), style: codeName }),
  expectedBackDate: businessDate().nullable(),
  late: z.boolean(),
  pieces: output({ ordered: z.number().int(), sent: z.number().int(), atWorkshop: z.number().int(), back: z.number().int() }),
  kit: output({ planned: z.number().int(), sent: z.number().int() }),
})

const kitView = output({
  id: id(),
  number: z.string(),
  status,
  version: z.number().int(),
  site: output({ id: id(), code: z.string() }),
  workshop: codeName,
  location: codeName,
  workOrder: output({ number: z.string(), style: codeName }),
  expectedBackDate: businessDate().nullable(),
  late: z.boolean(),
  operations: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      code: z.string(),
      name: z.string(),
      pieces: z.number().int(),
      sent: z.number().int(),
      backGood: z.number().int(),
      backDefective: z.number().int(),
      scrapped: z.number().int(),
      atWorkshop: z.number().int(),
      /** The work order cells it sends (none: every cell). */
      cells: z.array(id()),
    }),
  ),
  kitLines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(ITEM_TRACKINGS) }),
      colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
      lot: codeRef.nullable(),
      hide: codeRef.nullable(),
      quantity: z.string(),
      uom: z.enum(UOMS),
      baseQuantity: z.string(),
      status: z.enum(KIT_LINE_STATUSES),
      sentAt: z.string().nullable(),
      ddtNumber: z.string().nullable(),
      /** PLANNED: the site's places holding it (released lots, nothing on quality hold), the most first. */
      sources: z.array(output({ location: place, lot: codeRef.nullable(), hide: codeRef.nullable(), available: z.string(), covers: z.boolean() })),
      /** SENT: the place it left from (where unused material goes back by default). */
      from: place.nullable(),
      /** SENT: what of it is at the workshop now (base unit). */
      atWorkshop: z.string().nullable(),
    }),
  ),
  bundles: z.array(
    output({
      id: id(),
      code: z.string(),
      replacedCodes: z.array(z.string()),
      workOrderSizeId: id(),
      colourway: z.string(),
      size: z.string(),
      /** The garment part it carries; null: whole garments. */
      part: z.string().nullable(),
      quantity: z.number().int(),
      /** A send of this order named it. */
      sent: z.boolean(),
      /** What came back of it, per operation of the order. */
      back: z.array(output({ operationId: id(), good: z.number().int(), defective: z.number().int(), scrapped: z.number().int() })),
    }),
  ),
  /** The site's places material may come back to. */
  places: z.array(output({ id: id(), code: z.string(), name: z.string(), kind: z.string() })),
  ddts: z.array(output({ id: id(), number: z.string(), documentDate: businessDate(), cancelled: z.boolean(), pdf: z.boolean() })),
  /** Why the kit cannot go out or the goods cannot come back now, in words; null: it may. */
  actions: output({ send: z.string().nullable(), receive: z.string().nullable() }),
})

export const floorKitsContract = defineContract({
  querystring: input({ mode: z.enum(['send', 'receive']), code: z.string().trim().max(60).optional() }),
  response: { 200: output({ serverTime: instant(), orders: z.array(row), found: output({ id: id(), number: z.string(), status }).nullable() }) },
})

export const floorKitContract = defineContract({ params: orderParams, response: { 200: output({ serverTime: instant(), order: kitView }) } })

export const floorSendKitContract = defineContract({
  params: orderParams,
  body: input({
    version: z.number().int().min(1),
    lines: z.array(input({ lineId: id(), fromLocationId: id(), lotId: id().nullish(), hideId: id().nullish() })).max(MAX_LINES_PER_ACT).default([]),
    bundles: z.array(input({ bundleId: id() })).max(MAX_LINES_PER_ACT).default([]),
    /** The DDT for work on our behalf, always issued from the floor: who carries the goods, parcels, gross weight, appearance (default: the site's). */
    ddt: input({ transportBy: z.enum(['SENDER', 'RECIPIENT']), packages: z.number().int().min(1).max(999), grossWeightKg: quantity(), appearance: z.string().trim().min(1).max(100).nullish() }),
  }),
  response: { 201: output({ order: kitView, ddt: output({ id: id(), number: z.string(), pdf: z.boolean(), pdfProblem: z.string().nullable() }).nullable() }) },
})

export const floorReceiveBackContract = defineContract({
  params: orderParams,
  body: input({
    version: z.number().int().min(1),
    lines: z
      .array(input({ operationId: id(), bundleId: id().optional(), good: pieces(), defective: pieces(), scrapped: pieces(), reason: z.string().trim().max(300).nullish() }))
      .max(MAX_LINES_PER_ACT)
      .default([]),
    returns: z
      .array(input({ itemId: id(), itemColourId: id().nullish(), lotId: id().nullish(), hideId: id().nullish(), quantity: quantity(), uom: z.enum(UOMS).optional(), toLocationId: id() }))
      .max(MAX_LINES_PER_ACT)
      .default([]),
    supplierDdt: input({ number: z.string().trim().min(1).max(40), date: businessDate().nullish() }).nullish(),
    note: z.string().trim().max(1000).nullish(),
  }),
  response: {
    201: output({
      order: kitView,
      receipt: output({ id: id(), receivedAt: z.string(), good: z.number().int(), defective: z.number().int(), scrapped: z.number().int(), bundles: z.number().int(), returned: z.number().int() }),
    }),
  },
})

export const floorKitDdtPdfContract = defineContract({ params: input({ subcontractOrderId: id(), ddtId: id() }), response: { 200: output({ download: presignedView }) } })
