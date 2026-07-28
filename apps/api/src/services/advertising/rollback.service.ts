/**
 * AD.4 — Operator-initiated rollback of a recent execution's writes.
 *
 * Walks AdvertisingActionLog rows linked to the target execution
 * (matched by executionId when present, OR by userId='automation:<ruleId>'
 * + createdAt window when not). For each non-rolled-back row, applies
 * the inverse mutation using ads-mutation.service so the rollback
 * goes through the same OutboundSyncQueue + grace-period guarantees.
 *
 * Rollback support per actionType:
 *   AD_BUDGET_UPDATE              → restore dailyBudget
 *   AD_ENTITY_STATE_UPDATE        → restore status
 *   AD_BID_UPDATE / AD_BIDDING_*  → restore bid / strategy
 *   liquidate_aged_stock:*        → 1) revert paused campaigns to ENABLED,
 *                                    2) restore boosted budgets,
 *                                    3) RetailEvent: soft-disable (set isActive=false)
 *
 * Window: rollback only available for actions whose createdAt is within
 * 24h. Older actions need manual reversal (the action log still surfaces them).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  updateCampaignWithSync,
  updateAdGroupWithSync,
  updateAdTargetWithSync,
  type AdsActor,
} from './ads-mutation.service.js'

const ROLLBACK_WINDOW_MS = 24 * 60 * 60 * 1000
/** Surfaced to the UI so the button can explain itself rather than no-op. */
export const ROLLBACK_WINDOW_HOURS = ROLLBACK_WINDOW_MS / 3_600_000

export interface RollbackOutcome {
  ok: boolean
  reversed: number
  skipped: number
  failed: number
  /**
   * Phase 2 — why nothing was reversed, when nothing was.
   *
   * The History "Undo" button returned `reversed: 0` with no explanation, which
   * is indistinguishable from "there was nothing to undo". An expired window is
   * a fact the operator needs, not a silent no-op.
   */
  expired?: boolean
  windowHours?: number
  reason?: string
  details: Array<{
    actionLogId: string
    actionType: string
    entityType: string
    entityId: string
    outcome: 'REVERSED' | 'SKIPPED' | 'FAILED'
    reason?: string
  }>
}

interface AdLog {
  id: string
  actionType: string
  entityType: string
  entityId: string
  payloadBefore: unknown
  payloadAfter: unknown
  userId: string | null
  createdAt: Date
  rolledBackAt: Date | null
  amazonResponseStatus: string | null
}

