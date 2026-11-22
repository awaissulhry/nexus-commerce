import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * F-OS-203 (order SHIPMENTS tab; 13-backend B-OS-017, H3-B11) — two small commands of a shipment that had no window until now:
 *
 *   PUT  …/:id/ddt-required    "This shipment travels without a DDT" (required false) and back ("Put back the DDT"): a DRAFT or
 *                              PACKED Nexus shipment, no live DDT, a reason (shipping.manage + shipping.ddt.issue); reads no country
 *   GET  …/:id/carrier-return  where a shipment the carrier brought back stands (AWAITED, RECEIVED), its garments, the site's
 *                              finished-goods places
 *   POST …/:id/carrier-return  the garments back into finished goods, ONE command (shipping.manage)
 *
 * Both answer what the page reads again anyway; nothing of their answers is drawn but the carrier return's read.
 */

const enc = encodeURIComponent
const base = (shipmentId: string) => `/shipping/shipments/${enc(shipmentId)}`

/** B-OS-017: travels without a DDT (false) or with one again (true), with the office's reason. */
export async function setDdtRequired(api: ApiClient, shipmentId: string, body: { readonly version: number; readonly required: boolean; readonly reason: string }, idempotencyKey: string): Promise<void> {
  await api.request('PUT', `${base(shipmentId)}/ddt-required`, { body, idempotencyKey })
}

export const carrierReturnSchema = z.object({
  shipmentId: z.string(),
  number: z.string(),
  status: z.string(),
  version: z.number(),
  returnedAt: z.string().nullable(),
  state: z.string(),
  garments: z.number(),
  cells: z.array(z.object({ cellId: z.string(), label: z.string(), garments: z.number() })),
  receivedAt: z.string().nullable(),
  places: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  defaultLocationId: z.string().nullable(),
})
export type CarrierReturn = z.infer<typeof carrierReturnSchema>

export const readCarrierReturn = (api: ApiClient, shipmentId: string): Promise<CarrierReturn> => api.get(`${base(shipmentId)}/carrier-return`, { schema: z.object({ carrierReturn: carrierReturnSchema }) }).then((answer) => answer.carrierReturn)

export const receiveCarrierReturn = (api: ApiClient, shipmentId: string, body: { readonly version: number; readonly locationId?: string; readonly note?: string | null }, idempotencyKey: string): Promise<CarrierReturn> =>
  api.post(`${base(shipmentId)}/carrier-return`, { body, schema: z.object({ carrierReturn: carrierReturnSchema }), idempotencyKey }).then((answer) => answer.carrierReturn)
