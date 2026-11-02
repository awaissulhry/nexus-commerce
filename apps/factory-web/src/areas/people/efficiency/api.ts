import { z } from 'zod'
import { OPERATION_STATES, REVIEW_DECISIONS, REVIEW_REASONS, type ReviewDecision } from '@nexus/factory-domain/people/efficiency/rules'
import { OPEN_REASONS, type OpenReason } from '@nexus/factory-domain/people/privacy/figures'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { listEmployees } from '../_shared/api'

/**
 * Every call of People › Efficiency (B-W2b-64 on the API of B-W2b-44), with the answer's shape checked (zod; unknown fields
 * are dropped). Lines and operations, never a person: no call here takes a person key, and a sort parameter does not
 * exist, so nothing can rank. `words` of an answer are the API's English and are never drawn: the screen says its own
 * from the codes and counts. The one exception is `openPersonFigures`: its answer lives in the dialog's state only, never
 * in the address, a print or a file (Statuto dei Lavoratori art. 4; Owner answer H3).
 */

export type { OpenReason, ReviewDecision }
export { OPEN_REASONS, REVIEW_DECISIONS }

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const lineRef = z.object({ id: z.string(), code: z.string(), name: z.string() })
const styleRef = z.object({ id: z.string(), code: z.string(), name: z.string() })
const operationRef = z.object({ id: z.string(), code: z.string(), name: z.string(), seq: z.number() })
const rule = z.object({ tolerancePercent: z.number(), minBundles: z.number() })
const tooFew = { people: z.number().nullable(), tooFew: z.boolean() }

const lineFigures = z.object({
  earnedMinutes: z.string().nullable(),
  attendedMinutes: z.string().nullable(),
  plannedMinutes: z.string().nullable(),
  offStandardMinutes: z.string().nullable(),
  onStandardMinutes: z.string().nullable(),
  efficiency: z.string().nullable(),
  onStandardEfficiency: z.string().nullable(),
  plannedEfficiency: z.string().nullable(),
})
export type LineFigures = z.infer<typeof lineFigures>

const lineRow = z.object({ line: lineRef.nullable(), ...tooFew, figures: lineFigures })
export type LineRow = z.infer<typeof lineRow>

const overviewSchema = z.object({
  siteId: z.string(),
  from: z.string(),
  to: z.string(),
  asOf: z.string(),
  attendance: z.object({ open: z.boolean(), provisional: z.boolean() }),
  tiles: lineFigures.nullable(),
  previous: z.object({ from: z.string(), to: z.string(), tiles: lineFigures.nullable() }).nullable(),
  lines: z.array(lineRow),
  hiddenGroups: z.number(),
  traineeDaysLeftOut: z.number(),
  individual: z.object({ available: z.boolean() }),
})
export type Overview = z.infer<typeof overviewSchema>

const trendPoint = z.object({ date: z.string(), tooFew: z.boolean(), efficiency: z.string().nullable(), onStandardEfficiency: z.string().nullable(), earnedMinutes: z.string().nullable(), attendedMinutes: z.string().nullable() })
export type TrendPoint = z.infer<typeof trendPoint>
const trendSchema = z.object({ siteId: z.string(), from: z.string(), to: z.string(), lines: z.array(z.object({ line: lineRef.nullable(), targetPercent: z.string().nullable(), points: z.array(trendPoint) })) })
export type Trend = z.infer<typeof trendSchema>
export type TrendLine = Trend['lines'][number]

const operationFigures = z.object({ bundles: z.number().nullable(), pieces: z.number().nullable(), actualMinutes: z.string().nullable(), differencePercent: z.string().nullable(), state: z.enum(OPERATION_STATES).nullable() })
export type OperationFigures = z.infer<typeof operationFigures>
export type OperationState = (typeof OPERATION_STATES)[number]
const dayPoint = z.object({ date: z.string(), tooFew: z.boolean(), actualMinutes: z.string().nullable(), differencePercent: z.string().nullable() })
export type DayPoint = z.infer<typeof dayPoint>

const operationRow = z.object({ routingOperationId: z.string(), style: styleRef, revisionId: z.string(), operation: operationRef, standardMinutes: z.string(), ...tooFew, figures: operationFigures, series: z.array(dayPoint) })
export type OperationRow = z.infer<typeof operationRow>
const operationsSchema = z.object({ siteId: z.string(), from: z.string(), to: z.string(), rule, operations: z.array(operationRow), hiddenGroups: z.number(), untimedReports: z.number(), traineeBundles: z.number() })
export type Operations = z.infer<typeof operationsSchema>

const lastDecision = z.object({ id: z.string(), decision: z.enum(REVIEW_DECISIONS), at: z.string() }).nullable()
const decision = z.object({ id: z.string(), decision: z.enum(REVIEW_DECISIONS), at: z.string(), by: z.string(), reason: z.string().nullable(), proposedMinutes: z.string().nullable() })
export type Decision = z.infer<typeof decision>

const operationDetailSchema = z.object({
  siteId: z.string(),
  from: z.string(),
  to: z.string(),
  routingOperationId: z.string(),
  style: styleRef,
  revisionId: z.string(),
  operation: operationRef,
  standardMinutes: z.string(),
  people: z.number().nullable(),
  tooFew: z.boolean(),
  figures: operationFigures,
  days: z.array(dayPoint),
  review: z.object({ reason: z.enum(REVIEW_REASONS).nullable(), since: z.string().nullable(), lastDecision }),
  history: z.array(decision),
  rule,
})
export type OperationDetail = z.infer<typeof operationDetailSchema>

