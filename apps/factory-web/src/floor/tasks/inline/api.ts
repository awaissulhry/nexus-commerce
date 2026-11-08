import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'
import { IN_PROCESS_KINDS, IN_PROCESS_OUTCOMES, type InlineKind } from './model'

/**
 * SCR-176's calls (B-W2b-105 on the merged API of B-W2b-99, apps/factory-api modules/quality/inprocess; floor + quality.inprocess.view
 * to read, .record to write). Per line and operation: no list row names a person, one record names its inspector only behind the
 * site's PERFORMANCE gate (the screen never shows it). A rule's refusal is a 409 `refusal/<CODE>` with its `fix` (task-api.ts).
 *
 *   checks       the site's open first pieces (Which check? lists them), one check, open, the whole results list, decide, cancel
 *   line         the line's DHU of today and the roving board (the tablet's line)
 *   defects      the defect vocabulary of a stage in the worker's language (B-W2b-90; any floor session)
 *   one step     a roving result or an end-of-line pass or defect, online first: a network failure keeps it on the tablet
 *                (floor-sync `quality.inprocess.record`) under the try's id, so the try and the retry are ONE command (B-W2b-77)
 *   send back    the existing rework loop (B-W2a-13, POST /production/rework, production.rework): online only
 */

const kind = z.enum(IN_PROCESS_KINDS)
const outcome = z.enum(IN_PROCESS_OUTCOMES)
const words = z.object({ it: z.string(), en: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

const rowShape = {
  id: z.string(),
  kind,
  status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']),
  outcome: outcome.nullable(),
  line: ref.nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number() }).nullable(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  pieces: z.number(),
  defectivePieces: z.number(),
  defects: z.number(),
  dhu: z.string().nullable(),
  defect: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), critical: z.boolean() }).nullable(),
  hasPlan: z.boolean(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number(),
}
export const checkRowSchema = z.object(rowShape)
export type CheckRow = z.infer<typeof checkRowSchema>

export const planCheckSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  type: z.string(),
  checkClass: z.string().nullable(),
  mandatory: z.boolean(),
  photoRequired: z.boolean(),
  nominal: z.string().nullable(),
  tolerance: z.string().nullable(),
  uom: z.string().nullable(),
  choices: z.array(z.string()),
})
export type PlanCheck = z.infer<typeof planCheckSchema>

export const resultSchema = z.object({ id: z.string(), code: z.string(), sampleIndex: z.number(), outcome: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']), value: z.string().nullable(), note: z.string().nullable(), recordedAt: z.string() })
export type CheckResult = z.infer<typeof resultSchema>

/** One record as the floor reads it: the inspector and operator fields are left out (never on this screen). */
export const checkSchema = z.object({
  ...rowShape,
  plan: z.object({ versionId: z.string(), planId: z.string(), code: z.string(), name: z.string(), number: z.number() }).nullable(),
  checks: z.array(planCheckSchema),
  results: z.array(resultSchema),
  blockers: z.array(z.string()),
  suggested: z.enum(['GREEN', 'AMBER', 'RED']).nullable(),
  holdsRun: z.boolean().nullable(),
  sendBack: z.object({ workOrderOperationId: z.string(), bundleId: z.string(), pieces: z.number() }).nullable(),
  signatureSha256: z.string().nullable(),
})
export type CheckRecord = z.infer<typeof checkSchema>

const listAnswer = z.object({ checks: z.array(checkRowSchema), counts: z.object({ open: z.number(), decided: z.number(), firstPiecesOpen: z.number() }), capped: z.boolean() })
export type CheckList = z.infer<typeof listAnswer>

/** The site's checks (a floor device: its own site), newest first: Which check? asks the open first pieces. */
export const fetchChecks = (api: ApiClient, query: { readonly kind?: InlineKind; readonly status?: 'OPEN' | 'DECIDED'; readonly workOrderId?: string }): Promise<TaskOutcome<CheckList>> =>
  floorRead(api, '/quality/inprocess/checks', { query, schema: listAnswer })

const one = z.object({ check: checkSchema })

export async function fetchCheck(api: ApiClient, checkId: string): Promise<TaskOutcome<CheckRecord>> {
  const answer = await floorRead(api, `/quality/inprocess/checks/${seg(checkId)}`, { schema: one })
  return answer.ok ? { ok: true, value: answer.value.check } : answer
}

export interface Decision {
  readonly outcome: (typeof IN_PROCESS_OUTCOMES)[number]
  readonly pieces: number
  readonly defectivePieces?: number
  readonly defects?: number
  readonly defectCodeId?: string | null
}

export interface OpenBody {
  readonly kind: InlineKind
  readonly workOrderId?: string
  readonly bundleCode?: string
  readonly workOrderOperationId?: string
  readonly lineId?: string
  readonly decision?: Decision
}

/** Open a check (a first piece: the run waits from now on; with a `decision`: recorded in one step). */
export async function openCheck(api: ApiClient, body: OpenBody, key: string): Promise<TaskOutcome<CheckRecord>> {
  const answer = await floorWrite(api, 'POST', '/quality/inprocess/checks', { body, schema: one, idempotencyKey: key })
  return answer.ok ? { ok: true, value: answer.value.check } : answer
}

export interface ResultLine {
  readonly code: string
  readonly sampleIndex?: number
  readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'
  readonly value?: string | null
}

/** The WHOLE results list of an open check (each answer saves them all, with the check's version). */
export async function saveResults(api: ApiClient, checkId: string, body: { readonly version: number; readonly results: readonly ResultLine[] }, key: string): Promise<TaskOutcome<CheckRecord>> {
  const answer = await floorWrite(api, 'PUT', `/quality/inprocess/checks/${seg(checkId)}/results`, { body, schema: one, idempotencyKey: key })
  return answer.ok ? { ok: true, value: answer.value.check } : answer
}

/** Decide a check. A first piece is signed: 403 `stepUp` until the PIN is proved, then the SAME call with the same key. */
export async function decideCheck(api: ApiClient, checkId: string, body: Decision & { readonly version: number }, key: string): Promise<TaskOutcome<CheckRecord>> {
  const answer = await floorWrite(api, 'POST', `/quality/inprocess/checks/${seg(checkId)}/decide`, { body, schema: one, idempotencyKey: key })
  return answer.ok ? { ok: true, value: answer.value.check } : answer
}

export async function cancelCheck(api: ApiClient, checkId: string, body: { readonly version: number; readonly reason: string }, key: string): Promise<TaskOutcome<CheckRecord>> {
  const answer = await floorWrite(api, 'POST', `/quality/inprocess/checks/${seg(checkId)}/cancel`, { body, schema: one, idempotencyKey: key })
  return answer.ok ? { ok: true, value: answer.value.check } : answer
}

// ---- the line ------------------------------------------------------------------------------------------------------------------

const dhuAnswer = z.object({
  line: ref,
  day: z.string(),
  dhu: z.string().nullable(),
  defects: z.number(),
  pieces: z.number(),
  checks: z.number(),
  byOperation: z.array(z.object({ code: z.string(), name: z.string(), defects: z.number() })),
  asOf: z.string(),
})
export type LineDhu = z.infer<typeof dhuAnswer>

/** The tablet's line: its DHU of today from the end-of-line checks (400: the tablet shows no line). */
export const fetchDhu = (api: ApiClient): Promise<TaskOutcome<LineDhu>> => floorRead(api, '/quality/inprocess/dhu', { schema: dhuAnswer })

const tileSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string() }),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }),
  latest: z.object({ checkId: z.string(), outcome: z.enum(['GREEN', 'AMBER', 'RED']), outcomeWords: words, pieces: z.number(), defectivePieces: z.number(), at: z.string() }).nullable(),
  checksToday: z.number(),
})
export type RovingTile = z.infer<typeof tileSchema>
const rovingAnswer = z.object({ line: ref, day: z.string(), tiles: z.array(tileSchema), lineChecksToday: z.number(), asOf: z.string() })
export type RovingBoard = z.infer<typeof rovingAnswer>

