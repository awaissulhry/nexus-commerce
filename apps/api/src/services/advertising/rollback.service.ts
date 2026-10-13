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
import { NON_CHANGE_ACTION_TYPES } from './ads-engine-actors.js'
import type { AdWriteEvidence } from './ads-evidence.js'
import { sameToTheCent } from './same-value.js'

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
  /**
   * Editing correctness (group 3) — a person's Undo (`onlyIfStillStands`): how many rows were NOT put back because their
   * change no longer stands (changedSinceUndo). Each is a SKIPPED detail whose reason starts "Changed since: now …";
   * when nothing was reversed, `ok` is false and `reason` is the first of them.
   */
  changedSince?: number
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
  /** W4-11 — the queue row this write went out on (wasSbSdWrite reads its `sbSd` mark). */
  outboundQueueId?: string | null
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
  if (out.reversed > 0 || out.failed > 0 || out.skipped === 0 || out.changedSince) return out
  out.nothingToUndo = true
  if (!out.reason) out.reason = `Nothing to undo: ${why || 'this change left nothing that can be put back.'}`
  return out
}

/**
 * ADS AUTONOMY W4-11 — the write this row records was a Sponsored Brands / Display write the mutation layer let through
 * for a Claude request: its queue row carries `sbSd` (ads-mutation.service.ts EnqueueArgs.sbSd). Read off that row only.
 */