async function reverseOne(
  log: AdLog,
  actor: AdsActor,
  reason: string,
): Promise<{ ok: boolean; reason?: string; skipped?: boolean }> {
  // Refuse to invert anything that never made it past the gate / queue
  // — there's nothing to undo on the Amazon side, and re-applying the
  // before-state via the worker would create noise.
  if (log.amazonResponseStatus !== 'SUCCESS' && log.amazonResponseStatus !== 'PENDING') {
    return { ok: false, skipped: true, reason: `state=${log.amazonResponseStatus ?? 'null'} — nothing to reverse` }
  }
  const before = log.payloadBefore as Record<string, unknown> | null
  if (!before || typeof before !== 'object') {
    return { ok: false, reason: 'payloadBefore missing or invalid' }
  }

  try {
    // D1 — placement-bias rollback (the rank engine's main lever). actionType-specific because the
    // entity is CAMPAIGN but the affected field is dynamicBidding.placementBidding, not budget/status.
    if (log.actionType === 'update_placement_bidding') {
      const beforeAdj = before.adjustments as Array<{ placement: string; percentage: number }> | undefined
      if (!Array.isArray(beforeAdj)) return { ok: true, skipped: true, reason: 'no prior placement snapshot to restore' }
      const { updatePlacementBidding } = await import('./ads-create.service.js')
      const r = await updatePlacementBidding({ campaignId: log.entityId, adjustments: beforeAdj })
      return r.ok ? { ok: true } : { ok: false, reason: 'placement restore failed' }
    }
    // AX-IE.9 — inverting a CREATE.
    //
    // Everything else here restores a before-snapshot. A create has no before
    // state, so the inverse is to archive what was made. Archive IS the delete
    // on Amazon for these entities — there is no delete endpoint for a keyword
    // or a product ad, and archive is terminal, which is exactly the semantics
    // wanted here.
    //
    // Without this, undoing an import reverted every edit and silently left
    // behind every row the import INVENTED — the half of a round trip that is
    // easiest to miss and worst to find out about later.
    if (log.actionType.startsWith('bulksheet_create_')) {
      const patch = { status: 'ARCHIVED' as const }
      const common = { actor, reason: `rollback: ${reason}`, applyImmediately: true }
      if (log.entityType === 'AD_GROUP') {
        const r = await updateAdGroupWithSync({ adGroupId: log.entityId, patch, ...common })
        return r.ok ? { ok: true } : { ok: false, reason: r.error ?? 'archive failed' }
      }
      if (log.entityType === 'PRODUCT_AD') {
        const { updateProductAdWithSync } = await import('./ads-mutation.service.js')
        const r = await updateProductAdWithSync({ productAdId: log.entityId, status: 'ARCHIVED', ...common })
        return r.ok ? { ok: true } : { ok: false, reason: r.error ?? 'archive failed' }
      }
      if (log.entityType === 'AD_TARGET') {
        const r = await updateAdTargetWithSync({ adTargetId: log.entityId, patch, ...common })
        return r.ok ? { ok: true } : { ok: false, reason: r.error ?? 'archive failed' }
      }
      return { ok: false, reason: `cannot invert a create of ${log.entityType}` }
    }
    if (log.entityType === 'CAMPAIGN') {
      // Build patch from before-snapshot fields the action affected.
      const after = log.payloadAfter as Record<string, unknown>
      const patch: Parameters<typeof updateCampaignWithSync>[0]['patch'] = {}
      if (after.dailyBudget !== before.dailyBudget) patch.dailyBudget = Number(before.dailyBudget)
      if (after.dailyBudgetCurrency !== before.dailyBudgetCurrency)
        patch.dailyBudgetCurrency = String(before.dailyBudgetCurrency)
      if (after.status !== before.status) patch.status = before.status as 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      if (after.biddingStrategy !== before.biddingStrategy)
        patch.biddingStrategy = before.biddingStrategy as 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
      if (after.endDate !== before.endDate)
        patch.endDate = before.endDate ? new Date(String(before.endDate)) : null
      if (Object.keys(patch).length === 0) return { ok: true, skipped: true, reason: 'no diff to reverse' }
      const result = await updateCampaignWithSync({
        campaignId: log.entityId,
        patch,
        actor,
        reason: `rollback: ${reason}`,
        applyImmediately: true,
      })
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'unknown' }
    }
    if (log.entityType === 'AD_GROUP') {
      const after = log.payloadAfter as Record<string, unknown>
      const patch: Parameters<typeof updateAdGroupWithSync>[0]['patch'] = {}
      if (after.defaultBidCents !== before.defaultBidCents)
        patch.defaultBidCents = Number(before.defaultBidCents)
      if (after.status !== before.status) patch.status = before.status as 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      if (Object.keys(patch).length === 0) return { ok: true, skipped: true, reason: 'no diff to reverse' }
      const result = await updateAdGroupWithSync({
        adGroupId: log.entityId,
        patch,
        actor,
        reason: `rollback: ${reason}`,
        applyImmediately: true,
      })
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'unknown' }
    }
    if (log.entityType === 'AD_TARGET') {
      const after = log.payloadAfter as Record<string, unknown>
      const patch: Parameters<typeof updateAdTargetWithSync>[0]['patch'] = {}
      if (after.bidCents !== before.bidCents) patch.bidCents = Number(before.bidCents)
      if (after.status !== before.status) patch.status = before.status as 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      if (Object.keys(patch).length === 0) return { ok: true, skipped: true, reason: 'no diff to reverse' }
      const result = await updateAdTargetWithSync({
        adTargetId: log.entityId,
        patch,
        actor,
        reason: `rollback: ${reason}`,
        applyImmediately: true,
      })
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'unknown' }
    }
    if (log.entityType === 'RETAIL_EVENT') {
      // Soft-disable: set isActive=false. promotion-scheduler treats
      // isActive=false events as no-ops on its next ENTER/EXIT tick.
      // We don't hard-delete because operator may want to inspect later.
      await prisma.retailEvent.update({
        where: { id: log.entityId },
        data: { isActive: false },
      })
      return { ok: true }
    }
    return { ok: false, reason: `unsupported entityType ${log.entityType}` }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * AX-IE.6 — roll back a whole CHANGE SET in one call.
 *
 * Same inversion logic as rollbackByExecutionId (both walk `reverseOne`), but
 * found by change-set id rather than by an AutomationRuleExecution row, because
 * a bulksheet upload is not a rule execution. `AdvertisingActionLog.executionId`
 * is an indexed column with no foreign key, so it holds any change-set id — rule
 * executions were simply its first user.
 *
 * This is the thing no competitor has. Agencies ask for one-click reversal of an
 * applied change set and the teardown found it documented nowhere — Pacvue,
 * Quartile and Trellis are all called out for its absence. We already had the
 * primitive; this just points it at imports.
 */
