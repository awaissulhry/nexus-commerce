import { z } from 'zod'
import { BENCH_PROBLEMS } from '@nexus/factory-domain/shipping/cartons/rules'
import { PACKAGING_KINDS } from '@nexus/factory-domain/shipping/packaging/rules'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * A shipment's cartons as packed (B-W2b-384; `GET /shipping/shipments/:id/cartons`, shipping.view; the office's copy of the
 * packing bench): ordered against packed per style, colour and size, each carton with its number "n of N", its packaging
 * (the carton master), weights, sizes, contents by size with the lot and every serial, its marks and its label. No party,
 * no address, no money. Reprinting the marks with a reason is the Carrier tab's (B-W2b-391).
 */

const contentSchema = z.object({
  id: z.string(),
  shipmentLineId: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number(),
  workOrderNumber: z.string(),
  batchNumber: z.string().nullable(),
  originCountry: z.string().nullable(),
  serials: z.array(z.object({ id: z.string(), serial: z.string(), packedAt: z.string().nullable() })),
})
export type CartonContent = z.infer<typeof contentSchema>

const cartonSchema = z.object({
  id: z.string(),
  version: z.number(),
  seq: z.number(),
  closed: z.boolean(),
  cartonNumber: z.number().nullable(),
  cartonCount: z.number().nullable(),
  marksPrintedAt: z.string().nullable(),
  marksCurrent: z.boolean(),
  labelled: z.boolean(),
  packagingType: z.object({ id: z.string(), name: z.string(), kind: z.enum(PACKAGING_KINDS) }).nullable(),
  grossWeightKg: z.string().nullable(),
  netWeightKg: z.string().nullable(),
  lengthCm: z.string().nullable(),
  widthCm: z.string().nullable(),
  heightCm: z.string().nullable(),
  garments: z.number(),
  contents: z.array(contentSchema),
})
export type Carton = z.infer<typeof cartonSchema>

export const benchSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.enum(SHIPMENT_STATUSES), version: z.number() }),
  hold: z.object({ reason: z.string(), placedAt: z.string() }).nullable(),
  grid: z.array(
    z.object({
      styleId: z.string(),
      styleCode: z.string(),
      styleName: z.string(),
      colourwayId: z.string(),
      colourwayCode: z.string(),
      colourwayName: z.string(),
      serialTracked: z.boolean(),
      batchNumbers: z.array(z.string()),
      sizes: z.array(z.object({ size: z.string(), ordered: z.number(), packed: z.number() })),
    }),
  ),
  cartons: z.array(cartonSchema),
  openCartonId: z.string().nullable(),
  problems: z.array(z.enum(BENCH_PROBLEMS)),
})
export type Bench = z.infer<typeof benchSchema>

export const readCartons = (api: ApiClient, shipmentId: string): Promise<Bench> => api.get(`/shipping/shipments/${encodeURIComponent(shipmentId)}/cartons`, { schema: benchSchema })
