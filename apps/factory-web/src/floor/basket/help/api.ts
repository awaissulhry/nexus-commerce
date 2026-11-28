import { z } from 'zod'
import type { FloorSyncKind } from '@nexus/factory-domain/floor-sync/kinds'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { onlineFirst, type KeepsActions, type OnlineFirst } from '../../queue/online-first'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../../tasks/shared/task-api'
import { CALL_ANSWER, CALL_SEND } from '../../tasks/help/model'

/**
 * owb-fl8 — the calls of a basket's problems and asks on a phone (pick C: no floor chat; settles 2–5 of _owb-fl-common.md;
 * the contract of common § 3 "fl3", answered by server B on 2026-11-28). This web's own zod for each answer: only the fields
 * the screens read are required, so a new field never breaks a page.
 *
 *   types        GET /production/calls/station/types?for=PROBLEM|ASK (floor.work): the site's ACTIVE types of the settle-5
 *                codes, with `to` for an ask and `none` (the sentence when the site has none of these codes)
 *   raise        today's POST /production/calls/station { typeId, clientEventId, bundleId, workOrderId }, online first; with the
 *                network gone the SAME action under the SAME id waits in the queue (`andon.call.send`). The station is the phone's
 *                department pick (FloorSession.stationId), else the device's: NO_STATION = "Pick your department first."
 *   answer       the leader's On my way / Solved and the worker's own Solved: the queue kind `andon.call.answer` (today's applyCall)
 *   files        POST /production/calls/:callId/files (+ …/complete): a photo or a voice note on the call's own open call, online
 *   spot         POST /production/calls/:callId/spot { spot: 0..8 }: only when the read carries `spot` (fl0 kept HelpCall.spot)
 *   department   POST /floor/session/department { departmentId, stationId? } (fl1, settle 2): the pick, and the station when the
 *                department has several (`stationId` is this web's ask to server A, named in the notes)
 *
 * Never a price, never a customer's name; the floor reads the customer's CODE only.
 */

// ---- the basket as the help parts read it (a structural subset of fl1's GET /production/baskets/:code) --------------------------

/** A call on the basket (fl1 `flags.problem` / `flags.ask`): its id, its type's code, today's call status, minutes since it was told. */
export interface CallFlag {
  readonly callId: string
  readonly typeCode: string
  /** Today's HelpCall status: SENT · SEEN · ON_THE_WAY · SOLVED · CANCELLED. */
  readonly state: string
  readonly minutes: number
  readonly escalated: boolean
  /** The place on the picture (0..8, three by three), only where the wave kept `HelpCall.spot`; absent: no place to show. */
  readonly spot?: number | null
}

/** What the four tiles, the red card and the ask card read of the basket. fl5 passes its parsed read as it is. */
export interface HelpRead {
  readonly basket: { readonly id: string; readonly code: string; readonly workOrderId: string }
  readonly picture: { readonly src: string } | null
  /** fl5's read may carry no `here` (null): treated as no department picked. */
  readonly here: { readonly departmentId: string | null } | null
  readonly flags: {
    readonly problem: CallFlag | null
    readonly ask: CallFlag | null
    readonly answer: { readonly words: string; readonly at: string } | null
  }
  readonly notes: readonly { readonly at: string; readonly words: string; readonly fileIds: readonly string[] }[]
}

// ---- the types ---------------------------------------------------------------------------------------------------------------

export const CALL_GROUPS = ['PROBLEM', 'ASK'] as const
export type CallGroup = (typeof CALL_GROUPS)[number]

const typeSchema = z.object({
  id: z.string(),
  code: z.string(),
  active: z.boolean().optional(),
  escalateAfterMinutes: z.number().nullable().optional(),
  to: z.enum(['DESIGNER', 'TEAM_LEADER']).nullable().optional(),
})
export const typesSchema = z.object({ types: z.array(typeSchema), none: z.string().nullable().optional() })
export type CallTypeRow = z.infer<typeof typeSchema>
export type CallTypes = z.infer<typeof typesSchema>

