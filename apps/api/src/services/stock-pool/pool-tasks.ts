import prisma from '../../db.js'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { listenUrlFrom, startWakeListener } from '../../lib/pg-wake-listener.js'
import { publishEvent } from '../../lib/events/publish.js'
import { lockProductStock } from '../stock-lock.js'
import { consumeLayersInTx } from '../cost-layers.service.js'
import { recascadeProduct } from '../stock-movement.service.js'
import { handleMovementStockoutTransition } from '../stockout-detector.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { notifyOwners } from './pool-notify.js'
import { loadSyncLedgers } from './sync-ledgers.js'
import { evaluateOversellRisk } from '../inventory-oversell-watchdog.service.js'

/**
 * Shared stock — the work queue (contract docs/2026-09-19-shared-stock-build.md §2).
 *
 * The database writes a StockPoolTask for every business whose listings must follow a pool change,
 * in the same transaction as the change (stock-pool.sql). This module does that work, always in the
 * task's OWN business context (row security shows each business only its own tasks):
 *
 *   settle    — a door wrote a movement in this (lender) business for a borrower. Finish what this
 *               business's own writers do inside applyStockMovementInTx: cost of goods for units that
 *               left, the inventory.* event, then (after commit) the stockout check and the read cache.
 *   recascade — re-work one of this business's products' listings from its ledger (loadSyncLedgers:
 *               own stock or the pool). Pool changes use the instant lane: every second a listing
 *               shows a number the pool no longer has is an oversell window.
 *
 * Who runs it: `kickStockPoolWork()` right after our own code commits a pool change, and the worker
 * (`startStockPoolWorker`: woken by the database's notify, with a poll behind it) for changes made
 * elsewhere — a lender's own sale, an import, a trigger, a sale written by the API process. A
 * task is claimed with SKIP LOCKED, so two runners never do the same task; a claim older than two
 * minutes is taken again (a runner that died). A task that FAILS is released at once (claimedAt
 * null) with a "retryAt" that grows with its attempts (retryDelayMs): a passing failure — a lock
 * timeout, a deadlock — is retried within seconds, not after the two-minute claim, and a lasting one
 * does not spin. After MAX_ATTEMPTS failures the owners are told; it keeps being retried.
 */

const CLAIM_BATCH = 500
const STALE_CLAIM = "2 minutes"
const MAX_ATTEMPTS = 10
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/**
 * How long a task waits after its `attempts`-th failure: 5 s, doubling, at most 5 minutes
 * (5 s, 10 s, 20 s, 40 s, 80 s, 160 s, then 300 s). Pure.
 */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(attempts) ? attempts : 1))
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(n - 1, 16))
}

interface ClaimedTask {
  id: string
  kind: 'recascade' | 'settle'
  productId: string
  movementId: string | null
  reason: string
  attempts: number
}

export interface StockPoolRun {
  claimed: number
  settled: number
  recascaded: number
  failed: number
}

