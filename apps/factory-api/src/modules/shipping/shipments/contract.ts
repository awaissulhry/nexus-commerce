import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { MAX_LINES_PER_REQUEST } from '@nexus/factory-domain/shipping/shipments'
import { fileView } from '../../../platform/files/contract'
import { oneShipment, statusSchema, transportBySchema } from '../views'

/**
 * The office's shipments (LOG-001, LOG-002, LOG-039; A2 SCR-066, SCR-067): what is released and not yet shipped, the
 * shipments list and record, planning a DRAFT from a sales order, its lines and delivery details, cancelling it, and its
 * packing list. A version is the edit-conflict guard (COL-078): the shipment's version as read.
 */

const version = z.number().int().min(1).optional()
const garments = () => z.number().int().min(1).max(100_000)
const lineInput = input({ workOrderSizeId: id(), quantity: garments() })

export const readyContract = defineContract({
  querystring: input({ siteId: id().optional(), salesOrderId: id().optional(), partyId: id().optional() }),
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
              serialTracked: z.boolean(),
            }),
          ),
        }),
      ),
    }),
  },
})

export const listShipmentsContract = defineContract({
  querystring: input({
    status: statusSchema.optional(),
    siteId: id().optional(),
    salesOrderId: id().optional(),
    partyId: id().optional(),
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
          serviceCode: z.string().nullable(),
          lines: z.number().int(),
          garments: z.number().int(),
          parcels: z.number().int(),
          packedAt: instant().nullable(),
          shippedAt: instant().nullable(),
          cancelledAt: instant().nullable(),
          createdAt: instant(),
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
  response: { 201: output({ file: fileView, layout: z.string() }) },
})