/** The site's active types of one group (server B: the station's route, floor.work; the office route is production.calls.view). */
export const readCallTypes = (api: ApiClient, group: CallGroup): Promise<TaskOutcome<CallTypes>> => floorRead(api, '/production/calls/station/types', { query: { for: group }, schema: typesSchema })

// ---- raise --------------------------------------------------------------------------------------------------------------------

const raisedSchema = z.object({
  call: z.object({ id: z.string(), status: z.string(), bundle: z.object({ id: z.string(), code: z.string() }).nullable().optional() }),
  existing: z.boolean(),
})
export type Raised = z.infer<typeof raisedSchema>

/** What a raise sends, online and queued alike (the station and the person are the phone's session). */
export function raisePayload(typeId: string, read: Pick<HelpRead, 'basket'>): Record<string, unknown> {
  return { typeId, bundleId: read.basket.id, workOrderId: read.basket.workOrderId }
}

/** One tap tells it: the office's answer at once, or the same action kept on the phone under the same id. */
export function raiseCall(api: ApiClient, queue: KeepsActions, online: boolean, payload: Readonly<Record<string, unknown>>): Promise<OnlineFirst<TaskOutcome<Raised>>> {
  return onlineFirst(queue, {
    online,
    kind: CALL_SEND,
    payload,
    attempt: (clientEventId) => floorWrite(api, 'POST', '/production/calls/station', { body: { ...payload, clientEventId }, schema: raisedSchema, idempotencyKey: clientEventId }),
  })
}

// ---- answer (the leader's On my way and Solved, the worker's Solved) --------------------------------------------------------

export type AnswerStep = 'ON_THE_WAY' | 'SOLVED'

export const answerPayload = (callId: string, step: AnswerStep): Record<string, unknown> => ({ callId, step })

/** Queued: it works with no network, the two ticks follow it (today's `andon.call.answer`). */
export const answerCall = (queue: KeepsActions, callId: string, step: AnswerStep) => queue.enqueue(CALL_ANSWER, answerPayload(callId, step))

// ---- a photo or a voice note on the call (online) ------------------------------------------------------------------------------

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string() }) })

/**
 * A file up to a route of the floornotes pattern: announced with its size and SHA-256, its bytes PUT straight to the store, then
 * completed (the server attaches it to its record at once). `durationSeconds`: a voice note's length (server B: required for audio).
 */
export async function uploadTo(api: ApiClient, base: string, file: Blob, name: string, durationSeconds?: number): Promise<TaskOutcome<{ readonly fileId: string }>> {
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const contentType = (file.type || 'image/jpeg').split(';')[0]!.trim()
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType, sizeBytes: bytes.byteLength, sha256, ...(durationSeconds !== undefined ? { durationSeconds } : {}) }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: completed })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}

/** A photo or a voice note onto the phone's own open call. */
export const uploadCallFile = (api: ApiClient, callId: string, file: Blob, name: string, durationSeconds?: number) => uploadTo(api, `/production/calls/${seg(callId)}/files`, file, name, durationSeconds)

/** The place on the picture (0..8). */
export const setCallSpot = (api: ApiClient, callId: string, spot: number) => floorWrite(api, 'POST', `/production/calls/${seg(callId)}/spot`, { body: { spot }, schema: z.unknown() })

// ---- the phone's department pick (settle 2-3) -------------------------------------------------------------------------------

const place = z.object({ id: z.string(), name: z.string() })
const pickSchema = z.object({ department: z.unknown().optional(), station: place.nullable(), choose: z.array(place) })
export type DepartmentPicked = z.infer<typeof pickSchema>

/** The pick: the department, and the station when the department has several at the site. Online only (it is the session). */
export const pickDepartment = (api: ApiClient, departmentId: string, stationId?: string) =>
  floorWrite(api, 'POST', '/floor/session/department', { body: { departmentId, ...(stationId ? { stationId } : {}) }, schema: pickSchema })

/** Kinds a later PR adds to factory-domain floor-sync (server B's fl3): typed here so next build stays green until both land. */
export const kindOf = (kind: string): FloorSyncKind => kind as FloorSyncKind
