/**
 * AD.2 — Operator-write entry point for the Trading Desk.
 *
 * Every PATCH on a Campaign / AdGroup / AdTarget flows through here:
 *   1. UPSERT the local row (operator sees the change immediately)
 *   2. Enqueue an OutboundSyncQueue row with syncType=AD_* and
 *      holdUntil = NOW + 5min (gives a grace window to cancel)
 *   3. Write a CampaignBidHistory audit row (changedBy = "user:<id>"
 *      or "automation:<ruleId>")
 *   4. Add a BullMQ job to adsSyncQueue keyed by the OutboundSyncQueue
 *      row id — the AD.2 worker (ads-sync.worker.ts) consumes it
 *
 * Sandbox-safe: the worker's call to ads-api-client.update* short-
 * circuits in sandbox mode. So even with NEXUS_AMAZON_ADS_MODE unset,
 * an operator can PATCH a campaign, see the OutboundSyncQueue row,
 * undo within 5 min, and see the audit trail — all without touching
 * Amazon.
 *
 * If BullMQ is unavailable (Redis down / not configured in dev), the
 * mutation still succeeds. The OutboundSyncQueue row sits PENDING and
 * the node-cron fallback (existing) drains it on its next tick.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  IN_FLIGHT_STATES, isBelievablyPending, isBlockingWrite, isTerminal, stateForQueueStatus,
} from '../ads-core/ad-mutation-state.js'

// Conservative grace window. Operators have 5 min to cancel before
// the worker actually calls Amazon. Override via env for testing.
const GRACE_PERIOD_MS = Number(process.env.NEXUS_ADS_GRACE_MS ?? 5 * 60 * 1000)

export type AdsActor = `user:${string}` | `automation:${string}`

export type AdEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD' | 'PORTFOLIO'

export type AdSyncType =
  | 'AD_BID_UPDATE'
  | 'AD_BUDGET_UPDATE'
  | 'AD_ENTITY_STATE_UPDATE'
  | 'AD_BIDDING_STRATEGY_UPDATE'
  | 'AD_CAMPAIGN_NAME_UPDATE'
  | 'AD_CAMPAIGN_PORTFOLIO_UPDATE'
  | 'AD_PORTFOLIO_UPDATE'

export interface FieldChange {
  field: string
  oldValue: string | null
  newValue: string | null
}

export interface MutationOutcome {
  ok: boolean
  outboundQueueId: string | null
  bidHistoryIds: string[]
  /** AD.4 — id of the AdvertisingActionLog row this mutation wrote. */
  actionLogId: string | null
  error: string | null
}

/**
 * AD.4 — Write a single AdvertisingActionLog row capturing the
 * before/after JSON snapshots. The rollback endpoint walks these to
 * invert each operation. The actor string is stored in `userId` to
 * unify human + automation writes under one column (the audit table
 * needs to round-trip the actor verbatim).
 */
// Exported for the bulksheet create path (AX-IE.9): a create goes through the
// ads-create services, which do not enqueue outbound work and so never reach the
// call sites below — but it still has to join the upload's change set, or Undo
// leaves behind the rows the import invented.
export async function writeAdvertisingActionLog(args: {
  actor: AdsActor
  actionType: string
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'RETAIL_EVENT' | 'PRODUCT_AD'
  entityId: string
  payloadBefore: object
  payloadAfter: object
  outboundQueueId: string | null
  /**
   * AX-IE.6 — groups every write from one operation (a bulksheet upload, say)
   * under a single id so the whole set can be reverted together. `executionId`
   * has an index and no foreign key, so it takes any change-set id; rule
   * executions were simply its first user.
   */
  changeSetId?: string | null
}): Promise<string> {
  const row = await prisma.advertisingActionLog.create({
    data: {
      executionId: args.changeSetId ?? null,
      userId: args.actor,
      actionType: args.actionType,
      entityType: args.entityType,
      entityId: args.entityId,
      payloadBefore: args.payloadBefore,
      payloadAfter: args.payloadAfter,
      outboundQueueId: args.outboundQueueId,
      amazonResponseStatus: 'PENDING',
    },
    select: { id: true },
  })
  return row.id
}

interface EnqueueArgs {
  entityType: AdEntityType
  entityId: string
  externalId: string | null
  syncType: AdSyncType
  marketplace: string | null
  fieldChanges: FieldChange[]
  actor: AdsActor
  reason: string | null
  applyImmediately: boolean // when true, holdUntil = NOW (no grace)
}

