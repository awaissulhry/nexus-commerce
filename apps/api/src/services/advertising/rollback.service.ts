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

/**
 * ACR.4.3 — how long a SINGLE action stays reversible, by what it changed.
 *
 * Stage 4's exit condition asks for "every action reversible for 7 days". Applied flat, that
 * would be wrong for the one thing this account changes most: the rank engine re-evaluates bids
 * HOURLY, so a seven-day-old bid has been superseded a hundred times and restoring it moves real
 * money against a decision nobody is making today. That is precisely the reasoning behind
 * `ADS_STALE_INTENT_MS = 24h` in the delivery model, and behind this file's original 24h.
 *
 * Budgets and placements are different in kind, not degree. They change a handful of times a
 * week — 195 budget moves and ~2,500 placement moves against 11,140 bid rows in seven days — and
 * a budget of €4.14 from last Tuesday is still a meaningful number to go back to. So the window
 * follows what was changed:
 *
 *   bids            24h — superseded by the next engine tick
 *   budgets         7d  — set deliberately, changed rarely
 *   placements      7d  — same
 *   anything else   24h — default-deny, matching the original constant
 *
 * Deliberately NOT applied to `rollbackByChangeSetId`. A change set (a bulksheet import) can mix
 * every action type at once, and "undo the whole upload" means one atomic horizon rather than a
 * per-row one — a set that half-reverses is worse than one that refuses.
 */
const LONG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const LONG_WINDOW_ACTIONS = new Set([
  'AD_BUDGET_UPDATE',
  'update_placement_bidding',
  'adjust_ad_budget',
])

export function rollbackWindowMsFor(actionType: string): number {
  return LONG_WINDOW_ACTIONS.has(actionType) ? LONG_WINDOW_MS : ROLLBACK_WINDOW_MS
}

/** The window as a human phrase, so a refusal can name its own rule. */
export function rollbackWindowLabel(actionType: string): string {
  return LONG_WINDOW_ACTIONS.has(actionType) ? '7-day' : `${ROLLBACK_WINDOW_HOURS}-hour`
}

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
  /**
   * CM-22 — every row the Undo looked at was a no-op (the values before and after are the same, or nothing was
   * recorded to put back): nothing was reversed and nothing failed. `reason` then starts "Nothing to undo:". Such a row is
   * counted as skipped, never as reversed, and is not marked undone.
   */
  nothingToUndo?: boolean
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

/**
 * 1e (CM-9) — an edit that replaced the no-pause floor's memory (`suppressedFromBidCents`) records both values in its
 * payloads; undoing it puts the memory back, so the morning restore again restores the bid from before the floor.
 * Compare-and-set: a memory something else has moved since (a restore cleared it, a later edit) is left alone.
 */
async function restoreFloorMemory(log: AdLog, before: Record<string, unknown>): Promise<void> {
  if (!('suppressedFromBidCents' in before)) return
  const after = (log.payloadAfter ?? {}) as Record<string, unknown>
  const was = before.suppressedFromBidCents
  const now = after.suppressedFromBidCents
  if (typeof was !== 'number' || typeof now !== 'number') return
  const where = { id: log.entityId, suppressedFromBidCents: now }
  if (log.entityType === 'AD_TARGET') await prisma.adTarget.updateMany({ where, data: { suppressedFromBidCents: was } })
  else if (log.entityType === 'AD_GROUP') await prisma.adGroup.updateMany({ where, data: { suppressedFromBidCents: was } })
}

/** CM-22 — why a row has nothing to put back, in words the Undo shows. */
const NO_DIFF = 'the values before and after this change are the same, so there is nothing to put back.'
const NO_PLACEMENT_SNAPSHOT = 'Nexus has no record of the placements before this change, so there is nothing to put back.'

/**
 * CM-22 — when every row the Undo looked at was a no-op, the answer says "Nothing to undo" with the first row's reason
 * (it used to answer `reversed: 1` for a row that changed nothing, and mark it undone).
 */
export function noteNothingToUndo(out: RollbackOutcome, why?: string | null): RollbackOutcome {
  if (out.reversed > 0 || out.failed > 0 || out.skipped === 0) return out
  out.nothingToUndo = true
  if (!out.reason) out.reason = `Nothing to undo: ${why || 'this change left nothing that can be put back.'}`
  return out
}

