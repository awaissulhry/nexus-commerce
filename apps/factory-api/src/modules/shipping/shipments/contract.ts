import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { MAX_LINES_PER_REQUEST } from '@nexus/factory-domain/shipping/shipments'
import { fileView } from '../../../platform/files/contract'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { TRANSPORT_EVIDENCE_STATUSES } from '@nexus/factory-domain/shipping/evidence/evidence'
import { FREIGHT_RULES, MAX_FREIGHT } from '@nexus/factory-domain/shipping/shipments/freight'
import { freightSchema, oneShipment, statusSchema, transportBySchema } from '../views'

/**
 * The office's shipments (LOG-001, LOG-002, LOG-039; A2 SCR-066, SCR-067): what is released and not yet shipped, the
 * shipments list and record, planning a DRAFT from a sales order, its lines and delivery details, cancelling it, and its
 * packing list. A version is the edit-conflict guard (COL-078): the shipment's version as read.
 */

const version = z.number().int().min(1).optional()
const garments = () => z.number().int().min(1).max(100_000)
const lineInput = input({ workOrderSizeId: id(), quantity: garments() })

export const readyContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    salesOrderId: id().optional(),
    partyId: id().optional(),
    /** B-W2a-48: a page of orders at a time (by number); the cursor is the last order of the page before. */
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  response: {
    200: output({
      orders: z.array(
        output({
          salesOrderId: id(),
          number: z.string(),
          customerRef: z.string().nullable(),
          status: z.string(),
          companyId: id(),
          partyId: id(),
          party: output({ code: z.string(), legalName: z.string() }),
          cells: z.array(
            output({
              workOrderSizeId: id(),
              workOrderId: id(),
              workOrderNumber: z.string(),
              batchNumber: z.string().nullable(),
              siteId: id(),
              salesOrderLineId: id(),
              lineSeq: z.number().int(),
              styleCode: z.string(),
              styleName: z.string(),
              colourwayCode: z.string(),
              colourwayName: z.string(),
              size: z.string(),
              /** The cell's pieces (the work order's plan). */
              pieces: z.number().int(),
              released: z.number().int(),
              reversed: z.number().int(),
              /** On shipments that are not CANCELLED (DRAFT and PACKED ones too). */
              onShipments: z.number().int(),
              /** Released less reversed less on shipments: what a new line can take. */
              shippable: z.number().int(),
              /** B-W2a-48: of those, garments its work order has in finished goods (they leave from stock). */
              inStock: z.number().int(),
              serialTracked: z.boolean(),
            }),
          ),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const listShipmentsContract = defineContract({
  querystring: input({
    status: statusSchema.optional(),
    /** The ship-today queue (SCR-066): the shipments that have not left yet (DRAFT and PACKED). */
    open: z.enum(['true', 'false']).optional(),
    /** Part of the shipment's or its sales order's number, the customer PO, the customer's name, or a tracking number. */
    q: z.string().trim().max(64).optional(),
    siteId: id().optional(),
    salesOrderId: id().optional(),
    partyId: id().optional(),
    /** B-W2a-48 (LOG-090): the transport evidence's state; `open` = AWAITED or PARTIAL. */
    evidence: z.enum([...TRANSPORT_EVIDENCE_STATUSES, 'open']).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      shipments: z.array(
        output({
          id: id(),
          number: z.string(),
          status: statusSchema,
          version: z.number().int(),
          companyId: id(),
          siteId: id(),
          partyId: id(),
          partyName: z.string(),
          salesOrderId: id(),
          salesOrderNumber: z.string(),
          transportBy: transportBySchema,
          carrierCode: z.string().nullable(),
          carrierName: z.string().nullable(),
          serviceCode: z.string().nullable(),
          /** Where it goes, as sent (the ship-to snapshot): city and country. */
          shipTo: output({ city: z.string().nullable(), country: z.string().nullable() }),
          lines: z.number().int(),
          garments: z.number().int(),
          parcels: z.number().int(),
          /** The parcels' gross weights added up (kg, a decimal string); null while a parcel is not weighed. */
          grossWeightKg: z.string().nullable(),
          /** Parcels with a carrier label, and the first tracking numbers (by parcel). */
          labelled: z.number().int(),
          trackingNumbers: z.array(z.string()),
          /** The live DDT (none: not issued, or cancelled and not replaced yet). */
          ddt: output({ id: id(), number: z.string() }).nullable(),
          packedAt: instant().nullable(),
          shippedAt: instant().nullable(),
          cancelledAt: instant().nullable(),
          createdAt: instant(),
          /** B-W2a-48 (LOG-105): the freight charged (the order's currency, minor units; null: not decided yet). */
          freightCharge: money.price(z.number().int().nullable()),
          currency: z.string(),
          /** B-W2a-48 (LOG-090). */
          transportEvidence: z.enum(TRANSPORT_EVIDENCE_STATUSES),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

const shipmentParams = input({ shipmentId: id() })
const lineParams = input({ shipmentId: id(), lineId: id() })

export const getShipmentContract = defineContract({ params: shipmentParams, response: { 200: oneShipment } })

export const createShipmentContract = defineContract({
  body: input({
    salesOrderId: id(),
    /** The site the goods leave from; default the one site of the lines' work order cells. */
    siteId: id().optional(),
    /** A delivery address of the order's party; default the order's ship-to. */
    shipToAddressId: id().optional(),
    /** Defaults: the site's shipping settings. */
    transportBy: transportBySchema.optional(),
    carrierCode: z.string().trim().max(64).nullish(),
    serviceCode: z.string().trim().max(128).nullish(),
    internalNote: z.string().trim().max(2000).nullish(),
    lines: z.array(lineInput).max(MAX_LINES_PER_REQUEST).optional(),
  }),
  response: { 201: oneShipment },
})

export const updateShipmentContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    shipToAddressId: id().optional(),
    transportBy: transportBySchema.optional(),
    carrierCode: z.string().trim().max(64).nullish(),
    serviceCode: z.string().trim().max(128).nullish(),
    internalNote: z.string().trim().max(2000).nullish(),
  }),
  response: { 200: oneShipment },
})

export const addLinesContract = defineContract({
  params: shipmentParams,
  body: input({ version, lines: z.array(lineInput).min(1).max(MAX_LINES_PER_REQUEST) }),
  response: { 200: oneShipment },
})

export const changeLineContract = defineContract({
  params: lineParams,
  body: input({ version, quantity: garments() }),
  response: { 200: oneShipment },
})

export const removeLineContract = defineContract({
  params: lineParams,
  querystring: input({ version: z.coerce.number().int().min(1).optional() }),
  response: { 200: oneShipment },
})

export const cancelShipmentContract = defineContract({
  params: shipmentParams,
  body: input({ version, reason: z.string().trim().min(1).max(500) }),
  response: { 200: oneShipment },
})

export const packingListContract = defineContract({
  params: shipmentParams,
  body: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }),
  response: {
    201: output({
      file: fileView,
      layout: z.string(),
      /** B-W2a-48 (LOG-012): the packing list's version and number; `reused` when these contents were printed already. */
      version: z.number().int(),
      number: z.string(),
      reused: z.boolean(),
    }),
  },
})

// ---- B-W2a-48: shipping every day -----------------------------------------------------------------------------------

const packingListVersion = output({
  fileId: id(),
  version: z.number().int(),
  number: z.string(),
  language: z.enum(DOCUMENT_LANGUAGES),
  /** It lists the shipment's parcels and garments as they are now. */
  current: z.boolean(),
  parcels: z.number().int(),
  garments: z.number().int(),
  createdAt: instant(),
})

export const packingListsContract = defineContract({
  params: shipmentParams,
  response: { 200: output({ shipmentId: id(), number: z.string(), packingLists: z.array(packingListVersion) }) },
})

const sizeBackorder = output({
  size: z.string(),
  ordered: z.number().int(),
  closedShort: z.boolean(),
  closed: z.number().int(),
  shipped: z.number().int(),
  open: z.number().int(),
  thisShipment: z.number().int(),
  netReleased: z.number().int(),
  onShipments: z.number().int(),
  backorder: z.number().int(),
  readyNow: z.number().int(),
  inProduction: z.number().int(),
})

const backorderTotals = output({
  ordered: z.number().int(),
  closed: z.number().int(),
  shipped: z.number().int(),
  open: z.number().int(),
  thisShipment: z.number().int(),
  backorder: z.number().int(),
  readyNow: z.number().int(),
  inProduction: z.number().int(),
})

const backorderOrder = output({
  salesOrderId: id(),
  number: z.string(),
  status: z.string(),
  companyId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  customerRef: z.string().nullable(),
  promiseDate: z.iso.date().nullable(),
})

export const orderBackorderContract = defineContract({
  params: input({ salesOrderId: id() }),
  querystring: input({ shipmentId: id().optional() }),
  response: {
    200: output({
      order: backorderOrder,
      shipmentId: id().nullable(),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          kind: z.string(),
          styleCode: z.string(),
          styleName: z.string(),
          colourwayCode: z.string(),
          colourwayName: z.string(),
          closedShort: z.boolean(),
          closeShortReason: z.string().nullable(),
          sizes: z.array(sizeBackorder),
          totals: notMoney(backorderTotals),
        }),
      ),
      totals: notMoney(backorderTotals),
      words: z.string().nullable(),
      shipments: z.array(output({ id: id(), number: z.string(), status: statusSchema, shippedAt: instant().nullable() })),
    }),
  },
})

export const backordersContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    partyId: id().optional(),
    q: z.string().trim().max(64).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ orders: z.array(backorderOrder.extend({ totals: notMoney(backorderTotals), words: z.string().nullable() })), nextCursor: id().nullable() }) },
})

