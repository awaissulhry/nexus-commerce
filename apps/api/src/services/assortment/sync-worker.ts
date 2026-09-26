/**
 * AE.4 — who runs the live sync, and the follower's own controls over it (contract
 * docs/2026-09-19-shared-stock-build.md §6.1).
 *
 * The capture trigger writes a pending AssortmentChange in the OWNER's transaction and calls
 * pg_notify('nexus_assortment_sync', <follower>). This module:
 *
 *   processAssortmentChanges  claims this business's pending changes (SKIP LOCKED; one claim per link at
 *                             a time; a claim older than 10 minutes is taken again) and syncs each link.
 *                             A failure is retried after 1, 2, 4 … 60 minutes; after MAX_ATTEMPTS the
 *                             change is marked failed and the owners are told which product and why.
 *   startAssortmentSyncWorker LISTENs for the notify on a direct connection, with a poll behind it:
 *                             every 2 s after work, backing off to 60 s when quiet (research §12.6: a
 *                             fixed 1 s poll cost 86,400 queries a day).
 *   queueLinks / queueStaleLinks / followAgain  the follower's own notes: a resync of a share, the
 *                             nightly repair, and "Follow again" on a field it had kept.
 */
import { Client } from 'pg'
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { notifyOwners } from '../stock-pool/pool-notify.js'
import { createWorkspaceService } from '../workspace.service.js'
import { FOLLOW_AGAIN, readState, type AppliedState } from './sync-fields.js'
import { MEDIA_KEY, syncLink } from './sync.service.js'

const CLAIM_BATCH = 50
const STALE_CLAIM = '10 minutes'
/**
 * Families synced at the same time. A sync is mostly database round trips: one at a time, a bulk edit of
 * 200 products drained at 7.2 products/s (build doc §6.4). Variations of ONE parent run one after another
 * — their writes meet on the family's readiness rows, and in parallel they collided (measured: write
 * conflicts in readinessIndex, then a one-minute retry). NEXUS_ASSORTMENT_SYNC_CONCURRENCY overrides it (1–16).
 */
const CONCURRENCY = Math.min(16, Math.max(1, Number(process.env.NEXUS_ASSORTMENT_SYNC_CONCURRENCY ?? 4) || 4))
export const MAX_ATTEMPTS = 8
export const SYNC_CHANNEL = 'nexus_assortment_sync'

interface Claimed { id: string; linkId: string; attempts: number }

export interface SyncRun {
  claimed: number
  synced: number
  unchanged: number
  detached: number
  skipped: number
  retried: number
  failed: number
}

const retryDelayMinutes = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1))

/** Sync this business's waiting links. Call inside the business's context. */
export async function processAssortmentChanges(): Promise<SyncRun> {
  requireWorkspace()
  const run: SyncRun = { claimed: 0, synced: 0, unchanged: 0, detached: 0, skipped: 0, retried: 0, failed: 0 }
  const claimed = await prisma.$queryRaw<Claimed[]>(Prisma.sql`
    UPDATE "AssortmentChange" SET state = 'claimed', "claimedAt" = CURRENT_TIMESTAMP, attempts = attempts + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT c.id FROM "AssortmentChange" c
      WHERE ((c.state = 'pending' AND c."availableAt" <= CURRENT_TIMESTAMP)
          OR (c.state = 'claimed' AND c."claimedAt" < CURRENT_TIMESTAMP - ${STALE_CLAIM}::interval))
        AND NOT EXISTS (
          SELECT 1 FROM "AssortmentChange" o
          WHERE o."linkId" = c."linkId" AND o.id <> c.id AND o.state = 'claimed' AND o."claimedAt" >= CURRENT_TIMESTAMP - ${STALE_CLAIM}::interval)
      ORDER BY c."availableAt", c.id
      LIMIT ${CLAIM_BATCH}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, "linkId", attempts`)
  run.claimed = claimed.length
  const byLink = new Map<string, Claimed[]>()
  for (const change of claimed) byLink.set(change.linkId, [...(byLink.get(change.linkId) ?? []), change])

  // One lane per family at a time: the follower product's parent, or the product itself.
  const links = byLink.size ? await prisma.catalogLink.findMany({ where: { id: { in: [...byLink.keys()] } }, select: { id: true, targetProductId: true } }) : []
  const products = links.length ? await prisma.product.findMany({ where: { id: { in: links.map((l) => l.targetProductId) } }, select: { id: true, parentId: true } }) : []
  const rootOf = new Map(products.map((p) => [p.id, p.parentId ?? p.id]))
  const families = new Map<string, Array<[string, Claimed[]]>>()
  for (const [linkId, changes] of byLink) {
    const target = links.find((l) => l.id === linkId)?.targetProductId
    const root = (target && rootOf.get(target)) ?? linkId
    families.set(root, [...(families.get(root) ?? []), [linkId, changes]])
  }
  const queue = [...families.values()]
  const lanes = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let family = queue.shift(); family; family = queue.shift()) {
      for (const [linkId, changes] of family) await syncOne(linkId, changes, run)
    }
  })
  await Promise.all(lanes)
  return run
}

