import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * My day's calls (B-W2b-68 on the API of B-W2b-43, -44, -45, -50; design floor.myday SCR-171). `GET /people/myday` is the one
 * read of the day (own pieces, minutes, pace and, for a month piece pay covers, own money); `GET /production/labour/floor/mine`
 * the worker's records and disputes. Both answer 403 `stepUp` until the PIN is proved. Every answer stays in the screen's state
 * and nowhere else: nothing here is kept in a memory, a cache or the tablet's storage, on purpose.
 */

const pace = z.object({
  line: z.object({ code: z.string(), name: z.string() }).nullable(),
  done: z.number(),
  target: z.number().nullable(),
  targetSoFar: z.number().nullable(),
  hourTarget: z.number().nullable(),
  percent: z.number().nullable(),
  pace: z.enum(['ON_PACE', 'BEHIND', 'NO_TARGET']),
})
export type MyPace = z.infer<typeof pace>

const statementLine = z.object({ operationCode: z.string(), operationName: z.string(), pieces: z.number(), minutes: z.string(), sharePct: z.string().nullable(), rate: z.string(), amount: z.number() })
const timeLine = z.object({ code: z.string(), minutes: z.string(), rate: z.string(), amount: z.number() })
/** B-W2b-84: a standard-minute bonus scheme's bonus of the month (its figures are the worker's own). */
const bonus = z.object({ minutesPresent: z.number(), standardMinutes: z.string(), thresholdMinutes: z.string(), efficiencyPct: z.string(), bonusMinutes: z.string(), amount: z.number() })
const statement = z.object({ id: z.string(), status: z.string(), revision: z.number(), currency: z.string(), lines: z.array(statementLine), time: z.array(timeLine), bonus: bonus.nullable().default(null), earningsAmount: z.number().nullable(), makeUpAmount: z.number().nullable() })
export type MyStatement = z.infer<typeof statement>

const pay = z.object({
  month: z.string(),
  status: z.string().nullable(),
  currency: z.string(),
  todayEarnings: z.number(),
  periodPieces: z.number(),
  periodEarnings: z.number(),
  held: z.number(),
  statement: statement.nullable(),
})

export const myDaySchema = z.object({
  subject: z.enum(['WORKER', 'STATION']),
  linked: z.boolean(),
  today: z.string(),
  month: z.string(),
  asOf: z.string(),
  work: z.object({ pieces: z.number(), scrap: z.number(), rework: z.number(), reports: z.number() }),
  performance: z.object({ earnedMinutes: z.string(), timedMinutes: z.string(), offStandardMinutes: z.string(), efficiency: z.string().nullable(), traineeDay: z.boolean(), sharedReports: z.number(), pace }).nullable(),
  paysToday: z.boolean(),
  pay: pay.nullable(),
  printer: z.boolean(),
})
export type MyDay = z.infer<typeof myDaySchema>

const counts = z.object({ good: z.number(), scrap: z.number(), rework: z.number() })
const disputeRef = z.object({ id: z.string(), status: z.string() }).nullable()
const words = z.record(z.string(), z.string())

export const myDisputeSchema = z.object({
  id: z.string(),
  version: z.number(),
  recordType: z.enum(['OperationScan', 'OffStandardEntry']),
  recordId: z.string(),
  workDate: z.string(),
  reason: z.string(),
  words: z.string().nullable(),
  status: z.enum(['OPEN', 'UPHELD', 'REJECTED', 'WITHDRAWN']),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  raisedAt: z.string(),
})
export type MyDispute = z.infer<typeof myDisputeSchema>

export const mineSchema = z.object({
  subject: z.enum(['WORKER', 'STATION']),
  from: z.string(),
  to: z.string(),
  minutesShown: z.boolean(),
  records: z.array(
    z.object({
      scanId: z.string(),
      at: z.string(),
      workDate: z.string(),
      workOrder: z.object({ number: z.string() }),
      bundle: z.object({ code: z.string() }),
      operation: z.object({ seq: z.number().nullable().optional(), code: z.string().nullable().optional(), name: z.string().nullable().optional() }).nullable(),
      counts,
      state: z.string(),
      minutes: z.string().nullable(),
      enteredByLead: z.boolean(),
      disputable: z.boolean(),
      dispute: disputeRef,
    }),
  ),
  blocks: z.array(
    z.object({
      id: z.string(),
      code: z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words }),
      workDate: z.string(),
      startedAt: z.string(),
      minutes: z.number(),
      status: z.string(),
      disputable: z.boolean(),
      dispute: disputeRef,
    }),
  ),
  disputes: z.array(myDisputeSchema),
  edits: z.array(z.object({ id: z.string(), at: z.string(), changes: z.array(z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() })), reason: z.string().nullable() })),
  reasons: z.object({ OperationScan: z.array(z.string()), OffStandardEntry: z.array(z.string()) }),
})
export type Mine = z.infer<typeof mineSchema>

const answersSchema = z.object({ ids: z.array(z.string()) })
const raised = z.object({ dispute: myDisputeSchema, existing: z.boolean() })
const withdrawn = z.object({ dispute: myDisputeSchema })
const printed = z.object({ job: z.object({ id: z.string(), status: z.string() }), printer: z.object({ code: z.string(), name: z.string() }) })
export type Printed = z.infer<typeof printed>

export function readMyDay(api: ApiClient, month?: string): Promise<TaskOutcome<MyDay>> {
  return floorRead(api, '/people/myday', { query: { month }, schema: myDaySchema })
}

export function readMine(api: ApiClient, from: string, to: string): Promise<TaskOutcome<Mine>> {
  return floorRead(api, '/production/labour/floor/mine', { query: { from, to }, schema: mineSchema })
}

/** The tile's badge: no PIN, no figure. */
export function readAnswers(api: ApiClient): Promise<TaskOutcome<z.infer<typeof answersSchema>>> {
  return floorRead(api, '/people/myday/answers', { schema: answersSchema })
}

export interface DisputeBody {
  readonly clientEventId: string
  readonly recordType: 'OperationScan' | 'OffStandardEntry'
  readonly recordId: string
  readonly reason: string
  readonly message?: string
}

export function raiseDispute(api: ApiClient, body: DisputeBody, key: string) {
  return floorWrite(api, 'POST', '/production/labour/floor/disputes', { body, schema: raised, idempotencyKey: key })
}

export function withdrawDispute(api: ApiClient, disputeId: string, clientEventId: string, key: string) {
  return floorWrite(api, 'POST', `/production/labour/floor/disputes/${seg(disputeId)}/withdraw`, { body: { clientEventId }, schema: withdrawn, idempotencyKey: key })
}

export function printStatement(api: ApiClient, statementId: string, key: string) {
  return floorWrite(api, 'POST', `/people/myday/statements/${seg(statementId)}/print`, { schema: printed, idempotencyKey: key })
}

/** A person's own phone opens the statement in a new tab, through the app's `/api` (the session cookie is first-party). */
export const statementPdfHref = (statementId: string): string => `/api/people/myday/statements/${seg(statementId)}/pdf`