const freightRuleView = output({
  rule: z.enum(FREIGHT_RULES),
  /** In the company's currency, minor units. */
  amount: money.price(z.number().int().nullable()),
  /** The order's net value from which it ships free; null: never free. */
  freeFrom: money.price(z.number().int().nullable()),
  currency: z.string(),
  version: z.number().int(),
  updatedAt: instant(),
})

const siteFreight = output({ site: output({ id: id(), companyId: id(), code: z.string(), name: z.string() }), freight: freightRuleView.nullable() })

export const getFreightRuleContract = defineContract({ params: input({ siteId: id() }), response: { 200: siteFreight } })

export const saveFreightRuleContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    /** The site's shipping settings' version as read. */
    version: z.number().int().min(1).optional(),
    rule: z.enum(FREIGHT_RULES),
    amount: money.price(z.number().int().min(0).max(MAX_FREIGHT).nullish()),
    freeFrom: money.price(z.number().int().min(0).max(MAX_FREIGHT).nullish()),
  }),
  response: { 200: siteFreight },
})

export const setFreightContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    /** Minor units in the order's currency; null: back to the site's rule. */
    freightCharge: money.price(z.number().int().min(0).max(MAX_FREIGHT).nullable()),
  }),
  response: { 200: output({ shipmentId: id(), number: z.string(), status: statusSchema, version: z.number().int(), freight: freightSchema }) },
})
