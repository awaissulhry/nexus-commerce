import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import {
  actedSchema,
  assigneesSchema,
  flowSchema,
  handledSchema,
  layoutSchema,
  todaySchema,
  type Assignee,
  type FlowAnswer,
  type HandledList,
  type LayoutAnswer,
  type QuoteReview,
  type TodayAnswer,
  type TodayItem,
  type TodayLayout,
} from './model'
import { PanelShapeError, panelPage, type PanelRecordRow, type PanelSource } from './panels'

/**
 * Today's calls, through the one API client (lib/api/client.ts; `useOfficeApi` adds the company). Reads: GET /home/today
 * (rows, tiles, live events), GET /home/flow (lenses), a module's list for each panel, and for a quote approval the
 * quote itself (GET /sales/quotes/:id). Writes: the quotes module's own approve and reject (POST
 * /sales/quotes/:id/approval/approve|reject), with the quote's version as read (a moved quote is a 409, never
 * overwritten) and an Idempotency-Key. Problems come back as message keys of `home`, never the API's words.
 *
 * The alert verbs (API insights/actions): POST /home/today/rows/:key/assign | resolve | acknowledge with the row's
 * condition and its actions' version as read (a row that changed meanwhile is a 409), GET …/assignees, GET
 * /home/today/handled, GET and PUT /home/today/layout.
 */

export async function fetchToday(
  api: ApiClient,
  query: { readonly kind?: string | null; readonly category?: string | null; readonly cursor?: string | null; readonly limit?: number },
  signal?: AbortSignal,
): Promise<TodayAnswer> {
  return api.get('/home/today', { query: { kind: query.kind ?? undefined, category: query.category ?? undefined, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 }, schema: todaySchema, signal })
}

export async function fetchFlow(api: ApiClient, signal?: AbortSignal): Promise<FlowAnswer> {
  return api.get('/home/flow', { schema: flowSchema, signal })
}

/** One panel's rows (five, and whether more exist). */
export async function fetchPanel(api: ApiClient, panel: PanelSource, signal?: AbortSignal): Promise<{ rows: PanelRecordRow[]; more: boolean }> {
  const body = await api.get<unknown>(panel.path, { query: { ...panel.query, limit: 6 }, signal })
  return panelPage(panel.rows(body))
}

const quoteSchema = z.object({
  quote: z.object({
    id: z.string(),
    number: z.string(),
    status: z.string(),
    version: z.number().int(),
    party: z.object({ legalName: z.string() }),
    current: z.object({
      revision: z.number().int(),
      currency: z.string(),
      validUntil: z.string().nullable(),
      // Money the person's grains reach; absent otherwise (the API dropped it).
      netAmount: z.number().optional(),
      marginPct: z.string().nullable().optional(),
    }),
    approval: z.object({
      marginFloorPct: z.string().optional(),
      rules: z.array(z.object({ reason: z.string(), broken: z.boolean(), message: z.string() })),
      requests: z.array(z.object({ status: z.string(), reasons: z.array(z.string()), requestNote: z.string().nullable(), createdAt: z.string() })),
    }),
  }),
})

