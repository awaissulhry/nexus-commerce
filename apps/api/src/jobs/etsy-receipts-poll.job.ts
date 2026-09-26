/**
 * CX Etsy E5/E6 — poll each connected Etsy shop's receipts into the shared writer, and say how
 * fresh they are.
 *
 * 🔴 OFF by default, twice over. The schedule starts only with
 * `NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON=1` (index.ts), and a run — scheduled or "Run now" —
 * writes nothing unless `NEXUS_ENABLE_ETSY_ORDER_INGEST=1`.
 *
 * One run, per active Etsy account of the business being visited:
 *   • T0 must already exist from explicit activation (receipts created before it are skipped);
 *   • a LEASE on the account's ingest row means two runs never overlap, and every cursor move is
 *     fenced by it;
 *   • one recent-update page handles new orders promptly; remaining pages reconcile a fixed,
 *     closed creation window from T0, ordered by receipt_id (updates cannot change membership);
 *   • capped runs resume that window; after completion the next run reconciles from T0 again.
 *     Changed counts restart the window. Failures keep its page, never abandon an old bucket;
 *   • the outcome is stamped on the ingest row and the connection (lastSyncAt / lastSyncStatus /
 *     lastSyncError, by the database clock), and a stale account tells its owners (the bell).
 */
import { randomUUID } from 'node:crypto'
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { ETSY_MAX_OFFSET, ETSY_RECEIPTS_PAGE, pullEtsyReceiptsPage } from '../services/etsy/receipts.service.js'
import {
  etsyIngestBinding, etsyOrderIngestEnabled, etsyReceiptFreshness, ingestEtsyReceipt, receiptIdentity,
} from '../services/etsy/receipt-ingest.js'

const JOB = 'etsy-receipts-poll'
/** Extra overlap beyond one configured poll interval for the recent fast path. */
export const ETSY_POLL_OVERLAP_SECONDS = 600
export const ETSY_POLL_PAGE_CAP = 20
const LEASE_MINUTES = 15

export const etsyPollIntervalMinutes = (): number => {
  const n = Number(process.env.NEXUS_ETSY_RECEIPTS_POLL_MINUTES ?? '10')
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 10
}

export interface EtsyPollCounts {
  pages: number; recentPages: number; reconciliationPages: number; fetched: number; written: number; created: number; stale: number
  skippedBeforeActivation: number; refused: number; alreadyRead: number
}

export interface EtsyPollOutcome {
  connectionId: string
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED'
  reason?: string
  backlog: boolean
  counts: EtsyPollCounts
  error: string | null
}

