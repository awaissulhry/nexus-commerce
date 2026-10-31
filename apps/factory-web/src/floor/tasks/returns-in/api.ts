import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * Receive a return's calls (apps/factory-api modules/sales/returns dock.ts and photos.ts, B-W2a-43; the floor at its own
 * site: sales.returns.receive, grading sales.returns.inspect): the open RMA a scanned number names, the RMA read again,
 * the receipt in ONE call (online only: it is a receipt), the photos of the parcel and of a garment (announce → PUT to the
 * store → complete), the grades. The dock's view carries no price, discount, credit or internal note; nothing here does.
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const words = z.object({ labelIt: z.string(), labelEn: z.string() })
const codeName = z.object({ code: z.string(), name: z.string() })

const dockLine = z.object({
  id: z.string(),
  seq: z.number(),
  description: z.string().nullable(),
  style: codeName.nullable(),
  colourway: codeName.nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  ppe: z.boolean(),
  safety: z.boolean(),
  reasonCode: z.string(),
  reason: words.nullable(),
  quantity: z.number(),
  receivedQuantity: z.number(),
  expected: z.number(),
  grade: z.enum(['NEW', 'LIKE_NEW', 'GOOD', 'DAMAGED', 'UNUSABLE']).nullable(),
  cause: z.string().nullable(),
  photos: z.number(),
  suggestedOutcome: z.string().nullable(),
  disposition: z.string().nullable(),
  goodsOutcome: z.string().nullable(),
  place: z.string().nullable(),
  version: z.number(),
})
export type DockLine = z.infer<typeof dockLine>

const dock = z.object({
  id: z.string(),
  number: z.string(),
  site: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  customerRef: z.string().nullable(),
  status: z.enum(['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED', 'REJECTED', 'CANCELLED']),
  goodsDueBy: z.string().nullable(),
  receivedAt: z.string().nullable(),
  lines: z.array(dockLine),
  receipts: z.array(z.object({ id: z.string(), receivedAt: z.string(), parcels: z.number(), parcelCondition: z.string(), customerDdtNumber: z.string().nullable(), photos: z.number() })),
  places: z.object({ inspection: place.nullable(), quarantine: place.nullable(), finishedGoods: place.nullable() }),
  version: z.number(),
})
export type DockReturn = z.infer<typeof dock>

const dockAnswer = z.object({ return: dock })

/** GET /sales/returns/dock?code=: the open RMA (AUTHORISED, RECEIVED or INSPECTED) at this site; 404 in words otherwise. */
export function findReturn(api: ApiClient, code: string): Promise<TaskOutcome<DockReturn>> {
  return floorRead(api, '/sales/returns/dock', { query: { code }, schema: dockAnswer }).then((answer) => (answer.ok ? { ok: true, value: answer.value.return } : answer))
}

/** GET /sales/returns/:id/dock */
export function fetchReturn(api: ApiClient, returnId: string): Promise<TaskOutcome<DockReturn>> {
  return floorRead(api, `/sales/returns/${seg(returnId)}/dock`, { schema: dockAnswer }).then((answer) => (answer.ok ? { ok: true, value: answer.value.return } : answer))
}

export type ParcelCondition = 'INTACT' | 'DAMAGED' | 'OPENED'

export interface ReceiptBody {
  version: number
  parcels: number
  parcelCondition: ParcelCondition
  customerDdtNumber?: string | null
  lines: { lineId: string; quantity: number }[]
}

/** POST /sales/returns/:id/receipts — ONE command; the key is kept for a retry of the same receipt. */
export function postReceipt(api: ApiClient, returnId: string, body: ReceiptBody, idempotencyKey: string): Promise<TaskOutcome<{ return: DockReturn; receiptId: string }>> {
  return floorWrite(api, 'POST', `/sales/returns/${seg(returnId)}/receipts`, { body, schema: z.object({ return: dock, receiptId: z.string() }), idempotencyKey })
}

export type ReturnGrade = NonNullable<DockLine['grade']>

/** POST /sales/returns/:id/grades — one or more received lines graded (the floor sends one at a time). */
export function postGrades(api: ApiClient, returnId: string, body: { version: number; lines: { lineId: string; grade: ReturnGrade }[] }, idempotencyKey: string): Promise<TaskOutcome<DockReturn>> {
  return floorWrite(api, 'POST', `/sales/returns/${seg(returnId)}/grades`, { body, schema: dockAnswer, idempotencyKey }).then((answer) => (answer.ok ? { ok: true, value: answer.value.return } : answer))
}

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/**
 * A photo onto the receipt (`receipts/:receiptId`) or onto a garment's line (`lines/:lineId`): announced (its size and
 * SHA-256), its bytes PUT straight to the store, then confirmed. Each step's failure stops it; the receipt or the grade
 * it belongs to stands.
 */
export async function uploadPhoto(api: ApiClient, returnId: string, target: { kind: 'receipt' | 'line'; id: string }, photo: Blob, name: string): Promise<TaskOutcome<{ fileId: string }>> {
  const base = `/sales/returns/${seg(returnId)}/${target.kind === 'receipt' ? 'receipts' : 'lines'}/${seg(target.id)}/photos`
  const bytes = await photo.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType: photo.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256 }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }) }) })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}