export async function wasSbSdWrite(log: { outboundQueueId?: string | null }): Promise<boolean> {
  if (!log.outboundQueueId) return false
  const row = await prisma.outboundSyncQueue.findUnique({ where: { id: log.outboundQueueId }, select: { payload: true } }).catch(() => null)
  return (row?.payload as { sbSd?: unknown } | null | undefined)?.sbSd === true
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
  /**
   * ADS AUTONOMY W4-11 — undo-ad-change asks for it: the reversal of a Sponsored Brands / Display write goes back on the
   * same SB/SD route as the write it reverses (`allowSbSd`), but only for a write the mutation layer let through for a
   * Claude request (its queue row carries `sbSd`, sbSdWriteOf). Every other caller and write stays Sponsored Products only.
   */
  sbSd = false,
  /**
   * ADS AUTONOMY (auto-undo) — the reversal waits out the mutation layer's 5-minute grace window (holdUntil), as any
   * engine write does, so a person can still cancel it (cancel-queued-ad-write) before it reaches Amazon. Every other
   * caller sends at once, as before. A placement write has no queue: it goes at once either way.
   */
  hold = false,
  /**
   * Bid page R4 — what reverseRuleWrite asks of a keyword's or ad group's reversal, and nothing else does: `evidence` on its
   * action log row (`undoOf`: the row it puts back), and `askGate` — the write gate asked before Nexus writes its copy, so
   * a refusal (the halt, a locked campaign, the brain running the campaign now) writes nothing and says why. Absent: as before.
   */
  opts: {
    evidence?: AdWriteEvidence | null
    askGate?: boolean
    /**
     * Editing correctness (group 3) — a person's Undo (onlyIfStillStands): the reversal's local write is compare-and-set
     * on the values this change set (the mutation layer's `expected`): a write that lands after the check and before this
     * one leaves it unwritten and unqueued, answered as `changedSince` with "Changed since: now …".
     */
    expectAfter?: boolean
  } = {},
): Promise<{ ok: boolean; reason?: string; skipped?: boolean; actionLogId?: string | null; changedSince?: boolean }> {
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
        applyImmediately: !hold,
        manual,
        changeSetId,
        ...(sbSd && (await wasSbSdWrite(log)) ? { allowSbSd: true } : {}), // W4-11
        ...(opts.expectAfter ? { expected: expectedAfter(log, Object.keys(patch)) } : {}),
      })
      if (!result.ok && result.changedSince) return { ok: false, changedSince: true, reason: await changedSinceWords(log, Object.keys(patch)) }
      return result.ok ? { ok: true, actionLogId: result.actionLogId ?? null } : { ok: false, reason: result.error ?? 'unknown' }
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
        applyImmediately: !hold,
        manual,
        reversal: true,
        changeSetId,
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
        ...(opts.askGate ? { askGate: true } : {}),
        ...(opts.expectAfter ? { expected: expectedAfter(log, Object.keys(patch)) } : {}),
      })
      if (!result.ok && result.changedSince) return { ok: false, changedSince: true, reason: await changedSinceWords(log, Object.keys(patch)) }
      if (result.ok) await restoreFloorMemory(log, before)
      return result.ok ? { ok: true, actionLogId: result.actionLogId ?? null } : { ok: false, reason: result.error ?? 'unknown' }
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
        applyImmediately: !hold,
        manual,
        reversal: true,
        changeSetId,
        ...(sbSd && (await wasSbSdWrite(log)) ? { allowSbSd: true } : {}), // W4-11
        // Negative Targeting — the Undo of the very pause that set a kept-paused hold releases it (a person's Undo only: the
        // lock honours a release for a person). Any other rollback — a bulk-sheet upload's, an older change's — that would
        // switch a kept-paused keyword back on is refused by the lock in updateAdTargetWithSync, and says so.
        ...(patch.status === 'ENABLED' && after.keptPaused === true ? { releaseKeptPaused: true } : {}),
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
        ...(opts.askGate ? { askGate: true } : {}),
        ...(opts.expectAfter ? { expected: expectedAfter(log, Object.keys(patch)) } : {}),
      })
      if (!result.ok && result.changedSince) return { ok: false, changedSince: true, reason: await changedSinceWords(log, Object.keys(patch)) }
      if (result.ok) await restoreFloorMemory(log, before)
      return result.ok ? { ok: true, actionLogId: result.actionLogId ?? null } : { ok: false, reason: result.error ?? 'unknown' }
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
  /** W4-11 — undo-ad-change: an SB/SD write a Claude request made goes back on its own route (see reverseOne). */
  allowSbSd?: boolean
  /**
   * Editing correctness (group 3) — a person's Undo button (the change feed, the Bid page, the keyword tracker): a row is
   * put back only while its change still stands (changedSinceUndo), else it is refused with "Changed since: now …" and
   * nothing is written. Set only by those routes; a Claude request's undo-ad-change says in its preview that it
   * overwrites a newer value, and keeps doing so.
   */
  onlyIfStillStands?: boolean
}): Promise<RollbackOutcome> {
  const log = await prisma.advertisingActionLog.findUnique({ where: { id: args.actionLogId } })
  if (!log) return { ok: false, reversed: 0, skipped: 0, failed: 0, details: [], reason: 'That change no longer exists.' }
  // A grouped row reverses with its set, so the entity never lands in a state that never existed.
  if (log.executionId) return rollbackByChangeSetId({ changeSetId: log.executionId, actor: args.actor, reason: args.reason, manual: args.manual, stampChangeSetId: args.stampChangeSetId, allowSbSd: args.allowSbSd, onlyIfStillStands: args.onlyIfStillStands })

  const out: RollbackOutcome = { ok: true, reversed: 0, skipped: 0, failed: 0, details: [] }
  if (log.rolledBackAt) { out.skipped = 1; out.reason = 'Already undone.'; return out }
  if (Date.now() - log.createdAt.getTime() > rollbackWindowMsFor(log.actionType)) {
    out.expired = true; out.windowHours = rollbackWindowMsFor(log.actionType) / 3_600_000
    out.reason = `Older than the ${rollbackWindowLabel(log.actionType)} undo window for this kind of change.`
    return out
  }
  const base = { actionLogId: log.id, actionType: log.actionType, entityType: log.entityType, entityId: log.entityId }
  const moved = args.onlyIfStillStands ? await changedSinceUndo([log]) : null
  if (moved) {
    out.ok = false; out.skipped = 1; out.changedSince = 1; out.reason = moved
    out.details.push({ ...base, outcome: 'SKIPPED', reason: moved })
    return out
  }
  const r = await reverseOne(log as never, args.actor, args.reason, args.manual === true, args.stampChangeSetId ?? null, args.allowSbSd === true, false, { expectAfter: args.onlyIfStillStands === true })
  if (r.changedSince) {
    out.ok = false; out.skipped = 1; out.changedSince = 1; out.reason = r.reason
    out.details.push({ ...base, outcome: 'SKIPPED', reason: r.reason })
    return out
  }
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


/**
 * ADS AUTONOMY (auto-undo) — does this write still stand: no later write on its entity (one that failed at Amazon set
 * nothing), and the entity holds now what it set? Null when it stands, else why not, in words.
 */
export async function judgedWriteStands(log: { id: string; entityType: string; entityId: string; actionType: string; payloadAfter: unknown; createdAt: Date }): Promise<string | null> {
  const later = await prisma.advertisingActionLog.count({
    where: {
      entityType: log.entityType, entityId: log.entityId, id: { not: log.id }, createdAt: { gt: log.createdAt },
      // A row that records something other than a change (a would-do, a receipt) is never a later change.
      actionType: { notIn: [...NON_CHANGE_ACTION_TYPES] },
      OR: [{ amazonResponseStatus: null }, { amazonResponseStatus: { not: 'FAILED' } }],
    },
  })
  if (later) return `a later change on the same ${log.entityType.toLowerCase().replace('_', ' ')} superseded it (${later} since)`
  const after = (log.payloadAfter ?? {}) as Record<string, unknown>
  const same = (a: unknown, b: unknown) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005
  if (log.actionType === 'update_placement_bidding') {
    const c = await prisma.campaign.findUnique({ where: { id: log.entityId }, select: { dynamicBidding: true } })
    const now = ((c?.dynamicBidding as { placementBidding?: Array<{ placement?: string; percentage?: number }> } | null)?.placementBidding) ?? []
    const wrote = Array.isArray(after.adjustments) ? (after.adjustments as Array<{ placement?: string; percentage?: number }>) : []
    const holds = c && wrote.every((w) => (now.find((n) => n.placement === w.placement)?.percentage ?? 0) === (w.percentage ?? 0))
    return holds ? null : 'the campaign\'s placements are no longer what this change set'
  }
  if (log.entityType === 'AD_TARGET') {
    const t = await prisma.adTarget.findUnique({ where: { id: log.entityId }, select: { bidCents: true } })
    return t && same(t.bidCents, after.bidCents) ? null : 'the bid is no longer what this change set'
  }
  if (log.entityType === 'AD_GROUP') {
    const g = await prisma.adGroup.findUnique({ where: { id: log.entityId }, select: { defaultBidCents: true } })
    return g && same(g.defaultBidCents, after.defaultBidCents) ? null : 'the ad group\'s default bid is no longer what this change set'
  }
  if (log.entityType === 'CAMPAIGN') {
    const c = await prisma.campaign.findUnique({ where: { id: log.entityId }, select: { dailyBudget: true } })
    return c && same(c.dailyBudget, after.dailyBudget) ? null : 'the daily budget is no longer what this change set'
  }
  return `a ${log.entityType} write is not one auto-undo puts back`
}

/**
 * Editing correctness (group 3) — the fields reverseOne writes back, per entity: what a person's Undo would overwrite.
 * `placements` stands for a placement change's adjustments (update_placement_bidding).
 */
const UNDO_FIELDS: Record<string, readonly string[]> = {
  AD_TARGET: ['bidCents', 'status'],
  AD_GROUP: ['defaultBidCents', 'status'],
  CAMPAIGN: ['dailyBudget', 'dailyBudgetCurrency', 'status', 'biddingStrategy', 'endDate', 'name', 'portfolioId'],
}

type StandRow = { id: string; entityType: string; entityId: string; actionType: string; payloadBefore: unknown; payloadAfter: unknown; createdAt: Date }
type Payload = Record<string, unknown>
type Placements = Array<{ placement?: string; percentage?: number }>

/**
 * One value, as the action log and the entity hold it: a number to the cent (a budget is "20.00" in one, 20 in the other;
 * a 3-decimal €1.005 logged before writes were rounded is the €1.01 Nexus holds), a date as ISO.
 */
const sameValue = sameToTheCent
function samePlacements(a: unknown, b: unknown): boolean {
  const list = (p: unknown): Placements => (Array.isArray(p) ? (p as Placements) : [])
  const x = list(a)
  const y = list(b)
  const pct = (l: Placements, placement: string | undefined) => l.find((n) => n.placement === placement)?.percentage ?? 0
  return [...x, ...y].every((p) => pct(x, p.placement) === pct(y, p.placement))
}

/** The fields one action log row changed, of those its Undo writes back. */
function undoFieldsOf(row: Pick<StandRow, 'entityType' | 'actionType' | 'payloadBefore' | 'payloadAfter'>): string[] {
  const before = (row.payloadBefore ?? {}) as Payload
  const after = (row.payloadAfter ?? {}) as Payload
  if (row.actionType === 'update_placement_bidding') return Array.isArray(after.adjustments) && !samePlacements(before.adjustments, after.adjustments) ? ['placements'] : []
  return (UNDO_FIELDS[row.entityType] ?? []).filter((f) => (f in before || f in after) && !sameValue(before[f], after[f]))
}

const money = (amount: number, currency: string | null | undefined): string => {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'EUR' }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim()
  }
}
/** A value as the person reads it ("bid €0.45", "status paused", "daily budget €12.00"). */
function valueWords(entityType: string, field: string, value: unknown, currency: string | null): string {
  const n = Number(value)
  if (field === 'bidCents' || field === 'defaultBidCents') {
    return `${entityType === 'AD_GROUP' ? 'default bid' : 'bid'} ${value == null || !Number.isFinite(n) ? 'none' : money(n / 100, currency)}`
  }
  if (field === 'dailyBudget') return `daily budget ${value == null || !Number.isFinite(n) ? 'none' : money(n, currency)}`
  if (field === 'placements') {
    const list = (Array.isArray(value) ? value : []) as Placements
    return `placements ${list.length ? list.map((p) => `${String(p.placement ?? '').replace(/^PLACEMENT_/, '').toLowerCase().replace(/_/g, ' ')} ${p.percentage ?? 0} %`).join(', ') : 'none'}`
  }
  const label: Record<string, string> = { dailyBudgetCurrency: 'currency', biddingStrategy: 'bidding strategy', endDate: 'end date', portfolioId: 'portfolio' }
  const shown = value == null || value === '' ? 'none' : field === 'endDate' ? String(value).slice(0, 10) : field === 'status' ? String(value).toLowerCase() : String(value)
  return `${label[field] ?? field} ${field === 'name' && shown !== 'none' ? `"${shown}"` : shown}`
}

