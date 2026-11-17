import { z } from 'zod'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * F-PR-22 — the routes of "Ask the supervisor" / "Note to N" (B-PR-43a + B-PR-43b, apps/factory-api modules/production/notes; office
 * only, threads.post over each record's own scope), with the answers' shapes checked (zod; unknown fields are dropped):
 * - `POST /production/notes/check` — the draft before Send: the records the writer sees (customer, may write, supervisor as a list
 *   says it), the others counted (`unknown`), the customers, each person mentioned and the records they cannot read, the records with
 *   no supervisor / that raise no question, the records whose text names ANOTHER customer and whether Send is `held` (R-47).
 * - `POST /production/notes` — one office note in each record's own thread (one Idempotency-Key per draft): written, skipped with why,
 *   who was not mentioned where, the records not seen counted, and "Needs an answer"'s tasks.
 * The API's `why` is English: the screen says its own words from it (model skipKeyOf, notRaisedKeyOf).
 */

export const NOTE_RECORD_TYPES = ['SalesOrder', 'WorkOrder'] as const
export type NoteRecordType = (typeof NOTE_RECORD_TYPES)[number]

const recordType = z.enum(NOTE_RECORD_TYPES)
const recordView = z.object({ type: recordType, id: z.string(), label: z.string() })

const checkSchema = z.object({
  records: z.array(
    z.object({
      type: recordType,
      id: z.string(),
      label: z.string(),
      customer: z.object({ id: z.string(), name: z.string() }).nullable(),
      canWrite: z.boolean(),
      why: z.string().nullable(),
      supervisor: z.enum(SUPERVISOR_MARKS),
    }),
  ),
  unknown: z.number(),
  customers: z.number(),
  people: z.array(z.object({ userId: z.string(), name: z.string(), cannotRead: z.array(recordView) })),
  noSupervisor: z.array(recordView),
  noIssue: z.array(recordView.extend({ why: z.string() })),
  namesOtherCustomer: z.array(recordView.extend({ names: z.array(z.string()) })),
  held: z.boolean(),
})
export type NoteCheck = z.infer<typeof checkSchema>

const writeSchema = z.object({
  batchId: z.string(),
  written: z.array(recordView.extend({ messageId: z.string(), mentioned: z.array(z.string()), supervisorAsked: z.boolean(), issueId: z.string().nullable() })),
  skipped: z.array(recordView.extend({ why: z.string() })),
  notMentioned: z.array(z.object({ userId: z.string(), records: z.array(recordView) })),
  unknown: z.number(),
  issues: z
    .object({
      tasks: z.array(z.object({ taskId: z.string(), type: z.string(), id: z.string(), label: z.string(), assigned: z.boolean(), records: z.number() })),
      notRaised: z.array(z.object({ type: z.string(), id: z.string(), label: z.string(), why: z.string() })),
    })
    .nullable(),
})
export type NotesWritten = z.infer<typeof writeSchema>

/** The draft, the same for the check and the write. */
export interface NoteDraftBody {
  readonly records: readonly { readonly type: NoteRecordType; readonly id: string }[]
  readonly body: string
  readonly mentions: readonly string[]
  readonly askSupervisor: boolean
  readonly needsAnswer: boolean
  readonly namesNoOtherCustomer: boolean
}

const wire = (body: NoteDraftBody) => ({
  records: body.records.map((record) => ({ type: record.type, id: record.id })),
  body: body.body,
  mentions: [...body.mentions],
  askSupervisor: body.askSupervisor,
  needsAnswer: body.needsAnswer,
  namesNoOtherCustomer: body.namesNoOtherCustomer,
})

export function checkNotes(api: ApiClient, body: NoteDraftBody, signal?: AbortSignal): Promise<NoteCheck> {
  return api.post('/production/notes/check', { body: wire(body), schema: checkSchema, ...(signal ? { signal } : {}) })
}

export function writeNotes(api: ApiClient, body: NoteDraftBody, idempotencyKey: string): Promise<NotesWritten> {
  return api.post('/production/notes', { body: wire(body), schema: writeSchema, idempotencyKey })
}
