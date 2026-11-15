import { Job } from 'bullmq'
import type { Prisma } from '@nexus/factory-db'
import { INTEGRATIONS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { dismissHeldOf, fixPlaceOf, retryHeldOf, type ErrorSource, type RetryHeld } from '@nexus/factory-domain/integration-health/errors'
import { INTEGRATIONS_ERRORS_MANAGE } from '@nexus/factory-domain/integration-health/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type OfficeContext, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { openQueues, type QueueKit } from '../../../core/queue'
import { requeueDeadEvent } from '../../outbox/requeue'
import { processHealthRedis, type HealthRedis } from '../jobs/redis'
import type { ErrorDetail, ErrorItemView } from './contract'

/**
 * The error queue (B-W2b-415; PLT-201; design admin.connections sec:errors, pop:error-item): failed messages in and out,
 * collected by `collect.ts`, with what to do. Read with integrations.view (an item of a company: over that company; one
 * without a company: anyone holding it, as tenant-wide connections); Retry and Dismiss with integrations.errors.manage
 * over the item's company, or over every active company for an item without one.
 *
 * Retry sends the message again ONCE, in ONE command (the item RETRIED with when and by whom, audited, event
 * integration.error_retried): a dead event back to PENDING (its relay publishes it again); a failed webhook back to
 * RECEIVED with integration.inbound_received (its processor runs again, replay-safe); a background job out of tries run
 * again in its queue (BullMQ retry, inside the transaction so a refusal rolls the item back). A rejected signature and a
 * failed call are held with why (the call is sent again from where it started: "Edit and retry" opens it). Dismiss keeps
 * the item with who, when and why (3-500 characters). The collector brings an item back OPEN when its retry fails too.
 */

type Client = Prisma.TransactionClient

const SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

/** The office session (these routes are office only). */
function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ApiError('forbidden')
  return context
}
const actor = (caller: CommandCaller) => actorOf(contextOf(caller))

const ITEM = {
  id: true,
  companyId: true,
  source: true,
  sourceId: true,
  provider: true,
  operation: true,
  recordType: true,
  recordId: true,
  reasonCode: true,
  reasonText: true,
  tries: true,
  firstFailedAt: true,
  lastFailedAt: true,
  state: true,
  retriedAt: true,
  retriedById: true,
  dismissedAt: true,
  dismissedById: true,
  dismissReason: true,
  version: true,
} as const satisfies Prisma.IntegrationErrorItemSelect

type ItemRow = Prisma.IntegrationErrorItemGetPayload<{ select: typeof ITEM }>

/** The item as the list shows it: never who (a name stays inside the one item). */
function viewOf(row: ItemRow, mayManage: boolean): ErrorItemView {
  const facts = { source: row.source, state: row.state, reasonCode: row.reasonCode }
  return {
    id: row.id,
    companyId: row.companyId,
    source: row.source,
    provider: row.provider,
    operation: row.operation,
    record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    tries: row.tries,
    firstFailedAt: toUtcIso(row.firstFailedAt),
    lastFailedAt: toUtcIso(row.lastFailedAt),
    state: row.state,
    retriedAt: row.retriedAt ? toUtcIso(row.retriedAt) : null,
    retriedBySystem: row.retriedById === null ? null : row.retriedById === SYSTEM_ACTOR_ID,
    dismissedAt: row.dismissedAt ? toUtcIso(row.dismissedAt) : null,
    dismissReason: row.dismissReason,
    fixPlace: fixPlaceOf(row.source, row.operation),
    retry: { held: retryHeldOf(facts) ?? (mayManage ? null : 'NO_RIGHT') },
    dismiss: { held: dismissHeldOf(row) ?? (mayManage ? null : 'NO_RIGHT') },
    version: row.version,
  }
}

/** integrations.errors.manage over the item's company; an item without one: over every active company. */
async function mayManage(caller: CommandCaller, client: Client, companyId: string | null): Promise<boolean> {
  const who = actor(caller)
  if (companyId) return can(who, INTEGRATIONS_ERRORS_MANAGE, { companyId })
  if (!can(who, INTEGRATIONS_ERRORS_MANAGE, {})) return false
  const companies = await client.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  return companies.every((company) => can(who, INTEGRATIONS_ERRORS_MANAGE, { companyId: company.id }))
}