/** The entity as it is now: the values an Undo writes back (UNDO_FIELDS, its placements), and its money's currency. */
async function currentValues(entityType: string, entityId: string): Promise<{ values: Payload; currency: string | null } | null> {
  if (entityType === 'AD_TARGET') {
    const t = await prisma.adTarget.findUnique({ where: { id: entityId }, select: { bidCents: true, status: true, adGroup: { select: { campaign: { select: { dailyBudgetCurrency: true } } } } } })
    return t ? { values: { bidCents: t.bidCents, status: t.status }, currency: t.adGroup?.campaign?.dailyBudgetCurrency ?? null } : null
  }
  if (entityType === 'AD_GROUP') {
    const g = await prisma.adGroup.findUnique({ where: { id: entityId }, select: { defaultBidCents: true, status: true, campaign: { select: { dailyBudgetCurrency: true } } } })
    return g ? { values: { defaultBidCents: g.defaultBidCents, status: g.status }, currency: g.campaign?.dailyBudgetCurrency ?? null } : null
  }
  if (entityType === 'CAMPAIGN') {
    const c = await prisma.campaign.findUnique({
      where: { id: entityId },
      select: { dailyBudget: true, dailyBudgetCurrency: true, status: true, biddingStrategy: true, endDate: true, name: true, portfolioId: true, dynamicBidding: true },
    })
    if (!c) return null
    const { dynamicBidding, ...rest } = c
    const placements = (dynamicBidding as { placementBidding?: Placements } | null)?.placementBidding ?? []
    return {
      values: { ...rest, dailyBudget: Number(c.dailyBudget), endDate: c.endDate?.toISOString() ?? null, placements },
      currency: c.dailyBudgetCurrency ?? null,
    }
  }
  return null
}

