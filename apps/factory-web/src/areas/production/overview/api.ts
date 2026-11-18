import { z } from 'zod'
import { HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { ISSUE_RECORD_TYPES, ISSUE_SOURCES, ISSUE_STATUSES } from '@nexus/factory-domain/production-brand/issues'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { BRAND_URGENCIES } from '@nexus/factory-domain/production-brand/urgency'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
import { TASK_STATUSES } from '@nexus/factory-domain/tasks/rules'
import type { ApiClient } from '../../../lib/api/client'
import { BLOCKED_BY, WORK_ORDER_RISKS, WORK_ORDER_STATUSES } from '../_shared/api'

/**
 * F-PR-04 — the reads of Production › Overview, with the answers' shapes checked (zod; unknown fields are dropped, so a new API field
 * never breaks the page). The shapes mirror apps/factory-api modules/production/overview/contract.ts (B-PR-33) and
 * modules/production/issues/contract.ts (B-PR-45). Both are walled by customer in the API: a person limited to some customers gets
 * only their rows, their Total (`overall`) and their issues; the screen never adds customers up itself. Counts only: pieces and work
 * orders, never money, never a person (lists say Me / Someone else / Not set). The API's English words are not read.
 */

const count = z.number().int().min(0)
const customer = z.object({ id: z.string(), code: z.string(), name: z.string() })

/** The WIP stages of the overview (B-PR-33 tally WIP_STAGES), in the office's order. */
export const WIP_STAGES = ['NOT_RELEASED', 'RELEASED', 'CUTTING', 'SEWING', 'AT_WORKSHOP', 'QUALITY', 'FINISHED', 'ON_HOLD'] as const
export type WipStage = (typeof WIP_STAGES)[number]

const pieces = count.nullable()
const stagePieces = z.object({
  NOT_RELEASED: pieces,
  RELEASED: pieces,
  CUTTING: pieces,
  SEWING: pieces,
  AT_WORKSHOP: pieces,
  QUALITY: pieces,
  FINISHED: pieces,
  ON_HOLD: pieces,
})

/** The row kinds: one customer, the work orders made before the one-customer rule, the work of no customer, the Total. */
export const ROW_KINDS = ['CUSTOMER', 'MIXED', 'NO_CUSTOMER', 'ALL'] as const
export type RowKind = (typeof ROW_KINDS)[number]

const rowSchema = z.object({
  kind: z.enum(ROW_KINDS),
  customer: customer.nullable(),
  inProduction: z.object({ workOrders: count, pieces: count }),
  late: count,
  atRisk: count,
  blocked: count,
  waitingOn: z.object({ US: count, BRAND: count, SUPPLIER: count, WORKSHOP: count }),
  blockedBy: z.object({ HOLD: count, CUSTOMER: count, MATERIAL: count, GATE: count, NEEDS_SPLIT: count }),
  customerUrgent: count,
  requests: z.object({ waiting: count, toAnswer: count }),
  wip: z.object({ stages: stagePieces, sewingNotCounted: count }),
})
export type OverviewRow = z.infer<typeof rowSchema>

const urgentSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  kind: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  style: z.object({ code: z.string(), name: z.string() }),
  partyId: z.string().nullable(),
  customer: customer.nullable(),
  mixedCustomers: z.boolean(),
  dueDate: z.string().nullable(),
  daysLate: z.number().int().nullable(),
  pieces: count,
  risk: z.object({
    state: z.enum(WORK_ORDER_RISKS),
    daysLate: z.number().nullable(),
    plannedEnd: z.string().nullable(),
    planAfterDue: z.boolean(),
    raised: z.enum(HEALTH_REASON_CODES).nullable(),
    blockedBy: z.enum(BLOCKED_BY).nullable(),
  }),
  waitingOn: z.object({ on: z.enum(WAITING_ON), since: z.string().nullable() }).nullable(),
  supervisor: z.enum(SUPERVISOR_MARKS).nullable(),
  customerUrgency: z.enum(BRAND_URGENCIES).nullable(),
  urgentRank: z.number().int().nullable(),
  gate: z.boolean(),
})
export type UrgentRow = z.infer<typeof urgentSchema>

