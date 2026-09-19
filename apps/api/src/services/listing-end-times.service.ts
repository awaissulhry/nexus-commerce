/**
 * Shared stock plan step 3 — end times for listing overrides (plan docs/2026-09-19-shared-stock-plan.md §5,
 * contract docs/2026-09-19-shared-stock-build.md §3).
 *
 * "Fixed number 2 until Monday 09:00": at that time the listing goes back to Follow by itself, and the
 * history says so. The same for "Paused until …" (it resumes) and, on a shared eBay variant, for a fixed
 * number (it follows the pool again) and for Excluded (it is included again).
 *
 * Runs in the business's own context (the per-minute clustered job, jobs/listing-end-times.job.ts).
 *
 * THE END TIME IS CONSUMED BY THE MODE CHANGE, NEVER BEFORE IT. This job only changes the mode; the
 * database clears the end time in the same row write (trigger nexus_listing_end_times /
 * nexus_membership_end_times, packages/database/workspaces/listing-end-times.sql). So a write that
 * fails, or a bulk that stops mid-way, leaves the end time where it was and the next minute tries
 * again: an override can never be left fixed forever because its end time was spent on a failed run.
 * Every write re-checks the mode and the end time in its own WHERE: an operator who changed the listing
 * or its end time before the write is never overruled.
 *
 * DUE = the same predicate in the probe and in every write (`dueFixed`, `duePause`, … below), so the probe never wakes the
 * job for a row no step would act on. An ENDED listing's fixed number is not due: the one writer does
 * not touch ended listings, so it waits and ends the moment the listing is live again.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { setFollowMasterQuantity } from './follow-master.service.js'
import { recascadeAfterSyncControlChange } from './stock-movement.service.js'

const ACTOR = 'system:end-time'

export interface EndTimesRun {
  fixedEnded: number
  /** Amazon-managed (FBA) listings: nothing is sent to them, so their end time just ends (audited). */
  fixedLapsedFba: number
  pausesEnded: number
  sharedFixedEnded: number
  sharedExclusionsEnded: number
  /** Fixed numbers the writer could not end this minute (they stay due; the next minute tries again). */
  retryLater: number
}

const dueFixed = (now: Date): Prisma.ChannelListingWhereInput => ({ pinnedUntil: { lte: now }, followMasterQuantity: false, listingStatus: { not: 'ENDED' } })
const duePause = (now: Date): Prisma.ChannelListingWhereInput => ({ pausedUntil: { lte: now }, syncPaused: true })
const dueSharedFixed = (now: Date): Prisma.SharedListingMembershipWhereInput => ({ pinnedUntil: { lte: now }, pinnedQuantity: { not: null } })
const dueSharedExclusion = (now: Date): Prisma.SharedListingMembershipWhereInput => ({ pausedUntil: { lte: now }, followPool: false })

/** Cheap: is anything due in this business? (The job skips the rest of the minute when not.) */
export async function hasDueEndTimes(now = new Date()): Promise<boolean> {
  const [listing, membership] = await Promise.all([
    prisma.channelListing.findFirst({ where: { OR: [dueFixed(now), duePause(now)] }, select: { id: true } }),
    prisma.sharedListingMembership.findFirst({ where: { OR: [dueSharedFixed(now), dueSharedExclusion(now)] }, select: { id: true } }),
  ])
  return !!listing || !!membership
}

type AuditRow = Prisma.SyncControlAuditCreateManyInput

const auditRow = (a: Omit<AuditRow, 'actor'>): AuditRow => ({ actor: ACTOR, ...a })