/** The refusal's words: each field as the entity holds it now. */
async function refusalWords(entityType: string, entityId: string, fields: readonly string[]): Promise<string> {
  const now = await currentValues(entityType, entityId)
  const words = now ? fields.map((f) => valueWords(entityType, f, now.values[f], now.currency)).join(', ') : 'something else'
  return `Changed since: now ${words}. Undo would overwrite that newer change, so nothing was put back.`
}

/** The values a reversal's compare-and-set expects (the mutation layer's `expected`): what this change set, field by field. */
function expectedAfter(log: AdLog, fields: readonly string[]): Record<string, number | string | null> {
  const after = (log.payloadAfter ?? {}) as Payload
  return Object.fromEntries(fields.map((f) => [f, (after[f] ?? null) as number | string | null]))
}

/** A reversal the compare-and-set refused (a write landed between the check and the write): its words, as the check's. */
function changedSinceWords(log: AdLog, fields: readonly string[]): Promise<string> {
  return refusalWords(log.entityType, log.entityId, fields)
}

/**
 * Editing correctness (group 3) — a person's Undo puts the old value back only while the change still stands, judged on
 * the VALUE, field by field for the fields the change wrote (the only ones its Undo writes back, so a later pause does
 * not hold back the Undo of a bid). It stands when, for each of them,
 *   · the entity holds now what the change set, and
 *   · the newest later write of that field that still counts left it there: a write undone since (rolledBackAt) does
 *     not count, nor does one that set nothing (failed, refused, cancelled); its reversal is a write like any other and
 *     put the value back.
 * So undoing newest-first works (B undone, then A: B's reversal left A's value), and so does a bid moved away and back
 * (50 → 30 → 50: the newest write left 50); a newer value is never overwritten. The same compare-and-set as auto-undo
 * and a rule's undo (judgedWriteStands), which refuse on any later row instead.
 * `rows`: the change's own rows on ONE entity — one row, or every row of one change set on that entity (they are
 * judged together: none of them is a later change of the others, and the newest says what the set left).
 * Null when it stands, else the refusal in words: "Changed since: now bid €0.45. …". Rows of an entity or a change
 * the Undo does not write back (a create, a retail event, a product ad) are not judged here: null. The reversal's own
 * local write is compare-and-set on the same values (reverseOne `expectAfter`).
 */