const reviewEntry = z.object({
  routingOperationId: z.string(),
  style: styleRef,
  revisionId: z.string(),
  operation: operationRef,
  standardMinutes: z.string(),
  ...tooFew,
  figures: operationFigures,
  direction: z.enum(['OVER', 'UNDER']).nullable(),
  reason: z.enum(REVIEW_REASONS),
  since: z.string().nullable(),
  lastDecision,
})
export type ReviewEntry = z.infer<typeof reviewEntry>
const reviewSchema = z.object({ siteId: z.string(), from: z.string(), to: z.string(), rule, count: z.number(), queue: z.array(reviewEntry), leftOut: z.number() })
export type ReviewQueue = z.infer<typeof reviewSchema>

const decidedSchema = z.object({ routingOperationId: z.string(), decision: z.enum(REVIEW_DECISIONS), style: z.object({ id: z.string(), revisionId: z.string() }) })
export type Decided = z.infer<typeof decidedSchema>

const personFiguresSchema = z.object({
  person: z.object({ employeeId: z.string(), name: z.string() }),
  siteId: z.string(),
  from: z.string(),
  to: z.string(),
  as: z.enum(['SELF', 'FIGURE_ROLE']),
  days: z.array(z.object({ date: z.string(), pieces: z.number(), earnedMinutes: z.string(), timedEarnedMinutes: z.string(), timedMinutes: z.string(), offStandardMinutes: z.string(), efficiency: z.string().nullable() })),
  leftOut: z.object({ traineeDays: z.number(), sharedReports: z.number() }),
  recorded: z.literal(true),
})
export type PersonFigures = z.infer<typeof personFiguresSchema>

export interface FiguresScope {
  siteId: string
  from?: string | null
  to?: string | null
  lineId?: string | null
}

const scopeQuery = (scope: FiguresScope): Query => clean({ siteId: scope.siteId, from: scope.from, to: scope.to, lineId: scope.lineId })

/** GET /people/efficiency (people.efficiency.view): the tiles, one row per line, what is left out. */
export const getOverview = (api: ApiClient, scope: FiguresScope & { compare?: boolean }) => api.get('/people/efficiency', { query: { ...scopeQuery(scope), ...(scope.compare ? { compare: 'previous' } : {}) }, schema: overviewSchema })

export const getTrend = (api: ApiClient, scope: FiguresScope) => api.get('/people/efficiency/trend', { query: scopeQuery(scope), schema: trendSchema })

export const getOperations = (api: ApiClient, scope: FiguresScope & { styleId?: string | null }) => api.get('/people/efficiency/operations', { query: { ...scopeQuery(scope), ...clean({ styleId: scope.styleId }) }, schema: operationsSchema })

/** The pop-over and the review's detail. No minutes per bundle: a bundle is usually one person's work. */
export const getOperation = (api: ApiClient, routingOperationId: string, scope: { siteId: string; from?: string | null; to?: string | null }) =>
  api.get(`/people/efficiency/operations/${seg(routingOperationId)}`, { query: clean({ siteId: scope.siteId, from: scope.from, to: scope.to }), schema: operationDetailSchema })

export const getReview = (api: ApiClient, siteId: string) => api.get('/people/efficiency/review', { query: { siteId }, schema: reviewSchema })

export interface DecideBody {
  siteId: string
  decision: ReviewDecision
  reason: string | null
  proposedMinutes: string | null
  /** The last decision read: a decision made since is not overruled unseen (409 refusal/REVIEW_MOVED). */
  basedOn: string | null
}

/** One decision, or an operation sent to the review (people.efficiency.review): a command with its own Idempotency-Key. */
export const decide = (api: ApiClient, routingOperationId: string, body: DecideBody, key: string = newIdempotencyKey()) =>
  api.post(`/people/efficiency/review/${seg(routingOperationId)}/decide`, { body: { ...body }, idempotencyKey: key, schema: decidedSchema })

export interface PersonChoice {
  id: string
  name: string
  code: string | null
}

/** The dialog's people: the HR register's own read (people.view) of one site, read when the dialog opens. Names only, never a figure. */
export const peopleOfSite = (api: ApiClient, siteId: string): Promise<PersonChoice[]> => listEmployees(api, { siteId, limit: 500 }).then((answer) => answer.employees.map((row) => ({ id: row.id, name: row.name, code: row.employeeCode })))

/**
 * One person's figures: opening them writes who, whose, for what and why (audit people.openPersonFigures). Called only by the
 * person's "Show figures"; a refused answer tells nothing about whether the person exists.
 */
export const openPersonFigures = (api: ApiClient, employeeId: string, body: { siteId: string; from?: string | null; to?: string | null; reason: OpenReason; note: string | null }, key: string = newIdempotencyKey()) =>
  api.post(`/people/efficiency/people/${seg(employeeId)}/figures`, { body: { ...clean({ siteId: body.siteId, from: body.from, to: body.to, reason: body.reason }), note: body.note }, idempotencyKey: key, schema: personFiguresSchema })
