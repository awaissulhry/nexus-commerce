import { z } from 'zod'
import { TRACKING_EXCEPTION_KINDS } from '@nexus/factory-domain/shipping/exceptions/rules'
import { DELIVERED_VIAS } from '@nexus/factory-domain/shipping/pod/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * Tracking & delivery in depth (B-W2b-398; apps/factory-api modules/shipping pod, exceptions): the proof of delivery — how we
 * know it arrived (from the carrier or typed), who signed and when, the image — set by hand part by part once; the
 * tracking problems the carrier's news or the daily check raised, and Resolve. Codes only: the screens say them.
 */

export const podSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), shippedAt: z.string().nullable(), version: z.number() }),
  deliveredAt: z.string().nullable(),
  deliveredVia: z.enum(DELIVERED_VIAS).nullable(),
  pod: z.object({ signedBy: z.string().nullable(), signedAt: z.string().nullable(), file: z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number() }).nullable() }).nullable(),
  carrierAsked: z.boolean(),
  recordHeld: z.enum(['NOT_DELIVERED', 'KEPT', 'NO_RIGHT']).nullable(),
  signerMax: z.number(),
})
export type Pod = z.infer<typeof podSchema>

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}`

export const readPod = (api: ApiClient, shipmentId: string): Promise<Pod> => api.get(`${base(shipmentId)}/pod`, { schema: podSchema })

export function recordPod(api: ApiClient, shipmentId: string, body: { version: number; signedBy?: string; signedAt?: string; fileId?: string }, idempotencyKey: string): Promise<Pod> {
  return api.request('PUT', `${base(shipmentId)}/pod`, { body, schema: podSchema, idempotencyKey })
}

const presigned = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

/** The proof's image or PDF: a presigned GET that lives 60 seconds. */
export const podFileLink = (api: ApiClient, shipmentId: string): Promise<{ url: string; headers: Record<string, string> }> =>
  api.get(`${base(shipmentId)}/pod/file`, { schema: z.object({ fileId: z.string(), name: z.string(), download: presigned }) }).then((answer) => answer.download)

/** The image a person scanned or photographed: uploaded as a file of the shipment (office only), then named by the PUT. */
export async function uploadPodFile(api: ApiClient, shipment: { id: string; companyId: string }, file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const announced = await requestUpload(api, {
    companyId: shipment.companyId,
    record: { type: 'Shipment', id: shipment.id },
    kind: file.type === 'application/pdf' ? 'DOCUMENT' : 'PHOTO',
    name: file.name || 'proof-of-delivery',
    contentType: file.type || 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(announced.upload, bytes)
  const done = await completeUpload(api, announced.file.id)
  return done.file.id
}

// ---- tracking problems (LOG-063) ---------------------------------------------------------------------------------------------------

const problemSchema = z.object({ id: z.string(), kind: z.enum(TRACKING_EXCEPTION_KINDS), raisedAt: z.string(), resolvedAt: z.string().nullable(), taskId: z.string().nullable() })

export const shipmentProblemsSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  noScanDays: z.number(),
  problems: z.array(problemSchema.extend({ taskStatus: z.string().nullable(), raisedBySystem: z.boolean() })),
})
export type ShipmentProblems = z.infer<typeof shipmentProblemsSchema>

export const readProblems = (api: ApiClient, shipmentId: string): Promise<ShipmentProblems> => api.get(`${base(shipmentId)}/tracking-problems`, { schema: shipmentProblemsSchema })

export function resolveProblem(api: ApiClient, shipmentId: string, exceptionId: string, note: string | null, idempotencyKey: string): Promise<ShipmentProblems> {
  return api.post(`${base(shipmentId)}/tracking-problems/${encodeURIComponent(exceptionId)}/resolve`, { body: note ? { note } : {}, schema: shipmentProblemsSchema, idempotencyKey })
}
