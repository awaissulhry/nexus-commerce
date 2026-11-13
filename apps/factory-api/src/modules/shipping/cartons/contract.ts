import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BENCH_PROBLEMS } from '@nexus/factory-domain/shipping/cartons/rules'
import { PACKAGING_KINDS, PALLET_KINDS } from '@nexus/factory-domain/shipping/packaging/rules'
import { statusSchema } from '../views'

/**
 * The packing bench's cartons (B-W2b-384; LOG-007, LOG-003, LOG-010, LOG-013; design floor.pack, warehouse.shipments
 * "Cartons", "Carton 2 of 3"). No party, no address, no money: what the floor and the office both read. Weights are
 * kilograms (4 decimals), sizes centimetres (2 decimals), as decimal strings. A refusal is a 409 whose issue path names
 * its code (`refusal/<CODE>`, factory-domain shipping/cartons/rules CARTON_REFUSALS).
 */

const version = z.number().int().min(1).optional()
const code = z.string().trim().min(1).max(64)

const contentSchema = output({
  id: id(),
  shipmentLineId: id(),
  cellId: id(),
  styleId: id(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayId: id(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number().int(),
  workOrderNumber: z.string(),
  /** The lot of the garments (PPE Reg. art. 13): their work order's batch number. */
  batchNumber: z.string().nullable(),
  originCountry: z.string().nullable(),
  serials: z.array(output({ id: id(), serial: z.string(), packedAt: instant().nullable() })),
})

export const benchSchema = output({
  shipment: output({ id: id(), number: z.string(), status: statusSchema, version: z.number().int(), companyId: id(), siteId: id() }),
  /** The hold in force (its reason; the floor never reads the words), or null. */
  hold: output({ reason: z.string(), placedAt: instant() }).nullable(),
  /** Ordered against packed per style, colour and size. */
  grid: z.array(
    output({
      styleId: id(),
      styleCode: z.string(),
      styleName: z.string(),
      colourwayId: id(),
      colourwayCode: z.string(),
      colourwayName: z.string(),
      serialTracked: z.boolean(),
      batchNumbers: z.array(z.string()),
      sizes: z.array(output({ size: z.string(), cellIds: z.array(id()), ordered: z.number().int(), packed: z.number().int() })),
    }),
  ),
  cartons: z.array(
    output({
      id: id(),
      version: z.number().int(),
      seq: z.number().int(),
      closed: z.boolean(),
      cartonNumber: z.number().int().nullable(),
      cartonCount: z.number().int().nullable(),
      marksPrintedAt: instant().nullable(),
      /** Closed, numbered for its place and the shipment's count, its marks printed since. */
      marksCurrent: z.boolean(),
      labelled: z.boolean(),
      packagingType: output({ id: id(), name: z.string(), kind: z.enum(PACKAGING_KINDS) }).nullable(),
      grossWeightKg: z.string().nullable(),
      /** The gross weight less the packaging's tare. */
      netWeightKg: z.string().nullable(),
      lengthCm: z.string().nullable(),
      widthCm: z.string().nullable(),
      heightCm: z.string().nullable(),
      garments: z.number().int(),
      contents: z.array(contentSchema),
    }),
  ),
  /** The carton a scan without one goes into (null: the next scan opens a new one). */
  openCartonId: id().nullable(),
  /** What a carton may be packed in (in use; never the cost). */
  packagingTypes: z.array(
    output({
      id: id(),
      name: z.string(),
      kind: z.enum(PACKAGING_KINDS),
      innerLengthCm: z.string().nullable(),
      innerWidthCm: z.string().nullable(),
      innerHeightCm: z.string().nullable(),
      tareKg: z.string().nullable(),
      maxWeightKg: z.string().nullable(),
      palletKind: z.enum(PALLET_KINDS).nullable(),
    }),
  ),
  /** The default packaging for the open carton's garments (or the next ones to scan). */
  suggestedPackagingTypeId: id().nullable(),
  /** What the bench still has to do (NOT_SCANNED, CARTON_OPEN, MARKS_NOT_PRINTED). */
  problems: z.array(z.enum(BENCH_PROBLEMS)),
})

const shipmentParams = input({ shipmentId: id() })
const cartonParams = input({ shipmentId: id(), parcelId: id() })

export const benchContract = defineContract({ params: shipmentParams, response: { 200: benchSchema } })

export const scanContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    /** The serial, SKU, barcode or batch label as scanned. */
    code,
    /** The cell chosen on the size grid (a batch label names no size). */
    cellId: id().optional(),
    /** The carton; default the open carton, else a new one. */
    parcelId: id().optional(),
    /** When the tablet scanned it (a queued scan; believed when it is not ahead of the server nor too old). */
    occurredAt: instant().optional(),
  }),
  response: {
    200: output({
      scan: output({ kind: z.enum(['SERIAL', 'SKU', 'BATCH']), cellId: id(), parcelId: id(), cartonSeq: z.number().int(), shipmentLineId: id(), serialId: id().nullable(), newCarton: z.boolean() }),
      bench: benchSchema,
    }),
  },
})

export const takeOutContract = defineContract({
  params: cartonParams,
  body: input({ version, code, cellId: id().optional() }),
  response: { 200: output({ takenOut: output({ parcelId: id(), cartonSeq: z.number().int(), cellId: id(), serialId: id().nullable(), reopened: z.boolean() }), bench: benchSchema }) },
})

const copies = z.number().int().min(1).max(10).optional()

export const closeContract = defineContract({
  params: cartonParams,
  body: input({
    version,
    /** Default: the carton's own, else the default for its garments. */
    packagingTypeId: id().optional(),
    grossWeightKg: z.string().trim().max(24).optional(),
    /** Print its marks after closing it (default yes). */
    print: z.boolean().optional(),
    printerId: id().optional(),
    copies,
  }),
  response: {
    200: output({
      closed: output({ parcelId: id(), cartonNumber: z.number().int(), cartonCount: z.number().int(), packagingTypeId: id(), garments: z.number().int(), warnings: z.array(z.enum(['OVERWEIGHT'])) }),
      marks: output({ printed: z.boolean(), jobIds: z.array(id()), problem: output({ code: z.string(), message: z.string() }).nullable() }),
      bench: benchSchema,
    }),
  },
})

const parcelIds = z.array(id()).min(1).max(99).optional()

export const printMarksContract = defineContract({
  params: shipmentParams,
  body: input({ parcelIds, printerId: id().optional(), copies }),
  response: { 201: output({ jobs: z.array(output({ jobId: id(), parcelId: id() })) }) },
})

export const marksPdfContract = defineContract({ params: shipmentParams, body: input({ parcelIds, copies }), response: {} })
