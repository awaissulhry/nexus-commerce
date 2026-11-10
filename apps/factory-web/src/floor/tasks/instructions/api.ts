import { z } from 'zod'
import { ACK_DUE, MEDIA_KINDS } from '@nexus/factory-domain/production/instructions/rules'
import { DISPOSITIONS, NEWER_SPEC_STATES } from '@nexus/factory-domain/product/versions/drift'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex, storeHeaders, storeUrl } from '../../../record-panels/store'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * The floor's calls of Spec & instructions (SCR-174, B-W2b-232) on the merged APIs of B-W2b-214 (work instructions), B-W2b-220
 * (spec versions) and B-W2b-226 (change requests), each answer checked against its shape:
 *
 *   GET  /production/instructions/floor/operation?code&workOrderOperationId&language   the instruction in force for the bundle in hand
 *   GET  /production/instructions/floor/spec?code                                       the frozen spec for the bundle's size
 *   GET  /production/work-orders/:id/spec/newer                                         the Spec changed banner (no cost)
 *   GET  /production/instructions/floor/mine                                            the person's own: due and seen
 *   GET  /production/instructions/floor/media/:id/download                              a photo or video (a presigned GET, 60 s)
 *   POST /production/instructions/floor/seen                                            Seen (online first; else the queue)
 *   POST /product/floor/change-requests (+ …/:id/photos, …/complete)                     Report a spec problem (+ its photo)
 *
 * The floor never sees money: none of these answers carries a price or a cost.
 */

const dueSchema = z.enum(ACK_DUE)

const stepSchema = z.object({
  code: z.string(),
  words: z.string(),
  shownIn: z.string().nullable(),
  critical: z.boolean(),
  safety: z.string().nullable(),
  icon: z.string().nullable(),
  requiredTick: z.boolean(),
  media: z.array(z.object({ id: z.string(), kind: z.enum(MEDIA_KINDS), caption: z.string().nullable() })),
})

const settingSchema = z.object({
  seq: z.number(),
  machineClass: z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
  stitchType: z.string().nullable(),
  needle: z.string().nullable(),
  thread: z.string().nullable(),
  stitchesPerCm: z.string().nullable(),
  tension: z.string().nullable(),
  foot: z.string().nullable(),
  notes: z.string().nullable(),
})

export const instructionSchema = z.object({
  bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number() }),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }),
  language: z.string(),
  instruction: z
    .object({
      id: z.string(),
      number: z.string(),
      forRevision: z.boolean(),
      version: z.object({ id: z.string(), number: z.number(), publishedAt: z.string().nullable(), changeNote: z.string().nullable(), acknowledgementRequired: z.boolean() }),
      steps: z.array(stepSchema),
    })
    .nullable(),
  settings: z.array(settingSchema),
  acknowledgement: z.object({ due: dueSchema.nullable(), seenAt: z.string().nullable() }).nullable(),
})
export type FloorInstruction = z.infer<typeof instructionSchema>
export type InstructionStep = z.infer<typeof stepSchema>
export type MachineSetting = z.infer<typeof settingSchema>

export const specSchema = z.object({
  bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number(), part: z.string().nullable() }),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), releasedAt: z.string().nullable() }),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable() }).nullable(),
  revision: z.object({ id: z.string(), revision: z.number(), status: z.string(), releasedAt: z.string().nullable() }).nullable(),
  colourway: z.object({ code: z.string(), name: z.string() }).nullable(),
  size: z.object({ code: z.string(), label: z.string().nullable(), measures: z.array(z.object({ point: z.string(), min: z.string().nullable(), max: z.string().nullable(), unit: z.string().nullable() })) }),
  materials: z.array(
    z.object({
      seq: z.number(),
      placement: z.string().nullable(),
      item: z.object({ code: z.string(), name: z.string(), nameI18n: z.record(z.string(), z.string()) }),
      colour: z.object({ code: z.string(), name: z.string() }).nullable(),
      perGarment: z.string(),
      uom: z.string(),
    }),
  ),
  label: z.object({ code: z.string(), name: z.string(), revision: z.number(), languages: z.array(z.string()) }).nullable(),
  operations: z.array(z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string(), current: z.boolean() })),
})
export type FloorSpec = z.infer<typeof specSchema>

export const newerSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string() }),
  revision: z.object({ revision: z.number(), status: z.string() }).nullable(),
  newer: z.object({
    state: z.enum(NEWER_SPEC_STATES),
    banner: z.boolean(),
    newPages: z.boolean(),
    message: z.string(),
    newer: z.object({ id: z.string(), revision: z.number(), releasedOn: z.string().nullable() }).nullable(),
    decision: z.object({ disposition: z.enum(DISPOSITIONS), changeOrder: z.string() }).nullable(),
  }),
})
export type NewerSpec = z.infer<typeof newerSchema>