async function enqueueOutbound(args: EnqueueArgs): Promise<string> {
  const holdUntil = args.applyImmediately
    ? new Date()
    : new Date(Date.now() + GRACE_PERIOD_MS)
  // AX-ZD.1f — the queue row and its typed rows are now written in ONE
  // transaction. While AdMutation was bookkeeping only, a failed write there
  // was better swallowed than allowed to fail an operator's change. Now that
  // dispatch reads the typed rows, a half-write would be a SILENTLY DROPPED
  // write, which is the worst outcome available. Either both land or neither
  // does and the caller sees the error.
  return prisma.$transaction(async (tx) => {
    const id = await createQueueRow(tx, args, holdUntil)
    await recordAdMutations(tx, id, args, holdUntil)
    return id
  })
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

async function createQueueRow(tx: Tx, args: EnqueueArgs, holdUntil: Date): Promise<string> {
  const row = await tx.outboundSyncQueue.create({
    data: {
      // Campaign-level entities don't tie to a product/channel listing.
      // Leave both FKs null; the worker reads entityType from payload.
      productId: null,
      channelListingId: null,
      targetChannel: 'AMAZON',
      targetRegion: args.marketplace,
      syncStatus: 'PENDING',
      syncType: args.syncType,
      payload: {
        entityType: args.entityType,
        entityId: args.entityId,
        externalId: args.externalId,
        marketplace: args.marketplace,
        fieldChanges: args.fieldChanges,
        actor: args.actor,
        reason: args.reason,
      } as object,
      holdUntil,
      externalListingId: args.externalId,
    },
    select: { id: true },
  })
  return row.id
}

/**
 * AX-ZD.1 — write one typed `AdMutation` per changed field, alongside the queue row.
 *
 * The queue row carries every field change in a single JSON payload, which is
 * why the drift check cannot ask "is THIS field in flight?" and instead asks
 * "is anything in flight on this campaign?" — hiding real external edits. One
 * row per field is the whole point.
 *
 * AX-ZD.1f — no longer optional, and no longer swallowing. These rows are what
 * dispatch reads, so a missing one is a dropped write rather than a degraded
 * drift signal. It runs inside the enqueue transaction: either the queue row and
 * its typed rows both land, or the operator's PATCH fails loudly.
 */
async function recordAdMutations(
  tx: Tx,
  outboundQueueId: string,
  args: EnqueueArgs,
  holdUntil: Date,
): Promise<void> {
  if (!args.fieldChanges.length) return
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)
  {
    await tx.adMutation.createMany({
      data: dedupeFieldChanges(args.fieldChanges).map((c) => ({
        entityType: args.entityType,
        entityId: args.entityId,
        externalEntityId: args.externalId,
        marketplace: args.marketplace,
        field: c.field,
        intendedValue: str(c.newValue),
        previousValue: str(c.oldValue),
        state: 'PENDING',
        actor: args.actor,
        // The queue row id is the natural idempotency key: the dispatch path is
        // keyed on it, and one (queue row, field) pair is exactly one intent.
        idempotencyKey: `${outboundQueueId}:${c.field}`,
        holdUntil,
        outboundQueueId,
      })),
      skipDuplicates: true,
    })
  }
}

/**
 * AX-ZD.1f — collapse repeated fields, last-wins.
 *
 * The typed rows are keyed `${queueId}:${field}` and inserted with
 * `skipDuplicates`, so a repeated field would keep the FIRST occurrence and drop
 * the rest. The JSON path builds a plain object from the same array, so it keeps
 * the LAST. That is a silent divergence between two paths that must dispatch
 * identically — the operator would see the wrong value applied.
 *
 * No caller sends duplicates today, so this changes nothing now. It exists so
 * the two paths are equivalent by construction rather than by luck, because the
 * failure mode is a wrong bid reaching Amazon with nothing in the logs.
 */
export function dedupeFieldChanges(changes: FieldChange[]): FieldChange[] {
  const byField = new Map<string, FieldChange>()
  for (const c of changes) byField.set(c.field, c) // last wins, matching object-build
  return [...byField.values()]
}

/**
 * AX-ZD.1f — the dispatch payload, read from the typed rows.
 *
 * Dispatch used to parse a JSON blob on the queue row. That blob and the typed
 * rows are two records of one intent and could disagree; this makes the typed
 * rows authoritative and leaves OutboundSyncQueue owning delivery mechanics —
 * retries, dead-lettering, the grace window — which it does well.
 *
 * Returns null when there are no typed rows, and the caller falls back to the
 * blob. That is not defensive padding: rows enqueued before ZD.1 genuinely have
 * none, and dispatching nothing for them would silently drop an operator's
 * change. New rows always have them — the enqueue transaction guarantees it.
 */
export interface DispatchPayload {
  entityType: AdEntityType
  entityId: string
  externalId: string | null
  marketplace: string | null
  fieldChanges: FieldChange[]
  actor: string
  reason: string | null
}