const overviewSchema = z.object({
  asOf: z.string(),
  today: z.string(),
  filter: z.object({ siteId: z.string().nullable(), partyId: z.string().nullable(), supervisor: z.enum(['me']).nullable() }),
  everyCustomer: z.boolean(),
  tiles: z.object({
    waitingOnUs: count,
    waitingOnCustomer: count,
    waitingOnSupplier: count,
    waitingOnWorkshop: count,
    late: count,
    atRisk: count,
    blocked: count,
    customerRequests: count,
  }),
  customers: z.array(rowSchema),
  mixed: rowSchema.nullable(),
  noCustomer: rowSchema.nullable(),
  overall: rowSchema,
  requests: z.object({ waiting: count, toAnswer: count, byKind: z.array(z.object({ kind: z.string(), open: count, countered: count })) }),
  mostUrgent: z.object({ items: z.array(urgentSchema), count, nextCursor: z.string().nullable() }),
  live: z.object({ events: z.array(z.string()) }),
})
export type Overview = z.infer<typeof overviewSchema>

export interface OverviewQuery {
  /** One customer the reader reaches (the Production pages' one filter, `?party=`). */
  readonly partyId?: string | undefined
  /** "Only mine": the orders I supervise. */
  readonly supervisor?: 'me' | undefined
  /** Most urgent: rows on the page ("10 of N"). */
  readonly limit?: number
}

/** GET /production/overview (workorders.view; the API walls every figure by customer). */
export function getOverview(api: ApiClient, query: OverviewQuery, signal?: AbortSignal): Promise<Overview> {
  return api.get('/production/overview', { query: { partyId: query.partyId, supervisor: query.supervisor, limit: query.limit ?? 10 }, schema: overviewSchema, signal })
}

// ---- the open issues (B-PR-45: GET /production/issues, not in the overview read) ---------------------------------------------

const issueSchema = z.object({
  id: z.string(),
  source: z.enum(ISSUE_SOURCES),
  status: z.enum(ISSUE_STATUSES),
  /** "No reply sent yet": a customer's issue whose task was ticked while no reply went out. */
  note: z.enum(['NO_REPLY_YET']).nullable(),
  record: z.object({ type: z.enum(ISSUE_RECORD_TYPES), id: z.string(), label: z.string() }),
  salesOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  customer: z.object({ id: z.string(), name: z.string() }),
  raisedAt: z.string(),
  dueOn: z.string(),
  escalation: z.object({ step: z.number().int(), at: z.string() }).nullable(),
  task: z.object({ id: z.string(), status: z.enum(TASK_STATUSES), assignee: z.enum(SUPERVISOR_MARKS) }).nullable(),
  mine: z.boolean(),
})
export type IssueRow = z.infer<typeof issueSchema>

const issuesSchema = z.object({
  asOf: z.string(),
  counts: z.object({ open: count, noReplyYet: count, escalated: count, mine: count }),
  issues: z.array(issueSchema),
  more: z.boolean(),
  live: z.object({ events: z.array(z.string()) }),
})
export type Issues = z.infer<typeof issuesSchema>

/** GET /production/issues — the open issues, oldest first (the reader's customers only; `mine`: the ones whose open task is mine). */
export function getOpenIssues(api: ApiClient, query: { readonly partyId?: string | undefined; readonly mine: boolean; readonly limit: number }, signal?: AbortSignal): Promise<Issues> {
  return api.get('/production/issues', { query: { partyId: query.partyId, status: 'OPEN', mine: query.mine ? 'true' : undefined, limit: query.limit }, schema: issuesSchema, signal })
}
