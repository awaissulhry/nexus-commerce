import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { APPROVAL_MEANINGS, historyLineSchema } from '../../../shell/panels/approvals/api'

/**
 * The approval engine's requests (B-W2b-307 on B-W2b-282's routes; PLT-085, PLT-091, PLT-093, PLT-105): the inbox with its
 * tiles (`GET /approvals/tasks`), one request (`GET /approvals/tasks/:id`: the change, its re-check, every rule that asked,
 * who may decide it, its history), the yes (`POST …/approve`, the request's version; a signed rule asks a fresh step-up:
 * `POST /auth/office/step-up` first), the no (`POST …/reject` with a code of APPROVAL_REJECT and words). People come as
 * {id, name, me}; money facts carry their grain and are left out by the API for a reader without it. Kinds stay open
 * strings: a later step's kind is listed before this web knows its words (the API gives them in `kindLabel`).
 */

export const APPROVAL_TASK_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE'] as const
export type ApprovalTaskStatus = (typeof APPROVAL_TASK_STATUSES)[number]
export const APPROVAL_TILES = ['WAITING_FOR_ME', 'OVERDUE', 'ASKED_BY_ME', 'DECIDED_7_DAYS'] as const
export type ApprovalTile = (typeof APPROVAL_TILES)[number]

const words = z.object({ en: z.string(), it: z.string() })
export type Words = z.infer<typeof words>
const person = z.object({ id: z.string(), name: z.string(), me: z.boolean() })
const grain = z.string().nullable()
const decision = z.object({ allowed: z.boolean(), why: z.string().nullable() })

const factSchema = z.object({ field: z.string(), label: words.nullable(), value: z.unknown(), grain })
export type TaskFact = z.infer<typeof factSchema>

export const taskRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  kindLabel: words,
  status: z.enum(APPROVAL_TASK_STATUSES),
  summary: z.string(),
  // B-W2b-377: the record in words (no money) and, for a subject with no page of its own, the record whose page shows it.
  record: z.object({ type: z.string(), id: z.string(), label: z.string().nullable().optional(), parent: z.object({ type: z.string(), id: z.string() }).nullable().optional() }),
  companyId: z.string(),
  siteId: z.string().nullable(),
  requester: z.object({ kind: z.enum(['PERSON', 'WORKER']), id: z.string(), name: z.string(), me: z.boolean() }),
  approver: z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string(), me: z.boolean() }),
  rule: z.object({ id: z.string(), name: z.string(), sentence: words }).nullable(),
  signatureMeaning: z.enum(APPROVAL_MEANINGS).nullable(),
  requireStepUp: z.boolean(),
  changeSize: words,
  facts: z.array(factSchema),
  requestedAt: z.string(),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  decidedAt: z.string().nullable(),
  recheck: z.enum(['CURRENT', 'CHANGED', 'GONE']).nullable(),
  approve: decision,
  version: z.number().int(),
})
export type TaskRow = z.infer<typeof taskRowSchema>

const changeSchema = z.object({ field: z.string(), label: words.nullable(), from: z.unknown(), to: z.unknown(), grain })
export type TaskChange = z.infer<typeof changeSchema>

export const taskDetailSchema = taskRowSchema.extend({
  changes: z.array(changeSchema),
  fingerprint: z.string(),
  recheckLine: z.object({ checkedAt: z.string(), words: z.string(), changed: z.array(z.object({ field: z.string(), label: words.nullable(), was: z.unknown(), now: z.unknown(), grain })) }).nullable(),
  rules: z.array(z.object({ id: z.string(), name: z.string(), sentence: words })),
  deciders: z.array(z.object({ id: z.string(), name: z.string() })),
  decided: z
    .object({ by: person, at: z.string(), comment: z.string().nullable(), reasonCode: z.string().nullable(), reasonLabel: words.nullable(), reason: z.string().nullable(), stepUpAt: z.string().nullable() })
    .nullable(),
  withdrawn: z.object({ at: z.string(), by: person.nullable() }).nullable(),
  staleAt: z.string().nullable(),
  history: z.array(historyLineSchema),
  reject: decision,
  withdraw: decision,
})
export type TaskDetail = z.infer<typeof taskDetailSchema>

const listSchema = z.object({
  asOf: z.string(),
  tiles: z.array(z.object({ tile: z.enum(APPROVAL_TILES), count: z.number().int() })),
  notice: z.object({ changedSinceAsked: z.number().int() }),
  rows: z.array(taskRowSchema),
  nextCursor: z.string().nullable(),
})
export type TaskList = z.infer<typeof listSchema>

/** The inbox at a tile (at most 200 rows: the page says when there are more). */
export async function listTasks(api: ApiClient, tile: ApprovalTile, signal?: AbortSignal): Promise<TaskList> {
  return api.get('/approvals/tasks', { query: { tile, limit: 200 }, schema: listSchema, signal })
}

export async function getTask(api: ApiClient, id: string, signal?: AbortSignal): Promise<TaskDetail> {
  return (await api.get(`/approvals/tasks/${encodeURIComponent(id)}`, { schema: z.object({ task: taskDetailSchema }), signal })).task
}

export async function approveTask(api: ApiClient, task: Pick<TaskRow, 'id' | 'version'>, comment: string | null, idempotencyKey: string = newIdempotencyKey()): Promise<TaskDetail> {
  return (
    await api.post(`/approvals/tasks/${encodeURIComponent(task.id)}/approve`, {
      body: { version: task.version, comment: comment?.trim() || null },
      schema: z.object({ task: taskDetailSchema }),
      idempotencyKey,
    })
  ).task
}

export async function rejectTask(api: ApiClient, task: Pick<TaskRow, 'id' | 'version'>, reasonCode: string, reason: string): Promise<TaskDetail> {
  return (
    await api.post(`/approvals/tasks/${encodeURIComponent(task.id)}/reject`, {
      body: { version: task.version, reasonCode, reason: reason.trim() },
      schema: z.object({ task: taskDetailSchema }),
      idempotencyKey: newIdempotencyKey(),
    })
  ).task
}

const reasonSchema = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type RejectReason = z.infer<typeof reasonSchema>

/** The active codes of the tenant's APPROVAL_REJECT list, in order (a no needs one). */
export async function listRejectReasons(api: ApiClient, signal?: AbortSignal): Promise<RejectReason[]> {
  return (await api.get('/reasons', { query: { list: 'APPROVAL_REJECT' }, schema: z.object({ reasons: z.array(reasonSchema) }), signal })).reasons
}

/** A fresh authenticator code on this office session (5 minutes): a signed yes is recorded with it. */
export async function stepUp(api: ApiClient, code: string): Promise<void> {
  await api.post('/auth/office/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })
}