export const ERROR_VIEWS = ['open', 'retried', 'dismissed', 'all'] as const
export type ErrorView = (typeof ERROR_VIEWS)[number]

const STATES_OF: Readonly<Record<ErrorView, ReadonlyArray<'OPEN' | 'RETRIED' | 'DISMISSED'>>> = {
  open: ['OPEN'],
  retried: ['RETRIED'],
  dismissed: ['DISMISSED'],
  all: ['OPEN', 'RETRIED', 'DISMISSED'],
}

export interface ListQuery {
  readonly view: ErrorView
  readonly source?: ErrorSource | undefined
  readonly before?: string | undefined
  readonly limit: number
}

/** GET /integrations/errors: the items the caller may see, the newest failure first, with the counts per state. */
export async function listErrors(caller: CommandCaller, query: ListQuery): Promise<{ items: ErrorItemView[]; counts: { open: number; retried: number; dismissed: number }; nextBefore: string | null; canManage: boolean }> {
  const scope = scopeWhere(actor(caller), INTEGRATIONS_VIEW, SCOPE) as Prisma.IntegrationErrorItemWhereInput
  return caller.withClient(async (client) => {
    let page: Prisma.IntegrationErrorItemWhereInput = {}
    if (query.before) {
      const anchor = isUuid(query.before) ? await client.integrationErrorItem.findFirst({ where: { AND: [scope, { id: query.before }] }, select: { id: true, lastFailedAt: true } }) : null
      if (!anchor) throw new ValidationError('No such item to page from.', [{ path: 'querystring/before', message: 'Not an item of the queue.' }])
      page = { OR: [{ lastFailedAt: { lt: anchor.lastFailedAt } }, { lastFailedAt: anchor.lastFailedAt, id: { lt: anchor.id } }] }
    }
    const where: Prisma.IntegrationErrorItemWhereInput = { AND: [scope, { state: { in: [...STATES_OF[query.view]] } }, query.source ? { source: query.source } : {}, page] }
    const [rows, grouped] = await Promise.all([
      client.integrationErrorItem.findMany({ where, select: ITEM, orderBy: [{ lastFailedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 }),
      client.integrationErrorItem.groupBy({ by: ['state'], where: { AND: [scope, query.source ? { source: query.source } : {}] }, _count: { _all: true } }),
    ])
    const counts = { open: 0, retried: 0, dismissed: 0 }
    for (const row of grouped) counts[row.state.toLowerCase() as keyof typeof counts] = row._count._all
    const more = rows.length > query.limit
    const shown = more ? rows.slice(0, query.limit) : rows
    const manage = new Map<string, boolean>()
    const views: ErrorItemView[] = []
    for (const row of shown) {
      const key = row.companyId ?? ''
      if (!manage.has(key)) manage.set(key, await mayManage(caller, client, row.companyId))
      views.push(viewOf(row, manage.get(key)!))
    }
    return { items: views, counts, nextBefore: more ? shown[shown.length - 1]!.id : null, canManage: [...manage.values()].some(Boolean) || (await mayManage(caller, client, null)) }
  })
}

async function readItem(caller: CommandCaller, client: Client, itemId: string): Promise<ItemRow> {
  const row = isUuid(itemId) ? await client.integrationErrorItem.findUnique({ where: { id: itemId }, select: ITEM }) : null
  if (!row || !can(actor(caller), INTEGRATIONS_VIEW, row.companyId ? { companyId: row.companyId } : {})) throw new NotFoundError('Failed message not found.')
  return row
}

/** The top-level scalars of a summary the gateway kept (already without secrets or personal data). */
function summaryLines(summary: Prisma.JsonValue | null | undefined): Array<{ key: string; value: string }> {
  if (summary === null || summary === undefined || typeof summary !== 'object' || Array.isArray(summary)) return []
  return Object.entries(summary)
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 20)
    .map(([key, value]) => ({ key: key.slice(0, 60), value: String(value).slice(0, 200) }))
}

async function nameOf(client: Client, userId: string | null): Promise<{ system: boolean; name: string | null } | null> {
  if (userId === null) return null
  if (userId === SYSTEM_ACTOR_ID) return { system: true, name: null }
  const user = await client.user.findUnique({ where: { id: userId }, select: { displayName: true } })
  return { system: false, name: user?.displayName ?? null }
}

/** GET /integrations/errors/:itemId: the item, what failed in its source's words (no secret, no body), who retried or dismissed it. */
export async function getError(caller: CommandCaller, itemId: string): Promise<{ item: ErrorItemView; detail: ErrorDetail }> {
  return caller.withClient(async (client) => {
    const row = await readItem(caller, client, itemId)
    const item = viewOf(row, await mayManage(caller, client, row.companyId))
    let detail: ErrorDetail['source'] = { kind: 'gone' }
    if (row.source === 'OUTBOX') {
      const event = await client.outboxEvent.findUnique({ where: { id: row.sourceId }, select: { type: true, occurredAt: true, status: true, attempts: true } })
      if (event) detail = { kind: 'event', type: event.type, occurredAt: toUtcIso(event.occurredAt), status: event.status, attempts: event.attempts }
    } else if (row.source === 'WEBHOOK') {
      const hook = await client.inboundWebhook.findUnique({ where: { id: row.sourceId }, select: { eventType: true, receivedAt: true, status: true, attempts: true, bodyBytes: true, verified: true, accountId: true } })
      if (hook) {
        const account = await client.integrationAccount.findUnique({ where: { id: hook.accountId }, select: { label: true } })
        detail = { kind: 'webhook', eventType: hook.eventType, receivedAt: toUtcIso(hook.receivedAt), status: hook.status, attempts: hook.attempts, bodyBytes: hook.bodyBytes, verified: hook.verified, accountId: hook.accountId, accountLabel: account?.label ?? null }
      }
    } else {
      const call = await client.integrationCall.findUnique({
        where: { id: row.sourceId },
        select: { startedAt: true, durationMs: true, attempts: true, httpStatus: true, status: true, reason: true, accountId: true, mode: true, requestSummary: true, responseSummary: true },
      })
      if (call) {
        const account = await client.integrationAccount.findUnique({ where: { id: call.accountId }, select: { label: true } })
        detail = {
          kind: 'call',
          startedAt: toUtcIso(call.startedAt),
          durationMs: call.durationMs,
          attempts: call.attempts,
          httpStatus: call.httpStatus,
          status: call.status,
          reason: call.reason,
          mode: call.mode,
          accountId: call.accountId,
          accountLabel: account?.label ?? null,
          request: summaryLines(call.requestSummary),
          response: summaryLines(call.responseSummary),
        }
      }
    }
    return { item, detail: { source: detail, retriedBy: await nameOf(client, row.retriedById), dismissedBy: await nameOf(client, row.dismissedById) } }
  })
}

/** Runs a background job that ran out of tries again (the API's queues; tests set a stand-in). */
export interface JobRetrier {
  retry(queue: 'events' | 'event-handlers', jobId: string): Promise<'retried' | 'gone' | 'not_failed'>
}

let configuredRetrier: JobRetrier | undefined
let kitOf: { health: HealthRedis; kit: QueueKit } | undefined

export function useJobRetrier(retrier: JobRetrier | undefined): void {
  configuredRetrier = retrier
}

function processRetrier(): JobRetrier {
  if (configuredRetrier) return configuredRetrier
  return {
    async retry(queue, jobId) {
      const health = processHealthRedis()
      if (!kitOf || kitOf.health !== health) kitOf = { health, kit: openQueues({ connection: health.redis, prefix: health.prefix }) }
      const job = await Job.fromId(kitOf.kit.queue(queue), jobId)
      if (!job) return 'gone'
      if ((await job.getState()) !== 'failed') return 'not_failed'
      await job.retry('failed')
      return 'retried'
    },
  }
}

/** The API's words of a held Retry (the web says its own from the code). */
const RETRY_HELD_WORDS: Readonly<Record<RetryHeld, string>> = Object.freeze({
  DISMISSED: 'This message was dismissed: nothing more is done with it.',
  WAITING: 'This message was sent again; it comes back here if it fails again.',
  SIGNATURE: "This webhook's signature did not hold: it is never processed. Ask the service to send it again.",
  FROM_RECORD: 'A failed call is sent again from where it started: open it there.',
})

/** POST /integrations/errors/:itemId/retry: the message sent again once (see the file's note). */
export async function retryError(caller: CommandCaller, itemId: string, input: { version: number }, idempotencyKey?: string): Promise<ErrorItemView> {
  const context = officeOf(caller)
  const before = await caller.withClient(async (client) => {
    const row = await readItem(caller, client, itemId)
    if (!(await mayManage(caller, client, row.companyId))) throw new ForbiddenError()
    return row
  })
  const held = retryHeldOf({ source: before.source, state: before.state, reasonCode: before.reasonCode })
  if (held) throw new InvalidStateError(RETRY_HELD_WORDS[held])
  const job = before.source === 'OUTBOX' && (before.reasonCode === 'job_failed' || before.reasonCode === 'dispatch_failed')
  const { result } = await command(caller, { name: 'integration.retryError', idempotencyKey, input: { itemId, ...input }, record: { type: 'IntegrationErrorItem', id: before.id, expectedVersion: input.version } }, async (tools) => {
    const { tx, now } = tools
    if (before.source === 'OUTBOX' && !job) {
      if (!(await requeueDeadEvent(tx, before.sourceId, now))) throw new ConflictError('The event is not dead any more: it was sent again meanwhile.')
    } else if (before.source === 'WEBHOOK') {
      const hook = await tx.inboundWebhook.findUnique({ where: { id: before.sourceId }, select: { id: true, accountId: true, provider: true, companyId: true } })
      const moved = hook ? await tx.inboundWebhook.updateMany({ where: { id: before.sourceId, status: 'FAILED' }, data: { status: 'RECEIVED' } }) : { count: 0 }
      if (!hook || moved.count === 0) throw new ConflictError('The webhook is not failed any more: it was processed or sent again meanwhile.')
      tools.emit({ type: 'integration.inbound_received', subject: hook.id, companyId: hook.companyId, payload: { receiptId: hook.id, accountId: hook.accountId, provider: hook.provider } })
    }
    const row = await tx.integrationErrorItem.update({ where: { id: before.id }, data: { state: 'RETRIED', retriedAt: now, retriedById: context.actorId }, select: ITEM })
    tools.audit({ recordType: 'IntegrationErrorItem', recordId: row.id, companyId: row.companyId, before: { state: before.state, tries: before.tries }, after: { state: 'RETRIED', source: row.source, operation: row.operation } })
    tools.emit({ type: 'integration.error_retried', subject: row.id, companyId: row.companyId, payload: { itemId: row.id, source: row.source, bySystem: false } })
    if (job) {
      let outcome: Awaited<ReturnType<JobRetrier['retry']>>
      try {
        outcome = await processRetrier().retry(before.reasonCode === 'job_failed' ? 'event-handlers' : 'events', before.reasonCode === 'job_failed' ? `${before.operation}.${before.sourceId}` : before.sourceId)
      } catch {
        throw new ApiError('not_ready', 'The background queues cannot be reached right now: nothing was sent again. Try again in a moment.')
      }
      if (outcome === 'gone') throw new ConflictError('The background job is gone (a failed job is kept 30 days): dismiss the message with a reason.')
      if (outcome === 'not_failed') throw new ConflictError('The background job is not failed any more: it runs or ran again meanwhile.')
    }
    return viewOf(row, true)
  })
  return result
}

/** POST /integrations/errors/:itemId/dismiss: nothing more is done; the item stays with who, when and why. */
export async function dismissError(caller: CommandCaller, itemId: string, input: { version: number; reason: string }, idempotencyKey?: string): Promise<ErrorItemView> {
  const context = officeOf(caller)
  const before = await caller.withClient(async (client) => {
    const row = await readItem(caller, client, itemId)
    if (!(await mayManage(caller, client, row.companyId))) throw new ForbiddenError()
    return row
  })
  if (dismissHeldOf(before)) throw new InvalidStateError(RETRY_HELD_WORDS.DISMISSED)
  const reason = input.reason.trim()
  const { result } = await command(caller, { name: 'integration.dismissError', idempotencyKey, input: { itemId, version: input.version, reason }, record: { type: 'IntegrationErrorItem', id: before.id, expectedVersion: input.version } }, async (tools) => {
    const row = await tools.tx.integrationErrorItem.update({ where: { id: before.id }, data: { state: 'DISMISSED', dismissedAt: tools.now, dismissedById: context.actorId, dismissReason: reason }, select: ITEM })
    tools.audit({ recordType: 'IntegrationErrorItem', recordId: row.id, companyId: row.companyId, before: { state: before.state }, after: { state: 'DISMISSED' }, reason })
    tools.emit({ type: 'integration.error_dismissed', subject: row.id, companyId: row.companyId, payload: { itemId: row.id, source: row.source } })
    return viewOf(row, true)
  })
  return result
}