export async function endDueOverrides(now = new Date()): Promise<EndTimesRun> {
  const run: EndTimesRun = { fixedEnded: 0, fixedLapsedFba: 0, pausesEnded: 0, sharedFixedEnded: 0, sharedExclusionsEnded: 0, retryLater: 0 }
  const recascade = new Set<string>()

  // 1. Fixed numbers whose time has come → Follow, through the one writer that works out the number and
  //    sends it (setFollowMasterQuantity, pool-aware since shared stock step 2). Its FOLLOW write clears
  //    the end time (trigger); a row it does not reach keeps its end time and is tried again next minute.
  const fixed = await prisma.channelListing.findMany({
    where: dueFixed(now),
    select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, quantity: true, pinnedUntil: true, product: { select: { sku: true } } },
  })
  const byChannel = new Map<string, typeof fixed>()
  for (const l of fixed) byChannel.set(l.channel, [...(byChannel.get(l.channel) ?? []), l])
  for (const [channel, rows] of byChannel) {
    const byId = new Map(rows.map((l) => [l.id, l]))
    const label = (l: (typeof rows)[number]) => `${l.product?.sku ?? '?'}@${l.channel}:${l.marketplace}`
    let results: Awaited<ReturnType<typeof setFollowMasterQuantity>>['results'] = []
    try {
      const r = await setFollowMasterQuantity({
        productIds: [...new Set(rows.map((l) => l.productId))],
        channel: channel as never,
        markets: 'ALL',
        follow: true,
        actor: ACTOR,
        coordinates: rows.map((l) => ({ productId: l.productId, channel: l.channel, marketplace: l.marketplace, channelConnectionId: l.channelConnectionId, aliasKey: l.aliasKey })),
      })
      results = r.results
      if (r.error) logger.warn('[end-times] fixed numbers stopped mid-way; the rest is tried again next minute', { channel, error: r.error, remaining: r.remaining })
    } catch (error) {
      logger.warn('[end-times] could not end fixed numbers; tried again next minute', { channel, error: error instanceof Error ? error.message : String(error) })
    }
    const audit: AuditRow[] = []
    const handled = new Set<string>()
    for (const x of results) {
      const row = byId.get(x.listingId)
      if (!row) continue
      if (x.action === 'FOLLOW') {
        handled.add(row.id)
        run.fixedEnded++
        audit.push(auditRow({
          scopeType: 'LISTING', scopeId: row.id, scopeName: label(row), field: 'followMasterQuantity',
          before: { follow: false, quantity: row.quantity, pinnedUntil: row.pinnedUntil?.toISOString() ?? null }, after: { follow: true, quantity: x.quantity },
          reason: 'The fixed number reached its end time.',
        }))
      } else if (x.action === 'SKIPPED_FBA') {
        // Amazon manages this listing's stock: nothing is ever sent to it, so there is nothing to end.
        // Its end time ends here (else it would be due every minute), only if nobody changed it meanwhile.
        const u = await prisma.channelListing.updateMany({ where: { id: row.id, ...dueFixed(now), pinnedUntil: row.pinnedUntil }, data: { pinnedUntil: null } })
        if (u.count === 0) continue
        handled.add(row.id)
        run.fixedLapsedFba++
        audit.push(auditRow({
          scopeType: 'LISTING', scopeId: row.id, scopeName: label(row), field: 'pinnedUntil',
          before: { pinnedUntil: row.pinnedUntil?.toISOString() ?? null }, after: { pinnedUntil: null },
          reason: 'The fixed number reached its end time. Amazon manages this listing (FBA), so nothing was sent.',
        }))
      }
    }
    run.retryLater += rows.filter((l) => !handled.has(l.id)).length
    if (audit.length) {
      try {
        await prisma.syncControlAudit.createMany({ data: audit })
      } catch (error) {
        logger.warn('[end-times] audit write failed', { channel, rows: audit.length, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  // 2. Pauses whose time has come → resume, then re-work the listings (as Sync Control's RESUME does).
  //    The resume and its history row commit together.
  const paused = await prisma.channelListing.findMany({
    where: duePause(now),
    select: { id: true, productId: true, channel: true, marketplace: true, pausedUntil: true, product: { select: { sku: true } } },
  })
  for (const l of paused) {
    const done = await prisma.$transaction(async (tx) => {
      const u = await tx.channelListing.updateMany({ where: { id: l.id, ...duePause(now) }, data: { syncPaused: false } })
      if (u.count === 0) return false // changed meanwhile
      await tx.syncControlAudit.create({
        data: auditRow({
          scopeType: 'LISTING', scopeId: l.id, scopeName: `${l.product?.sku ?? '?'}@${l.channel}:${l.marketplace}`, field: 'syncPaused',
          before: { syncPaused: true, pausedUntil: l.pausedUntil?.toISOString() ?? null }, after: { syncPaused: false },
          reason: 'The pause reached its end time.',
        }),
      })
      return true
    })
    if (!done) continue
    run.pausesEnded++
    recascade.add(l.productId)
  }

  // 3. Shared eBay variants: a fixed number → follows the pool; Excluded → included again.
  const members = await prisma.sharedListingMembership.findMany({
    where: { OR: [dueSharedFixed(now), dueSharedExclusion(now)] },
    select: { id: true, sku: true, itemId: true, productId: true, pinnedQuantity: true, pinnedUntil: true, followPool: true, pausedUntil: true },
  })
  for (const m of members) {
    const scopeName = `${m.sku}@${m.itemId}`
    if (m.pinnedQuantity != null && m.pinnedUntil && m.pinnedUntil <= now) {
      const done = await prisma.$transaction(async (tx) => {
        const u = await tx.sharedListingMembership.updateMany({ where: { id: m.id, ...dueSharedFixed(now) }, data: { pinnedQuantity: null } })
        if (u.count === 0) return false
        await tx.syncControlAudit.create({
          data: auditRow({
            scopeType: 'MEMBERSHIP', scopeId: m.id, scopeName, field: 'pinnedQuantity',
            before: { pinnedQuantity: m.pinnedQuantity, pinnedUntil: m.pinnedUntil!.toISOString() }, after: { pinnedQuantity: null },
            reason: 'The fixed number reached its end time.',
          }),
        })
        return true
      })
      if (done) {
        run.sharedFixedEnded++
        if (m.productId) recascade.add(m.productId)
      }
    }
    if (!m.followPool && m.pausedUntil && m.pausedUntil <= now) {
      const done = await prisma.$transaction(async (tx) => {
        const u = await tx.sharedListingMembership.updateMany({ where: { id: m.id, ...dueSharedExclusion(now) }, data: { followPool: true } })
        if (u.count === 0) return false
        await tx.syncControlAudit.create({
          data: auditRow({
            scopeType: 'MEMBERSHIP', scopeId: m.id, scopeName, field: 'followPool',
            before: { followPool: false, pausedUntil: m.pausedUntil!.toISOString() }, after: { followPool: true },
            reason: 'The exclusion reached its end time.',
          }),
        })
        return true
      })
      if (done) {
        run.sharedExclusionsEnded++
        if (m.productId) recascade.add(m.productId)
      }
    }
  }

  if (recascade.size) await recascadeAfterSyncControlChange([...recascade], ACTOR)
  return run
}