/** One account, one run. Exported for the tests and for "Run now". */
export async function pollEtsyConnection(connectionId: string, options: { pageCap?: number } = {}): Promise<EtsyPollOutcome> {
  const counts: EtsyPollCounts = { pages: 0, recentPages: 0, reconciliationPages: 0, fetched: 0, written: 0, created: 0, stale: 0, skippedBeforeActivation: 0, refused: 0, alreadyRead: 0 }
  const token = randomUUID()
  const claimed = await prisma.$queryRaw<Array<{ activatedAt: Date; scanCreatedThrough: Date | null; scanExpectedCount: number | null; scanOffset: number; lastPollCounts: { recentPages?: number } | null; now: Date }>>`
    UPDATE "EtsyReceiptIngest"
       SET "leaseToken" = ${token}, "leaseUntil" = clock_timestamp() + make_interval(mins => ${LEASE_MINUTES}),
           "lastPollStartedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
     WHERE "connectionId" = ${connectionId} AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp())
    RETURNING "activatedAt", "scanCreatedThrough", "scanExpectedCount", "scanOffset", "lastPollCounts", clock_timestamp() AS now`
  if (claimed.length === 0) {
    const [active] = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "EtsyReceiptIngest" WHERE "connectionId" = ${connectionId}`
    return { connectionId, status: 'SKIPPED', reason: active ? 'another run holds this account' : 'not_activated', backlog: false, counts, error: null }
  }
  const [state] = claimed

  let status: EtsyPollOutcome['status'] = 'SUCCESS'
  let backlog = true
  let error: string | null = null
  try {
    const binding = await etsyIngestBinding(connectionId)
    const t0 = Math.floor(state.activatedAt.getTime() / 1000)
    const now = Math.floor(state.now.getTime() / 1000)
    // One fixed, closed creation horizon: updates cannot remove a member or move its receipt ID.
    const through = state.scanCreatedThrough ? Math.floor(state.scanCreatedThrough.getTime() / 1000) : now - 1
    let offset = state.scanCreatedThrough ? state.scanOffset : 0
    let expectedCount = state.scanCreatedThrough ? state.scanExpectedCount : null
    const pageCap = options.pageCap ?? ETSY_POLL_PAGE_CAP
    if (!Number.isSafeInteger(pageCap) || pageCap < 1 || pageCap > ETSY_POLL_PAGE_CAP) throw new Error(`pageCap must be 1..${ETSY_POLL_PAGE_CAP}.`)
    const checkpoint = async (finished = false) => {
      const moved = await prisma.$executeRaw`
        UPDATE "EtsyReceiptIngest" SET "scanCreatedThrough" = CASE WHEN ${finished} THEN NULL ELSE to_timestamp(${through}) END,
               "scanExpectedCount" = ${finished ? null : expectedCount}, "scanOffset" = ${finished ? 0 : offset}, "updatedAt" = clock_timestamp()
         WHERE "connectionId" = ${connectionId} AND "leaseToken" = ${token} AND "leaseUntil" > clock_timestamp()`
      if (moved !== 1) throw new Error('This run lost its lease on the account; it stopped rather than move the cursor.')
    }
    const ingestPage = async (results: unknown[]) => {
      for (const raw of results) {
        const identity = receiptIdentity(raw)
        const outcome = await ingestEtsyReceipt({ connectionId, raw, binding, source: 'poll' })
        if (outcome.kind === 'refused') throw new Error(`[${outcome.code}] ${outcome.message}`)
        if (outcome.kind === 'receipt_refused') counts.refused++
        else if (outcome.kind === 'written') { counts.written++; if (outcome.created) counts.created++ }
        else if (outcome.kind === 'stale') counts.stale++
        else if (outcome.kind === 'skipped') counts.skippedBeforeActivation++
        if (identity.receiptId !== 'unknown' && identity.updatedAt !== null) {
          // Diagnostic only: neither this timestamp nor this ID advances reconciliation.
          const moved = await prisma.$executeRaw`
            UPDATE "EtsyReceiptIngest" SET "cursorUpdatedAt" = GREATEST("cursorUpdatedAt", to_timestamp(${identity.updatedAt})), "cursorReceiptId" = ${identity.receiptId}, "updatedAt" = clock_timestamp()
             WHERE "connectionId" = ${connectionId} AND "leaseToken" = ${token} AND "leaseUntil" > clock_timestamp()`
          if (moved !== 1) throw new Error('This run lost its lease on the account; it stopped rather than move the cursor.')
        }
      }
    }
    if (through >= t0) await checkpoint()
    // With a single-page cap, alternate; otherwise one recent page and the rest reconciliation.
    const readRecent = pageCap > 1 || state.lastPollCounts?.recentPages !== 1
    if (readRecent) {
      const page = await pullEtsyReceiptsPage(connectionId, { minCreated: t0, minLastModified: Math.max(t0, now - (etsyPollIntervalMinutes() * 60 + ETSY_POLL_OVERLAP_SECONDS)), offset: 0 })
      counts.pages++; counts.recentPages++; counts.fetched += page.results.length
      await ingestPage(page.results)
    }
    while (counts.pages < pageCap && through >= t0) {
      if (offset > ETSY_MAX_OFFSET) throw new Error('Etsy reconciliation reached its offset limit; the creation window remains held for recovery.')
      const page = await pullEtsyReceiptsPage(connectionId, { minCreated: t0, maxCreated: through, offset })
      counts.pages++; counts.reconciliationPages++; counts.fetched += page.results.length
      // Late publication/deletion can still change membership. Never reuse that offset if the
      // provider reports a different count; replay the window. No snapshot guarantee is claimed.
      if (expectedCount !== null && page.count !== expectedCount && offset > 0) {
        offset = 0; expectedCount = page.count
        await checkpoint()
        continue
      }
      expectedCount = page.count
      await checkpoint() // A failing receipt retains this whole page for replay.
      await ingestPage(page.results)
      offset += page.results.length
      if (page.results.length < ETSY_RECEIPTS_PAGE) {
        if (offset !== expectedCount) throw new Error('Etsy reconciliation page/count disagreed; the creation window remains held for recovery.')
        await checkpoint(true)
        backlog = false
        break
      }
      await checkpoint()
    }
    if (backlog || counts.refused > 0) status = 'PARTIAL'
  } catch (caught) {
    status = 'FAILED'
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 500)
  }

  const succeeded = status !== 'FAILED' && !backlog
  await prisma.$executeRaw`
    UPDATE "EtsyReceiptIngest"
       SET "leaseToken" = NULL, "leaseUntil" = NULL, "lastPollStatus" = ${status}, "lastPollError" = ${error},
           "backlog" = ${backlog}, "lastPollCounts" = ${JSON.stringify(counts)}::jsonb,
           "lastPollSucceededAt" = CASE WHEN ${succeeded} THEN clock_timestamp() ELSE "lastPollSucceededAt" END,
           "updatedAt" = clock_timestamp()
     WHERE "connectionId" = ${connectionId} AND "leaseToken" = ${token}`
  const syncError = error ?? (backlog ? 'More receipts are waiting than one run reads.' : counts.refused > 0 ? `${counts.refused} receipt(s) refused.` : null)
  await prisma.$executeRaw`
    UPDATE "ChannelConnection" SET "lastSyncAt" = clock_timestamp(), "lastSyncStatus" = ${status}, "lastSyncError" = ${syncError}
     WHERE id = ${connectionId}`.catch((e: unknown) => logger.warn(`${JOB}: could not stamp the connection`, { connectionId, error: e instanceof Error ? e.message : String(e) }))
  return { connectionId, status, backlog, counts, error }
}

/** E6 — an account whose orders are not known to be current tells its owners. */
async function alertIfStale(connectionId: string): Promise<void> {
  const [row] = await prisma.$queryRaw<Array<{ activatedAt: Date; lastPollSucceededAt: Date | null; backlog: boolean; now: Date }>>`
    SELECT "activatedAt", "lastPollSucceededAt", backlog, clock_timestamp() AS now FROM "EtsyReceiptIngest" WHERE "connectionId" = ${connectionId}`
  const freshness = etsyReceiptFreshness(row ?? null, row?.now ?? new Date(), etsyPollIntervalMinutes() * 60_000)
  if (freshness.status !== 'stale' && freshness.status !== 'never') return
  // A run that has not succeeded YET, still inside its first two periods, is not stale.
  if (freshness.status === 'never' && row && row.now.getTime() - row.activatedAt.getTime() <= 2 * etsyPollIntervalMinutes() * 60_000) return
  const { notifyOwners } = await import('../services/stock-pool/pool-notify.js')
  await notifyOwners({
    type: 'etsy-receipts-stale', severity: 'danger',
    title: 'Etsy orders may be missing',
    body: `Nexus cannot confirm this Etsy account's orders are current: ${freshness.reasons.join('; ')}.`,
    entityType: 'ChannelConnection', entityId: connectionId, href: '/settings/channels',
    meta: { reasons: freshness.reasons },
  })
}

