import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { contentsSchema, statusSchema, transportBySchema } from '../views'

/**
 * Packing (LOG-039, LOG-002, QHS-073; A2 SCR-098 on the floor, SCR-067 in the office): parcels, which garments go in
 * which parcel, serials, weights and sizes, DRAFT ⇄ PACKED. The same routes serve the office and a floor device at its
 * own site; a floor write needs an Idempotency-Key (a resent tap packs once). Weights are kilograms (Decimal(18,4)),
 * sizes centimetres (Decimal(10,2)), as decimal strings. No sales order, party or address here: the floor reads none.
 */

const version = z.number().int().min(1).optional()
const weight = z.string().trim().max(24)
const centimetres = z.string().trim().max(16)

const packingShipment = output({
  id: id(),
  number: z.string(),
  status: statusSchema,
  version: z.number().int(),
  companyId: id(),
  siteId: id(),
  transportBy: transportBySchema,
  carrierCode: z.string().nullable(),
  serviceCode: z.string().nullable(),
  internalNote: z.string().nullable(),
  packedAt: instant().nullable(),
  ...contentsSchema,
  /**
   * What the packing station prints of the office's documents (SCR-098 "Documents", W1: the documents the office made):
   * the live DDT (number, date, its stored PDF) and the latest packing list PDF; null while the office has made none.
   */
  documents: output({
    ddt: output({ id: id(), number: z.string(), documentDate: z.string(), fileId: id().nullable() }).nullable(),
    packingList: output({ fileId: id(), createdAt: instant() }).nullable(),
  }),
  /** The site's packing settings: the cut-off, the goods' appearance, the station's printers; null when none are set. */
  settings: output({
    cutOffTime: z.string().nullable(),
    defaultGoodsAppearance: z.string().nullable(),
    labelPrinterId: id().nullable(),
    documentPrinterId: id().nullable(),
  }).nullable(),
})

const onePacking = { 200: output({ shipment: packingShipment }) }
const shipmentParams = input({ shipmentId: id() })
const versionQuery = input({ version: z.coerce.number().int().min(1).optional() })

export const packingQueueContract = defineContract({
  querystring: input({ siteId: id().optional(), status: z.enum(['DRAFT', 'PACKED']).optional() }),
  response: {
    200: output({
      shipments: z.array(
        output({
          id: id(),
          number: z.string(),
          status: statusSchema,
          version: z.number().int(),
          siteId: id(),
          transportBy: transportBySchema,
          carrierCode: z.string().nullable(),
          lines: z.number().int(),
          garments: z.number().int(),
          parcels: z.number().int(),
          packedAt: instant().nullable(),
          createdAt: instant(),
        }),
      ),
    }),
  },
})

export const packingViewContract = defineContract({ params: shipmentParams, response: onePacking })

export const addParcelContract = defineContract({
  params: shipmentParams,
  body: input({ version, grossWeightKg: weight.optional(), lengthCm: centimetres.optional(), widthCm: centimetres.optional(), heightCm: centimetres.optional() }),
  response: { 201: output({ shipment: packingShipment, parcelId: id() }) },
})

export const changeParcelContract = defineContract({
  params: input({ shipmentId: id(), parcelId: id() }),
  /** A measure left out stays; null clears it. */
  body: input({ version, grossWeightKg: weight.nullish(), lengthCm: centimetres.nullish(), widthCm: centimetres.nullish(), heightCm: centimetres.nullish() }),
  response: onePacking,
})

export const removeParcelContract = defineContract({ params: input({ shipmentId: id(), parcelId: id() }), querystring: versionQuery, response: onePacking })

export const placeLineContract = defineContract({
  params: input({ shipmentId: id(), lineId: id() }),
  body: input({
    version,
    /** The parcel; null: out of every parcel. */
    parcelId: id().nullable(),
    /** Default every garment of the line; fewer splits it. */
    quantity: z.number().int().min(1).max(100_000).optional(),
  }),
  response: onePacking,
})

export const packSerialContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    /** The serial as scanned. */
    serial: z.string().trim().min(1).max(64),
    /** The parcel it goes in; default a line of its cell with room. */
    parcelId: id().optional(),
  }),
  response: onePacking,
})

export const unpackSerialContract = defineContract({ params: input({ shipmentId: id(), serialId: id() }), querystring: versionQuery, response: onePacking })

export const packContract = defineContract({ params: shipmentParams, body: input({ version }), response: onePacking })

/** The office's documents a packer prints on the station's A4 printer (the site's shipping settings, else the one named). */
export const PACKING_DOCUMENTS = ['DDT', 'PACKING_LIST'] as const

export const printDocumentsContract = defineContract({
  params: shipmentParams,
  body: input({
    /** Default: every one that is there (the live DDT's PDF, the latest packing list). */
    documents: z.array(z.enum(PACKING_DOCUMENTS)).min(1).max(PACKING_DOCUMENTS.length).optional(),
    /** Default: the site's document printer (shipping settings). */
    printerId: id().optional(),
    copies: z.number().int().min(1).max(10).optional(),
  }),
  response: { 201: output({ jobs: z.array(output({ jobId: id(), document: z.enum(PACKING_DOCUMENTS), status: z.string() })) }) },
})
