import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { holdReasonOf } from '../../../pack/carton/model'
import { cartonState, type CartonScanCard } from './model'

/** The carton a marks code names (`GET /shipping/cartons/scan`, shipping.pack), or null when none has it. */

const answer = z.object({
  carton: z.object({
    shipmentNumber: z.string(),
    shipmentStatus: z.enum(['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED']),
    hold: z.object({ reason: z.string() }).nullable(),
    seq: z.number(),
    closed: z.boolean(),
    cartonNumber: z.number().nullable(),
    cartonCount: z.number().nullable(),
    cartons: z.number(),
    marksCurrent: z.boolean(),
    labelled: z.boolean(),
    packagingType: z.object({ name: z.string(), kind: z.enum(['CARTON', 'BOX', 'PALLET', 'POLYBAG', 'HANGER']) }).nullable(),
    grossWeightKg: z.string().nullable(),
    netWeightKg: z.string().nullable(),
    garments: z.number(),
    contents: z.array(z.object({ styleCode: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number(), batchNumber: z.string().nullable(), serials: z.number() })),
  }),
})

export async function lookupCarton(api: ApiClient, code: string): Promise<CartonScanCard | null> {
  try {
    const { carton } = await api.get('/shipping/cartons/scan', { query: { code: code.trim().slice(0, 80) }, schema: answer })
    return {
      kind: 'carton',
      code: code.trim(),
      shipmentNumber: carton.shipmentNumber,
      shipmentStatus: carton.shipmentStatus,
      hold: carton.hold ? holdReasonOf(carton.hold.reason) : null,
      seq: carton.seq,
      numbered: carton.closed && carton.cartonNumber !== null ? { n: carton.cartonNumber, of: carton.cartonCount ?? carton.cartons } : null,
      cartons: carton.cartons,
      state: cartonState(carton),
      packaging: carton.packagingType,
      grossKg: carton.grossWeightKg,
      netKg: carton.netWeightKg,
      garments: carton.garments,
      contents: carton.contents.map((content) => ({ label: `${content.styleCode} ${content.colourwayCode} ${content.size}`, quantity: content.quantity, batch: content.batchNumber, serials: content.serials })),
    }
  } catch (error) {
    if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid')) return null
    throw error
  }
}