export async function changedSinceUndo(rows: StandRow[]): Promise<string | null> {
  if (!rows.length) return null
  const { entityType, entityId } = rows[0]!
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const judged = ordered.filter((r) => !r.actionType.startsWith('create_') && !r.actionType.startsWith('bulksheet_create_'))
  const fields = [...new Set(judged.flatMap(undoFieldsOf))]
  if (!fields.length) return null
  // What the change(s) left: each field as the newest row that wrote it set it.
  const expected: Payload = {}
  for (const r of judged) {
    const after = (r.payloadAfter ?? {}) as Payload
    for (const f of fields) {
      if (f === 'placements') { if (Array.isArray(after.adjustments)) expected.placements = after.adjustments }
      else if (f in after) expected[f] = after[f]
    }
  }
  const later = await prisma.advertisingActionLog.findMany({
    where: {
      entityType, entityId, createdAt: { gt: ordered[0]!.createdAt }, id: { notIn: rows.map((r) => r.id) },
      rolledBackAt: null,
      actionType: { notIn: [...NON_CHANGE_ACTION_TYPES] },
      OR: [{ amazonResponseStatus: null }, { amazonResponseStatus: { notIn: ['FAILED', 'SKIPPED', 'CANCELLED'] } }],
    },
    select: { entityType: true, actionType: true, payloadBefore: true, payloadAfter: true },
    orderBy: { createdAt: 'asc' },
  })
  const same = (f: string, a: unknown, b: unknown) => (f === 'placements' ? samePlacements(a, b) : sameValue(a, b))
  // The newest later write of each field left it where this change did, or not.
  const leftElsewhere = fields.filter((f) => {
    const newest = [...later].reverse().find((r) => undoFieldsOf(r).includes(f))
    if (!newest) return false
    const after = (newest.payloadAfter ?? {}) as Payload
    return !same(f, f === 'placements' ? after.adjustments : after[f], expected[f])
  })
  const now = await currentValues(entityType, entityId)
  if (!now) return null // the entity is gone: reverseOne answers that in its own words
  const moved = fields.filter((f) => !same(f, now.values[f], expected[f]))
  const changed = fields.filter((f) => moved.includes(f) || leftElsewhere.includes(f))
  if (!changed.length) return null
  return refusalWords(entityType, entityId, changed)
}