async function reverseOne(
  log: AdLog,
  actor: AdsActor,
  reason: string,
  /**
   * 1e (CM-10) — the Undo was a person's click (the undo routes set it; a Claude request or an engine never does): the
   * reversal passes the account halt and autonomy OFF like his other edits (isPersonEdit). Every other check binds.
   */
  manual = false,
  /**
   * ADS AUTONOMY AA-W2-9 — the change set the reversal's own writes carry (an approved undo request's id), so the undo
   * can itself be put back by change set (undo-ad-change of it re-applies). Not on the archive that inverts a create:
   * an archive cannot be undone at Amazon.
   */
  changeSetId: string | null = null,
): Promise<{ ok: boolean; reason?: string; skipped?: boolean }> {
  // Refuse to invert anything that never made it past the gate / queue
  // — there's nothing to undo on the Amazon side, and re-applying the
  // before-state via the worker would create noise.
  if (log.amazonResponseStatus !== 'SUCCESS' && log.amazonResponseStatus !== 'PENDING') {
    return { ok: false, skipped: true, reason: `this change never reached Amazon (${log.amazonResponseStatus ?? 'no state'}), so there is nothing to put back.` }
  }
  const before = log.payloadBefore as Record<string, unknown> | null
  if (!before || typeof before !== 'object') {
    return { ok: false, reason: 'payloadBefore missing or invalid' }
  }
  if (isArchiveLog(log)) return { ok: false, skipped: true, reason: ARCHIVE_IS_FINAL }
  // PB-10 — a create (an import's is inverted below) has nothing before it to put back: what it made is archived
  // (archive-ads) or, a negative, retired (undo-ad-change retires those apart). Putting back its empty before-state would
  // write nonsense (a keyword's bid from `{}`).
  if (isPlainCreateLog(log)) return { ok: true, skipped: true, reason: CREATE_NOT_PUT_BACK }

  try {
    // D1 — placement-bias rollback (the rank engine's main lever). actionType-specific because the
    // entity is CAMPAIGN but the affected field is dynamicBidding.placementBidding, not budget/status.
    if (log.actionType === 'update_placement_bidding') {
      const beforeAdj = before.adjustments as Array<{ placement: string; percentage: number }> | undefined
      if (!Array.isArray(beforeAdj)) return { ok: true, skipped: true, reason: NO_PLACEMENT_SNAPSHOT }
      const { updatePlacementBidding } = await import('./ads-create.service.js')
      // HX.1 — the 'Undo:' reason prefix is the same marker /campaigns/:id/history already uses to
      // flag a row as an undo, so a reversal reads as one everywhere rather than as a fresh change.
      const r = await updatePlacementBidding({ campaignId: log.entityId, adjustments: beforeAdj, actor, reason: `Undo: ${log.actionType}${reason ? ` — ${reason}` : ''}`, manual, changeSetId })
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
      const common = { actor, reason: `rollback: ${reason}`, applyImmediately: true, manual, reversal: true }
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
      // CM-22 — a rename and a portfolio move are recorded with their before values like the rest; an Undo of one used
      // to find "no diff" and say nothing was there to undo.
      if ('name' in before && after.name !== before.name && typeof before.name === 'string' && before.name.trim())
        patch.name = before.name
      if ('portfolioId' in before && (after.portfolioId ?? null) !== (before.portfolioId ?? null))
        patch.portfolioId = (before.portfolioId as string | null | undefined) ?? null
      if (Object.keys(patch).length === 0) return { ok: true, skipped: true, reason: NO_DIFF }
      const result = await updateCampaignWithSync({
        campaignId: log.entityId,
        patch,
        actor,
        reason: `rollback: ${reason}`,
        applyImmediately: true,
        manual,
        changeSetId,
      })
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'unknown' }
    }
    if (log.entityType === 'AD_GROUP') {
      const after = log.payloadAfter as Record<string, unknown>
      const patch: Parameters<typeof updateAdGroupWithSync>[0]['patch'] = {}
      if (after.defaultBidCents !== before.defaultBidCents)
        patch.defaultBidCents = Number(before.defaultBidCents)
      if (after.status !== before.status) patch.status = before.status as 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      if (Object.keys(patch).length === 0) return { ok: true, skipped: true, reason: NO_DIFF }
      const result = await updateAdGroupWithSync({
        adGroupId: log.entityId,
        patch,
        actor,
        reason: `rollback: ${reason}`,
        applyImmediately: true,
        manual,
        reversal: true,
        changeSetId,
      })
      if (result.ok) await restoreFloorMemory(log, before)
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'unknown' }
    }
    if (log.entityType === 'AD_TARGET') {
      const after = log.payloadAfter as Record<string, unknown>
      const patch: Parameters<typeof updateAdTargetWithSync>[0]['patch'] = {}
      if (after.bidCents !== before.bidCents) patch.bidCents = Number(before.bidCents)
      if (after.status !== before.status) patch.status = before.status as 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      if (Object.keys(patch).length === 0) return { ok: true, skipped: true, reason: NO_DIFF }
      const result = await updateAdTargetWithSync({
        adTargetId: log.entityId,
        patch,
        actor,
        reason: `rollback: ${reason}`,
        applyImmediately: true,
        manual,
        reversal: true,
        changeSetId,
      })
      if (result.ok) await restoreFloorMemory(log, before)
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
/**
 * HX.7 — undo ONE recorded change.
 *
 * The service already reversed a whole rule execution or a whole change set. What the change log
 * needs is the single row in front of you: "put that one bid back".
 *
 * Deliberately reuses reverseOne and the same 24-hour horizon rather than inventing a second set of
 * rules — an undo that behaved differently depending on which button you pressed would be worse
 * than no undo at all.
 *
 * GROUPING IS PRESERVED. If the row belongs to a change set, the whole set reverses together, the
 * way Google Ads does it: one operation that wrote four fields is one thing the operator did, and
 * unpicking a quarter of it would leave the entity in a state that never existed. The caller is
 * told how many rows came with it so the confirm can say so BEFORE it happens.
 */
/**
 * An archive is final at Amazon: no write switches an archived campaign, ad group, keyword, target or product ad on
 * again, so Undo never puts one back — re-enabling it in Nexus would show an ad Amazon no longer serves. While the
 * archive still waits to be sent, cancel it instead (DELETE /advertising/mutations/:outboundQueueId).
 */
/** PB-10 — a create's audit row (create_keyword, create_negative_keyword, create_product_ad …), not an import's. */
export const isPlainCreateLog = (log: { actionType: string }) => log.actionType.startsWith('create_')
export const CREATE_NOT_PUT_BACK = 'A create has nothing before it to put back: archive what it made (archive-ads); a negative it made is retired.'
export const ARCHIVE_IS_FINAL = 'An archive cannot be undone: Amazon cannot switch an archived ad on again. While it still waits to be sent, cancel it instead.'

/** The log row archived its entity (a status write to ARCHIVED from another status). */
export function isArchiveLog(log: { payloadBefore: unknown; payloadAfter: unknown }): boolean {
  const status = (p: unknown) => ((p as { status?: unknown } | null)?.status ?? null)
  return status(log.payloadAfter) === 'ARCHIVED' && status(log.payloadBefore) !== 'ARCHIVED'
}

export async function previewRollbackOfAction(actionLogId: string): Promise<{
  found: boolean; eligible: boolean; reason?: string
  actionType?: string; entityType?: string; entityId?: string
  groupedWith?: number; changeSetId?: string | null; at?: Date
}> {
  const log = await prisma.advertisingActionLog.findUnique({ where: { id: actionLogId } })
  if (!log) return { found: false, eligible: false, reason: 'That change no longer exists.' }
  const base = { found: true, actionType: log.actionType, entityType: log.entityType, entityId: log.entityId, changeSetId: log.executionId, at: log.createdAt }
  if (log.rolledBackAt) return { ...base, eligible: false, reason: 'Already undone.' }
  if (isArchiveLog(log)) return { ...base, eligible: false, reason: ARCHIVE_IS_FINAL }
  if (log.amazonResponseStatus !== 'SUCCESS' && log.amazonResponseStatus !== 'PENDING') {
    // Nothing reached Amazon, so there is nothing to put back.
    return { ...base, eligible: false, reason: `This change never landed (${log.amazonResponseStatus ?? 'unknown'}) — there is nothing to reverse.` }
  }
  if (Date.now() - log.createdAt.getTime() > rollbackWindowMsFor(log.actionType)) {
    return {
      ...base,
      eligible: false,
      reason: `Older than the ${rollbackWindowLabel(log.actionType)} undo window for this kind of change. Amazon's own state has usually moved on, so restoring an old snapshot can do more harm than the change it reverses.`,
    }
  }
  // A grouped row reverses with its whole set, and the SET's horizon is the flat one — so the
  // count must use the same window the set rollback will, or this would promise more rows than
  // that path is willing to touch.
  const groupedWith = log.executionId
    ? await prisma.advertisingActionLog.count({ where: { executionId: log.executionId, rolledBackAt: null, createdAt: { gte: new Date(Date.now() - ROLLBACK_WINDOW_MS) } } })
    : 1
  return { ...base, eligible: true, groupedWith }
}

export async function rollbackByActionLogId(args: {
  actionLogId: string
  actor: AdsActor
  reason: string
  /** 1e — the Undo button: a person's click (see reverseOne). Set only by the routes. */
  manual?: boolean
  /** AA-W2-9 — the change set the reversal's own writes carry (see reverseOne). */
  stampChangeSetId?: string | null
}): Promise<RollbackOutcome> {
  const log = await prisma.advertisingActionLog.findUnique({ where: { id: args.actionLogId } })
  if (!log) return { ok: false, reversed: 0, skipped: 0, failed: 0, details: [], reason: 'That change no longer exists.' }
  // A grouped row reverses with its set, so the entity never lands in a state that never existed.
  if (log.executionId) return rollbackByChangeSetId({ changeSetId: log.executionId, actor: args.actor, reason: args.reason, manual: args.manual, stampChangeSetId: args.stampChangeSetId })

  const out: RollbackOutcome = { ok: true, reversed: 0, skipped: 0, failed: 0, details: [] }
  if (log.rolledBackAt) { out.skipped = 1; out.reason = 'Already undone.'; return out }
  if (Date.now() - log.createdAt.getTime() > rollbackWindowMsFor(log.actionType)) {
    out.expired = true; out.windowHours = rollbackWindowMsFor(log.actionType) / 3_600_000
    out.reason = `Older than the ${rollbackWindowLabel(log.actionType)} undo window for this kind of change.`
    return out
  }
  const r = await reverseOne(log as never, args.actor, args.reason, args.manual === true, args.stampChangeSetId ?? null)
  const base = { actionLogId: log.id, actionType: log.actionType, entityType: log.entityType, entityId: log.entityId }
  // CM-22 — a no-op (`ok` with `skipped`) is skipped, not reversed, and the row is not marked undone.
  if (r.ok && !r.skipped) {
    out.reversed = 1
    out.details.push({ ...base, outcome: 'REVERSED' })
    await prisma.advertisingActionLog.update({ where: { id: log.id }, data: { rolledBackAt: new Date(), rollbackReason: args.reason } }).catch(() => {})
  } else if (r.skipped) {
    out.skipped = 1
    out.details.push({ ...base, outcome: 'SKIPPED', reason: r.reason })
  } else {
    out.failed = 1; out.ok = false; out.reason = r.reason
    out.details.push({ ...base, outcome: 'FAILED', reason: r.reason })
  }
  return noteNothingToUndo(out, r.reason)
}

/** ADS AUTONOMY W3-1 — the ids of every write a change set holds (read only), for a step to tell its own writes apart. */
export async function writesOfChangeSet(changeSetId: string): Promise<string[]> {
  const rows = await prisma.advertisingActionLog.findMany({ where: { executionId: changeSetId }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function rollbackByChangeSetId(args: {
  changeSetId: string
  actor: AdsActor
  reason: string
  /** 1e — an Undo a person clicked (see reverseOne). Set only by the routes. */
  manual?: boolean
  /** AA-W2-9 — the change set the reversal's own writes carry (see reverseOne); never the set it reverses. */
  stampChangeSetId?: string | null
  /**
   * ADS AUTONOMY W3-1 — only these writes of the set (one step of a change plan: its writes share the plan's set).
   * Absent: every write of the set, as before.
   */
  actionLogIds?: string[] | null
}): Promise<RollbackOutcome> {
  const logs = await prisma.advertisingActionLog.findMany({
    where: {
      executionId: args.changeSetId,
      ...(args.actionLogIds ? { id: { in: args.actionLogIds } } : {}),
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
  const stamp = args.stampChangeSetId && args.stampChangeSetId !== args.changeSetId ? args.stampChangeSetId : null
  for (const log of logs) {
    const r = await reverseOne(log, args.actor, args.reason, args.manual === true, stamp)
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
  return noteNothingToUndo(out, out.details.find((d) => d.outcome === 'SKIPPED')?.reason)
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
  /** 1e — a Rollback a person clicked (see reverseOne). Set only by the routes. */
  manual?: boolean
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
    const r = await reverseOne(log, args.actor, args.reason, args.manual === true)
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

  return noteNothingToUndo(out, out.details.find((d) => d.outcome === 'SKIPPED')?.reason)
}
