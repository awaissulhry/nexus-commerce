/**
 * AX-ZD.2 — consumers for the two non-performance AMS families.
 *
 * `ingestMarketingStream` owns the hourly performance rollups. These two are
 * different data answering different questions, and routing them into the
 * metrics pipe (or dropping them, which is what happened before) loses the
 * single most valuable signal the stream carries.
 *
 * CHANGE — campaigns / adgroups / ads / targets. Near-real-time events when
 * state, budget, bid or name changes. This is the only push notification that
 * someone edited in Seller Central. It updates OBSERVED state, never intent:
 * the reconciler's job is to drive observed toward intended, and conflating the
 * two is how a external edit gets silently overwritten by our own stale value.
 *
 * BUDGET — budget-usage at each 5% increment. Feeds pacing.
 *
 * Deliberately conservative: this records what Amazon told us and stamps
 * freshness. It does NOT auto-repair. Repair is the reconciler's decision and
 * needs the intended/observed split (AX-ZD.3) to be safe.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { familyOf, readBudgetUsage, readEntityChange, type EntityChangeEvent } from '../ads-core/ams-dataset.js'

export interface ChangeIngestResult {
  received: number
  campaigns: number
  adGroups: number
  targets: number
  skipped: number
  /** Entities Amazon reported that we do not have locally. */
  unmatched: number
}

/**
 * Record entity-change events as OBSERVED state.
 *
 * Only campaign/ad-group/target are mapped today because those are the grains
 * with local rows carrying an external id. `ads` events are counted and skipped
 * rather than dropped silently, so the gap is visible in the result.
 */
export async function ingestEntityChanges(records: Array<Record<string, unknown>>): Promise<ChangeIngestResult> {
  const out: ChangeIngestResult = { received: records.length, campaigns: 0, adGroups: 0, targets: 0, skipped: 0, unmatched: 0 }
  const now = new Date()

  for (const rec of records) {
    const datasetId = String(rec.dataset_id ?? rec.datasetId ?? '')
    if (familyOf(datasetId) !== 'CHANGE') { out.skipped++; continue }
    const ev = readEntityChange(datasetId, rec)
    if (!ev || !Object.keys(ev.changes).length) { out.skipped++; continue }

    try {
      const applied = await recordObserved(ev, now)
      if (applied === 'campaign') out.campaigns++
      else if (applied === 'adGroup') out.adGroups++
      else if (applied === 'target') out.targets++
      else out.unmatched++
    } catch (e) {
      out.skipped++
      logger.warn('[AX-ZD.2] change record failed', { datasetId, error: (e as Error).message })
    }
  }

  if (out.campaigns || out.adGroups || out.targets) {
    logger.info('[AX-ZD.2] observed state updated from the change stream', out as unknown as Record<string, unknown>)
  }
  return out
}

async function recordObserved(ev: EntityChangeEvent, now: Date): Promise<'campaign' | 'adGroup' | 'target' | null> {
  if (ev.entityType === 'CAMPAIGN') {
    const row = await prisma.campaign.findFirst({ where: { externalCampaignId: ev.externalId }, select: { id: true } })
    if (!row) return null
    // settingsSyncedAt is READ freshness (AX2.2) — a push event is a read, and
    // a fresher one than the 20-minute poll. lastSyncStatus is deliberately
    // untouched: that is WRITE delivery truth and an external edit says nothing
    // about whether our last write landed.
    await prisma.campaign.update({ where: { id: row.id }, data: { settingsSyncedAt: ev.occurredAt ?? now } })
    return 'campaign'
  }
  if (ev.entityType === 'AD_GROUP') {
    const row = await prisma.adGroup.findFirst({ where: { externalAdGroupId: ev.externalId }, select: { id: true } })
    if (!row) return null
    await prisma.adGroup.update({ where: { id: row.id }, data: { lastSyncedAt: ev.occurredAt ?? now } })
    return 'adGroup'
  }
  if (ev.entityType === 'TARGET') {
    const row = await prisma.adTarget.findFirst({ where: { externalTargetId: ev.externalId }, select: { id: true, orphanedAt: true } })
    if (!row) return null
    // A target Amazon is emitting events for demonstrably exists, so an orphan
    // mark on it is stale (AX2.0 self-heal, via a second independent signal).
    await prisma.adTarget.update({
      where: { id: row.id },
      data: { lastSyncedAt: ev.occurredAt ?? now, ...(row.orphanedAt ? { orphanedAt: null, orphanReason: null } : {}) },
    })
    return 'target'
  }
  return null
}

export interface BudgetIngestResult {
  received: number
  exhausted: number
  warning: number
  skipped: number
}

/**
 * Record budget-usage events.
 *
 * The feed is a PERCENTAGE at 5% increments, so the exact moment of exhaustion
 * is unobservable — only the crossing of the last bucket is. That imprecision
 * is inherent to the stream, and pretending otherwise ("out of budget at
 * 14:32:07") would be inventing precision Amazon never sent.
 */
export async function ingestBudgetUsage(records: Array<Record<string, unknown>>): Promise<BudgetIngestResult> {
  const out: BudgetIngestResult = { received: records.length, exhausted: 0, warning: 0, skipped: 0 }
  for (const rec of records) {
    const ev = readBudgetUsage(rec)
    if (!ev || !ev.campaignId) { out.skipped++; continue }
    if (ev.exhausted) out.exhausted++
    else if (ev.warning) out.warning++

    if (ev.exhausted || ev.warning) {
      logger.warn('[AX-ZD.2] budget consumption', {
        campaignId: ev.campaignId, percent: ev.budgetUsagePercent, exhausted: ev.exhausted,
      })
    }
  }
  return out
}