/**
 * ADS AUTONOMY (auto-undo) — put back ONE recorded write that auto-undo judged clearly worse (ads-auto-undo.service.ts),
 * at AUTO or once a person approved undo-worse-ad-change. The same Undo as everywhere (reverseOne): the mutation layer,
 * its write gate, the ads audit row ("rollback: …") and the original row marked undone (rolledBackAt). Three things
 * differ, each on purpose:
 *   · one row only, never its whole change set: the judgement is of this write alone (the rest of its set stands);
 *   · no 24-hour / 7-day undo window: that window keeps an old value from overwriting what has moved since. Here the
 *     write is judged days later by design, so this checks exactly that instead, right before writing (compare-and-set,
 *     judgedWriteStands): a later write on the entity, or a value that moved, refuses it (`superseded`), nothing written;
 *   · `hold`: the reversal waits out the 5-minute grace window, so a person can still cancel it (cancel-queued-ad-write).
 */
export async function reverseJudgedWrite(args: {
  actionLogId: string
  actor: AdsActor
  reason: string
  /** A person approved it (undo-worse-ad-change): his click, as approvedRun says. Never set at AUTO. */
  manual?: boolean
  /** The approved request's id (its writes carry it, so undo-ad-change of it puts the engine's value back). */
  changeSetId?: string | null
}): Promise<{ ok: true; actionLogId: string | null } | { ok: false; reason: string; superseded?: boolean }> {
  const log = await prisma.advertisingActionLog.findUnique({ where: { id: args.actionLogId } })
  if (!log) return { ok: false, reason: 'That change no longer exists.' }
  if (log.rolledBackAt) return { ok: false, reason: 'It was undone already.', superseded: true }
  const moved = await judgedWriteStands(log)
  if (moved) return { ok: false, reason: `Not undone: ${moved}.`, superseded: true }
  const r = await reverseOne(log as never, args.actor, args.reason, args.manual === true, args.changeSetId ?? null, false, true)
  if (!r.ok || r.skipped) return { ok: false, reason: r.reason ?? 'the undo was refused' }
  await prisma.advertisingActionLog.update({ where: { id: log.id }, data: { rolledBackAt: new Date(), rollbackReason: args.reason } }).catch(() => {})
  return { ok: true, actionLogId: r.actionLogId ?? null }
}

/**
 * Bid page R4 (2026-10-11) — put back ONE write a rule's approved ask made, AS THE RULE (bid-rules/ask-undo.ts). The ask was
 * the rule's decision a person agreed to, and its write carries the rule's actor; so does its undo: the bid (or state) it
 * replaced goes back through reverseOne with `automation:<ruleId>`, never a person's actor and never `manual`. It is
 * therefore no person's write anywhere: no BidHold (bid-brain/brain-holds.ts recordBrainHold reads only a person's write),
 * not a person's bid of the last 60 days (bid-grid.service.ts personBidTargetIds), not "You" as a bid's owner. The shared
 * Undo route and every other caller are unchanged: this is its own entry, with its own checks:
 *   · only the rule's own write (its actor), not undone yet, inside the undo window of its kind (rollbackWindowMsFor);
 *   · it still stands (judgedWriteStands, as auto-undo): a later change on the keyword, or a value that moved, refuses it —
 *     putting the old value back would overwrite a newer decision;
 *   · the largest change of one step (the campaign's and the ads strategy's, the clamp every automatic bid write takes)
 *     must allow the way back whole: otherwise refused, never written part of the way;
 *   · the write gate is asked before Nexus writes its copy (askGate): a refusal writes nothing and says why.
 * Its action log row carries `evidence.undoOf` (the row it puts back), and the row it puts back is marked undone, so the
 * Bid page folds the two away (bid-owner.ts withoutUndonePairs): the owner is again the one before the approval.
 */