export const mineSchema = z.object({
  due: z.array(
    z.object({
      instructionId: z.string(),
      number: z.string(),
      forRevision: z.boolean(),
      operation: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      versionId: z.string(),
      versionNumber: z.number(),
      publishedAt: z.string().nullable(),
      reason: dueSchema,
    }),
  ),
  seen: z.array(z.object({ instructionId: z.string(), number: z.string(), versionId: z.string(), versionNumber: z.number(), at: z.string(), locale: z.string() })),
})
export type MineAnswer = z.infer<typeof mineSchema>
export type DueInstruction = MineAnswer['due'][number]

const seenAnswer = z.object({ acknowledgement: z.object({ id: z.string(), versionId: z.string(), versionNumber: z.number(), at: z.string() }) })
export type SeenAnswer = z.infer<typeof seenAnswer>

/** The instruction in force for the bundle in hand at this operation, in the person's language. */
export function fetchInstruction(api: ApiClient, code: string, workOrderOperationId: string | null): Promise<TaskOutcome<FloorInstruction>> {
  return floorRead(api, '/production/instructions/floor/operation', { query: { code, workOrderOperationId: workOrderOperationId ?? undefined }, schema: instructionSchema })
}

/** The frozen spec of the bundle's work order for its size (PRD-258). */
export function fetchSpec(api: ApiClient, code: string): Promise<TaskOutcome<FloorSpec>> {
  return floorRead(api, '/production/instructions/floor/spec', { query: { code }, schema: specSchema })
}

/** Whether a newer spec exists for the work order (PRD-195): the tablet's banner, no cost, no compare. */
export async function fetchNewerSpec(api: ApiClient, workOrderId: string): Promise<TaskOutcome<NewerSpec>> {
  const answer = await floorRead(api, `/production/work-orders/${seg(workOrderId)}/spec/newer`, { schema: z.object({ spec: newerSchema }) })
  return answer.ok ? { ok: true, value: answer.value.spec } : answer
}

/** The person's own: the published versions waiting for their Seen, and what they saw. */
export function fetchMine(api: ApiClient): Promise<TaskOutcome<MineAnswer>> {
  return floorRead(api, '/production/instructions/floor/mine', { schema: mineSchema })
}

/** Seen, tried online under the action's client id (the queue's retry keeps the same id: onlineFirst). */
export function sendSeen(api: ApiClient, body: { readonly versionId: string; readonly locale?: string }, clientEventId: string): Promise<TaskOutcome<SeenAnswer>> {
  return floorWrite(api, 'POST', '/production/instructions/floor/seen', { body: { clientEventId, ...body }, schema: seenAnswer, idempotencyKey: clientEventId })
}

/**
 * A photo or video of a step: the floor's own download route (a floor role holds no files right), the bytes read with the
 * presigned GET at once (it lives 60 s), kept as a blob of the medium's type.
 */
export async function readMedium(api: ApiClient, mediaId: string): Promise<TaskOutcome<Blob>> {
  const answer = await floorRead(api, `/production/instructions/floor/media/${seg(mediaId)}/download`, { schema: z.object({ download: presignedSchema }) })
  if (!answer.ok) return answer
  try {
    // The store says the type (a video needs it to play from a blob); the bytes as they came.
    const presigned = answer.value.download
    const url = storeUrl(presigned.url)
    const response = await fetch(url, { method: 'GET', headers: storeHeaders(presigned), credentials: url.startsWith('/') ? 'same-origin' : 'omit', cache: 'no-store' })
    if (!response.ok) return { ok: false, problem: { kind: 'unavailable' } }
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
    const bytes = await response.arrayBuffer()
    return { ok: true, value: new Blob([bytes], type ? { type } : {}) }
  } catch {
    return { ok: false, problem: { kind: 'offline' } }
  }
}

const requestAnswer = z.object({ changeRequest: z.object({ id: z.string() }), replayed: z.boolean() })

/** Report a spec problem (PRD-259), tried online under the action's client id; offline the queue sends the same. */
export function sendSpecProblem(api: ApiClient, body: Readonly<Record<string, unknown>>, clientEventId: string): Promise<TaskOutcome<{ readonly requestId: string }>> {
  return floorWrite(api, 'POST', '/product/floor/change-requests', { body: { clientEventId, ...body }, schema: requestAnswer, idempotencyKey: clientEventId }).then((answer) => (answer.ok ? { ok: true, value: { requestId: answer.value.changeRequest.id } } : answer))
}

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string() }) })

/**
 * The spec problem's photo, once the request has its id (the online answer or the queue's receipt): announced with its size
 * and SHA-256, the bytes PUT straight to the store, then confirmed. Each step's failure stops it.
 */
export async function uploadProblemPhoto(api: ApiClient, requestId: string, photo: Blob, name: string): Promise<TaskOutcome<{ readonly fileId: string }>> {
  const base = `/product/floor/change-requests/${seg(requestId)}/photos`
  const bytes = await photo.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const contentType = (photo.type || 'image/jpeg').split(';')[0]!.trim()
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType, sizeBytes: bytes.byteLength, sha256 }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: completed })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}