export async function dispatchPayloadFromMutations(
  outboundQueueId: string,
): Promise<DispatchPayload | null> {
  const rows = await prisma.adMutation.findMany({
    where: { outboundQueueId },
    select: {
      entityType: true, entityId: true, externalEntityId: true, marketplace: true,
      field: true, intendedValue: true, previousValue: true, actor: true,
    },
    orderBy: { field: 'asc' },
  })
  if (!rows.length) return null
  const head = rows[0]!
  return {
    entityType: head.entityType as AdEntityType,
    entityId: head.entityId,
    externalId: head.externalEntityId,
    marketplace: head.marketplace,
    fieldChanges: rows.map((r) => ({
      field: r.field, oldValue: r.previousValue, newValue: r.intendedValue,
    })),
    actor: head.actor,
    // `reason` is audit prose, never dispatched, and lives on the queue row.
    // Recording it per field would duplicate it N times to no purpose.
    reason: null,
  }
}

/**
 * AX-ZD.1 — project an `OutboundSyncQueue` outcome onto its typed mutations.
 *
 * Called from the worker at every point the queue row's status moves. This is
 * the half that makes the typed record safe to READ from: an unsettled row means
 * "in flight", so a record that is written but never settled would suppress
 * drift on its field indefinitely. `PENDING_TRUST_WINDOW_MS` bounds that failure
 * mode, but settling correctly is what stops it happening at all.
 *
 * Never throws: settlement bookkeeping must not fail a write that already
 * reached Amazon.
 */