export async function reverseRuleWrite(args: { actionLogId: string; ruleId: string; reason: string; now?: Date }): Promise<
  /** `nothing`: why nothing had to be put back (the change never reached Amazon and the value is back, or it changed nothing). */
  { ok: true; actionLogId: string | null; nothing?: string } | { ok: false; reason: string }
> {
  const log = await prisma.advertisingActionLog.findUnique({ where: { id: args.actionLogId } })
  if (!log) return { ok: false, reason: 'That change no longer exists.' }
  const actor = `automation:${args.ruleId}` as AdsActor
  if (log.userId !== actor && log.userId !== `automation:${actor}`) return { ok: false, reason: 'This change was not written by this rule, so it is not undone as the rule.' }
  if (log.rolledBackAt) return { ok: false, reason: 'It was undone already.' }
  const now = args.now ?? new Date()
  // A write that never reached Amazon (cancelled before it was sent — an archive cancels the rule's queued writes —, refused,
  // replaced, failed) whose value Nexus already holds again: nothing to put back.
  if (log.amazonResponseStatus !== 'SUCCESS' && log.amazonResponseStatus !== 'PENDING') {
    const before = (log.payloadBefore ?? {}) as Record<string, unknown>
    const back = log.entityType === 'AD_TARGET'
      ? await prisma.adTarget.findUnique({ where: { id: log.entityId }, select: { bidCents: true, status: true } })
      : null
    if (back && (before.bidCents == null || back.bidCents === before.bidCents) && (before.status == null || back.status === before.status)) {
      return { ok: true, actionLogId: null, nothing: `Its change never reached Amazon (${String(log.amazonResponseStatus ?? 'not sent').toLowerCase()}) and the value is already back, so nothing had to be put back.` }
    }
  }
  if (now.getTime() - log.createdAt.getTime() > rollbackWindowMsFor(log.actionType)) {
    return { ok: false, reason: `Older than the ${rollbackWindowLabel(log.actionType)} undo window for this kind of change: Amazon's own state has usually moved on since. Nothing was written.` }
  }
  const moved = await judgedWriteStands(log)
  if (moved) return { ok: false, reason: `Not put back: ${moved}, and putting the old value back would overwrite that. Nothing was written.` }
  const before = (log.payloadBefore ?? {}) as Record<string, unknown>
  const after = (log.payloadAfter ?? {}) as Record<string, unknown>
  if (log.entityType === 'AD_TARGET' && typeof before.bidCents === 'number' && before.bidCents !== after.bidCents) {
    const t = await prisma.adTarget.findUnique({ where: { id: log.entityId }, select: { bidCents: true, adGroupId: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true, dynamicBidding: true } } } } } })
    const c = t?.adGroup?.campaign
    if (t && c) {
      const { bidLimitsFor, stepClamp } = await import('./ads-strategy/bids.js')
      const step = stepClamp(t.bidCents, before.bidCents, c.dynamicBidding, await bidLimitsFor({ marketplace: c.marketplace, adGroupId: t.adGroupId, campaignId: c.id }))
      if (step.cents !== before.bidCents) {
        const whose = step.by === 'strategy' ? 'the ads strategy' : 'the campaign'
        return { ok: false, reason: `Not put back: the largest change of one step (${step.pct != null ? `${step.pct} %, ` : ''}${whose}) holds the way back from ${t.bidCents}¢ to ${before.bidCents}¢ at ${step.cents}¢. Nothing was written; change the bid by hand if you want it back.` }
      }
    }
  }
  const r = await reverseOne(log as never, actor, args.reason, false, null, false, false, { evidence: { undoOf: log.id }, askGate: true })
  if (r.ok && r.skipped) return { ok: true, actionLogId: null, nothing: 'The approval changed nothing, so nothing had to be put back.' }
  if (!r.ok) return { ok: false, reason: r.reason ?? 'the undo was refused' }
  await prisma.advertisingActionLog.update({ where: { id: log.id }, data: { rolledBackAt: now, rollbackReason: args.reason } })
  return { ok: true, actionLogId: r.actionLogId ?? null }
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
  /** W4-11 — undo-ad-change: an SB/SD write a Claude request made goes back on its own route (see reverseOne). */
  allowSbSd?: boolean
  /**
   * Editing correctness (group 3) — a person's Undo button (see rollbackByActionLogId): each entity of the set is put back
   * only while what the set did to it still stands (changedSinceUndo, judged before anything is written); the rows of
   * an entity changed since are refused with "Changed since: now …", the others are still put back.
   */
  onlyIfStillStands?: boolean
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
  // Editing correctness (group 3) — judged per entity before the first write: the reversals' own rows are later writes.
  const movedOf = args.onlyIfStillStands ? await changedSinceByEntity(logs) : new Map<string, string | null>()
  for (const log of logs) {
    const base = { actionLogId: log.id, actionType: log.actionType, entityType: log.entityType, entityId: log.entityId }
    const moved = movedOf.get(`${log.entityType}:${log.entityId}`)
    if (moved) {
      out.skipped += 1
      out.changedSince = (out.changedSince ?? 0) + 1
      out.details.push({ ...base, outcome: 'SKIPPED', reason: moved })
      continue
    }
    const r = await reverseOne(log, args.actor, args.reason, args.manual === true, stamp, args.allowSbSd === true, false, { expectAfter: args.onlyIfStillStands === true })
    if (r.changedSince) {
      out.skipped += 1
      out.changedSince = (out.changedSince ?? 0) + 1
      out.details.push({ ...base, outcome: 'SKIPPED', reason: r.reason })
      continue
    }
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
  noteChangedSince(out, logs.length)
  return noteNothingToUndo(out, out.details.find((d) => d.outcome === 'SKIPPED')?.reason)
}