/** A write conflict or deadlock between two transactions: nothing is wrong with the link; try again now. */
const isWriteConflict = (error: unknown) =>
  (error as { code?: string })?.code === 'P2034' || /write conflict or a deadlock|could not serialize|deadlock detected/i.test(error instanceof Error ? error.message : String(error))

async function syncWithConflictRetry(linkId: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncLink(linkId)
    } catch (error) {
      if (attempt >= 3 || !isWriteConflict(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 150) * (attempt + 1)))
    }
  }
}

/** One link and the notes claimed for it: done, retried later, or failed after MAX_ATTEMPTS. */
async function syncOne(linkId: string, changes: Claimed[], run: SyncRun): Promise<void> {
  const ids = changes.map((change) => change.id)
  try {
    const outcome = await syncWithConflictRetry(linkId)
    if (outcome.outcome === 'synced') run.synced++
    else if (outcome.outcome === 'unchanged') run.unchanged++
    else if (outcome.outcome === 'detached') run.detached++
    else run.skipped++
    // A refused field is this run's error; otherwise the note keeps the error of its last failed try, if any.
    const refused = outcome.refused.map((r) => `${r.key}: ${r.message}`).join('\n').slice(0, 2000) || null
    await prisma.assortmentChange.updateMany({ where: { id: { in: ids } }, data: { state: 'done', doneAt: new Date(), ...(refused ? { lastError: refused } : {}) } })
    if (outcome.refused.length) await tellRefused(linkId, outcome.refused)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = Math.max(...changes.map((change) => change.attempts))
    if (attempts >= MAX_ATTEMPTS) {
      run.failed++
      await prisma.assortmentChange.updateMany({ where: { id: { in: ids } }, data: { state: 'failed', lastError: message.slice(0, 2000) } })
      await tellFailed(linkId, message)
      return
    }
    run.retried++
    // A newer note for this link already waits: it redoes this work, so these are closed.
    const newer = await prisma.assortmentChange.count({ where: { linkId, state: 'pending' } })
    const [first, ...rest] = ids
    if (rest.length || newer) await prisma.assortmentChange.updateMany({ where: { id: { in: newer ? ids : rest } }, data: { state: 'done', doneAt: new Date(), lastError: message.slice(0, 2000) } })
    if (!newer) {
      await prisma.assortmentChange.update({
        where: { id: first },
        data: { state: 'pending', availableAt: new Date(Date.now() + retryDelayMinutes(attempts) * 60_000), lastError: message.slice(0, 2000) },
      })
    }
    logger.warn('assortment-sync: a link failed; it is tried again later', { linkId, attempts, error: message.slice(0, 300) })
  }
}

async function targetOf(linkId: string) {
  const link = await prisma.catalogLink.findFirst({ where: { id: linkId }, select: { targetProductId: true } })
  if (!link) return null
  return prisma.product.findFirst({ where: { id: link.targetProductId }, select: { id: true, sku: true } })
}

async function tellFailed(linkId: string, message: string) {
  const product = await targetOf(linkId)
  await notifyOwners({
    type: 'assortment-sync-failed', severity: 'danger',
    title: `${product?.sku ?? 'A product'} stopped following its shared product`,
    body: `Its changes could not be applied after ${MAX_ATTEMPTS} tries: ${message.slice(0, 300)}`,
    entityType: 'CatalogLink', entityId: linkId, href: product ? `/products/${encodeURIComponent(product.id)}/edit` : '/settings/sharing',
  })
}

async function tellRefused(linkId: string, refused: Array<{ key: string; message: string }>) {
  const product = await targetOf(linkId)
  await notifyOwners({
    type: 'assortment-sync-refused', severity: 'warn',
    title: `${product?.sku ?? 'A product'}: some shared changes could not be applied`,
    body: refused.slice(0, 5).map((r) => `${r.key}: ${r.message}`).join(' · '),
    entityType: 'CatalogLink', entityId: linkId, href: product ? `/products/${encodeURIComponent(product.id)}/edit` : '/settings/sharing',
  })
}

// ── The follower's own notes ────────────────────────────────────────────────────────────────