export async function settleAdMutations(
  outboundQueueId: string,
  syncStatus: string,
  opts: { isDead?: boolean; error?: string | null } = {},
): Promise<void> {
  const state = stateForQueueStatus(syncStatus, opts.isDead ?? false)
  try {
    await prisma.adMutation.updateMany({
      where: { outboundQueueId, state: { in: [...IN_FLIGHT_STATES] } },
      data: {
        state,
        lastError: opts.error ?? null,
        ...(state === 'IN_FLIGHT' ? { attempts: { increment: 1 } } : {}),
        ...(isTerminal(state) ? { settledAt: new Date() } : {}),
      },
    })
  } catch (err) {
    logger.warn('[AX-ZD.1] mutation settle failed', {
      outboundQueueId, syncStatus, error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * AX-ZD.1e — claim an entity for writing, atomically.
 *
 * Amazon answers two concurrent writes to one entity with HTTP 423
 * ConcurrentModificationException, and the ads worker runs at concurrency 2, so
 * two jobs for the same campaign genuinely overlap.
 *
 * ZD.1b did this as check-then-act and I labelled it a mitigation, on the
 * grounds that a Postgres advisory lock — the natural fix — was unusable here
 * because pgbouncer transaction pooling detaches the lock from the client. That
 * is true of SESSION-scoped locks (`pg_advisory_lock`), which is why
 * `prisma migrate deploy` stalls against this database. It is NOT true of
 * TRANSACTION-scoped locks: `pg_advisory_xact_lock` releases at COMMIT, which is
 * exactly the unit transaction pooling preserves. Measured against this
 * database before relying on it — two concurrent holders serialised cleanly and
 * a try-lock from a second client correctly refused while held.
 *
 * So this is a real claim, not a mitigation.
 *
 * THE LOCK COVERS THE CHECK-AND-SET, NOT THE WRITE. Holding a transaction open
 * across an Amazon call — seconds, with retries — would pin a pooled server
 * connection for the whole round trip and turn a slow Amazon into a database
 * incident. It does not need to: once this commits, our row is IN_FLIGHT, and
 * any other claimer must take the same lock and will see it. The IN_FLIGHT
 * state is the exclusion token; the lock only makes acquiring it indivisible.
 *
 * Returns false when the entity is busy — the caller defers rather than failing,
 * so nothing is lost.
 *
 * VERIFIED BY `scripts/_zd1e-claim-verify.mts`, not by the unit suite. The
 * property that matters is Postgres lock behaviour under real concurrency, and
 * a mocked test would assert only that this function calls the mock. The
 * harness races two claims on one entity against the live database and checks
 * exactly one wins, the loser is refused while the winner is in flight, the
 * loser succeeds once it settles, and a different entity is never blocked.
 */
export async function claimEntityWrite(
  entityType: AdEntityType,
  entityId: string,
  outboundQueueId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Namespaced two-key form so this can never collide with another
      // advisory-lock user (Prisma's migrate lock included).
      const got = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(${ADS_LOCK_CLASS}, hashtext($1)) AS ok`,
        `${entityType}:${entityId}`,
      )
      // Another worker is inside the critical section for this entity right
      // now. Don't wait for it — deferring is cheaper than holding a connection.
      if (!got[0]?.ok) return false

      const blockers = await tx.adMutation.findMany({
        where: { entityType, entityId, state: 'IN_FLIGHT', NOT: { outboundQueueId } },
        select: { state: true, updatedAt: true },
      })
      if (blockers.some((b) => isBlockingWrite(b, now))) return false

      const claimed = await tx.adMutation.updateMany({
        where: { outboundQueueId, state: 'PENDING' },
        data: { state: 'IN_FLIGHT', attempts: { increment: 1 } },
      })
      // A queue row enqueued before ZD.1 has no typed rows, so there is nothing
      // to claim and nothing to exclude on. Let it through: that is exactly the
      // pre-ZD.1 behaviour, and these drain within the retry ladder.
      return claimed.count > 0 || (await legacyRowWithNoMutations(tx, outboundQueueId))
    }, { timeout: 10_000 })
  } catch (err) {
    // Fail OPEN: if we cannot tell, let the write proceed. Amazon's 423 is
    // retryable and visible; a write blocked by a failed bookkeeping query
    // would be neither.
    logger.warn('[AX-ZD.1e] claim failed; proceeding unserialised', {
      outboundQueueId, error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

/** Namespace for ads entity-write advisory locks. */
const ADS_LOCK_CLASS = 4242

async function legacyRowWithNoMutations(
  tx: { adMutation: { count: (a: unknown) => Promise<number> } },
  outboundQueueId: string,
): Promise<boolean> {
  return (await tx.adMutation.count({ where: { outboundQueueId } })) === 0
}

/**
 * AX-ZD.3b — every in-flight field, for every entity of a type, in ONE query.
 *
 * `pendingWriteFields` asks per entity, which is right for a single campaign and
 * wrong inside the settings-sync loop: that runs per campaign across every
 * profile, so it issued one query per campaign per poll and would grow linearly
 * with the account.
 *
 * Unfiltered by entity on purpose. AdMutation holds only UNDELIVERED writes —
 * everything else has settled to a terminal state — so this set is naturally
 * tiny (normally empty) regardless of how many campaigns exist. `take` is a
 * backstop against a pathological backlog rather than an expected path, and it
 * logs rather than truncating silently, because a silent cap here would quietly
 * stop protecting the entities past the limit.
 */
export async function pendingWriteFieldsByEntity(
  entityType: AdEntityType,
  fields: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (!fields.length) return out
  const LIMIT = 5_000
  try {
    const rows = await prisma.adMutation.findMany({
      where: { entityType, field: { in: [...fields] }, state: { in: [...IN_FLIGHT_STATES] } },
      select: { entityId: true, field: true, state: true, createdAt: true },
      take: LIMIT,
    })
    if (rows.length === LIMIT) {
      logger.warn('[AX-ZD.3b] in-flight mutation set hit the cap; entities beyond it are unprotected this pass', {
        entityType, limit: LIMIT,
      })
    }
    for (const r of rows) {
      if (!isBelievablyPending(r, now)) continue
      const set = out.get(r.entityId) ?? new Set<string>()
      set.add(r.field)
      out.set(r.entityId, set)
    }
    return out
  } catch {
    // Fail OPEN, same as the per-entity form: reporting drift we caused costs a
    // minute, suppressing a real one loses an operator's edit.
    return out
  }
}

/**
 * AX-ZD.1 — which of these fields have a write in flight on this entity?
 *
 * The replacement for the campaign-wide JSON scan. One query, field-scoped, so a
 * queued budget change no longer explains away a name edit.
 *
 * Fails OPEN (empty set) on error: if we cannot tell, we report drift rather
 * than suppress it. An operator investigating a drift that turns out to be our
 * own pending write loses a minute; a suppressed drift loses their edit.
 */
export async function pendingWriteFields(
  entityType: AdEntityType,
  entityId: string,
  fields: readonly string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (!fields.length) return new Set()
  try {
    const rows = await prisma.adMutation.findMany({
      where: {
        entityType, entityId,
        field: { in: [...fields] },
        state: { in: [...IN_FLIGHT_STATES] },
      },
      select: { field: true, state: true, createdAt: true },
    })
    return new Set(rows.filter((r) => isBelievablyPending(r, now)).map((r) => r.field))
  } catch {
    return new Set()
  }
}

async function writeBidHistory(args: {
  entityType: AdEntityType
  entityId: string
  campaignId: string | null
  fieldChanges: FieldChange[]
  actor: AdsActor
  reason: string | null
}): Promise<string[]> {
  const ids: string[] = []
  for (const change of args.fieldChanges) {
    const row = await prisma.campaignBidHistory.create({
      data: {
        entityType: args.entityType,
        entityId: args.entityId,
        campaignId: args.campaignId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        changedBy: args.actor,
        reason: args.reason,
      },
      select: { id: true },
    })
    ids.push(row.id)
  }
  return ids
}

// Bound on how long we'll wait for the BullMQ enqueue before giving up and
// letting the cron drain handle the row. When Redis is unreachable ioredis
// *hangs* on connect rather than throwing, so a bare try/catch isn't enough —
// without this cap the operator's PATCH response blocked for the full ioredis
// connect timeout (observed as curl HTTP 000 on prod). The row is already
// persisted to OutboundSyncQueue, so timing out here is safe.
const ENQUEUE_TIMEOUT_MS = Number(process.env.NEXUS_ADS_ENQUEUE_TIMEOUT_MS ?? 1500)

async function enqueueBullMQJob(queueRowId: string, syncType: AdSyncType): Promise<void> {
  // Best-effort BullMQ enqueue. If Redis is down/slow or the queue isn't
  // initialized, the row still sits in OutboundSyncQueue and gets drained by
  // the cron fallback (drain-ads-sync). Never block or fail the operator write.
  try {
    const { adsSyncQueue } = await import('../../lib/queue.js')
    const add = adsSyncQueue
      .add(syncType, { queueId: queueRowId, syncType }, { delay: GRACE_PERIOD_MS, jobId: `ads-sync:${queueRowId}` })
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.warn('[ads-mutation] BullMQ enqueue failed (cron drain will handle)', {
          queueRowId, syncType, error: err instanceof Error ? err.message : String(err),
        })
      })
    // Cap the wait — a hung Redis connect must not stall the HTTP response.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ENQUEUE_TIMEOUT_MS))
    await Promise.race([add, timeout])
  } catch (err) {
    logger.warn('[ads-mutation] BullMQ enqueue setup failed (cron drain will handle)', {
      queueRowId, syncType, error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Update helpers ────────────────────────────────────────────────────

export interface CampaignPatch {
  name?: string
  portfolioId?: string | null
  dailyBudget?: number
  dailyBudgetCurrency?: string
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
  endDate?: Date | null
}

export async function updateCampaignWithSync(args: {
  campaignId: string
  patch: CampaignPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
}): Promise<MutationOutcome> {
  const existing = await prisma.campaign.findUnique({
    where: { id: args.campaignId },
    select: {
      id: true,
      name: true,
      portfolioId: true,
      externalCampaignId: true,
      marketplace: true,
      dailyBudget: true,
      dailyBudgetCurrency: true,
      status: true,
      biddingStrategy: true,
      endDate: true,
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }

  // Diff: only audit fields the patch actually changes.
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BUDGET_UPDATE'
  if (args.patch.name != null && args.patch.name !== existing.name) {
    changes.push({
      field: 'name',
      oldValue: existing.name,
      newValue: args.patch.name,
    })
    syncType = 'AD_CAMPAIGN_NAME_UPDATE'
  }
  if (args.patch.portfolioId !== undefined && (args.patch.portfolioId ?? null) !== (existing.portfolioId ?? null)) {
    changes.push({
      field: 'portfolioId',
      oldValue: existing.portfolioId ?? null,
      newValue: args.patch.portfolioId ?? null,
    })
    syncType = 'AD_CAMPAIGN_PORTFOLIO_UPDATE'
  }
  if (args.patch.dailyBudget != null && Number(existing.dailyBudget) !== args.patch.dailyBudget) {
    changes.push({
      field: 'dailyBudget',
      oldValue: String(existing.dailyBudget),
      newValue: String(args.patch.dailyBudget),
    })
    syncType = 'AD_BUDGET_UPDATE'
  }
  if (args.patch.dailyBudgetCurrency && args.patch.dailyBudgetCurrency !== existing.dailyBudgetCurrency) {
    changes.push({
      field: 'dailyBudgetCurrency',
      oldValue: existing.dailyBudgetCurrency,
      newValue: args.patch.dailyBudgetCurrency,
    })
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (args.patch.biddingStrategy && args.patch.biddingStrategy !== existing.biddingStrategy) {
    changes.push({
      field: 'biddingStrategy',
      oldValue: existing.biddingStrategy,
      newValue: args.patch.biddingStrategy,
    })
    syncType = 'AD_BIDDING_STRATEGY_UPDATE'
  }
  if (args.patch.endDate !== undefined && args.patch.endDate?.toISOString() !== existing.endDate?.toISOString()) {
    changes.push({
      field: 'endDate',
      oldValue: existing.endDate?.toISOString() ?? null,
      newValue: args.patch.endDate?.toISOString() ?? null,
    })
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }

  // Capture payloadBefore snapshot BEFORE we write to local row.
  const payloadBefore = {
    name: existing.name,
    portfolioId: existing.portfolioId,
    dailyBudget: Number(existing.dailyBudget),
    dailyBudgetCurrency: existing.dailyBudgetCurrency,
    status: existing.status,
    biddingStrategy: existing.biddingStrategy,
    endDate: existing.endDate?.toISOString() ?? null,
  }

  // Local write
  const data: Record<string, unknown> = {}
  if (args.patch.name != null) data.name = args.patch.name
  if (args.patch.portfolioId !== undefined) data.portfolioId = args.patch.portfolioId
  if (args.patch.dailyBudget != null) data.dailyBudget = args.patch.dailyBudget
  if (args.patch.dailyBudgetCurrency) data.dailyBudgetCurrency = args.patch.dailyBudgetCurrency
  if (args.patch.status) data.status = args.patch.status
  if (args.patch.biddingStrategy) data.biddingStrategy = args.patch.biddingStrategy
  if (args.patch.endDate !== undefined) data.endDate = args.patch.endDate
  await prisma.campaign.update({ where: { id: args.campaignId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    externalId: existing.externalCampaignId,
    syncType,
    marketplace: existing.marketplace,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    campaignId: args.campaignId,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.name != null ? { name: args.patch.name } : {}),
    ...(args.patch.portfolioId !== undefined ? { portfolioId: args.patch.portfolioId } : {}),
    ...(args.patch.dailyBudget != null ? { dailyBudget: args.patch.dailyBudget } : {}),
    ...(args.patch.dailyBudgetCurrency ? { dailyBudgetCurrency: args.patch.dailyBudgetCurrency } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
    ...(args.patch.biddingStrategy ? { biddingStrategy: args.patch.biddingStrategy } : {}),
    ...(args.patch.endDate !== undefined ? { endDate: args.patch.endDate?.toISOString() ?? null } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: syncType,
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)

  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

export interface AdGroupPatch {
  defaultBidCents?: number
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
}

export async function updateAdGroupWithSync(args: {
  adGroupId: string
  patch: AdGroupPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  force?: boolean // NP — bypass the 5¢ floor for deliberate bid suppression/restore
  forceResync?: boolean // WC — push to Amazon even if the local value is unchanged (one-time re-sync of stale Amazon state)
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
}): Promise<MutationOutcome> {
  const existing = await prisma.adGroup.findUnique({
    where: { id: args.adGroupId },
    select: {
      id: true,
      externalAdGroupId: true,
      defaultBidCents: true,
      status: true,
      orphanedAt: true,
      campaign: { select: { id: true, marketplace: true } },
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }
  // AX2.0 — same guard as AdTarget: Amazon says this ad group is gone, so stop
  // regenerating writes for it. `force` is the operator's re-test path.
  if (existing.orphanedAt && !args.force) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'entity_orphaned' }
  }
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BID_UPDATE'
  if (args.patch.defaultBidCents != null && (args.forceResync || args.patch.defaultBidCents !== existing.defaultBidCents)) {
    changes.push({
      field: 'defaultBid',
      oldValue: String(existing.defaultBidCents),
      newValue: String(args.patch.defaultBidCents),
    })
    syncType = 'AD_BID_UPDATE'
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }

  // Floor clamp on bid — AD.3's automation handler reuses this; same
  // safety belongs in the user path so a slip-up can't zero impressions.
  if (!args.force && args.patch.defaultBidCents != null && args.patch.defaultBidCents < 5) {
    return {
      ok: false,
      outboundQueueId: null,
      bidHistoryIds: [],
      actionLogId: null,
      error: 'bid_below_floor_5_cents',
    }
  }

  const payloadBefore = {
    defaultBidCents: existing.defaultBidCents,
    status: existing.status,
  }

  const data: Record<string, unknown> = {}
  if (args.patch.defaultBidCents != null) data.defaultBidCents = args.patch.defaultBidCents
  if (args.patch.status) data.status = args.patch.status
  await prisma.adGroup.update({ where: { id: args.adGroupId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    externalId: existing.externalAdGroupId,
    syncType,
    marketplace: existing.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    campaignId: existing.campaign?.id ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.defaultBidCents != null ? { defaultBidCents: args.patch.defaultBidCents } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: syncType,
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)
  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

// AF.5 — product ad enable/pause. Status-only (product ads carry no bid).
export async function updateProductAdWithSync(args: {
  productAdId: string
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
}): Promise<MutationOutcome> {
  const existing = await prisma.adProductAd.findUnique({
    where: { id: args.productAdId },
    select: { id: true, externalAdId: true, status: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true } } } } },
  })
  if (!existing) return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  if (args.status === existing.status) return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }

  const changes: FieldChange[] = [{ field: 'status', oldValue: existing.status, newValue: args.status }]
  await prisma.adProductAd.update({ where: { id: args.productAdId }, data: { status: args.status } })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'PRODUCT_AD',
    entityId: args.productAdId,
    externalId: existing.externalAdId,
    syncType: 'AD_ENTITY_STATE_UPDATE',
    marketplace: existing.adGroup?.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: 'AD_ENTITY_STATE_UPDATE',
    entityType: 'PRODUCT_AD',
    entityId: args.productAdId,
    payloadBefore: { status: existing.status },
    payloadAfter: { status: args.status },
    outboundQueueId,
  })
  await enqueueBullMQJob(outboundQueueId, 'AD_ENTITY_STATE_UPDATE')
  return { ok: true, outboundQueueId, bidHistoryIds: [], actionLogId, error: null }
}

export interface AdTargetPatch {
  bidCents?: number
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
}

export async function updateAdTargetWithSync(args: {
  adTargetId: string
  patch: AdTargetPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  force?: boolean // NP — bypass the change-clamp + 5¢ floor for deliberate bid suppression/restore
  forceResync?: boolean // WC — push to Amazon even if the local value is unchanged (one-time re-sync of stale Amazon state)
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
}): Promise<MutationOutcome> {
  const existing = await prisma.adTarget.findUnique({
    where: { id: args.adTargetId },
    select: {
      id: true,
      externalTargetId: true,
      bidCents: true,
      status: true,
      orphanedAt: true,
      adGroup: {
        select: { id: true, campaign: { select: { id: true, marketplace: true, dynamicBidding: true } } },
      },
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }

  // AX2.0 — Amazon has already told us this target does not exist. Enqueueing
  // again just recreates the dead write: this is the loop that produced 662
  // dead-lettered rows from 23 targets, ~23/day for 26 days. Refuse at the
  // chokepoint so EVERY caller (rank-defend, dayparting, bulk, manual) is
  // covered, and no queue row or Amazon call is generated.
  //
  // `force` is the deliberate operator override — a repair path may push to
  // re-test whether the entity is back, and a success clears orphanedAt.
  if (existing.orphanedAt && !args.force) {
    return {
      ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null,
      error: 'entity_orphaned',
    }
  }

  // Apex A.2a — clamp the requested bid to the campaign's max-change-% guardrail
  // (when set). Caps how far a single bid move (manual, bulk, or automation) can
  // swing from the current bid, so a runaway rule can't 10× a bid in one step.
  // Applied before the diff so the audit trail records the clamped value.
  if (!args.force && args.patch.bidCents != null && existing.bidCents > 0) {
    const guards = (existing.adGroup?.campaign?.dynamicBidding ?? {}) as { maxBidChangePct?: number }
    const pct = Number(guards.maxBidChangePct)
    if (Number.isFinite(pct) && pct > 0) {
      const maxUp = Math.round(existing.bidCents * (1 + pct / 100))
      const maxDown = Math.round(existing.bidCents * (1 - pct / 100))
      args.patch.bidCents = Math.max(5, Math.min(maxUp, Math.max(maxDown, args.patch.bidCents)))
    }
  }

  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BID_UPDATE'
  if (args.patch.bidCents != null && (args.forceResync || args.patch.bidCents !== existing.bidCents)) {
    changes.push({
      field: 'bid',
      oldValue: String(existing.bidCents),
      newValue: String(args.patch.bidCents),
    })
    syncType = 'AD_BID_UPDATE'
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }
  if (!args.force && args.patch.bidCents != null && args.patch.bidCents < 5) {
    return {
      ok: false,
      outboundQueueId: null,
      bidHistoryIds: [],
      actionLogId: null,
      error: 'bid_below_floor_5_cents',
    }
  }

  const payloadBefore = {
    bidCents: existing.bidCents,
    status: existing.status,
  }

  const data: Record<string, unknown> = {}
  if (args.patch.bidCents != null) data.bidCents = args.patch.bidCents
  if (args.patch.status) data.status = args.patch.status
  await prisma.adTarget.update({ where: { id: args.adTargetId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    externalId: existing.externalTargetId,
    syncType,
    marketplace: existing.adGroup?.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    campaignId: existing.adGroup?.campaign?.id ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.bidCents != null ? { bidCents: args.patch.bidCents } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: syncType,
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)
  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

// ── Bulk target bid update ─────────────────────────────────────────────

export interface BulkBidEntry {
  adTargetId: string
  bidCents: number
}

export interface BulkBidOutcome {
  applied: number
  skipped: number
  failed: number
  outcomes: MutationOutcome[]
  chunks: number
}

// Amazon Ads bulk endpoints limit ~1k entities per call. We chunk
// here so a single operator action (e.g. "bid +20% on 4k keywords")
// translates into 4 sequential OutboundSyncQueue rows + 4 BullMQ
// jobs rather than a single oversized payload.
const AMAZON_BULK_CHUNK = 1000

export async function bulkUpdateAdTargetBids(args: {
  entries: BulkBidEntry[]
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
}): Promise<BulkBidOutcome> {
  const out: BulkBidOutcome = {
    applied: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    chunks: 0,
  }
  for (let i = 0; i < args.entries.length; i += AMAZON_BULK_CHUNK) {
    const chunk = args.entries.slice(i, i + AMAZON_BULK_CHUNK)
    out.chunks += 1
    for (const entry of chunk) {
      const outcome = await updateAdTargetWithSync({
        adTargetId: entry.adTargetId,
        patch: { bidCents: entry.bidCents },
        actor: args.actor,
        reason: args.reason ?? null,
        applyImmediately: args.applyImmediately ?? false,
      })
      out.outcomes.push(outcome)
      if (outcome.ok && outcome.outboundQueueId) out.applied += 1
      else if (outcome.ok) out.skipped += 1
      else out.failed += 1
    }
  }
  return out
}

/**
 * AX-IE.2 — portfolio update, on the same rails as every other ad write.
 *
 * Rides updateOutbound → ads-write-gate → the outbox exactly like campaigns do,
 * so the live-write gate, the grace window, the audit log and the rollback path
 * all apply unchanged. A portfolio moves budget, so it must not get a private
 * path around the gate.
 *
 * State is NOT writable here: Amazon marks it "(Informational only)" on its own
 * Portfolios sheet.
 */
export interface PortfolioPatch {
  name?: string
  budgetAmount?: number
  budgetCurrencyCode?: string
  budgetPolicy?: string
  startDate?: string | null
  endDate?: string | null
}

export async function updatePortfolioWithSync(args: {
  portfolioId: string
  patch: PortfolioPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  changeSetId?: string | null
}): Promise<MutationOutcome> {
  const existing = await prisma.amazonAdsPortfolio.findUnique({ where: { id: args.portfolioId } })
  if (!existing) return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'portfolio_not_found' }

  const changes: FieldChange[] = []
  const data: Record<string, unknown> = {}
  // startDate/endDate are DateTime columns but the sheet carries YYYY-MM-DD.
  // Compare on the date part or every run reports a change it cannot settle.
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null
      : v instanceof Date ? v.toISOString().slice(0, 10)
        : String(v)
  const track = (field: string, oldValue: unknown, newValue: unknown, column: string): void => {
    if (newValue === undefined) return
    if (str(oldValue) === str(newValue)) return
    data[column] = newValue
    changes.push({ field, oldValue: str(oldValue), newValue: str(newValue) })
  }
  track('name', existing.name, args.patch.name, 'name')
  track('budgetAmount', existing.budgetAmount == null ? null : Number(existing.budgetAmount), args.patch.budgetAmount, 'budgetAmount')
  track('budgetCurrencyCode', existing.budgetCurrencyCode, args.patch.budgetCurrencyCode, 'budgetCurrencyCode')
  track('budgetPolicy', existing.budgetPolicy, args.patch.budgetPolicy, 'budgetPolicy')
  const asDate = (v: string | null | undefined): Date | undefined =>
    v === undefined ? undefined : v ? new Date(`${v}T00:00:00.000Z`) : undefined
  track('startDate', existing.startDate, asDate(args.patch.startDate), 'startDate')
  track('endDate', existing.endDate, asDate(args.patch.endDate), 'endDate')

  if (!changes.length) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: null }
  }

  const payloadBefore = {
    name: existing.name,
    budgetAmount: existing.budgetAmount == null ? null : Number(existing.budgetAmount),
    budgetCurrencyCode: existing.budgetCurrencyCode,
    budgetPolicy: existing.budgetPolicy,
    startDate: existing.startDate,
    endDate: existing.endDate,
  }

  await prisma.amazonAdsPortfolio.update({ where: { id: existing.id }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'PORTFOLIO',
    entityId: existing.id,
    externalId: existing.externalPortfolioId ?? null,
    syncType: 'AD_PORTFOLIO_UPDATE',
    // The portfolio model carries profileId, not marketplace, and the worker
    // resolves the write gate + profile from marketplace. Look it up rather
    // than leaving it null, or the write is refused as unattributable.
    marketplace: (await prisma.amazonAdsConnection.findFirst({
      where: { profileId: existing.profileId }, select: { marketplace: true },
    }))?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately === true,
  })

  const actionLogId = await writeAdvertisingActionLog({
    actor: args.actor,
    actionType: 'AD_PORTFOLIO_UPDATE',
    entityType: 'CAMPAIGN', // the audit table's enum has no PORTFOLIO member yet
    entityId: existing.id,
    payloadBefore,
    payloadAfter: { ...payloadBefore, ...data },
    outboundQueueId,
    changeSetId: args.changeSetId ?? null,
  })

  await enqueueBullMQJob(outboundQueueId, 'AD_PORTFOLIO_UPDATE')
  return { ok: true, outboundQueueId, bidHistoryIds: [], actionLogId, error: null }
}

// AD.4 hook — operator cancel within grace window. Flips
// syncStatus=CANCELLED so the BullMQ worker sees it and skips.
export async function cancelPendingMutation(outboundQueueId: string): Promise<{ ok: boolean; error: string | null }> {
  const row = await prisma.outboundSyncQueue.findUnique({
    where: { id: outboundQueueId },
    select: { id: true, syncStatus: true, holdUntil: true },
  })
  if (!row) return { ok: false, error: 'not_found' }
  if (row.syncStatus !== 'PENDING') return { ok: false, error: `not_pending:${row.syncStatus}` }
  if (row.holdUntil && row.holdUntil <= new Date()) {
    return { ok: false, error: 'grace_expired' }
  }
  await prisma.outboundSyncQueue.update({
    where: { id: outboundQueueId },
    data: { syncStatus: 'CANCELLED' },
  })
  // AX-ZD.1 — release the typed rows too. A cancelled intent that stayed
  // PENDING would keep suppressing drift on its fields for the full trust
  // window, which is exactly the bug this model exists to remove.
  await settleAdMutations(outboundQueueId, 'CANCELLED')
  return { ok: true, error: null }
}
