import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { presignedSchema } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * "Report a problem" › Repair or alteration by link (apps/factory-api modules/sales/repairs-depth/link.ts, B-W2b-342;
 * follow-ups RR1:01, RR1:02). Beside B-W2b-192's claim routes, on the same CLAIM link:
 *
 *   GET  /link/claim/repair                         the repair is offered (its kinds), the repairs this link opened
 *   POST /link/claim/repair (Idempotency-Key)       the request: a repair waiting for the garment; this link's repairs + `sent`
 *   POST /link/claim/repair/photos (+ /:fileId/complete)  a damage photo of a repair this link opened, PUT to the store between
 *
 * Never a price: the claim link holds no price grain (an estimate is answered in the portal or by the office). An older API
 * without these routes answers 404: the page then offers no repair (the read's failure is never a refusal of the link).
 */

export const REPAIR_KINDS = ['REPAIR', 'ALTERATION'] as const
export type RepairKind = (typeof REPAIR_KINDS)[number]

const ref = z.object({ code: z.string(), name: z.string() })

export const repairEntrySchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(REPAIR_KINDS),
  stage: z.string(),
  channel: z.string(),
  opened: z.string(),
  open: z.boolean(),
  next: z.object({ code: z.string(), forYou: z.boolean() }),
  garment: z.object({ style: ref.nullable(), colourway: ref.nullable(), size: z.string().nullable(), serial: z.string().nullable() }),
  estimate: z.object({ revision: z.number(), status: z.string() }).nullable(),
})
export type RepairEntry = z.infer<typeof repairEntrySchema>

export const repairOfferSchema = z.object({
  offered: z.boolean(),
  kinds: z.array(z.enum(REPAIR_KINDS)),
  repairs: z.array(repairEntrySchema),
  photos: z.object({ max: z.number(), damage: z.number() }),
})
export type RepairOffer = z.infer<typeof repairOfferSchema>

const sentSchema = z.object({ type: z.literal('REPAIR'), id: z.string(), number: z.string(), answerBy: z.string().nullable() })
const submittedSchema = repairOfferSchema.extend({ link: z.object({ expiresAt: z.string(), usesLeft: z.number(), live: z.boolean() }), sent: sentSchema })
export type RepairSubmitted = z.infer<typeof submittedSchema>

export interface RepairBody {
  kind: RepairKind
  salesOrderLineId: string | null
  size: string | null
  serial: string | null
  problem: string | null
  workWanted: string | null
  typedName: string | null
}

/** `GET /link/claim/repair`: null when the API offers no repair (an older API). */
export async function readRepairOffer(api: ApiClient, signal?: AbortSignal): Promise<RepairOffer | null> {
  try {
    return await api.get('/link/claim/repair', { schema: repairOfferSchema, signal })
  } catch {
    return null
  }
}

/** `POST /link/claim/repair`: the repair, then this link's repairs and `sent`. The same key on a retry replays it. */
export function sendRepair(api: ApiClient, body: RepairBody, idempotencyKey: string): Promise<RepairSubmitted> {
  return api.post('/link/claim/repair', { body, schema: submittedSchema, idempotencyKey })
}

const uploadSchema = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completeSchema = z.object({ file: z.object({ id: z.string(), status: z.string() }) })

/** One damage photo onto a repair this link opened: announced with its SHA-256, PUT to the store, then confirmed. */
export async function uploadRepairPhoto(
  api: ApiClient,
  repairId: string,
  photo: { blob: Blob; name: string },
  keys: { announce: string; complete: string },
  put: typeof putToStore = putToStore,
): Promise<{ fileId: string; status: string }> {
  const bytes = await photo.blob.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const announced = await api.post('/link/claim/repair/photos', {
    body: { repairId, originalName: photo.name, contentType: photo.blob.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256 },
    schema: uploadSchema,
    idempotencyKey: keys.announce,
  })
  await put(announced.upload, bytes)
  const done = await api.post(`/link/claim/repair/photos/${encodeURIComponent(announced.file.id)}/complete`, { schema: completeSchema, idempotencyKey: keys.complete })
  return { fileId: done.file.id, status: done.file.status }
}