/** The quote a QUOTE_APPROVAL row asks about, as its review shows it. */
export async function fetchQuoteReview(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteReview> {
  const { quote } = await api.get(`/sales/quotes/${encodeURIComponent(quoteId)}`, { schema: quoteSchema, signal })
  const pending = quote.approval.requests.find((request) => request.status === 'PENDING') ?? null
  return {
    quoteId: quote.id,
    number: quote.number,
    version: quote.version,
    customer: quote.party.legalName,
    status: quote.status,
    revision: quote.current.revision,
    currency: quote.current.currency,
    netAmount: quote.current.netAmount ?? null,
    marginPct: quote.current.marginPct ?? null,
    marginFloorPct: quote.approval.marginFloorPct ?? null,
    validUntil: quote.current.validUntil,
    rules: quote.approval.rules.filter((rule) => rule.broken).map((rule) => ({ reason: rule.reason, message: rule.message })),
    request: pending ? { reasons: pending.reasons, note: pending.requestNote, askedAt: pending.createdAt } : null,
    decidable: quote.status === 'PENDING_APPROVAL' && pending !== null,
  }
}

export function approveQuote(api: ApiClient, review: Pick<QuoteReview, 'quoteId' | 'version'>, note: string | null): Promise<unknown> {
  return api.post(`/sales/quotes/${encodeURIComponent(review.quoteId)}/approval/approve`, { body: { version: review.version, note }, idempotencyKey: newIdempotencyKey() })
}

export function rejectQuote(api: ApiClient, review: Pick<QuoteReview, 'quoteId' | 'version'>, reason: string): Promise<unknown> {
  return api.post(`/sales/quotes/${encodeURIComponent(review.quoteId)}/approval/reject`, { body: { version: review.version, reason: reason.trim() }, idempotencyKey: newIdempotencyKey() })
}

/** A failed read, as a message key. */
export function readProblem(error: unknown): string {
  if (error instanceof PanelShapeError) return 'today.problem.shape'
  if (!isApiError(error)) return 'today.problem.read'
  if (error.kind === 'forbidden') return 'today.problem.forbidden'
  if (error.kind === 'not_found') return 'today.problem.notFound'
  if (error.kind === 'unavailable') return 'today.problem.offline'
  return 'today.problem.read'
}

/** A refused decision, as a notice: a moved quote is read again (`reload`). */
export function decisionProblem(error: unknown): { key: string; tone: 'warning' | 'danger'; reload: boolean } {
  if (!isApiError(error)) return { key: 'today.decide.problem.failed', tone: 'danger', reload: false }
  if (error.kind === 'conflict') return { key: 'today.decide.problem.changed', tone: 'warning', reload: true }
  if (error.kind === 'forbidden') return { key: 'today.decide.problem.forbidden', tone: 'danger', reload: true }
  if (error.kind === 'step_up') return { key: 'today.decide.problem.stepUp', tone: 'warning', reload: false }
  if (error.kind === 'unavailable') return { key: 'today.problem.offline', tone: 'danger', reload: false }
  return { key: 'today.decide.problem.failed', tone: 'danger', reload: false }
}

// ---- the alert verbs, "Handled today", "Arrange Today" -----------------------------------------------------------------

const rowPath = (key: string, verb: string) => `/home/today/rows/${encodeURIComponent(key)}/${verb}`
type Acted = { readonly key: string; readonly resolved: boolean }
const asRead = (item: Pick<TodayItem, 'condition' | 'actions'>) => ({ condition: item.condition, version: item.actions.version })

export async function fetchAssignees(api: ApiClient, key: string, signal?: AbortSignal): Promise<Assignee[]> {
  const answer = await api.get(rowPath(key, 'assignees'), { schema: assigneesSchema, signal })
  return answer.people
}

/** Assign the row to a person who may act on it (null: take it back from its assignee). */
export function assignRow(api: ApiClient, item: Pick<TodayItem, 'key' | 'condition' | 'actions'>, assigneeId: string | null): Promise<Acted> {
  return api.post(rowPath(item.key, 'assign'), { body: { ...asRead(item), assigneeId }, schema: actedSchema, idempotencyKey: newIdempotencyKey() })
}

/** Resolve the row with a note saying what was done: it leaves Today for everyone until its condition changes. */
export function resolveRow(api: ApiClient, item: Pick<TodayItem, 'key' | 'condition' | 'actions'>, note: string): Promise<Acted> {
  return api.post(rowPath(item.key, 'resolve'), { body: { ...asRead(item), note: note.trim() }, schema: actedSchema, idempotencyKey: newIdempotencyKey() })
}

export function acknowledgeRow(api: ApiClient, item: Pick<TodayItem, 'key' | 'condition' | 'actions'>): Promise<Acted> {
  return api.post(rowPath(item.key, 'acknowledge'), { body: asRead(item), schema: actedSchema, idempotencyKey: newIdempotencyKey() })
}

export async function fetchHandled(api: ApiClient, signal?: AbortSignal): Promise<HandledList> {
  return api.get('/home/today/handled', { schema: handledSchema, signal })
}

export async function fetchLayout(api: ApiClient, signal?: AbortSignal): Promise<LayoutAnswer> {
  return api.get('/home/today/layout', { schema: layoutSchema, signal })
}

export function saveLayout(api: ApiClient, layout: TodayLayout, version: number): Promise<LayoutAnswer> {
  return api.request('PUT', '/home/today/layout', { body: { ...layout, version }, schema: layoutSchema, idempotencyKey: newIdempotencyKey() })
}

/**
 * A refused action, as a notice. The row is read again whenever it may have moved: changed (its condition or what is
 * stored), handled meanwhile (not on Today any more), or a person who may not act on it (the assign list is read again).
 */
export function actionProblem(error: unknown): { key: string; tone: 'warning' | 'danger'; reload: boolean } {
  if (!isApiError(error)) return { key: 'today.actions.problem.failed', tone: 'danger', reload: false }
  if (error.kind === 'conflict') return { key: 'today.actions.problem.changed', tone: 'warning', reload: true }
  if (error.kind === 'not_found') return { key: 'today.actions.problem.gone', tone: 'warning', reload: true }
  if (error.kind === 'invalid') return { key: 'today.actions.problem.invalid', tone: 'warning', reload: true }
  if (error.kind === 'forbidden') return { key: 'today.actions.problem.forbidden', tone: 'danger', reload: false }
  if (error.kind === 'unavailable') return { key: 'today.problem.offline', tone: 'danger', reload: false }
  return { key: 'today.actions.problem.failed', tone: 'danger', reload: false }
}