/**
 * Editing correctness (group 3) — the answer of an Undo some rows of which no longer stood: nothing put back → not ok, and
 * the first refusal is the reason; some put back → "N of M changes not undone. Changed since: now …".
 */
function noteChangedSince(out: RollbackOutcome, total: number): void {
  if (!out.changedSince) return
  const first = out.details.find((d) => d.reason?.startsWith('Changed since:'))?.reason ?? 'Changed since.'
  if (out.reversed === 0) { out.ok = false; out.reason ??= first }
  else out.reason ??= `${out.changedSince} of ${total} changes not undone. ${first}`
}

/** Editing correctness (group 3) — each entity's rows of one Undo, judged before the first write (changedSinceUndo). */
async function changedSinceByEntity(logs: StandRow[]): Promise<Map<string, string | null>> {
  const byEntity = new Map<string, StandRow[]>()
  for (const log of logs) {
    const key = `${log.entityType}:${log.entityId}`
    byEntity.set(key, [...(byEntity.get(key) ?? []), log])
  }
  const out = new Map<string, string | null>()
  for (const [key, rows] of byEntity) out.set(key, await changedSinceUndo(rows))
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
  /** 1e — a Rollback a person clicked (see reverseOne). Set only by the routes. */
  manual?: boolean
  /**
   * Editing correctness (group 3) — a person's Rollback of a rule run: per entity, only what still stands is put back
   * (see rollbackByChangeSetId); the rest is refused with "Changed since: now …".
   */
  onlyIfStillStands?: boolean
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

  // Editing correctness (group 3) — judged per entity before the first write, as rollbackByChangeSetId.
  const movedOf = args.onlyIfStillStands ? await changedSinceByEntity(logs) : new Map<string, string | null>()
  for (const log of logs) {
    const base = { actionLogId: log.id, actionType: log.actionType, entityType: log.entityType, entityId: log.entityId }
    const moved = movedOf.get(`${log.entityType}:${log.entityId}`)
    const r = moved
      ? { ok: false, changedSince: true, reason: moved, skipped: false }
      : await reverseOne(log, args.actor, args.reason, args.manual === true, null, false, false, { expectAfter: args.onlyIfStillStands === true })
    if (r.changedSince) {
      out.skipped += 1
      out.changedSince = (out.changedSince ?? 0) + 1
      out.details.push({ ...base, outcome: 'SKIPPED', reason: r.reason })
      continue
    }
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

  noteChangedSince(out, logs.length)
  return noteNothingToUndo(out, out.details.find((d) => d.outcome === 'SKIPPED')?.reason)
}