/** Queue these links of this business (a resync, the repair, "Follow again"). Returns how many. */
export async function queueLinks(linkIds: string[], reason: string): Promise<number> {
  const { workspaceId } = requireWorkspace()
  if (!linkIds.length) return 0
  const links = await prisma.catalogLink.findMany({
    where: { id: { in: [...new Set(linkIds)] }, targetWorkspaceId: workspaceId, status: 'active' },
    select: { id: true, shareId: true, sourceWorkspaceId: true, targetWorkspaceId: true },
  })
  for (let offset = 0; offset < links.length; offset += 500) {
    const batch = links.slice(offset, offset + 500)
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "AssortmentChange" (id, "linkId", "shareId", "sourceWorkspaceId", "targetWorkspaceId", reasons, "updatedAt")
      SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || l.id), 1, 24), l.id, l."shareId", l."sourceWorkspaceId", l."targetWorkspaceId", ARRAY[${reason}]::text[], CURRENT_TIMESTAMP
      FROM unnest(${batch.map((link) => link.id)}::text[]) AS x(id) JOIN "CatalogLink" l ON l.id = x.id
      ON CONFLICT ("linkId") WHERE state = 'pending' DO UPDATE SET
        reasons = ARRAY(SELECT DISTINCT r FROM unnest("AssortmentChange".reasons || EXCLUDED.reasons) AS r ORDER BY r),
        "availableAt" = LEAST("AssortmentChange"."availableAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP`)
  }
  // The worker's listener wakes on this, as on a captured change (delivered when this transaction commits).
  if (links.length) await prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${SYNC_CHANNEL}, ${workspaceId})`)
  return links.length
}

/** The repair job: queue every link whose source changed after its last sync, or whose rename is held. */
export async function queueStaleLinks(max = 2000): Promise<number> {
  requireWorkspace()
  const rows = await prisma.$queryRaw<Array<{ link_id: string }>>(Prisma.sql`SELECT link_id FROM nexus_assortment_stale_links(${max}::int)`)
  return queueLinks(rows.map((row) => row.link_id), 'repair')
}

/** Finished notes older than a week are history nobody reads. */
export async function cleanFinishedChanges(): Promise<number> {
  requireWorkspace()
  const removed = await prisma.assortmentChange.deleteMany({ where: { state: 'done', doneAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } } })
  return removed.count
}

/** Every active link of one incoming share, queued — the on-demand repair. */
export async function resyncShare(shareId: string): Promise<{ queued: number }> {
  const { workspaceId, actorUserId } = requireWorkspace()
  if (!actorUserId) throw new WorkspaceError('session_required', 'Sign in as an owner of this business profile.', 403)
  await createWorkspaceService(prisma).requireOwner(actorUserId, workspaceId)
  const share = await prisma.assortmentShare.findFirst({ where: { id: shareId, workspaceId }, select: { id: true, status: true } })
  if (!share) throw new WorkspaceError('share_not_found', 'This share is unavailable in this business profile.', 404)
  if (share.status !== 'active') throw new WorkspaceError('share_not_active', `This share is ${share.status}. Only an active share follows.`, 409)
  const links = await prisma.catalogLink.findMany({ where: { shareId, targetWorkspaceId: workspaceId, status: 'active' }, select: { id: true } })
  const queued = await queueLinks(links.map((link) => link.id), 'resync')
  afterSyncQueued()
  return { queued }
}

/**
 * "Follow again": the follower stops keeping these fields ("all": every one it keeps). Each field's
 * fingerprint is reset to "whatever this business holds now", so the next run applies the source's value.
 */
export async function followAgain(linkId: string, fields: string[] | 'all'): Promise<{ followed: string[] }> {
  const { workspaceId } = requireWorkspace()
  const link = await prisma.catalogLink.findFirst({ where: { id: linkId, targetWorkspaceId: workspaceId } })
  if (!link) throw new WorkspaceError('link_not_found', 'This product does not follow a shared product.', 404)
  if (link.status !== 'active') throw new WorkspaceError('link_detached', 'This product no longer follows a shared product.', 409)
  const chosen = fields === 'all' ? [...link.overrides] : [...new Set(fields.map(String))]
  if (!chosen.length) return { followed: [] }
  const state: AppliedState = readState(link.appliedState)
  for (const key of chosen) {
    if (key === MEDIA_KEY) state.media = { target: FOLLOW_AGAIN, map: [] }
    else state.fields[key] = ['', FOLLOW_AGAIN]
  }
  await prisma.catalogLink.update({
    where: { id: link.id },
    data: { overrides: link.overrides.filter((key) => !chosen.includes(key)), appliedState: state as unknown as Prisma.InputJsonValue },
  })
  await queueLinks([link.id], 'follow-again')
  afterSyncQueued()
  return { followed: chosen }
}

// ── Who runs it ─────────────────────────────────────────────────────────────────────────────

/**
 * Businesses with waiting changes. The database answers only a caller with NO business context, so this
 * runs in the empty (system) context even inside a request's context.
 */
async function pendingWorkspaces(): Promise<string[]> {
  const rows = await withWorkspace({ workspaceId: '', actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    prisma.$queryRaw<Array<{ workspace_id: string }>>(Prisma.sql`SELECT workspace_id FROM nexus_assortment_pending_workspaces()`))
  return rows.map((row) => row.workspace_id)
}

let running: Promise<number> | null = null
let again = false

/** Sync every business's waiting changes now. Coalesces: a kick during a run schedules one more run. */
export function kickAssortmentSync(): Promise<number> {
  if (running) { again = true; return running }
  running = (async () => {
    let total = 0
    do {
      again = false
      for (const workspaceId of await pendingWorkspaces()) {
        const run = await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, () => processAssortmentChanges())
        total += run.claimed
      }
    } while (again)
    return total
  })().catch((error) => {
    logger.warn('assortment-sync: run failed', { error: error instanceof Error ? error.message : String(error) })
    return 0
  }).finally(() => { running = null })
  return running
}

/** Fire-and-forget after this business queued work itself. Never throws, never blocks the caller. */
export function afterSyncQueued(): void {
  if (process.env.NEXUS_PROCESS_ROLE === 'api' || process.env.NEXUS_PROCESS_ROLE === 'scheduler') return
  void kickAssortmentSync()
}

export interface SyncWorkerOptions {
  /** The connection to LISTEN on. Default listenUrlFrom(process.env). null: poll only. */
  listenUrl?: string | null
}

/**
 * The URL to LISTEN on: DIRECT_URL, else DATABASE_URL with Neon's `-pooler` taken off the host — the rule
 * packages/database/scripts/migrate-direct.mjs uses for migrations (one credential, so it follows a rotation).
 * A notify does not reach a LISTEN made through the pooler (PgBouncer in transaction mode gives the server
 * session back after each statement). Nothing else in this repo reads DIRECT_URL (migrate-direct.mjs names only
 * DIRECT_DATABASE_URL on Railway): with DATABASE_URL alone the worker would only poll there (up to 60 s when
 * quiet) while the local measurement said 0.1 s (build doc §7).
 */
export function listenUrlFrom(env: NodeJS.ProcessEnv): string | null {
  if (env.DIRECT_URL) return env.DIRECT_URL
  if (!env.DATABASE_URL) return null
  let url: URL
  try { url = new URL(env.DATABASE_URL) } catch { throw new Error('Listener requires a valid PostgreSQL URL') }
  if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace(/-pooler(?=\.)/, '')
  return url.toString()
}

export function startAssortmentSyncWorker(options: SyncWorkerOptions = {}): () => Promise<void> {
  const listenUrl = options.listenUrl === undefined ? listenUrlFrom(process.env) : options.listenUrl
  let stopped = false
  let client: Client | null = null
  let listenTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let listenDelay = 5_000
  let pollDelay = 2_000

  const wake = () => {
    if (stopped) return
    void kickAssortmentSync().then((found) => {
      if (found > 0) pollDelay = 2_000
    })
  }

  const reconnect = () => {
    if (stopped || listenTimer) return
    const dropped = client
    client = null
    dropped?.end().catch(() => { /* already closed */ })
    listenTimer = setTimeout(() => { listenTimer = null; void listen() }, listenDelay)
    listenTimer.unref?.()
    listenDelay = Math.min(listenDelay * 2, 60_000)
  }

  const listen = async () => {
    if (stopped || !listenUrl) return
    const next = new Client({ connectionString: listenUrl })
    client = next
    next.on('notification', wake)
    next.on('error', (error) => {
      logger.warn('assortment-sync: listener connection failed; polling covers it', { error: error.message })
      reconnect()
    })
    next.on('end', reconnect)
    try {
      await next.connect()
      await next.query(`LISTEN ${SYNC_CHANNEL}`)
      logger.info('assortment-sync: listening', { pooled: listenUrl.includes('-pooler') })
      listenDelay = 5_000
      wake() // anything written while we were not listening
    } catch (error) {
      logger.warn('assortment-sync: could not listen; polling covers it', { error: error instanceof Error ? error.message : String(error) })
      reconnect()
    }
  }

  const poll = async () => {
    if (stopped) return
    const found = await kickAssortmentSync()
    if (stopped) return
    pollDelay = found > 0 ? 2_000 : Math.min(pollDelay * 2, 60_000)
    pollTimer = setTimeout(() => { void poll() }, pollDelay)
    pollTimer.unref?.()
  }

  void listen()
  pollTimer = setTimeout(() => { void poll() }, pollDelay)
  pollTimer.unref?.()

  return async () => {
    stopped = true
    if (listenTimer) clearTimeout(listenTimer)
    if (pollTimer) clearTimeout(pollTimer)
    const open = client
    client = null
    open?.removeAllListeners('end')
    await open?.end().catch(() => { /* closing */ })
    await running
  }
}