export interface EtsyPollReport { enabled: boolean; accounts: EtsyPollOutcome[] }

/** Every active Etsy account of the business being visited. */
export async function pollEtsyReceipts(options: { pageCap?: number } = {}): Promise<EtsyPollReport> {
  if (!etsyOrderIngestEnabled()) return { enabled: false, accounts: [] }
  const { listActiveConnections } = await import('../services/connection-resolver.service.js')
  const accounts: EtsyPollOutcome[] = []
  for (const connection of await listActiveConnections('ETSY')) {
    try {
      accounts.push(await pollEtsyConnection(connection.id, options))
    } catch (error) {
      accounts.push({ connectionId: connection.id, status: 'FAILED', backlog: false, error: error instanceof Error ? error.message : String(error),
        counts: { pages: 0, recentPages: 0, reconciliationPages: 0, fetched: 0, written: 0, created: 0, stale: 0, skippedBeforeActivation: 0, refused: 0, alreadyRead: 0 } })
    }
    await alertIfStale(connection.id).catch((error) => logger.warn(`${JOB}: freshness check failed`, { connectionId: connection.id, error: error instanceof Error ? error.message : String(error) }))
  }
  return { enabled: true, accounts }
}

export async function runEtsyReceiptsPoll(): Promise<EtsyPollReport> {
  let report: EtsyPollReport = { enabled: false, accounts: [] }
  await recordCronRun(JOB, async () => {
    report = await pollEtsyReceipts()
    if (!report.enabled) return { summary: 'Etsy order ingest is off (NEXUS_ENABLE_ETSY_ORDER_INGEST); nothing was read or written.' }
    const by = (s: string) => report.accounts.filter((a) => a.status === s).length
    const total = (k: keyof EtsyPollCounts) => report.accounts.reduce((sum, a) => sum + a.counts[k], 0)
    return { summary: `${report.accounts.length} account(s): ${by('SUCCESS')} ok, ${by('PARTIAL')} partial, ${by('FAILED')} failed, ${by('SKIPPED')} skipped; ${total('fetched')} read, ${total('written')} written (${total('created')} new), ${total('refused')} refused, ${total('skippedBeforeActivation')} before activation` }
  })
  return report
}

let scheduledTask: { stop: () => void } | null = null

/** Started by index.ts ONLY when NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON=1. */
export function startEtsyReceiptsPollCron(): void {
  if (scheduledTask) {
    logger.warn(`${JOB} cron already started — skipping`)
    return
  }
  const schedule = `*/${etsyPollIntervalMinutes()} * * * *`
  if (!cron.validate(schedule)) {
    logger.error(`${JOB} cron: invalid schedule, not starting`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => { await runEtsyReceiptsPoll() })
  logger.info(`${JOB} cron: scheduled`, { schedule })
}

export function stopEtsyReceiptsPollCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
