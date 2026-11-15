import { Job } from 'bullmq'
import type { FactoryDatabase, IntegrationProvider, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { CALL_REFUSALS_COLLECTED, errorKeyOf, reasonCodeOf, reasonTextOf, TEST_OPERATION, type ErrorSource } from '@nexus/factory-domain/integration-health/errors'
import { scrubText } from '@nexus/factory-domain/observability/report'
import { callerFor, command } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { DeadLetter, Log, QueueKit } from '../../../core/queue'
import { activeTenants, systemContext } from '../../outbox/system'

/**
 * The error queue's collector (B-W2b-415; PLT-201): the scheduler's clustered cron `integrations.collectErrors`, every
 * minute, per active tenant in its system scope. It turns failed source rows into IntegrationErrorItems — one per row
 * (`<outbox | webhook | call>:<id>`, the database's unique key) — and keeps them true:
 *
 *   OUTBOX    an event the relay gave up on (DEAD: `publish_failed`); an event whose background job ran out of tries (the
 *             dead-letter queue: `job_failed` for a handler, `dispatch_failed` for the dispatcher; the job's name is the
 *             item's operation, so Retry finds the job)
 *   WEBHOOK   a receipt whose processing FAILED (`processing_failed`) or whose signature did not hold (REJECTED:
 *             `signature_mismatch`)
 *   CALL      a call of the last 7 days that FAILED or TIMED_OUT, or was REFUSED for a reason a person must act on (paused,
 *             disabled, FAKE in production); never a connection test. Calls with one idempotency key are one message: the
 *             first failed call is the item, a later failure of the same key adds a try. When the same key later SUCCEEDED
 *             the message went: no item, or (an open item) RETRIED by the system.
 *
 * An item a person sent again (RETRIED) whose source failed again comes back OPEN with one more try and the new time; an
 * OPEN item whose source went through meanwhile is RETRIED by the system. DISMISSED items never change. Each tenant's
 * changes are ONE system command (audited per item; events integration.error_opened / error_retried), only when there is
 * something to change; the plan is made again inside the transaction.
 */

export const COLLECT_JOB = 'integrations.collectErrors'
export const COLLECT_SCHEDULE = '* * * * *'

const DAY_MS = 24 * 3_600_000
/** Calls are looked at for this long after they failed. */
export const CALL_WINDOW_MS = 7 * DAY_MS
/** At most this many rows of one kind per tenant and run (the newest; the next minute takes what remains). */
export const COLLECT_BATCH = 500

type Client = Prisma.TransactionClient

/** The background queues as the collector needs them (the scheduler's queue kit; tests give a stand-in). */
export interface JobsReader {
  /** The jobs that ran out of tries (the dead-letter queue). */
  deadLetters(): Promise<DeadLetter[]>
  /** The job, when it failed again after `since`: when and why; null when it did not (or is gone). */
  failedSince(queue: 'events' | 'event-handlers', jobId: string, since: Date): Promise<{ at: Date; reason: string | null } | null>
}

/** The reader over the scheduler's queue kit. */
export function queueJobsReader(kit: QueueKit): JobsReader {
  return {
    async deadLetters() {
      const jobs = await kit.queue('dead-letter').getJobs(['waiting', 'delayed', 'paused', 'completed', 'failed'], 0, 999)
      return jobs.map((job) => job.data as DeadLetter).filter((letter) => letter && (letter.queue === 'events' || letter.queue === 'event-handlers'))
    },
    async failedSince(queue, jobId, since) {
      const job = await Job.fromId(kit.queue(queue), jobId)
      if (!job || !job.finishedOn || job.finishedOn <= since.getTime()) return null
      const state = await job.getState()
      return state === 'failed' ? { at: new Date(job.finishedOn), reason: job.failedReason ?? null } : null
    },
  }
}

/** The tenant and event of a dead letter (its data is the event envelope). */
function letterEvent(letter: DeadLetter): { tenantId: string; eventId: string; companyId: string | null } | null {
  const data = letter.data as { tenantId?: unknown; eventId?: unknown; companyId?: unknown } | null
  if (!data || typeof data.tenantId !== 'string' || typeof data.eventId !== 'string') return null
  return { tenantId: data.tenantId, eventId: data.eventId, companyId: typeof data.companyId === 'string' ? data.companyId : null }
}

interface NewItem {
  readonly id: string
  readonly source: ErrorSource
  readonly sourceId: string
  readonly companyId: string | null
  readonly provider: IntegrationProvider | null
  readonly operation: string
  readonly reasonCode: string
  readonly reasonText: string | null
  readonly failedAt: Date
  /** A message of one key that failed again in the same pass is born with its tries (default 1) and its latest failure. */
  tries?: number
  lastFailedAt?: Date
}

interface Plan {
  readonly create: NewItem[]
  /** RETRIED → OPEN: failed again after the retry. */
  readonly reopen: Array<{ id: string; source: ErrorSource; tries: number; lastFailedAt: Date; reasonText: string | null }>
  /** OPEN → OPEN: one more failure of the same message. */
  readonly bump: Array<{ id: string; tries: number; lastFailedAt: Date }>
  /** OPEN → RETRIED by the system: it went through meanwhile. */
  readonly heal: Array<{ id: string; source: ErrorSource; at: Date }>
}

const emptyPlan = (plan: Plan) => plan.create.length + plan.reopen.length + plan.bump.length + plan.heal.length === 0

const ITEM = { id: true, source: true, sourceId: true, state: true, tries: true, lastFailedAt: true, retriedAt: true, reasonCode: true, operation: true } as const

const textOf = (text: string | null | undefined): string | null => reasonTextOf(text ? scrubText(text, 2000) : null)

/** The plan of one tenant: what to open, reopen, add a try to, or mark as gone through. Reads only. */
export async function planTenant(client: Client, input: { readonly letters: readonly DeadLetter[]; readonly jobs: JobsReader | null; readonly now: Date }): Promise<Plan> {
  const { now } = input
  const plan: Plan = { create: [], reopen: [], bump: [], heal: [] }

  // OUTBOX: dead events.
  const dead = await client.outboxEvent.findMany({ where: { status: 'DEAD' }, select: { id: true, companyId: true, type: true, lastError: true }, orderBy: { id: 'desc' }, take: COLLECT_BATCH })
  const outboxItems = await client.integrationErrorItem.findMany({ where: { source: 'OUTBOX', OR: [{ sourceId: { in: dead.map((row) => row.id) } }, { state: { in: ['OPEN', 'RETRIED'] } }] }, select: ITEM })
  const outboxBySource = new Map(outboxItems.map((item) => [item.sourceId, item]))
  for (const event of dead) {
    const item = outboxBySource.get(event.id)
    if (!item) plan.create.push({ id: newId(), source: 'OUTBOX', sourceId: event.id, companyId: event.companyId, provider: null, operation: event.type, reasonCode: 'publish_failed', reasonText: textOf(event.lastError), failedAt: now })
    else if (item.state === 'RETRIED' && item.reasonCode === 'publish_failed') plan.reopen.push({ id: item.id, source: 'OUTBOX', tries: item.tries + 1, lastFailedAt: now, reasonText: textOf(event.lastError) })
  }
  const deadIds = new Set(dead.map((row) => row.id))
  const openPublish = outboxItems.filter((item) => item.state === 'OPEN' && item.reasonCode === 'publish_failed' && !deadIds.has(item.sourceId))
  if (openPublish.length > 0) {
    const moved = await client.outboxEvent.findMany({ where: { id: { in: openPublish.map((item) => item.sourceId) }, status: { not: 'DEAD' } }, select: { id: true } })
    const movedIds = new Set(moved.map((row) => row.id))
    for (const item of openPublish) if (movedIds.has(item.sourceId)) plan.heal.push({ id: item.id, source: 'OUTBOX', at: now })
  }

  // OUTBOX: background jobs out of tries (the dead-letter queue of this tenant).
  const letters = input.letters.filter((letter) => letterEvent(letter))
  if (letters.length > 0) {
    const eventIds = [...new Set(letters.map((letter) => letterEvent(letter)!.eventId))]
    const [events, items] = await Promise.all([
      client.outboxEvent.findMany({ where: { id: { in: eventIds }, status: { in: ['PUBLISHED', 'DEAD'] } }, select: { id: true, companyId: true } }),
      client.integrationErrorItem.findMany({ where: { source: 'OUTBOX', sourceId: { in: eventIds } }, select: ITEM }),
    ])
    const known = new Map(events.map((row) => [row.id, row]))
    const taken = new Set(items.map((item) => item.sourceId))
    for (const letter of letters) {
      const event = letterEvent(letter)!
      const row = known.get(event.eventId)
      if (!row || taken.has(event.eventId) || plan.create.some((item) => item.sourceId === event.eventId)) continue
      const failedAt = new Date(letter.failedAt)
      plan.create.push({
        id: newId(),
        source: 'OUTBOX',
        sourceId: event.eventId,
        companyId: row.companyId,
        provider: null,
        operation: letter.queue === 'event-handlers' ? letter.name : `events.${letter.name}`.slice(0, 100),
        reasonCode: letter.queue === 'event-handlers' ? 'job_failed' : 'dispatch_failed',
        reasonText: textOf(letter.error),
        failedAt: Number.isNaN(failedAt.getTime()) || failedAt > now ? now : failedAt,
      })
      taken.add(event.eventId)
    }
  }
  // A job sent again that failed again comes back OPEN.
  if (input.jobs) {
    for (const item of outboxItems.filter((entry) => entry.state === 'RETRIED' && (entry.reasonCode === 'job_failed' || entry.reasonCode === 'dispatch_failed'))) {
      const queue = item.reasonCode === 'job_failed' ? 'event-handlers' : 'events'
      const again = await input.jobs.failedSince(queue, item.reasonCode === 'job_failed' ? `${item.operation}.${item.sourceId}` : item.sourceId, item.retriedAt!)
      if (again && again.at > item.lastFailedAt && again.at <= now) plan.reopen.push({ id: item.id, source: 'OUTBOX', tries: item.tries + 1, lastFailedAt: again.at, reasonText: textOf(again.reason) })
    }
  }

  // WEBHOOK: failed processing and rejected signatures.
  const hooks = await client.inboundWebhook.findMany({
    where: { status: { in: ['FAILED', 'REJECTED'] } },
    select: { id: true, companyId: true, provider: true, status: true, lastError: true, rejectReason: true, receivedAt: true },
    orderBy: { receivedAt: 'desc' },
    take: COLLECT_BATCH,
  })
  const hookItems = await client.integrationErrorItem.findMany({ where: { source: 'WEBHOOK', OR: [{ sourceId: { in: hooks.map((row) => row.id) } }, { state: 'OPEN', reasonCode: 'processing_failed' }] }, select: ITEM })
  const hookBySource = new Map(hookItems.map((item) => [item.sourceId, item]))
  for (const hook of hooks) {
    const item = hookBySource.get(hook.id)
    const rejected = hook.status === 'REJECTED'
    if (!item) {
      plan.create.push({
        id: newId(),
        source: 'WEBHOOK',
        sourceId: hook.id,
        companyId: hook.companyId,
        provider: hook.provider,
        operation: 'webhook.process',
        reasonCode: rejected ? 'signature_mismatch' : 'processing_failed',
        reasonText: textOf(rejected ? hook.rejectReason : hook.lastError),
        failedAt: rejected ? hook.receivedAt : now,
      })
    } else if (item.state === 'RETRIED' && !rejected) plan.reopen.push({ id: item.id, source: 'WEBHOOK', tries: item.tries + 1, lastFailedAt: now, reasonText: textOf(hook.lastError) })
  }
  const failedHooks = new Set(hooks.map((row) => row.id))
  const openHooks = hookItems.filter((item) => item.state === 'OPEN' && item.reasonCode === 'processing_failed' && !failedHooks.has(item.sourceId))
  if (openHooks.length > 0) {
    const moved = await client.inboundWebhook.findMany({ where: { id: { in: openHooks.map((item) => item.sourceId) }, status: { in: ['RECEIVED', 'PROCESSED'] } }, select: { id: true } })
    const movedIds = new Set(moved.map((row) => row.id))
    for (const item of openHooks) if (movedIds.has(item.sourceId)) plan.heal.push({ id: item.id, source: 'WEBHOOK', at: now })
  }

  // CALL: failed, timed out or refused for a person's reason, of the last 7 days; one message per idempotency key.
  const since = new Date(now.getTime() - CALL_WINDOW_MS)
  const calls = (
    await client.integrationCall.findMany({
      where: {
        startedAt: { gte: since },
        operation: { not: TEST_OPERATION },
        OR: [{ status: { in: ['FAILED', 'TIMED_OUT'] } }, { status: 'REFUSED', reason: { in: [...CALL_REFUSALS_COLLECTED] } }],
      },
      select: { id: true, companyId: true, accountId: true, provider: true, operation: true, idempotencyKey: true, status: true, reason: true, error: true, finishedAt: true },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: COLLECT_BATCH,
    })
  ).reverse()
  const callItems = await client.integrationErrorItem.findMany({ where: { source: 'CALL', lastFailedAt: { gte: new Date(since.getTime() - DAY_MS) } }, select: ITEM })
  const sources = callItems.length === 0 ? [] : await client.integrationCall.findMany({ where: { id: { in: callItems.map((item) => item.sourceId) } }, select: { id: true, accountId: true, operation: true, idempotencyKey: true } })
  const groupOf = (row: { accountId: string; operation: string; idempotencyKey: string | null }) => (row.idempotencyKey ? `${row.accountId}|${row.operation}|${row.idempotencyKey}` : null)
  const itemBySource = new Map(callItems.map((item) => [item.sourceId, item]))
  const itemByGroup = new Map<string, { id: string; state: string; tries: number; lastFailedAt: Date; retriedAt: Date | null; isNew: boolean }>()
  for (const source of sources) {
    const group = groupOf(source)
    const item = itemBySource.get(source.id)
    if (group && item) itemByGroup.set(group, { ...item, isNew: false })
  }
  // The keys to look for a later success: the failed calls' and the open items' (a message whose failures were counted earlier).
  const keys = new Set([
    ...calls.flatMap((call) => (call.idempotencyKey ? [call.idempotencyKey] : [])),
    ...sources.flatMap((source) => (source.idempotencyKey && itemBySource.get(source.id)?.state === 'OPEN' ? [source.idempotencyKey] : [])),
  ])
  const successes =
    keys.size === 0
      ? []
      : await client.integrationCall.findMany({
          where: { status: 'SUCCEEDED', startedAt: { gte: since }, idempotencyKey: { in: [...keys] } },
          select: { accountId: true, operation: true, idempotencyKey: true, finishedAt: true },
        })
  const wentAt = (group: string, after: Date): Date | null => {
    const found = successes.filter((row) => groupOf(row) === group && row.finishedAt > after).map((row) => row.finishedAt.getTime())
    return found.length === 0 ? null : new Date(Math.min(...found))
  }
  for (const call of calls) {
    if (itemBySource.has(call.id)) continue
    const group = groupOf(call)
    const existing = group ? itemByGroup.get(group) : undefined
    if (existing) {
      if (existing.state === 'DISMISSED' || call.finishedAt <= existing.lastFailedAt) continue
      if (existing.isNew) {
        const born = plan.create.find((entry) => entry.id === existing.id)!
        existing.tries += 1
        existing.lastFailedAt = call.finishedAt > now ? now : call.finishedAt
        born.tries = existing.tries
        born.lastFailedAt = existing.lastFailedAt
        continue
      }
      if (existing.state === 'OPEN') {
        existing.tries += 1
        existing.lastFailedAt = call.finishedAt
        const bump = plan.bump.find((entry) => entry.id === existing.id)
        if (bump) Object.assign(bump, { tries: existing.tries, lastFailedAt: existing.lastFailedAt })
        else plan.bump.push({ id: existing.id, tries: existing.tries, lastFailedAt: existing.lastFailedAt })
      } else if (existing.retriedAt && call.finishedAt > existing.retriedAt) {
        existing.tries += 1
        existing.lastFailedAt = call.finishedAt
        existing.state = 'OPEN'
        plan.reopen.push({ id: existing.id, source: 'CALL', tries: existing.tries, lastFailedAt: existing.lastFailedAt, reasonText: textOf(call.error) })
      }
      continue
    }
    if (group && wentAt(group, call.finishedAt)) continue
    const created: NewItem = {
      id: newId(),
      source: 'CALL',
      sourceId: call.id,
      companyId: call.companyId,
      provider: call.provider,
      operation: call.operation,
      reasonCode: reasonCodeOf(call.reason ?? call.status.toLowerCase()),
      reasonText: textOf(call.error),
      failedAt: call.finishedAt > now ? now : call.finishedAt,
    }
    plan.create.push(created)
    if (group) itemByGroup.set(group, { id: created.id, state: 'OPEN', tries: 1, lastFailedAt: created.failedAt, retriedAt: null, isNew: true })
  }
  // An open message of one key that later went through: RETRIED by the system.
  for (const [group, item] of itemByGroup) {
    if (item.isNew || item.state !== 'OPEN') continue
    const at = wentAt(group, item.lastFailedAt)
    if (at && at <= now) plan.heal.push({ id: item.id, source: 'CALL', at })
  }
  return plan
}

export interface CollectOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  /** The queues (the scheduler's kit); without it, background jobs out of tries are not collected. */
  readonly jobs?: JobsReader | null
  readonly now?: () => Date
}