export async function rollbackByChangeSetId(args: {
  changeSetId: string
  actor: AdsActor
  reason: string
}): Promise<RollbackOutcome> {
  const logs = await prisma.advertisingActionLog.findMany({
    where: {
      executionId: args.changeSetId,
      rolledBackAt: null,
      // Same 24h horizon as the rule path: past that, Amazon's own state has
      // usually moved on and restoring a day-old snapshot does more harm than good.
      createdAt: { gte: new Date(Date.now() - ROLLBACK_WINDOW_MS) },
    },
    // Newest first: undo in reverse order of application, so a field written
    // twice within one set lands back on its original value rather than an
    // intermediate one.
    orderBy: { createdAt: 'desc' },
  })

  const out: RollbackOutcome = { ok: true, reversed: 0, skipped: 0, failed: 0, details: [] }
  if (logs.length === 0) {
    // Distinguish "nothing to undo" from "too late to undo" — the caller
    // otherwise shows the same empty result for both.
    const anyOutsideWindow = await prisma.advertisingActionLog.count({
      where: { executionId: args.changeSetId, rolledBackAt: null },
    }).catch(() => 0)
    if (anyOutsideWindow > 0) {
      out.expired = true
      out.windowHours = ROLLBACK_WINDOW_HOURS
      out.reason = `This change set is older than the ${ROLLBACK_WINDOW_HOURS}-hour undo window. Amazon's own state has usually moved on by then, so restoring a day-old snapshot can do more harm than the change it reverses.`
    }
  }
  for (const log of logs) {
    const r = await reverseOne(log, args.actor, args.reason)
    const base = { actionLogId: log.id, actionType: log.actionType, entityType: log.entityType, entityId: log.entityId }
    if (r.ok && !r.skipped) {
      out.reversed += 1
      out.details.push({ ...base, outcome: 'REVERSED' })
      await prisma.advertisingActionLog.update({
        where: { id: log.id },
        data: { rolledBackAt: new Date(), rollbackReason: args.reason },
      })
    } else if (r.skipped) {
      out.skipped += 1
      out.details.push({ ...base, outcome: 'SKIPPED', reason: r.reason })
    } else {
      out.failed += 1
      out.ok = false
      out.details.push({ ...base, outcome: 'FAILED', reason: r.reason })
    }
  }
  return out
}

/**
 * Roll back every non-rolled-back AdvertisingActionLog row tied to an
 * execution. executionId can be null when the operator invokes rollback
 * by ruleId-window instead — we synthesize a window from the
 * AutomationRuleExecution's startedAt/finishedAt timestamps.
 */
export async function rollbackByExecutionId(args: {
  executionId: string
  actor: AdsActor
  reason: string
}): Promise<RollbackOutcome> {
  const exec = await prisma.automationRuleExecution.findUnique({
    where: { id: args.executionId },
    select: { id: true, ruleId: true, startedAt: true, finishedAt: true },
  })
  if (!exec) {
    return {
      ok: false,
      reversed: 0,
      skipped: 0,
      failed: 0,
      details: [{ actionLogId: 'n/a', actionType: 'n/a', entityType: 'n/a', entityId: 'n/a', outcome: 'FAILED', reason: 'execution not found' }],
    }
  }

  // Two paths to find the logs:
  //   1. executionId on AdvertisingActionLog (only set by the AD.4
  //      coordinator paths today)
  //   2. userId='automation:<ruleId>' + createdAt in [startedAt, finishedAt+5min]
  // We union the two so both shapes are covered.
  const windowStart = new Date(exec.startedAt.getTime() - 1000)
  const windowEnd = new Date(
    (exec.finishedAt ?? new Date()).getTime() + 5 * 60 * 1000,
  )
  const logs = await prisma.advertisingActionLog.findMany({
    where: {
      OR: [
        { executionId: exec.id },
        {
          AND: [
            { userId: `automation:${exec.ruleId}` },
            { createdAt: { gte: windowStart, lte: windowEnd } },
          ],
        },
      ],
      rolledBackAt: null,
      createdAt: { gte: new Date(Date.now() - ROLLBACK_WINDOW_MS) },
    },
    orderBy: { createdAt: 'asc' },
  })

  const out: RollbackOutcome = {
    ok: true,
    reversed: 0,
    skipped: 0,
    failed: 0,
    details: [],
  }

  for (const log of logs) {
    const r = await reverseOne(log, args.actor, args.reason)
    if (r.ok && !r.skipped) {
      out.reversed += 1
      out.details.push({
        actionLogId: log.id,
        actionType: log.actionType,
        entityType: log.entityType,
        entityId: log.entityId,
        outcome: 'REVERSED',
      })
      await prisma.advertisingActionLog.update({
        where: { id: log.id },
        data: { rolledBackAt: new Date(), rollbackReason: args.reason },
      })
    } else if (r.skipped) {
      out.skipped += 1
      out.details.push({
        actionLogId: log.id,
        actionType: log.actionType,
        entityType: log.entityType,
        entityId: log.entityId,
        outcome: 'SKIPPED',
        reason: r.reason,
      })
    } else {
      out.failed += 1
      out.ok = false
      out.details.push({
        actionLogId: log.id,
        actionType: log.actionType,
        entityType: log.entityType,
        entityId: log.entityId,
        outcome: 'FAILED',
        reason: r.reason,
      })
      logger.warn('[rollback] reversal failed', {
        actionLogId: log.id,
        actionType: log.actionType,
        error: r.reason,
      })
    }
  }

  return out
}