/** Do this business's pool work. Call inside the business's context. */
export async function processStockPoolTasks(): Promise<StockPoolRun> {
  requireWorkspace()
  const run: StockPoolRun = { claimed: 0, settled: 0, recascaded: 0, failed: 0 }
  const tasks = await prisma.$queryRaw<ClaimedTask[]>(Prisma.sql`
    UPDATE "StockPoolTask" SET "claimedAt" = CURRENT_TIMESTAMP, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "StockPoolTask"
      WHERE ("claimedAt" IS NULL AND ("retryAt" IS NULL OR "retryAt" <= CURRENT_TIMESTAMP))
         OR "claimedAt" < CURRENT_TIMESTAMP - ${STALE_CLAIM}::interval
      ORDER BY "createdAt", id
      LIMIT ${CLAIM_BATCH}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, "productId", "movementId", reason, attempts`)
  run.claimed = tasks.length
  if (tasks.length === 0) return run

  const done: string[] = []
  const failures: Array<{ task: ClaimedTask; error: string }> = []

  // 1. Settle first: its movement changed this business's numbers, which the recascade then reads.
  for (const task of tasks.filter((t) => t.kind === 'settle')) {
    try {
      await settlePoolMovement(task.movementId!)
      run.settled++
      done.push(task.id)
    } catch (error) {
      failures.push({ task, error: messageOf(error) })
    }
  }

  // 2. One recascade per product, whatever number of tasks named it (a settle names its product too).
  const byProduct = new Map<string, ClaimedTask[]>()
  for (const task of tasks) {
    if (task.kind === 'settle' && !done.includes(task.id)) continue // its settle failed: retry both later
    byProduct.set(task.productId, [...(byProduct.get(task.productId) ?? []), task])
  }
  for (const [productId, group] of byProduct) {
    try {
      const reasons = [...new Set(group.map((t) => t.reason))].sort().join(',')
      const result = await recascadeProduct(productId, {
        reason: 'ORDER_PLACED', // the instant lane: 0 hold, priority dispatch
        referenceType: 'STOCK_POOL',
        referenceId: reasons,
        actor: 'system:stock-pool',
      })
      if (!result.ok) throw new Error(`recascade refused: ${'reason' in result ? result.reason : 'unknown'}`)
      run.recascaded++
      await watchPoolOversell(productId)
      for (const t of group) if (t.kind === 'recascade') done.push(t.id)
    } catch (error) {
      for (const t of group) if (t.kind === 'recascade') failures.push({ task: t, error: messageOf(error) })
    }
  }

  if (done.length > 0) await prisma.$executeRaw(Prisma.sql`DELETE FROM "StockPoolTask" WHERE id = ANY(${done}::text[])`)
  for (const { task, error } of failures) {
    run.failed++
    // Released now, due again after its back-off (stock-pool.sql's nexus_pool_pending_workspaces reads the same columns).
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "StockPoolTask" SET "lastError" = ${error.slice(0, 500)}, "claimedAt" = NULL,
        "retryAt" = CURRENT_TIMESTAMP + ${retryDelayMs(task.attempts)}::double precision * interval '1 millisecond'
      WHERE id = ${task.id}`)
    logger.warn('[stock-pool] task failed; it will be retried', { taskId: task.id, kind: task.kind, productId: task.productId, attempts: task.attempts, retryInMs: retryDelayMs(task.attempts), error: error.slice(0, 200) })
    if (task.attempts === MAX_ATTEMPTS) {
      await notifyOwners({
        type: 'stock-pool-task-stuck',
        severity: 'danger',
        title: 'Shared stock could not update a product',
        body: `Nexus tried ${MAX_ATTEMPTS} times to update the listings of a product that uses shared stock, and failed. It keeps trying. The last error: ${error.slice(0, 200)}`,
        entityType: 'Product',
        entityId: task.productId,
        href: `/products/${encodeURIComponent(task.productId)}/edit`,
        meta: { taskId: task.id, kind: task.kind, reason: task.reason },
      })
    }
  }
  return run
}

interface PoolMovementRow {
  id: string
  productId: string
  locationId: string | null
  change: number
  quantityBefore: number | null
  balanceAfter: number
  reason: string
  reservationId: string | null
  poolSettledAt: Date | null
}

/**
 * A door's movement, finished in the lender's own context. Idempotent: a settled movement is left
 * alone. The numbers in the event are the movement's own (before, after, change); `available` is
 * read now, under the product lock — a door does not record it.
 */
export async function settlePoolMovement(movementId: string): Promise<void> {
  const settled = await prisma.$transaction(async (tx) => {
    const head = await tx.stockMovement.findUnique({ where: { id: movementId }, select: { productId: true } })
    if (!head) return null // the movement is not this business's, or it is gone: nothing to finish
    await lockProductStock(tx, [head.productId])
    const [m] = await tx.$queryRaw<PoolMovementRow[]>(Prisma.sql`
      SELECT id, "productId", "locationId", change, "quantityBefore", "balanceAfter", reason::text AS reason, "reservationId", "poolSettledAt"
      FROM "StockMovement" WHERE id = ${movementId} FOR UPDATE`)
    if (!m || m.poolSettledAt) return null

    const level = m.locationId
      ? await tx.stockLevel.findFirst({ where: { productId: m.productId, locationId: m.locationId, variationId: null }, select: { available: true } })
      : null
    const product = await tx.product.findUnique({ where: { id: m.productId }, select: { totalStock: true, sku: true } })
    const reservation = m.reservationId
      ? await tx.stockReservation.findUnique({ where: { id: m.reservationId }, select: { quantity: true, kind: true } })
      : null
    const available = level?.available ?? 0
    let cogsCents: number | null = null

    // Units that left: cost of goods, exactly as applyStockMovementInTx does for its CONSUME_REASONS.
    if (m.change < 0 && (m.reason === 'ORDER_PLACED' || m.reason === 'RESERVATION_CONSUMED')) {
      try {
        cogsCents = (await consumeLayersInTx(tx, { productId: m.productId, units: -m.change })).cogsCents
      } catch (error) {
        logger.warn('[stock-pool] cost-layer consume failed (continuing without COGS)', { movementId, error: messageOf(error) })
      }
    }

    if (m.change !== 0 && m.locationId) {
      await publishEvent(tx, 'inventory.stock_changed', {
        productId: m.productId,
        locationId: m.locationId,
        movementId: m.id,
        change: m.change,
        quantityBefore: m.quantityBefore ?? m.balanceAfter - m.change,
        quantityAfter: m.balanceAfter,
        available,
        poolTotal: product?.totalStock ?? 0,
        reason: m.reason,
        orderId: null,
      })
    }
    if (m.reason === 'RESERVATION_CREATED' && m.reservationId && m.locationId && reservation) {
      await publishEvent(tx, 'inventory.reserved', {
        productId: m.productId, reservationId: m.reservationId, locationId: m.locationId,
        quantity: reservation.quantity, kind: reservation.kind === 'SOFT' ? 'SOFT' : 'HARD', availableAfter: available, orderId: null,
      })
    } else if (m.reason === 'RESERVATION_RELEASED' && m.reservationId && reservation) {
      await publishEvent(tx, 'inventory.reservation_released', {
        productId: m.productId, reservationId: m.reservationId, quantity: reservation.quantity,
        kind: reservation.kind === 'SOFT' ? 'SOFT' : 'HARD', availableAfter: available, reason: 'shared stock: given back',
      })
    } else if (m.reason === 'RESERVATION_CONSUMED' && m.reservationId && reservation) {
      await publishEvent(tx, 'inventory.reservation_consumed', {
        productId: m.productId, reservationId: m.reservationId, quantity: reservation.quantity,
        kind: reservation.kind === 'SOFT' ? 'SOFT' : 'HARD', orderId: null,
      })
    }

    await tx.$executeRaw(Prisma.sql`UPDATE "StockMovement" SET "poolSettledAt" = CURRENT_TIMESTAMP, "cogsCents" = COALESCE(${cogsCents}::int, "cogsCents") WHERE id = ${m.id}`)
    return { m, sku: product?.sku ?? null, available }
  })
  if (!settled) return

  // After commit, as afterStockMovementCommit: the stockout check and the product list's read cache.
  const { m, sku, available } = settled
  if (m.change !== 0 && sku && m.locationId) {
    try {
      await handleMovementStockoutTransition({ productId: m.productId, sku, locationId: m.locationId, prevAvailable: available - m.change, nextAvailable: available })
    } catch (error) {
      logger.warn('[stock-pool] stockout hook failed', { movementId, error: messageOf(error) })
    }
  }
  void productReadCacheService.refresh(m.productId).catch((error) =>
    logger.warn('[stock-pool] read-cache refresh failed (reconcile cron will heal)', { productId: m.productId, error: messageOf(error) }))
}

/**
 * The oversell watchdog, for a product that sells from a pool. The watchdog listens to this business's
 * own stock events, and a pool changes in ANOTHER business — so after each pool recascade it asks here:
 * does any single listing (a fixed number, a paused one) promise more than the pool holds? Same rule
 * and same event as inventory-oversell-watchdog.service.ts; one report per distinct state.
 */
async function watchPoolOversell(productId: string): Promise<void> {
  try {
    const ledger = (await loadSyncLedgers(prisma, [productId])).get(productId)
    if (ledger?.source.kind !== 'pool') return
    const assessment = await evaluateOversellRisk(productId, ledger.quantity)
    if (!assessment) return
    // One report per distinct state: the event's causation id must be a UUID, so derive one (v5-style)
    // from the product, the pool and the largest promise.
    const causationId = stateUuid(`stock-pool:${productId}:${ledger.quantity}:${assessment.maxChannelCommitment}`)
    const reported = await prisma.eventOutbox.findFirst({ where: { type: 'inventory.oversell_risk_detected', causationId }, select: { id: true } })
    if (reported) return
    await publishEvent(prisma, 'inventory.oversell_risk_detected', assessment, { causationId })
    logger.warn('[stock-pool] a listing promises more than the shared pool holds', { productId, excessUnits: assessment.excessUnits })
  } catch (error) {
    logger.warn('[stock-pool] oversell check failed', { productId, error: messageOf(error) })
  }
}

// ── Who runs it ──────────────────────────────────────────────────────────────────────────────

/**
 * Businesses with pool work waiting. The database answers only a caller with NO business context, so
 * this runs in the empty (system) context even when a request's context is active around the kick:
 * an empty workspace id reaches the database as no business at all.
 */
async function pendingWorkspaces(): Promise<string[]> {
  const rows = await withWorkspace({ workspaceId: '', actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    prisma.$queryRaw<Array<{ workspace_id: string }>>(Prisma.sql`SELECT workspace_id FROM nexus_pool_pending_workspaces()`))
  return rows.map((r) => r.workspace_id)
}

let running: Promise<number> | null = null
let again = false

/** Process every business's waiting pool work now. Coalesces: a kick during a run schedules one more run. */
export function kickStockPoolWork(): Promise<number> {
  if (running) { again = true; return running }
  running = (async () => {
    let total = 0
    do {
      again = false
      for (const workspaceId of await pendingWorkspaces()) {
        const result = await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, () => processStockPoolTasks())
        total += result.claimed
      }
    } while (again)
    return total
  })().catch((error) => {
    logger.warn('[stock-pool] run failed', { error: messageOf(error) })
    return 0
  }).finally(() => { running = null })
  return running
}

/** Fire-and-forget after a commit that changed a pool. Never throws, never blocks the caller. */
export function afterPoolChange(): void {
  if (process.env.NEXUS_PROCESS_ROLE === 'api' || process.env.NEXUS_PROCESS_ROLE === 'scheduler') return
  void kickStockPoolWork()
}

/** The channel stock-pool.sql's nexus_stock_pool_task_wake notifies on every write that queues pool work. */
export const POOL_WAKE_CHANNEL = 'nexus_stock_pool'

export interface StockPoolWorkerOptions {
  /** The connection to LISTEN on. Default listenUrlFrom(process.env). null: poll only. */
  listenUrl?: string | null
}

/**
 * The worker. LISTENs for the database's wake signal (POOL_WAKE_CHANNEL, sent at the commit of every
 * write that queues pool work, whichever process wrote it — the API process does not kick, see
 * afterPoolChange), and runs at once: a sale reaches the other business's listings in about a second
 * (Owner 2026-10-01: "in real time"). The poll stays as the backstop for a lost connection: every 2 s
 * while there was work in the last minute, 10 s when quiet. Our own commits also kick it directly
 * (afterStockMovementCommit, afterPoolChange).
 */
export function startStockPoolWorker(options: StockPoolWorkerOptions = {}): () => Promise<void> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastWorkAt = 0
  const stopListening = startWakeListener({
    channel: POOL_WAKE_CHANNEL,
    url: options.listenUrl === undefined ? listenUrlFrom(process.env) : options.listenUrl,
    label: 'stock-pool',
    wake: () => { if (!stopped) void kickStockPoolWork().then((found) => { if (found > 0) lastWorkAt = Date.now() }) },
  })
  const tick = async () => {
    if (stopped) return
    const found = await kickStockPoolWork()
    if (stopped) return
    if (found > 0) lastWorkAt = Date.now()
    const busy = Date.now() - lastWorkAt < 60_000
    timer = setTimeout(tick, busy ? 2_000 : 10_000)
    timer.unref?.()
  }
  timer = setTimeout(tick, 5_000)
  timer.unref?.()
  return async () => { stopped = true; if (timer) clearTimeout(timer); await stopListening(); await running }
}

function stateUuid(text: string): string {
  const h = createHash('sha1').update(text).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