/** The tablet's line's operations as tiles, with today's latest light. */
export const fetchRoving = (api: ApiClient): Promise<TaskOutcome<RovingBoard>> => floorRead(api, '/quality/inprocess/roving', { schema: rovingAnswer })

// ---- the defects of a stage, in the worker's language (B-W2b-90) ---------------------------------------------------------------

const defectSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  severity: z.string(),
  needsDetail: z.boolean(),
})
export type StageDefect = z.infer<typeof defectSchema>

export async function fetchDefects(api: ApiClient, stage: 'IN_LINE' | 'CUTTING', language: string): Promise<TaskOutcome<readonly StageDefect[]>> {
  const answer = await floorRead(api, '/quality/vocabulary', { query: { stage, language }, schema: z.object({ defects: z.array(defectSchema) }) })
  return answer.ok ? { ok: true, value: answer.value.defects } : answer
}

// ---- one step, online first ----------------------------------------------------------------------------------------------------

/** The office's key for the queued retry (`<device>.<client event id>`, platform/floor-sync): the try sends the same (B-W2b-77). */
export const recordKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

/** A roving result or an end-of-line pass or defect: online first, kept on the tablet when the network fails. */
export const recordOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, body: OpenBody) =>
  onlineFirst(queue, { online, kind: 'quality.inprocess.record', payload: { ...body }, attempt: (clientEventId) => openCheck(api, body, recordKey(deviceId, clientEventId)) })

// ---- send back: the rework loop (online only) -----------------------------------------------------------------------------------

const reworkAnswer = z.object({ rework: z.object({ id: z.string() }) })

export interface SendBackBody {
  readonly workOrderId: string
  readonly bundleId: string
  readonly reworkAtOperationId: string
  readonly quantity: number
  readonly reasonCode: string
  readonly description: string
  readonly recordType: 'InProcessCheck'
  readonly recordId: string
  /** The garments go back on the bundle's own ticket: no new ticket is printed at the end of the line. */
  readonly split: false
}

export async function sendBack(api: ApiClient, body: SendBackBody, key: string): Promise<TaskOutcome<{ readonly reworkId: string }>> {
  const answer = await floorWrite(api, 'POST', '/production/rework', { body, schema: reworkAnswer, idempotencyKey: key })
  return answer.ok ? { ok: true, value: { reworkId: answer.value.rework.id } } : answer
}