/** One pass over every active tenant (the cron's; tests call it): how many items were opened, reopened, added a try, healed. */
export async function collectErrors(options: CollectOptions): Promise<{ opened: number; reopened: number; bumped: number; healed: number }> {
  const totals = { opened: 0, reopened: 0, bumped: 0, healed: 0 }
  const requestId = `collect-errors-${newId()}`
  let letters: DeadLetter[] = []
  if (options.jobs) {
    try {
      letters = await options.jobs.deadLetters()
    } catch (error) {
      options.log.warn({ err: error }, 'the dead-letter queue could not be read; jobs out of tries wait for the next minute')
    }
  }
  for (const tenantId of await activeTenants(options.database)) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const mine = letters.filter((letter) => letterEvent(letter)?.tenantId === tenantId)
    try {
      const now = options.now?.() ?? new Date()
      const first = await caller.withClient((client) => planTenant(client, { letters: mine, jobs: options.jobs ?? null, now }))
      if (emptyPlan(first)) continue
      const { result } = await command(caller, { name: 'integrations.collectErrors', input: { opened: first.create.length, reopened: first.reopen.length, bumped: first.bump.length, healed: first.heal.length } }, async (tools) => {
        const plan = await planTenant(tools.tx, { letters: mine, jobs: options.jobs ?? null, now: tools.now < now ? now : tools.now })
        const done = { opened: 0, reopened: 0, bumped: 0, healed: 0 }
        for (const item of plan.create) {
          await tools.tx.integrationErrorItem.create({
            data: {
              id: item.id,
              companyId: item.companyId,
              key: errorKeyOf(item.source, item.sourceId),
              source: item.source,
              sourceId: item.sourceId,
              provider: item.provider,
              operation: item.operation,
              reasonCode: item.reasonCode,
              reasonText: item.reasonText,
              tries: item.tries ?? 1,
              firstFailedAt: item.failedAt,
              lastFailedAt: item.lastFailedAt ?? item.failedAt,
            },
            select: { id: true },
          })
          tools.audit({ action: 'integration.errorOpened', recordType: 'IntegrationErrorItem', recordId: item.id, companyId: item.companyId, after: { source: item.source, operation: item.operation, reasonCode: item.reasonCode, state: 'OPEN' } })
          tools.emit({ type: 'integration.error_opened', subject: item.id, companyId: item.companyId, payload: { itemId: item.id, source: item.source, provider: item.provider } })
          done.opened++
        }
        for (const item of plan.reopen) {
          const changed = await tools.tx.integrationErrorItem.updateMany({
            where: { id: item.id, state: 'RETRIED', lastFailedAt: { lt: item.lastFailedAt } },
            data: { state: 'OPEN', tries: item.tries, lastFailedAt: item.lastFailedAt, reasonText: item.reasonText, version: { increment: 1 } },
          })
          if (changed.count === 0) continue
          tools.audit({ action: 'integration.errorFailedAgain', recordType: 'IntegrationErrorItem', recordId: item.id, before: { state: 'RETRIED' }, after: { state: 'OPEN', tries: item.tries } })
          done.reopened++
        }
        for (const item of plan.bump) {
          const changed = await tools.tx.integrationErrorItem.updateMany({ where: { id: item.id, state: 'OPEN', lastFailedAt: { lt: item.lastFailedAt } }, data: { tries: item.tries, lastFailedAt: item.lastFailedAt, version: { increment: 1 } } })
          if (changed.count === 0) continue
          tools.audit({ action: 'integration.errorFailedAgain', recordType: 'IntegrationErrorItem', recordId: item.id, before: { state: 'OPEN' }, after: { state: 'OPEN', tries: item.tries } })
          done.bumped++
        }
        for (const item of plan.heal) {
          const changed = await tools.tx.integrationErrorItem.updateMany({ where: { id: item.id, state: 'OPEN', lastFailedAt: { lte: item.at } }, data: { state: 'RETRIED', retriedAt: item.at, retriedById: SYSTEM_ACTOR_ID, version: { increment: 1 } } })
          if (changed.count === 0) continue
          tools.audit({ action: 'integration.errorWentThrough', recordType: 'IntegrationErrorItem', recordId: item.id, before: { state: 'OPEN' }, after: { state: 'RETRIED', bySystem: true } })
          tools.emit({ type: 'integration.error_retried', subject: item.id, payload: { itemId: item.id, source: item.source, bySystem: true } })
          done.healed++
        }
        if (done.opened + done.reopened + done.bumped + done.healed === 0) tools.audit({ action: 'integration.collectErrors', recordType: 'Tenant', recordId: tenantId, after: { changed: 0 } })
        return done
      })
      totals.opened += result.opened
      totals.reopened += result.reopened
      totals.bumped += result.bumped
      totals.healed += result.healed
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the error queue of a tenant could not be collected; tried again next minute')
    }
  }
  if (totals.opened + totals.reopened + totals.bumped + totals.healed > 0) options.log.info(totals, 'error queue collected')
  return totals
}

export interface CollectCronOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  /** The scheduler's queue kit: the dead-letter queue and the jobs sent again. */
  readonly kit?: QueueKit | null
}

export function errorCollectorCron(options: CollectCronOptions): CronJob {
  return defineCron({
    name: COLLECT_JOB,
    schedule: COLLECT_SCHEDULE,
    async run() {
      await collectErrors({ database: options.database, log: options.log, jobs: options.kit ? queueJobsReader(options.kit) : null })
    },
  })
}
