import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../../shared/task-api'

/**
 * Goods without a PO's calls (B-W2b-300; apps/factory-api modules/inventory/unplanned, contract.ts; inventory.receive at the
 * device's site): where they wait and the suppliers to pick, the materials found by a typed code, the goods taken in with ONE
 * call (the receipt takes its number from the office: online only), the receipt read again. The DDT photo goes through Receive
 * goods' own `uploadDdtPhoto` (the receipt's photo route). No field carries money or a person.
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const tracking = z.enum(['NONE', 'LOT', 'HIDE'])

const start = z.object({
  serverTime: z.string(),
  holding: place.nullable(),
  suppliers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
})
export type UnplannedStart = z.infer<typeof start>

const material = z.object({ id: z.string(), code: z.string(), name: z.string(), tracking, baseUom: z.string(), purchaseUom: z.string(), colours: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })) })
export type Material = z.infer<typeof material>

const receipt = z.object({
  id: z.string(),
  number: z.string(),
  state: z.enum(['WAITING', 'ORDER_NAMED', 'SENT_BACK']),
  supplier: z.object({ id: z.string(), name: z.string() }),
  holding: place.nullable(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: z.string().nullable(),
  receivedAt: z.string(),
  buyerAsked: z.boolean(),
  ddtPhotos: z.number(),
  lines: z.array(z.object({ id: z.string(), seq: z.number(), label: z.string(), item: z.object({ id: z.string(), code: z.string(), name: z.string(), tracking }), colour: z.object({ code: z.string(), name: z.string() }).nullable(), quantity: z.string(), uom: z.string(), hideCount: z.number().nullable() })),
})
export type UnplannedReceipt = z.infer<typeof receipt>

export function fetchStart(api: ApiClient, q?: string): Promise<TaskOutcome<UnplannedStart>> {
  return floorRead(api, '/inventory/receiving/unplanned/start', { query: { q: q?.trim() || undefined }, schema: start })
}

export function fetchMaterials(api: ApiClient, q: string): Promise<TaskOutcome<Material[]>> {
  return floorRead(api, '/inventory/receiving/unplanned/items', { query: { q: q.trim() }, schema: z.object({ items: z.array(material) }) }).then((answer) => (answer.ok ? { ok: true, value: answer.value.items } : answer))
}

export interface UnplannedBody {
  readonly supplierId: string
  readonly holdingLocationId?: string
  readonly placeCode?: string
  readonly supplierDdtNumber?: string | null
  readonly supplierDdtDate?: string | null
  readonly note?: string | null
  readonly lines: readonly { readonly itemId: string; readonly itemColourId: string | null; readonly quantity: string; readonly hideCount?: number | null }[]
}

/** POST /inventory/receiving/unplanned with the screen's key (kept while the body is the same: a retry is answered, never taken in twice). */
export function postUnplanned(api: ApiClient, body: UnplannedBody, key: string): Promise<TaskOutcome<UnplannedReceipt>> {
  return floorWrite(api, 'POST', '/inventory/receiving/unplanned', { body, schema: z.object({ receipt }), idempotencyKey: key }).then((answer) => (answer.ok ? { ok: true, value: answer.value.receipt } : answer))
}

export function fetchUnplanned(api: ApiClient, receiptId: string): Promise<TaskOutcome<UnplannedReceipt>> {
  return floorRead(api, `/inventory/receiving/unplanned/${seg(receiptId)}`, { schema: z.object({ receipt }) }).then((answer) => (answer.ok ? { ok: true, value: answer.value.receipt } : answer))
}
