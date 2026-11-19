import { z } from 'zod'
import { ELSEWHERE_PROBLEMS } from '@nexus/factory-domain/shipping/elsewhere'
import type { ApiClient } from '../../../../../../lib/api/client'
import { shipmentSchema } from '../../../../../warehouse/shipments/api'

/**
 * F-OP-123 (order page N5; apps/factory-api modules/shipping/elsewhere, B-OP-032): "Record a shipment made elsewhere" — the preview
 * (`POST /shipping/shipments/elsewhere/preview`, shipping.view: what the recording would say, nothing written) and the recording
 * (`POST /shipping/shipments/elsewhere`, shipping.manage + shipping.ddt.issue: ONE command, the shipment SHIPPED at the time it
 * left). Unknown fields of an answer are dropped. The API's English words are never drawn as they are: the screen words the codes.
 */

export interface ElsewhereBody {
  readonly salesOrderId: string
  readonly siteId?: string
  readonly lines: readonly { readonly workOrderSizeId: string; readonly quantity: number; readonly serials?: readonly string[] }[]
  readonly transportBy: 'CARRIER' | 'SENDER' | 'RECIPIENT'
  readonly carrierName?: string | null
  readonly trackingNumber?: string | null
  readonly externalDdt: { readonly number: string; readonly date: string } | null
  readonly ddtRequired: boolean
  readonly shippedAt: string
  readonly holdReason?: string
  readonly internalNote?: string | null
}

export const elsewherePreviewSchema = z.object({
  order: z.object({ id: z.string(), number: z.string() }),
  siteId: z.string(),
  lines: z.array(z.object({ workOrderSizeId: z.string(), label: z.string(), quantity: z.number(), shippable: z.number(), releasedAt: z.string().nullable(), serialTracked: z.boolean() })),
  earliest: z.string().nullable(),
  problems: z.array(z.object({ code: z.enum(ELSEWHERE_PROBLEMS), path: z.string(), message: z.string() })),
  holds: z.object({ held: z.boolean(), accountHold: z.string().nullable(), creditHeld: z.boolean(), mayRelease: z.boolean() }),
  ddtUsed: z.boolean(),
  noticeOn: z.boolean(),
  ddtCitable: z.boolean(),
})
export type ElsewherePreview = z.infer<typeof elsewherePreviewSchema>

const recordedSchema = z.object({ shipment: shipmentSchema, warnings: z.array(z.string()) })
export type ElsewhereRecorded = z.infer<typeof recordedSchema>

export function previewElsewhere(api: ApiClient, body: ElsewhereBody, signal?: AbortSignal): Promise<ElsewherePreview> {
  return api.post('/shipping/shipments/elsewhere/preview', { body, schema: elsewherePreviewSchema, ...(signal ? { signal } : {}) })
}

export function recordElsewhere(api: ApiClient, body: ElsewhereBody, idempotencyKey: string): Promise<ElsewhereRecorded> {
  return api.post('/shipping/shipments/elsewhere', { body, schema: recordedSchema, idempotencyKey })
}
