import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { floorRead, floorWrite, seg, taskProblemOf, type TaskOutcome, type TaskProblem } from '../shared/task-api'

/**
 * Receive goods' calls (apps/factory-api modules/inventory/receiving, contract.ts; inventory.receive at the device's site):
 * what the site expects (or the order of a scanned number), one order with its open lines, the receipt posted in ONE
 * call (its numbers, lots and hide tags come from the office: online only), the receipt read again (its tags' print
 * state), its tags printed again. Each answer is checked against the fields the screen reads; no field carries money.
 * Every write carries an Idempotency-Key (floorWrite); the receipt's key is kept for a retry of the same delivery.
 */

const decimal = z.union([z.string(), z.number()]).transform(String)
const party = z.object({ id: z.string(), name: z.string() })
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const printer = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
})

const expectedOrder = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  supplier: party,
  due: z.string().nullable(),
  openLines: z.number(),
  lines: z.number(),
  receivedBefore: z.boolean(),
})
export type ExpectedOrder = z.infer<typeof expectedOrder>

const expectedList = z.object({
  serverTime: z.string(),
  orders: z.array(expectedOrder),
  found: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
})
export type ExpectedList = z.infer<typeof expectedList>

const orderHead = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  version: z.number(),
  supplier: party,
  requestedDate: z.string().nullable(),
})
export type OrderHead = z.infer<typeof orderHead>

const orderLine = z.object({
  id: z.string(),
  seq: z.number(),
  item: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']),
    baseUom: z.string(),
    isPpeComponent: z.boolean(),
  }),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  quantity: decimal,
  uom: z.string(),
  expected: decimal,
  received: decimal,
  open: decimal,
  tolerancePct: z.string().nullable(),
  upTo: decimal,
  needDate: z.string(),
  confirmedDate: z.string().nullable(),
  estimatedHides: z.number().nullable(),
  hidesReceived: z.number(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  holds: z.array(z.string()),
  areaUnits: z.array(z.string()),
})
export type OrderLine = z.infer<typeof orderLine>

const orderToReceive = z.object({
  serverTime: z.string(),
  order: orderHead,
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
  lines: z.array(orderLine),
  dock: place.nullable(),
  hold: place.nullable(),
  printer: printer.nullable(),
})
export type OrderToReceive = z.infer<typeof orderToReceive>

const tag = z.object({
  hideId: z.string(),
  code: z.string(),
  jobId: z.string().nullable(),
  status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']).nullable(),
  version: z.number().nullable(),
  problem: z.string().nullable(),
})
export type TagJob = z.infer<typeof tag>

const receipt = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  receivedAt: z.string(),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: z.string().nullable(),
  order: orderHead,
  lines: z.array(
    z.object({
      seq: z.number(),
      purchaseOrderLineId: z.string().nullable(),
      item: z.object({
        code: z.string(),
        name: z.string(),
        tracking: z.string(),
      }),
      colour: z.object({ code: z.string(), name: z.string() }).nullable(),
      quantity: decimal,
      uom: z.string(),
      baseQuantity: decimal,
      hideCount: z.number().nullable(),
      difference: z
        .object({
          kind: z.string(),
          expected: decimal,
          after: decimal,
          open: decimal,
          difference: decimal,
          upTo: decimal,
        })
        .nullable(),
    }),
  ),
  lots: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      lineSeq: z.number(),
      supplierLotRef: z.string().nullable(),
      dyeBatch: z.string().nullable(),
      qualityStatus: z.string(),
      holds: z.array(z.string()),
      requiresCrViTest: z.boolean(),
      crViStatus: z.string(),
      baseQuantity: decimal,
      hideCount: z.number(),
      location: place.nullable(),
    }),
  ),
  hides: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      lotId: z.string(),
      lotCode: z.string(),
      supplierCode: z.string().nullable(),
      area: decimal,
      areaUom: z.string(),
      grade: z.string().nullable(),
      shade: z.string().nullable(),
      thicknessMm: z.string().nullable(),
    }),
  ),
  tags: z.object({ printer: printer.nullable(), jobs: z.array(tag) }),
})
export type FloorReceipt = z.infer<typeof receipt>

const note = z.object({
  code: z.string(),
  seq: z.number().nullable(),
  message: z.string(),
})
export type ReceiptNote = z.infer<typeof note>

const recorded = z.object({ receipt, notes: z.array(note) })
export type Recorded = z.infer<typeof recorded>

const oneReceipt = z.object({ receipt })
const job = z.object({
  job: z.object({ id: z.string(), status: z.string(), version: z.number() }),
})

/** GET /inventory/receiving/orders[?code=]: what the site expects (with a code: the order of that number). */
export function fetchExpected(api: ApiClient, code?: string): Promise<TaskOutcome<ExpectedList>> {
  return floorRead(api, '/inventory/receiving/orders', {
    query: code ? { code } : {},
    schema: expectedList,
  })
}

/** GET /inventory/receiving/orders/:orderId: the order, its open lines, the dock, the hold place, the station printer. */
export function fetchOrder(api: ApiClient, orderId: string): Promise<TaskOutcome<OrderToReceive>> {
  return floorRead(api, `/inventory/receiving/orders/${seg(orderId)}`, {
    schema: orderToReceive,
  })
}

/** A failed post as the screen answers it: over the tolerance (which lines need a reason), else the task problem. */
export type PostProblem =
  | { readonly kind: 'over'; readonly lines: readonly number[] }
  | {
      readonly kind: 'task'
      readonly problem: TaskProblem
      readonly lineIndex: number | null
    }

const LINE_PATH = /^body\/lines\/(\d+)(?:\/(.+))?$/

/** The line indexes an error names (`body/lines/<i>/…`), and those that ask a difference reason. */
export function postProblemOf(error: unknown): PostProblem {
  const problem = taskProblemOf(error)
  if (!isApiError(error)) return { kind: 'task', problem, lineIndex: null }
  const named = error.issues.map((issue) => LINE_PATH.exec(issuePath(issue))).filter((match): match is RegExpExecArray => match !== null)
  const over = named.filter((match) => match[2] === 'differenceReason').map((match) => Number(match[1]))
  if (error.kind === 'conflict' && over.length > 0) return { kind: 'over', lines: [...new Set(over)] }
  return {
    kind: 'task',
    problem,
    lineIndex: named[0] ? Number(named[0][1]) : null,
  }
}

export interface ReceiveBody {
  readonly version: number
  readonly supplierDdtNumber?: string | null
  /** B-W2a-75: the delivery note's date (YYYY-MM-DD). */
  readonly supplierDdtDate?: string | null
  readonly lines: readonly unknown[]
  readonly printerId?: string | null
  readonly language?: 'it' | 'en'
}

/** POST /inventory/receiving/orders/:orderId/receipts: the whole delivery at once (keep `key` to send it again). */
export async function postReceipt(api: ApiClient, orderId: string, body: ReceiveBody, key: string): Promise<{ ok: true; value: Recorded } | { ok: false; problem: PostProblem }> {
  try {
    await api.get('/auth/csrf')
    const value = await api.request('POST', `/inventory/receiving/orders/${seg(orderId)}/receipts`, { body, schema: recorded, idempotencyKey: key })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, problem: postProblemOf(error) }
  }
}

/** GET /inventory/receiving/receipts/:receiptId: the receipt again (its tags' print state). */
export function fetchReceipt(api: ApiClient, receiptId: string): Promise<TaskOutcome<FloorReceipt>> {
  return floorRead(api, `/inventory/receiving/receipts/${seg(receiptId)}`, {
    schema: oneReceipt,
  }).then((answer) => (answer.ok ? { ok: true, value: answer.value.receipt } : answer))
}

export type ReprintReason = 'DAMAGED' | 'LOST' | 'NOT_PRINTED' | 'OTHER'

/** POST /inventory/receiving/receipts/:receiptId/tags: print these hides' tags again (all of them without `hideIds`). */
export function printTags(
  api: ApiClient,
  receiptId: string,
  input: {
    hideIds?: readonly string[]
    printerId?: string | null
    language: 'it' | 'en'
    reason: ReprintReason
  },
): Promise<TaskOutcome<FloorReceipt>> {
  return floorWrite(api, 'POST', `/inventory/receiving/receipts/${seg(receiptId)}/tags`, { body: input, schema: oneReceipt, idempotencyKey: newIdempotencyKey() }).then((answer) =>
    answer.ok ? { ok: true, value: answer.value.receipt } : answer,
  )
}

/** POST /print/jobs/:jobId/retry: a FAILED tag queued again. */
export function retryTag(api: ApiClient, jobId: string, version: number): Promise<TaskOutcome<{ id: string; status: string; version: number }>> {
  return floorWrite(api, 'POST', `/print/jobs/${seg(jobId)}/retry`, {
    body: { version },
    schema: job,
    idempotencyKey: newIdempotencyKey(),
  }).then((answer) => (answer.ok ? { ok: true, value: answer.value.job } : answer))
}

// ---- the delivery note's photo (B-W2a-75 on B-W2a-31's route: a PHOTO of the receipt, OFFICE + FLOOR at the site) ----

const ddtUpload = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/**
 * The supplier's delivery note photo, after the receipt is posted: announced (its size, type and SHA-256), its bytes PUT
 * straight to the store with the presigned request, then confirmed. The floor may not write files itself: the API writes
 * it as the site's (inventory.receive at the device's site). Each step keeps no state here: a failure says so and the
 * screen offers Retry.
 */
export async function uploadDdtPhoto(api: ApiClient, receiptId: string, photo: Blob, name: string): Promise<TaskOutcome<{ fileId: string }>> {
  try {
    const bytes = await photo.arrayBuffer()
    const announced = await floorWrite(api, 'POST', `/inventory/receipts/${seg(receiptId)}/ddt-photos`, {
      body: { originalName: name, contentType: photo.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
      schema: ddtUpload,
    })
    if (!announced.ok) return announced
    await putToStore(announced.value.upload, bytes)
    const completed = await floorWrite(api, 'POST', `/inventory/receipts/${seg(receiptId)}/ddt-photos/${seg(announced.value.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }) }) })
    return completed.ok ? { ok: true, value: { fileId: completed.value.file.id } } : completed
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
}

