/**
 * MCP full control A6–A10, A12 (docs/mcp-full-control/sections/01-ads.md §3, §6) — Claude's Amazon ad change tools
 * beyond the fleet's three (ads-propose.tools.ts). Every one follows the rules in ads-change-kit.ts: preview first
 * with the A3 guards, refused and not queued when Amazon's write gate would refuse it, run only as an approved
 * request (as the approver, changeSetId = the approval), re-checked in `execute`, and never pausing anything (d3).
 *
 * ADS AUTONOMY AA-W2-8 — set-campaign-budget and set-placement-multipliers are strategy-bound (tool-types.ts
 * StrategyBound): a business may let them run by its rule, only inside the tool's limits and the ads strategy where the
 * change lands (ads-autonomy-kit.ts C1–C7, the month's forecast for a budget raise) and only where Amazon's write gate
 * lets the rule's own write through (ruleFactsFor's `ruleGate`: the allowlist, pins, a halt and his own limits bind a
 * run by rule).
 *
 *   set-campaign-budget (A6)        a campaign's daily budget, in its own currency; the campaign's budget bounds and
 *                                   (live) the gate's value cap, spend ceilings and daily budget-movement bound refuse
 *   set-placement-multipliers (A6)  top-of-search / product-pages / rest-of-search adjustments (0–900 %)
 *   bulk-ad-bid-change (A7)         up to 500 target bids in one request — a list, or a selection moved by a percent;
 *                                   every exclusion counted by its reason; one change set, undone as one. AA-W2-6 —
 *                                   strategy-bound: every row is checked against the ads strategy of its own ad group,
 *                                   so the business may let it run by its rule (one run of its daily cap)
 *   suppress-campaign (A8)          the no-pause stop: every bid of the campaign to the 2-cent floor, remembered
 *   restore-campaign (A8)           puts the remembered bids back — only a suppression a person set (`user:`), never an
 *                                   engine's
 *   set-campaign-live-writes (A12)  the per-campaign live-write allowlist (d2): only an allowlisted campaign takes a
 *                                   live write. A Nexus switch (no Amazon call); by rule only off, or on for a campaign
 *                                   a Claude request created (AA-W2-9)
 *   undo-ad-change (A10)   puts back an ad change: an approved request's whole change set (changeSetId = its approval
 *                          id) or one recorded change (actionLogId, from ad-changes), through the rollback service;
 *                          W3-1 — or, with changeId, only what ONE recorded change of the request did (a step of a
 *                          change plan: the writes and negatives that step recorded, not its siblings');
 *                          negatives the request created are retired (archived at Amazon — that removes a block, it
 *                          stops no ad). AA-W2-9 — its own writes carry its approval as their change set, so it can be
 *                          undone in turn (retired negatives are not created again).
 *
 * AA-W2-9 — suppress-campaign, restore-campaign, set-campaign-live-writes (on: only a campaign Claude created; off: a
 * brake) and undo-ad-change are strategy-bound too, each on the same terms.
 *
 * ADS AUTONOMY W3-1 — set-campaign-budget, bulk-ad-bid-change (per row) and suppress-campaign take an optional `source`
 * (ads-change-source.ts): the engine recommendation the change carries out, kept in the preview and on the ads audit
 * rows, and settled once the write ran.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { previewRollbackOfAction, rollbackByActionLogId, rollbackByChangeSetId } from '../../advertising/rollback.service.js'
import { setLiveWrites } from '../../advertising/campaign-settings.service.js'
import { adsProfileFor } from '../../advertising/ads-profile-resolver.js'
import { bulkUpdateAdTargetBids, updateCampaignWithSync } from '../../advertising/ads-mutation.service.js'
import { clampBidsByCeiling } from '../../advertising/ads-cpc-ceiling.js'
import { getBidGrid, type BidTargetRow } from '../../advertising/bid-grid.service.js'
import { createHash } from 'node:crypto'
import { updatePlacementBidding } from '../../advertising/ads-create.service.js'
import { adGroupCampaigns, adGroupDefaultBids, adGroupSuppressionCounts, highestAdGroupBidAbove } from '../../advertising/ads-entity-lookup.service.js'
import { restoreBidsFor, restoreCampaignBids, suppressCampaignBids, SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { stopBidsFor, strategySourceWords } from '../../advertising/ads-strategy/effective.js'
import { amountLabel, campaignCurrency, checkLiveReach, liftSuppressionRefusal, suppressionOf, type AdWriteIntent, type LiveReach } from './ads-tool-guards.js'
import { alsoChangedBy, approvedRun, BY_RULE_WORDS, changeClampedBid, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, storedReach, strategyFactsMoney, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, STEP_PCT_LIMITS, STEP_POINT_LIMITS, type KitItem } from './ads-autonomy-kit.js'
import { strategyBidReader } from '../../advertising/ads-strategy/bids.js'
import type { AgentTool, FieldPermission, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { recommendationIdFor, settleSources, sourceArg, sourceOf, sourcePreview, sourceRefusal, sourcesRecord, unsettleChange, withSource, type AdChangeSource } from './ads-change-source.js'
import { afterUndone } from '../change-record.service.js'

/** The flat horizon a change set reverses within (rollbackByChangeSetId). */
const SET_WINDOW_MS = 24 * 3600 * 1000
/** At most this many rows are listed in a preview; the rest are counted. */
const ROWS_SHOWN = 50

// ── undo-ad-change (A10) ──────────────────────────────────────────────────────────────────────────

interface UndoRow {
  actionLogId: string
  actionType: string
  entityType: string
  entityId: string
  /** What the row wrote, and what undo puts back (the before-snapshot). */
  wrote: unknown
  restores: unknown
  at: string
}

interface UndoNegative {
  targetId: string
  keywordText: string
}

/** Field names a restore writes, by action type, for the live-reach question. */
function intentFieldsOf(row: { actionType: string; entityType: string; restores: unknown }): AdWriteIntent['changes'] {
  const before = (row.restores ?? {}) as Record<string, unknown>
  if (row.actionType === 'update_placement_bidding') return [{ field: 'placementBidding', valueCents: null }]
  if (row.entityType === 'CAMPAIGN' && before.dailyBudget != null) return [{ field: 'dailyBudget', valueCents: Math.round(Number(before.dailyBudget) * 100) }]
  if (row.entityType === 'AD_TARGET' && typeof before.bidCents === 'number') return [{ field: 'bid', valueCents: before.bidCents }]
  if (row.entityType === 'AD_GROUP' && typeof before.defaultBidCents === 'number') return [{ field: 'defaultBid', valueCents: before.defaultBidCents }]
  return [{ field: 'status', valueCents: null }]
}

/** The campaign of each entity a row names (a campaign is its own; a target or ad group its campaign's). */
async function campaignsOf(rows: Array<{ entityType: string; entityId: string }>, negatives: UndoNegative[]): Promise<Map<string, { id: string; marketplace: string | null }>> {
  const targetIds = [...rows.filter((r) => r.entityType === 'AD_TARGET').map((r) => r.entityId), ...negatives.map((n) => n.targetId)]
  const groupIds = rows.filter((r) => r.entityType === 'AD_GROUP').map((r) => r.entityId)
  const campaignIds = rows.filter((r) => r.entityType === 'CAMPAIGN').map((r) => r.entityId)
  const [targets, groups, campaigns] = await Promise.all([
    targetIds.length ? prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true } } } } } }) : [],
    adGroupCampaigns(groupIds),
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, marketplace: true } }) : [],
  ])
  const out = new Map<string, { id: string; marketplace: string | null }>()
  for (const t of targets) out.set(t.id, t.adGroup.campaign)
  for (const [groupId, campaign] of groups) out.set(groupId, campaign)
  for (const c of campaigns) out.set(c.id, c)
  return out
}

/**
 * The writes of a restore, one per campaign it touches, sorted. AA-W2-9 — the same writes the gate judges as a run by
 * rule (ruleFactsFor).
 */
async function restoreWrites(rows: UndoRow[], negatives: UndoNegative[]): Promise<RuleWrite[]> {
  const campaignOf = await campaignsOf(rows, negatives)
  const byCampaign = new Map<string, { marketplace: string | null; changes: AdWriteIntent['changes'] }>()
  const add = (entityId: string, changes: AdWriteIntent['changes']) => {
    const c = campaignOf.get(entityId)
    if (!c) return
    const entry = byCampaign.get(c.id) ?? { marketplace: c.marketplace, changes: [] }
    entry.changes.push(...changes)
    byCampaign.set(c.id, entry)
  }
  for (const r of rows) add(r.entityId, intentFieldsOf(r))
  for (const n of negatives) add(n.targetId, [{ field: 'status', valueCents: null }])
  return [...byCampaign].sort(([a], [b]) => (a < b ? -1 : 1)).map(([campaignId, entry]) => ({ campaignId, marketplace: entry.marketplace, changes: entry.changes, label: `campaign ${campaignId}` }))
}

/** Where the restore lands: every campaign it touches must answer the same, or it is refused. */
async function reachOfRestore(writes: readonly RuleWrite[]): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }> }> {
  const profiles = new Set<string>()
  for (const { label: _label, ...intent } of writes) {
    const reach = await checkLiveReach(intent)
    if (reach.reach === 'refused') return { refused: reach }
    if (reach.reach === 'live') profiles.add(reach.profileId)
  }
  // Some of it live, some in sandbox: it is live (that is what reaches Amazon), on every profile named.
  return { reach: profiles.size ? { reach: 'live', profileId: [...profiles].sort().join(',') } : { reach: 'sandbox' } }
}

/**
 * AA-W2-9 — what an undo does, as the kit judges it: each bid, budget and placement it puts back, from the value stored
 * NOW (a put-back that raises is a raise), and in words what no run by rule judges (`notJudged`: a status, an archive,
 * another campaign setting, a negative keyword lifted) — such an undo waits for a person.
 */
async function undoItems(rows: UndoRow[], negatives: UndoNegative[]): Promise<{ items: KitItem[]; notJudged: string[] }> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))]
  const targets = ids('AD_TARGET').length ? await prisma.adTarget.findMany({ where: { id: { in: ids('AD_TARGET') } }, select: { id: true, bidCents: true } }) : []
  const groupBid = await adGroupDefaultBids(ids('AD_GROUP'))
  const campaigns = ids('CAMPAIGN').length ? await prisma.campaign.findMany({ where: { id: { in: ids('CAMPAIGN') } }, select: { id: true, dailyBudget: true, dynamicBidding: true } }) : []
  const bid = new Map<string, number>(targets.map((t) => [t.id, t.bidCents]))
  const campaign = new Map(campaigns.map((c) => [c.id, c] as const))
  const items: KitItem[] = []
  const notJudged: string[] = []
  const differs = (after: Record<string, unknown>, before: Record<string, unknown>, key: string) => key in before && after[key] !== before[key]
  for (const r of rows) {
    const before = (r.restores ?? {}) as Record<string, unknown>
    const after = (r.wrote ?? {}) as Record<string, unknown>
    if (r.actionType === 'update_placement_bidding') {
      const back = Array.isArray(before.adjustments) ? (before.adjustments as Array<{ placement?: string; percentage?: number }>) : []
      const now = ((campaign.get(r.entityId)?.dynamicBidding as { placementBidding?: Array<{ placement?: string; percentage?: number }> } | null)?.placementBidding) ?? []
      for (const a of back) {
        const from = now.find((n) => n.placement === a.placement)?.percentage ?? 0
        if (typeof a.percentage === 'number' && a.percentage !== from) items.push({ entity: { kind: 'campaign', id: r.entityId }, change: { field: 'placementPct', fromPct: from, toPct: a.percentage } })
      }
      continue
    }
    if (r.actionType.startsWith('bulksheet_create_')) { notJudged.push('archives what an import created (permanent at Amazon)'); continue }
    if (differs(after, before, 'status')) notJudged.push(`puts back the status of ${r.entityType.toLowerCase().replace('_', ' ')} ${r.entityId}`)
    if (r.entityType === 'CAMPAIGN') {
      const c = campaign.get(r.entityId)
      if (before.dailyBudget != null && after.dailyBudget !== before.dailyBudget && c) {
        items.push({ entity: { kind: 'campaign', id: r.entityId }, change: { field: 'dailyBudget', fromCents: Math.round(Number(c.dailyBudget) * 100), toCents: Math.round(Number(before.dailyBudget) * 100) } })
      }
      const other = ['dailyBudgetCurrency', 'biddingStrategy', 'endDate', 'name', 'portfolioId'].filter((key) => differs(after, before, key))
      if (other.length) notJudged.push(`puts back ${other.join(', ')} of campaign ${r.entityId}`)
    } else if (r.entityType === 'AD_GROUP') {
      if (typeof before.defaultBidCents === 'number' && after.defaultBidCents !== before.defaultBidCents) {
        items.push({ entity: { kind: 'adGroup', id: r.entityId }, change: { field: 'bid', fromCents: groupBid.get(r.entityId) ?? null, toCents: before.defaultBidCents } })
      }
    } else if (r.entityType === 'AD_TARGET') {
      if (typeof before.bidCents === 'number' && after.bidCents !== before.bidCents) {
        items.push({ entity: { kind: 'target', id: r.entityId }, change: { field: 'bid', fromCents: bid.get(r.entityId) ?? null, toCents: before.bidCents } })
      }
    } else {
      notJudged.push(`puts back a ${r.entityType.toLowerCase().replace('_', ' ')}`)
    }
  }
  if (negatives.length) notJudged.push(`lifts ${negatives.length === 1 ? 'a negative keyword' : `${negatives.length} negative keywords`} it created (a block removed)`)
  return { items, notJudged }
}

/** AA-W2-9 — undo-ad-change's Claude limits: up to 50 items run by rule; a put-back raise, in % or points, 0 by default. */
const UNDO_LIMITS = adKitLimits({ maxItems: 50 }, { ...STEP_PCT_LIMITS, ...STEP_POINT_LIMITS })

/** AA-W2-9 — an undo doing something no run by rule judges waits for a person (pure, on the preview). */
function undoRefusal(preview: unknown): string | null {
  const notJudged = (preview as { notJudgedByRule?: unknown } | null | undefined)?.notJudgedByRule
  if (!Array.isArray(notJudged)) return 'the preview does not say what of this undo a run by rule can judge; a person decides'
  if (!notJudged.length) return null
  return `it also ${notJudged[0]}${notJudged.length > 1 ? ` (and ${notJudged.length - 1} more)` : ''}, which a run by rule does not judge; a person decides`
}

const rowOut = (log: { id: string; actionType: string; entityType: string; entityId: string; payloadBefore: unknown; payloadAfter: unknown; createdAt: Date }): UndoRow => ({
  actionLogId: log.id,
  actionType: log.actionType,
  entityType: log.entityType,
  entityId: log.entityId,
  wrote: log.payloadAfter,
  restores: log.payloadBefore,
  at: log.createdAt.toISOString(),
})

/**
 * The negatives an approved request created (its recorded changes), still standing — undo retires them. W3-1 — every
 * change of the request (a change plan records one per step), or only the one named (`changeId`).
 */
async function negativesCreatedBy(changeSetId: string, changeId?: string): Promise<UndoNegative[]> {
  const changes = await prisma.agentChange.findMany({ where: { approvalId: changeSetId, ...(changeId ? { id: changeId } : {}) }, select: { after: true } })
  const listed = changes.flatMap((c) => ((c.after ?? null) as { negatives?: Array<{ targetId?: unknown; keywordText?: unknown }> } | null)?.negatives ?? [])
  const ids = [...new Set(listed.map((n) => String(n.targetId ?? '')).filter(Boolean))]
  if (!ids.length) return []
  // 5f — status decides, as in retireNegatives: a stale `retiredAt` from a failed retire blocks nothing.
  const standing = await prisma.adTarget.findMany({
    where: { id: { in: ids }, isNegative: true, status: { not: 'ARCHIVED' } },
    select: { id: true, expressionValue: true },
  })
  return standing.map((t) => ({ targetId: t.id, keywordText: t.expressionValue }))
}

async function undoPreview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const changeSetId = typeof args.changeSetId === 'string' ? args.changeSetId.trim() : ''
  const actionLogId = typeof args.actionLogId === 'string' ? args.actionLogId.trim() : ''
  const changeId = typeof args.changeId === 'string' ? args.changeId.trim() : ''
  if (!changeSetId && !actionLogId) {
    return { ok: false, error: 'Name the ad change to undo: changeSetId (the approvalId of an approved ad request) or actionLogId (undoActionLogId in ad-changes).' }
  }
  if (changeId) {
    if (actionLogId) return { ok: false, error: 'Name one way: a changeId of the change set, or an actionLogId — not both.' }
    return undoOneChange(changeSetId, changeId, ctx)
  }
  let setId = changeSetId
  if (actionLogId) {
    const single = await previewRollbackOfAction(actionLogId)
    if (!single.found) return { ok: false, error: 'Change not found.' }
    if (changeSetId && single.changeSetId !== changeSetId) return { ok: false, error: 'That change is not part of that change set: name one of them.' }
    if (!single.eligible) return { ok: false, error: `Not undone: ${single.reason}` }
    if (!single.changeSetId) {
      const log = await prisma.advertisingActionLog.findUnique({ where: { id: actionLogId } })
      if (!log) return { ok: false, error: 'Change not found.' }
      const rows = [rowOut(log)]
      return finish({ mode: 'action', actionLogId }, rows, [], 1, ctx)
    }
    setId = single.changeSetId
  }
  const logs = await prisma.advertisingActionLog.findMany({
    where: { executionId: setId, rolledBackAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  })
  const since = Date.now() - SET_WINDOW_MS
  const inWindow = logs.filter((l) => l.createdAt.getTime() >= since)
  const negatives = await negativesCreatedBy(setId)
  if (!inWindow.length && !negatives.length) {
    if (logs.length) return { ok: false, error: `Not undone: change set ${setId} is older than the 24-hour undo window for a change set. Ask for the opposite change instead.` }
    const known = await prisma.advertisingActionLog.count({ where: { executionId: setId } })
    return { ok: false, error: known ? `Nothing of change set ${setId} is left to undo: it was undone already.` : 'Change set not found.' }
  }
  return finish({ mode: 'set', changeSetId: setId }, inWindow.map(rowOut), negatives, inWindow.length, ctx)
}

/**
 * W3-1 — the undo of ONE recorded change of a request (a step of a change plan): only the writes it recorded
 * (`before.actionLogIds`) and the negatives it created — never its siblings' writes, which share the plan's change set.
 */
async function undoOneChange(changeSetId: string, changeId: string, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  if (!changeSetId) return { ok: false, error: 'A changeId names a change of a change set: name that changeSetId too.' }
  const change = await prisma.agentChange.findFirst({ where: { id: changeId, approvalId: changeSetId }, select: { before: true, undoneAt: true } })
  if (!change) return { ok: false, error: 'That change is not found in that change set.' }
  if (change.undoneAt) return { ok: false, error: 'Not undone: that change was undone already.' }
  const recorded = (change.before as { actionLogIds?: unknown } | null)?.actionLogIds
  const ids = Array.isArray(recorded) ? recorded.filter((id): id is string => typeof id === 'string') : []
  const logs = ids.length
    ? await prisma.advertisingActionLog.findMany({ where: { executionId: changeSetId, id: { in: ids }, rolledBackAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })
    : []
  const inWindow = logs.filter((l) => l.createdAt.getTime() >= Date.now() - SET_WINDOW_MS)
  const negatives = await negativesCreatedBy(changeSetId, changeId)
  if (!inWindow.length && !negatives.length) {
    if (logs.length) return { ok: false, error: `Not undone: that change is older than the 24-hour undo window for a change set. Ask for the opposite change instead.` }
    return { ok: false, error: `Nothing of that change is left to undo: ${ids.length ? 'it was undone already' : 'it recorded no write of its own'}.` }
  }
  return finish({ mode: 'change', changeSetId, changeId }, inWindow.map(rowOut), negatives, inWindow.length, ctx)
}

async function finish(source: Record<string, unknown>, rows: UndoRow[], negatives: UndoNegative[], total: number, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const writes = await restoreWrites(rows, negatives)
  const reach = await reachOfRestore(writes)
  if ('refused' in reach) return { ok: false, error: reachRefusal(reach.refused) }
  // AA-W2-9 — what a run by rule is judged on: every row (not only the 50 shown) against the ads strategy where it lands
  // and the tool's limits, the gate as the rule's write, and what no run by rule judges.
  const { items, notJudged } = await undoItems(rows, negatives)
  const rule = await ruleFactsFor({ tool: 'undo-ad-change', limits: UNDO_LIMITS, items, writes, approvalId: ctx?.approvalId })
  const parts = [
    rows.length ? `restores ${total} recorded write${total === 1 ? '' : 's'} to the values before them` : '',
    negatives.length ? `removes ${negatives.length === 1 ? 'the negative keyword' : `${negatives.length} negative keywords`} it created at Amazon (the block is lifted, no ad is stopped)` : '',
  ].filter(Boolean)
  return {
    ok: true,
    preview: {
      action: 'undo-ad-change',
      source,
      rows: rows.slice(0, ROWS_SHOWN),
      ...(rows.length > ROWS_SHOWN ? { moreRows: rows.length - ROWS_SHOWN } : {}),
      negatives,
      reach: reach.reach,
      reachNote: reachNote(reach.reach),
      notJudgedByRule: notJudged,
      ...rule,
      effect: `Undo ${parts.join(', and ')}. A bid or budget changed since by someone else is overwritten with the earlier value.`,
    },
  }
}

/** W3-1 — the writes one recorded change made (`before.actionLogIds`, kept by the tools whose steps share a plan's set). */
async function recordedWritesOf(changeId: string): Promise<string[]> {
  const change = await prisma.agentChange.findUnique({ where: { id: changeId }, select: { before: true } })
  const recorded = (change?.before as { actionLogIds?: unknown } | null)?.actionLogIds
  return Array.isArray(recorded) ? recorded.filter((id): id is string => typeof id === 'string') : []
}

/** AA-W2-9 — the writes of an undo still standing (its change set, not reversed since). */
async function undoWritesStanding(changeSetId: string): Promise<{ changeSetId: string; standing: number }> {
  const standing = await prisma.advertisingActionLog.count({ where: { executionId: changeSetId, rolledBackAt: null } })
  return { changeSetId, standing }
}

/**
 * AA-W2-9 — undo of an undo: undo-ad-change of its own change set puts back what it reversed. Only while all of its
 * writes still stand; the negative keywords it retired are not created again, and an undo that only retired negatives
 * has nothing to put back here.
 */
export const UNDO_AD_CHANGE_UNDO: ToolUndo = {
  current: (change) => undoWritesStanding(String((change.after as { changeSetId?: unknown } | null)?.changeSetId ?? '')),
  request(change) {
    const after = (change.after ?? {}) as { changeSetId?: unknown; standing?: unknown }
    if (typeof after.changeSetId !== 'string' || !after.changeSetId) return { refusal: 'This undo does not name its own change set.' }
    if (!(Number(after.standing) > 0)) return { refusal: 'This undo wrote nothing that can be put back (retired negative keywords are not created again): ask for them again.' }
    return { tool: 'undo-ad-change', args: { changeSetId: after.changeSetId, why: 'undo of an undo: puts back what it reversed' } }
  },
}

const undoAdChange: AgentTool = {
  name: 'undo-ad-change',
  title: 'Undo an ad change',
  input: z.object({
    changeSetId: z.string().trim().min(1).max(64).optional()
      .describe('the change set to put back: the approvalId of an approved ad request (its writes carry it), or an import\'s change set'),
    actionLogId: z.string().trim().min(1).max(64).optional()
      .describe('one recorded change to put back (undoActionLogId in ad-changes); a change in a set reverses with its whole set'),
    changeId: z.string().trim().min(1).max(64).optional()
      .describe('with changeSetId: only what this recorded change of the request did (a step of a change plan; undo-change sets it)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the approver and kept in the ads audit'),
  }),
  requires: [F.adsBidsEdit, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  // AA-W2-9 — its own writes carry its approval as their change set, so undo-ad-change of it puts back what it reversed;
  // the negative keywords it retired are not created again (partial).
  reversibility: 'partial',
  // AA-W2-9 — it may run by the business's rule, only inside its limits and the ads strategy: each bid, budget and
  // placement it puts back is judged as a change of its own (a put-back that raises is a raise: 0 by default).
  strategyBound: 'amazon-ads',
  maxClaudeTrust: 'auto',
  limits: UNDO_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? undoRefusal(preview),
  undo: UNDO_AD_CHANGE_UNDO,
  description:
    'Put back an Amazon ad change: every write of an approved ad request (changeSetId = its approvalId) or one '
    + 'recorded change (actionLogId from ad-changes), or — with changeId — only what one step of a change plan did. '
    + 'Bids, budgets and placements return to the values before them '
    + 'through the rollback service (within 24 hours for a change set); negative keywords the request created are '
    + `retired. Nothing changes until it is approved. ${BY_RULE_WORDS}: each value it puts back no larger a move than its `
    + 'limits allow (a put-back that raises waits for a person by default), and never a status, an archive or a lifted '
    + 'negative keyword. The preview lists every write it reverses, where it lands (live or sandbox) and the ads '
    + 'strategy\'s limits that apply; refused, and not queued, when Amazon\'s write gate would refuse it. Its own writes '
    + 'are a change set of their own: undo-change of it puts back what it reversed (retired negatives are not created again).',
  async handler(args, ctx) {
    return undoPreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await undoPreview(args, ctx)
    const refusal = recheck(ctx, fresh, ['source', 'rows', 'negatives'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { source: { mode: 'set' | 'action' | 'change'; changeSetId?: string; actionLogId?: string; changeId?: string }; rows: UndoRow[]; negatives: UndoNegative[]; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    // AA-W2-9 — the reversal's own writes carry this request as their change set (F11): it can be undone in turn.
    const rollback = p.rows.length
      ? p.source.mode === 'action'
        ? await rollbackByActionLogId({ actionLogId: p.source.actionLogId!, actor: run.actor, reason: run.reason, manual: run.manual, stampChangeSetId: run.changeSetId })
        // W3-1 — one change of the set: only the writes it recorded (the preview read them all, not only those shown).
        : await rollbackByChangeSetId({
          changeSetId: p.source.changeSetId!, actor: run.actor, reason: run.reason, manual: run.manual, stampChangeSetId: run.changeSetId,
          ...(p.source.mode === 'change' ? { actionLogIds: await recordedWritesOf(p.source.changeId!) } : {}),
        })
      : null
    let retired: { retired: number; refused: number; failed: number } | null = null
    if (p.negatives.length) {
      const { retireNegatives } = await import('../../advertising/negatives-retire.service.js')
      const out = await retireNegatives({ adTargetIds: p.negatives.map((n) => n.targetId), actor: run.actor, retireReason: run.reason })
      retired = { retired: out.summary.retired + out.summary.removedLocal, refused: out.summary.refused, failed: out.summary.failed }
    }
    // The request this put back is undone now (also when it was asked for directly, not through undo-change). W3-1 —
    // one change of it only, when that is what was put back; and what each left outside its rows (settles) is tidied.
    if (p.source.mode !== 'action' && p.source.changeSetId) {
      const where = { approvalId: p.source.changeSetId, undoneAt: null, ...(p.source.mode === 'change' ? { id: p.source.changeId } : {}) }
      const marked = await prisma.agentChange.findMany({ where, select: { id: true, toolName: true, before: true, after: true } })
      await prisma.agentChange.updateMany({ where, data: { undoneAt: new Date(), undoneByApprovalId: run.changeSetId } })
      await afterUndone(marked)
    }
    const failed = (rollback?.failed ?? 0) + (retired?.failed ?? 0) + (retired?.refused ?? 0)
    const data = {
      reversed: rollback?.reversed ?? 0,
      skipped: rollback?.skipped ?? 0,
      failed: rollback?.failed ?? 0,
      ...(rollback?.reason ? { note: rollback.reason } : {}),
      details: (rollback?.details ?? []).slice(0, ROWS_SHOWN),
      ...(retired ? { negatives: retired } : {}),
      changeSetId: run.changeSetId,
    }
    // AA-W2-9 — what undo-change of this undo compares and asks for (UNDO_AD_CHANGE_UNDO).
    const change = { before: { changeSetId: run.changeSetId, undid: p.source }, after: await undoWritesStanding(run.changeSetId) }
    if (failed) return { ok: false, data, change, error: `Partly undone: ${data.reversed} write${data.reversed === 1 ? '' : 's'} put back, ${failed} not. The rest stays as it was; approve again to retry.` }
    return { ok: true, data, change }
  },
}

// ── shared: one campaign, read for a change ─────────────────────────────────────────────────────

const CAMPAIGN_FOR_CHANGE = {
  id: true, name: true, type: true, adProduct: true, marketplace: true, dailyBudget: true, dailyBudgetCurrency: true,
  dynamicBidding: true, minBudgetCents: true, maxBudgetCents: true, pinPlacement: true, pinBids: true, pinBudget: true, pinNote: true,
  liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true,
} as const

async function campaignForChange(campaignId: string) {
  return prisma.campaign.findFirst({ where: { id: campaignId }, select: CAMPAIGN_FOR_CHANGE })
}
type ChangeCampaign = NonNullable<Awaited<ReturnType<typeof campaignForChange>>>

/**
 * Not found or not SP: why a change to it is refused; null when it may go on. 4A (Owner decided 2026-10-06) — a pin
 * no longer refuses it: a change tool writes only once a person approves it, and his approval counts as his own click,
 * which a pin (like the allowlist) does not stop. `dimension` is kept for the callers.
 */
function campaignRefusal(campaign: ChangeCampaign | null, campaignId: string, _dimension: 'bids' | 'budget' | 'placement'): string | null {
  if (!campaign) return `campaign ${campaignId} not found`
  return spOnlyRefusal(campaign)
}

const whyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit')
const campaignIdArg = z.string().trim().min(1).max(64).describe('Nexus campaign id (campaignId in ad-campaigns)')

// ── set-campaign-budget (A6) ──────────────────────────────────────────────────────────────────────

async function budgetPreview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const proposed = Math.round(Number(args.dailyBudgetCents))
  if (!campaignId || !Number.isFinite(proposed) || proposed <= 0) return { ok: false, error: 'campaignId and a dailyBudgetCents above 0 are required' }
  // W3-1 — a source names this campaign's own budget recommendation, or the request is refused.
  const changeSource = sourceOf(args.source)
  const wrongSource = sourceRefusal(changeSource, recommendationIdFor.budget(campaignId))
  if (wrongSource) return { ok: false, error: `Not queued: ${wrongSource}.` }
  const campaign = await campaignForChange(campaignId)
  const refused = campaignRefusal(campaign, campaignId, 'budget')
  if (refused) return { ok: false, error: refused }
  const c = campaign!
  const currency = campaignCurrency(c)
  const current = Math.round(Number(c.dailyBudget) * 100)
  if (proposed === current) return { ok: false, error: `The daily budget of ${c.name} is already ${amountLabel(current, currency)}.` }
  // 3A + 4A — the campaign's own min/max budget is HIS limit: not a refusal here. The gate (asked as the approver)
  // reports it in `reach.pastOwnLimits`, the card warns before he approves, and approving sends it anyway.
  const intent = { campaignId: c.id, marketplace: c.marketplace, changes: [{ field: 'dailyBudget', valueCents: proposed }] }
  const reach = await checkLiveReach(intent)
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(c.id)
  // AA-W2-8 — what a run by rule is judged on: the gate as the rule's write, the ads strategy where it lands, this
  // change counted (a raise adds its difference to the market's daily budget increase and its month's forecast).
  const rule = await ruleFactsFor({
    tool: 'set-campaign-budget',
    limits: BUDGET_LIMITS,
    items: [{ entity: { kind: 'campaign', id: c.id }, change: { field: 'dailyBudget', fromCents: current, toCents: proposed } }],
    writes: [{ ...intent, label: `campaign "${c.name}"` }],
    approvalId: ctx?.approvalId,
  })
  return {
    ok: true,
    preview: {
      action: 'set-campaign-budget',
      campaign: { id: c.id, name: c.name, marketplace: c.marketplace },
      currency,
      currentBudgetCents: current,
      proposedBudgetCents: proposed,
      deltaCents: proposed - current,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...rule,
      ...sourcePreview(changeSource),
      effect: `Sets the daily budget of ${c.name} from ${amountLabel(current, currency)} to ${amountLabel(proposed, currency)}.`,
    },
  }
}

/** AA-W2-8 — set-campaign-budget's Claude limits: every raise waits for a person until he sets one (0 %); a cut, 100 %. */
const BUDGET_LIMITS = adKitLimits({ maxItems: 1 }, STEP_PCT_LIMITS)

/** AA-W2-8 — a raise from no recorded budget has no size in percent: it never runs by rule. */
function budgetRefusal(preview: unknown): string | null {
  const p = (preview ?? {}) as { currentBudgetCents?: unknown; proposedBudgetCents?: unknown }
  const from = Number(p.currentBudgetCents)
  const to = Number(p.proposedBudgetCents)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'the preview does not say the budget before and after; a person decides'
  if (from <= 0 && to > from) return 'Nexus records no daily budget for the campaign, so the raise has no size to judge against the limits; a person decides'
  return null
}

/** C2 — undo of a budget change: set the budget it replaced, through set-campaign-budget itself. */
export const SET_CAMPAIGN_BUDGET_UNDO: ToolUndo = {
  async current(change) {
    const campaignId = String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')
    const c = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { dailyBudget: true } })
    return { campaignId, dailyBudgetCents: c ? Math.round(Number(c.dailyBudget) * 100) : null }
  },
  request(change) {
    const before = (change.before ?? {}) as { campaignId?: string; dailyBudgetCents?: number }
    if (!before.campaignId || !(Number(before.dailyBudgetCents) > 0)) return { refusal: 'This change does not record the budget it replaced.' }
    return { tool: 'set-campaign-budget', args: { campaignId: before.campaignId, dailyBudgetCents: before.dailyBudgetCents, why: 'undo of an earlier budget change' } }
  },
  undone: unsettleChange,
}

const setCampaignBudget: AgentTool = {
  name: 'set-campaign-budget',
  title: 'Change a campaign budget',
  input: z.object({
    campaignId: campaignIdArg,
    dailyBudgetCents: z.coerce.number().int().positive().describe('new daily budget in minor units (cents) of the campaign\'s own currency'),
    why: whyArg,
    source: sourceArg,
  }),
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // AA-W2-8 — it may run by the business's rule, only inside its limits and the ads strategy (D-W2-1 = A).
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: BUDGET_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? budgetRefusal(preview),
  undo: SET_CAMPAIGN_BUDGET_UNDO,
  description:
    'Set the daily budget of an Amazon Sponsored Products campaign, in the campaign\'s own currency (never converted). '
    + `Nothing changes until it is approved. ${BY_RULE_WORDS}: a raise or a cut no larger than its limits allow (a raise `
    + 'waits for a person until the business sets how large one may be), within the market\'s daily budget increase by '
    + 'rule, and keeping the month\'s spend forecast under its monthly cap. The preview shows the budget now and after, '
    + 'where it lands (live at Amazon or sandbox), the ads strategy\'s limits that apply and where each comes from, and '
    + 'the rules that may change it again. Refused, and not queued, when Amazon\'s write gate would refuse it (the value '
    + 'cap of one write); the campaign\'s own budget bounds, spend ceilings and the daily budget-movement bound warn the '
    + 'person who approves it, and a run by rule never goes past them. Undo puts the old budget back.',
  async handler(args, ctx) {
    return budgetPreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await budgetPreview(args, ctx)
    const refusal = recheck(ctx, fresh, ['currentBudgetCents', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; currentBudgetCents: number; proposedBudgetCents: number; currency: string; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const changeSource = sourceOf(args.source)
    const out = await updateCampaignWithSync({
      campaignId: p.campaign.id,
      patch: { dailyBudget: p.proposedBudgetCents / 100 },
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
      manual: run.manual, // 4A — a person approved it: his own click
      confirmOwnLimits: run.confirmOwnLimits, // 4A — his approval is his "Send anyway" (the card warned him)
      ...(changeSource ? { evidence: withSource(null, changeSource) } : {}), // W3-1
    })
    if (!out.ok) return notRun(`Not run: the budget write was refused (${out.error ?? 'unknown'}). Nothing changed.`)
    await settleSources([changeSource], run.changeSetId)
    return {
      ok: true,
      data: {
        campaignId: p.campaign.id,
        dailyBudgetCents: p.proposedBudgetCents,
        currency: p.currency,
        reach: p.reach,
        changeSetId: run.changeSetId,
        outboundQueueId: out.outboundQueueId,
        note: 'Queued for Amazon: it is sent after the 5-minute cancel window. approval-status follows it.',
      },
      change: {
        before: { campaignId: p.campaign.id, dailyBudgetCents: p.currentBudgetCents, changeSetId: run.changeSetId, ...sourcesRecord([changeSource]) },
        after: { campaignId: p.campaign.id, dailyBudgetCents: p.proposedBudgetCents },
      },
    }
  },
}

// ── set-placement-multipliers (A6) ────────────────────────────────────────────────────────────────

const PLACEMENTS = [
  { key: 'topOfSearchPct', placement: 'PLACEMENT_TOP', label: 'top of search' },
  { key: 'productPagesPct', placement: 'PLACEMENT_PRODUCT_PAGE', label: 'product pages' },
  { key: 'restOfSearchPct', placement: 'PLACEMENT_REST_OF_SEARCH', label: 'rest of search' },
] as const
type PlacementKey = (typeof PLACEMENTS)[number]['key']
type Placements = Record<PlacementKey, number | null>

/** The campaign's stored adjustments, by our three names (null = not set). */
function placementsOf(dynamicBidding: unknown): Placements {
  const list = ((dynamicBidding as { placementBidding?: Array<{ placement?: string; percentage?: number }> } | null)?.placementBidding) ?? []
  const out = {} as Placements
  for (const p of PLACEMENTS) {
    const hit = list.find((a) => a.placement === p.placement)
    out[p.key] = typeof hit?.percentage === 'number' ? hit.percentage : null
  }
  return out
}

/**
 * AA-W2-8 — set-placement-multipliers' Claude limits: an item is one placement's adjustment (three at most); every raise
 * waits for a person until he sets how many points one may be (0 by default): a raise raises every bid there.
 */
const PLACEMENT_LIMITS = adKitLimits({ maxItems: PLACEMENTS.length }, STEP_POINT_LIMITS)

const pctLine = (v: Record<PlacementKey, number | null>) => PLACEMENTS.map((p) => `${p.label} ${v[p.key] ?? 0}%`).join(', ')

async function placementPreview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const asked = PLACEMENTS.filter((p) => args[p.key] != null)
  if (!campaignId || !asked.length) return { ok: false, error: 'campaignId and at least one of topOfSearchPct, productPagesPct, restOfSearchPct are required' }
  const campaign = await campaignForChange(campaignId)
  const refused = campaignRefusal(campaign, campaignId, 'placement')
  if (refused) return { ok: false, error: refused }
  const c = campaign!
  const current = placementsOf(c.dynamicBidding)
  const proposed = { ...current }
  for (const p of asked) proposed[p.key] = Math.round(Number(args[p.key]))
  if (PLACEMENTS.every((p) => (proposed[p.key] ?? 0) === (current[p.key] ?? 0))) {
    return { ok: false, error: `${c.name} already has these placement adjustments (${pctLine(current)}).` }
  }
  const intent = { campaignId: c.id, marketplace: c.marketplace, changes: [{ field: 'placementBidding', valueCents: null }] }
  const reach = await checkLiveReach(intent)
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(c.id)
  const raises = PLACEMENTS.filter((p) => (proposed[p.key] ?? 0) > (current[p.key] ?? 0)).map((p) => p.label)
  // AA-W2-8 — each adjustment that moves is one item, in points: a raise raises every bid there.
  const items: KitItem[] = PLACEMENTS.filter((p) => (proposed[p.key] ?? 0) !== (current[p.key] ?? 0))
    .map((p): KitItem => ({ entity: { kind: 'campaign', id: c.id }, change: { field: 'placementPct', fromPct: current[p.key] ?? 0, toPct: proposed[p.key] ?? 0 } }))
  const rule = await ruleFactsFor({ tool: 'set-placement-multipliers', limits: PLACEMENT_LIMITS, items, writes: [{ ...intent, label: `campaign "${c.name}"` }], approvalId: ctx?.approvalId })
  return {
    ok: true,
    preview: {
      action: 'set-placement-multipliers',
      campaign: { id: c.id, name: c.name, marketplace: c.marketplace },
      current,
      proposed,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...rule,
      effect: `Sets the placement adjustments of ${c.name} from ${pctLine(current)} to ${pctLine(proposed)}${raises.length ? `: bids rise on ${raises.join(' and ')}` : ''}.`,
    },
  }
}

/** C2 — undo of a placement change: set the adjustments it replaced, through set-placement-multipliers itself. */
export const SET_PLACEMENTS_UNDO: ToolUndo = {
  async current(change) {
    const campaignId = String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')
    const c = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { dynamicBidding: true } })
    return { campaignId, placements: c ? placementsOf(c.dynamicBidding) : null }
  },
  request(change) {
    const before = (change.before ?? {}) as { campaignId?: string; placements?: Placements }
    if (!before.campaignId || !before.placements) return { refusal: 'This change does not record the adjustments it replaced.' }
    const args: Record<string, unknown> = { campaignId: before.campaignId, why: 'undo of an earlier placement change' }
    for (const p of PLACEMENTS) args[p.key] = before.placements[p.key] ?? 0
    return { tool: 'set-placement-multipliers', args }
  },
}

const pctArg = (label: string) => z.coerce.number().int().min(0).max(900).optional().describe(`${label} adjustment in percent, 0–900 (left as it is when absent)`)

const setPlacementMultipliers: AgentTool = {
  name: 'set-placement-multipliers',
  title: 'Change placement adjustments',
  input: z.object({
    campaignId: campaignIdArg,
    topOfSearchPct: pctArg('top-of-search'),
    productPagesPct: pctArg('product-pages'),
    restOfSearchPct: pctArg('rest-of-search'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // AA-W2-8 — it may run by the business's rule, only inside its limits and the ads strategy (D-W2-1 = A).
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: PLACEMENT_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits),
  undo: SET_PLACEMENTS_UNDO,
  description:
    'Set the placement bid adjustments of an Amazon Sponsored Products campaign: top of search, product pages, rest '
    + `of search, each 0–900 %. Nothing changes until it is approved. ${BY_RULE_WORDS}: a raise or a cut no larger, in `
    + 'points, than its limits allow (a raise raises every bid there, so it waits for a person until the business sets '
    + 'how large one may be). The preview shows the adjustments now and after, where it lands (live at Amazon or '
    + 'sandbox) and the ads strategy\'s limits that apply. Refused, and not queued, when Amazon\'s write gate would '
    + 'refuse it. Approved, it is sent at once. Undo puts the old adjustments back.',
  async handler(args, ctx) {
    return placementPreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await placementPreview(args, ctx)
    const refusal = recheck(ctx, fresh, ['current', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; current: Placements; proposed: Placements; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const adjustments = PLACEMENTS.filter((pl) => p.proposed[pl.key] != null).map((pl) => ({ placement: pl.placement, percentage: p.proposed[pl.key] as number }))
    const out = await updatePlacementBidding({ campaignId: p.campaign.id, adjustments, actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
    if (!out.ok) return notRun(`Not run: ${out.reason ? `Amazon's write gate refused it — ${out.reason}` : 'Amazon did not accept the new adjustments'}. Nothing changed.`)
    return {
      ok: true,
      data: { campaignId: p.campaign.id, placements: p.proposed, reach: p.reach, mode: out.mode, changeSetId: run.changeSetId },
      change: {
        before: { campaignId: p.campaign.id, placements: p.current, changeSetId: run.changeSetId },
        after: { campaignId: p.campaign.id, placements: p.proposed },
      },
    }
  },
}

// ── bulk-ad-bid-change (A7) ───────────────────────────────────────────────────────────────────────

/** The most targets one request may move (a selection): above it, narrow the selection. */
const BULK_MAX = 500
/** The most a written list may name (the tool contract bounds every list to 250). */
const BULK_LIST_MAX = 250
const LINES_SHOWN = 20
const BULK_FLOOR_CENTS = 5

type Exclusion = 'notFound' | 'notSponsoredProducts' | 'pinned' | 'belowFloor' | 'suppressed' | 'lowUnflagged' | 'unchanged' | 'outsideBounds' | 'refusedByGate'
const EXCLUSION_WORDS: Record<Exclusion, string> = {
  notFound: 'not found (or a negative)',
  notSponsoredProducts: 'not a Sponsored Products campaign',
  pinned: 'its campaign\'s bids are pinned by hand',
  belowFloor: 'below the 5-cent floor',
  suppressed: 'suppressed (no-pause floor): only a restore raises it',
  lowUnflagged: 'at the floor another path lowered it to',
  unchanged: 'already at that bid',
  outsideBounds: 'outside the campaign\'s own bid bounds',
  refusedByGate: 'Amazon\'s write gate refuses its campaign',
}

interface BulkTarget {
  id: string
  text: string
  bidCents: number
  suppressedFromBidCents: number | null
  campaign: { id: string; name: string; type: string; adProduct: string | null; marketplace: string | null; dailyBudgetCurrency: string; dynamicBidding: unknown; minBidCents: number | null; maxBidCents: number | null; pinPlacement: boolean; pinBids: boolean; pinBudget: boolean; pinNote: string | null }
  adGroupId: string
}

const TARGET_SELECT = {
  id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true, isNegative: true, adGroupId: true,
  adGroup: { select: { campaign: { select: { id: true, name: true, type: true, adProduct: true, marketplace: true, dailyBudgetCurrency: true, dynamicBidding: true, minBidCents: true, maxBidCents: true, pinPlacement: true, pinBids: true, pinBudget: true, pinNote: true } } } },
} as const

async function loadTargets(ids: string[]): Promise<Map<string, BulkTarget>> {
  if (!ids.length) return new Map()
  const rows = await prisma.adTarget.findMany({ where: { id: { in: [...new Set(ids)] }, isNegative: false }, select: TARGET_SELECT })
  return new Map(rows.map((t) => [t.id, { id: t.id, text: t.expressionValue, bidCents: t.bidCents, suppressedFromBidCents: t.suppressedFromBidCents, campaign: { ...t.adGroup.campaign, type: String(t.adGroup.campaign.type) }, adGroupId: t.adGroupId }]))
}

interface BulkArgs {
  bids?: Array<{ targetId: string; bidCents: number; source?: AdChangeSource }>
  campaignId?: string
  adGroupId?: string
  market?: string
  search?: string
  percent?: number
}

/** What a bulk request asks for: each target id with the bid asked, or why it cannot be read. */
async function askedBids(a: BulkArgs): Promise<{ asked: Array<{ targetId: string; bidCents: number }> } | { refusal: string }> {
  if (a.bids?.length) {
    if (a.percent != null) return { refusal: 'Give a list of bids, or a selection and a percent — not both.' }
    return { asked: a.bids.map((t) => ({ targetId: t.targetId, bidCents: Math.round(Number(t.bidCents)) })) }
  }
  if (a.percent == null) return { refusal: 'Give bids (each target with its new bid), or a selection (campaignId, adGroupId or market) and a percent.' }
  if (!a.campaignId && !a.adGroupId && !a.market) return { refusal: 'A percent moves a selection: name a campaignId, an adGroupId or a market (never the whole account).' }
  let campaign = a.campaignId ?? null
  if (a.adGroupId) {
    const group = (await adGroupCampaigns([a.adGroupId])).get(a.adGroupId)
    if (!group || (campaign && group.id !== campaign)) return { refusal: 'Ad group not found' }
    campaign = group.id
  }
  if (a.campaignId && !(await prisma.campaign.findFirst({ where: { id: a.campaignId }, select: { id: true } }))) return { refusal: 'Campaign not found' }
  const grid = await getBidGrid({
    market: a.market ?? 'all', line: null, portfolio: null, campaign, view: 'targets', status: 'enabled', kind: [], match: [],
    band: null, measured: 'all', q: a.search ?? null, windowDays: 30, sort: null, dir: 'desc', limit: 5000,
  })
  const rows = (grid.rows as BidTargetRow[]).filter((r) => !a.adGroupId || r.adGroupId === a.adGroupId)
  if (rows.length > BULK_MAX) return { refusal: `${rows.length} targets match: at most ${BULK_MAX} move in one request. Narrow it (adGroupId, market or search).` }
  if (!rows.length) return { refusal: 'No enabled target matches that selection.' }
  return { asked: rows.map((r) => ({ targetId: r.id, bidCents: Math.max(BULK_FLOOR_CENTS, Math.round(r.bidCents * (1 + Number(a.percent) / 100))) })) }
}

type BulkWrite = { targetId: string; fromCents: number; toCents: number; source?: AdChangeSource }

/**
 * AA-W2-6 — bulk-ad-bid-change's Claude limits: the kit's (at most 50 targets in one request run by rule), with a raise
 * and a cut step. By default no raise runs alone (0 %); cuts run alone inside the ads strategy of each row's ad group.
 */
const BULK_BID_LIMITS = adKitLimits({ maxItems: 50 }, STEP_PCT_LIMITS)

/**
 * A bulk request decided: its preview (20 lines shown), and every write it makes (all of them). `rule` (the dry run,
 * not `execute`): AA-W2-6 — also the facts its limits are judged on, over EVERY row, when it may run by rule.
 */
async function bulkDecision(args: Record<string, unknown>, opts: { rule?: { approvalId?: string | null } } = {}): Promise<{ result: ToolResult; writes: BulkWrite[] }> {
  const a = args as BulkArgs
  // W3-1 — each row's source names that target's own bid recommendation, or the whole request is refused.
  const sourceByTarget = new Map<string, AdChangeSource>()
  for (const row of a.bids ?? []) {
    const rowSource = sourceOf(row.source)
    const wrongSource = sourceRefusal(rowSource, recommendationIdFor.bid(row.targetId))
    if (wrongSource) return { result: { ok: false, error: `Not queued: target ${row.targetId}: ${wrongSource}.` }, writes: [] }
    if (rowSource) sourceByTarget.set(row.targetId, rowSource)
  }
  const read = await askedBids(a)
  if ('refusal' in read) return { result: { ok: false, error: read.refusal }, writes: [] }
  const targets = await loadTargets(read.asked.map((t) => t.targetId))
  const excluded: Array<{ targetId: string; why: Exclusion; detail?: string }> = []
  const kept: Array<{ t: BulkTarget; wanted: number }> = []
  const seen = new Set<string>()
  for (const ask of read.asked) {
    if (seen.has(ask.targetId)) continue
    seen.add(ask.targetId)
    const t = targets.get(ask.targetId)
    if (!t || (a.campaignId && t.campaign.id !== a.campaignId) || (a.adGroupId && t.adGroupId !== a.adGroupId) || (a.market && t.campaign.marketplace !== a.market)) {
      excluded.push({ targetId: ask.targetId, why: 'notFound' })
      continue
    }
    if (spOnlyRefusal(t.campaign)) { excluded.push({ targetId: t.id, why: 'notSponsoredProducts' }); continue }
    // 4A — a pin does not stop a change a person approves (his own click).
    if (!(ask.bidCents >= BULK_FLOOR_CENTS)) { excluded.push({ targetId: t.id, why: 'belowFloor' }); continue }
    kept.push({ t, wanted: ask.bidCents })
  }
  // The bid that lands: the CPC ceiling, then each campaign's max-change guardrail (as set-target-bid shows it).
  // W1-5 — the largest change is the lower of the campaign's and the ads strategy's for the target's ad group.
  const { entries } = await clampBidsByCeiling(kept.map((k) => ({ adTargetId: k.t.id, bidCents: k.wanted })))
  const strategy = kept.length ? await strategyBidReader().forAdGroups(kept.map((k) => ({ adGroupId: k.t.adGroupId, marketplace: k.t.campaign.marketplace }))) : new Map()
  const changing: Array<{ t: BulkTarget; to: number }> = []
  kept.forEach((k, i) => {
    const to = changeClampedBid(k.t.bidCents, entries[i].bidCents, k.t.campaign.dynamicBidding, strategy.get(k.t.adGroupId)?.limits)
    const verdict = suppressionOf({ id: k.t.id, bidCents: k.t.bidCents, suppressedFromBidCents: k.t.suppressedFromBidCents }, to)
    if (verdict === 'suppressed') return void excluded.push({ targetId: k.t.id, why: 'suppressed' })
    if (verdict === 'low-unflagged') return void excluded.push({ targetId: k.t.id, why: 'lowUnflagged' })
    if (to === k.t.bidCents) return void excluded.push({ targetId: k.t.id, why: 'unchanged' })
    // 3A + 4A — the campaign's own min/max bid is HIS limit: the gate reports it (pastOwnLimits) and the card warns.
    changing.push({ t: k.t, to })
  })
  // Live reach per ad group: bounds are an interval, so the lowest and the highest new bid answer for all between.
  // W1-5 — per AD GROUP (it was per campaign): the ads strategy's bid band is the one of each ad group's products, as
  // the write itself is judged (ads-mutation.service.ts, the worker).
  const groupKey = (t: BulkTarget) => `${t.campaign.id}|${t.adGroupId}`
  const byGroup = new Map<string, Array<{ t: BulkTarget; to: number }>>()
  for (const c of changing) byGroup.set(groupKey(c.t), [...(byGroup.get(groupKey(c.t)) ?? []), c])
  const profiles = new Set<string>()
  const refusedGroups = new Map<string, string>()
  const pastOwnLimits: Array<{ limit: string; reason: string }> = [] // 3A + 4A — for the card's warning
  // AA-W2-6 — the same writes as the gate judges a run by rule (asked only when it may run by rule).
  const ruleWrites: RuleWrite[] = []
  for (const [key, list] of [...byGroup].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const values = [...new Set([Math.min(...list.map((l) => l.to)), Math.max(...list.map((l) => l.to))])]
    const where = { campaignId: list[0].t.campaign.id, adGroupId: list[0].t.adGroupId, marketplace: list[0].t.campaign.marketplace }
    for (const value of values) {
      const reach = await checkLiveReach({ ...where, changes: [{ field: 'bid', valueCents: value }] })
      if (reach.reach === 'refused') { refusedGroups.set(key, reach.reason); break }
      if (reach.reach === 'live') {
        profiles.add(reach.profileId)
        for (const l of reach.pastOwnLimits ?? []) if (!pastOwnLimits.some((x) => x.reason === l.reason)) pastOwnLimits.push(l)
      }
    }
    if (!refusedGroups.has(key)) for (const value of values) ruleWrites.push({ ...where, label: `campaign "${list[0].t.campaign.name}"`, changes: [{ field: 'bid', valueCents: value }] })
  }
  const going = changing.filter((c) => !refusedGroups.has(groupKey(c.t)))
  for (const c of changing.filter((x) => refusedGroups.has(groupKey(x.t)))) {
    excluded.push({ targetId: c.t.id, why: 'refusedByGate', detail: refusedGroups.get(groupKey(c.t)) })
  }
  if (!going.length) {
    const counts = countBy(excluded)
    return { result: { ok: false, error: `Nothing would change: ${Object.entries(counts).map(([k, n]) => `${n} ${EXCLUSION_WORDS[k as Exclusion]}`).join('; ')}.` }, writes: [] }
  }
  going.sort((x, y) => (x.t.id < y.t.id ? -1 : 1))
  const reach: StoredReach = profiles.size ? { reach: 'live', profileId: [...profiles].sort().join(','), ...(pastOwnLimits.length ? { pastOwnLimits } : {}) } : { reach: 'sandbox' }
  const byCurrency: Record<string, { targets: number; deltaCents: number }> = {}
  for (const g of going) {
    const cur = campaignCurrency(g.t.campaign)
    const entry = (byCurrency[cur] ??= { targets: 0, deltaCents: 0 })
    entry.targets++
    entry.deltaCents += g.to - g.t.bidCents
  }
  const bound = (await Promise.all([...new Set(going.map((g) => g.t.campaign.id))].slice(0, 10).map((id) => alsoChangedBy(id)))).flatMap((b) => b.automations).slice(0, 10)
  const counts = countBy(excluded)
  const writes = going.map((g) => ({ targetId: g.t.id, fromCents: g.t.bidCents, toCents: g.to, ...(sourceByTarget.has(g.t.id) ? { source: sourceByTarget.get(g.t.id)! } : {}) }))
  const sourced = writes.filter((w) => w.source).length
  // AA-W2-6 — every row against the ads strategy of its own ad group (not only the 20 lines shown), counted as one run.
  const rule = opts.rule
    ? await ruleFactsFor({
      tool: 'bulk-ad-bid-change',
      limits: BULK_BID_LIMITS,
      items: writes.map((w) => ({ entity: { kind: 'target' as const, id: w.targetId }, change: { field: 'bid' as const, fromCents: w.fromCents, toCents: w.toCents } })),
      writes: ruleWrites,
      approvalId: opts.rule.approvalId,
    })
    : null
  return { writes, result: {
    ok: true,
    preview: {
      action: 'bulk-ad-bid-change',
      mode: a.bids?.length ? 'list' : 'selection',
      ...(a.percent != null ? { percent: a.percent } : {}),
      totals: { asked: read.asked.length, changing: going.length, excluded: counts },
      changes: going.slice(0, LINES_SHOWN).map((g) => ({ targetId: g.t.id, text: g.t.text, campaignName: g.t.campaign.name, currency: campaignCurrency(g.t.campaign), fromCents: g.t.bidCents, toCents: g.to, ...(sourceByTarget.has(g.t.id) ? { source: sourceByTarget.get(g.t.id)!.id } : {}) })),
      ...(going.length > LINES_SHOWN ? { moreChanges: going.length - LINES_SHOWN } : {}),
      excludedLines: excluded.slice(0, LINES_SHOWN).map((e) => ({ targetId: e.targetId, why: e.detail ? `${EXCLUSION_WORDS[e.why]}: ${e.detail}` : EXCLUSION_WORDS[e.why] })),
      byCurrency,
      // Every target's id, starting bid and new bid: a move on any of the 500 is caught, not only on the 20 shown.
      basis: createHash('sha256').update(going.map((g) => `${g.t.id}:${g.t.bidCents}:${g.to}`).join('|')).digest('base64url').slice(0, 32),
      reach,
      reachNote: reachNote(reach),
      alsoChangedBy: bound,
      ...(rule ?? {}),
      // W3-1 — how many rows carry out an engine's recommendation (each line names its id).
      ...(sourced ? { sources: { recommendations: sourced }, sourceNote: `${sourced} of these bids carry out the bid optimizer's recommendations (each line names its id). Once they run they are not offered again until the data shows what the change did.` } : {}),
      effect: `Moves ${going.length} bid${going.length === 1 ? '' : 's'} (${Object.entries(byCurrency).map(([cur, v]) => `${v.deltaCents >= 0 ? '+' : '−'}${amountLabel(Math.abs(v.deltaCents), cur)} in total per click on ${v.targets}`).join('; ')})${excluded.length ? `; ${excluded.length} left as they are` : ''}.`,
    },
  } }
}

const countBy = (list: Array<{ why: Exclusion }>) => {
  const out: Partial<Record<Exclusion, number>> = {}
  for (const e of list) out[e.why] = (out[e.why] ?? 0) + 1
  return out
}

/**
 * C2 — undo of a bulk bid change: undo-ad-change reverses its writes as one (never a part of them). W3-1 — a change that
 * recorded its own writes is named by its id, so only they are reversed (in a change plan every step shares the plan's
 * set); an older record reverses the whole set, as before.
 */
export const BULK_BID_UNDO: ToolUndo = {
  async current(change) {
    const ids = Object.keys(((change.after as { bids?: Record<string, number> } | null)?.bids) ?? {})
    const rows = ids.length ? await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, bidCents: true } }) : []
    return { bids: Object.fromEntries(rows.sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.bidCents])) }
  },
  request(change) {
    const changeSetId = (change.before as { changeSetId?: unknown } | null)?.changeSetId
    if (typeof changeSetId !== 'string' || !changeSetId) return { refusal: 'This change does not name the request that made it.' }
    const own = change.id && Array.isArray((change.before as { actionLogIds?: unknown }).actionLogIds)
    return { tool: 'undo-ad-change', args: { changeSetId, ...(own ? { changeId: change.id } : {}), why: 'undo of a bulk bid change' } }
  },
  undone: unsettleChange,
}

const bulkAdBidChange: AgentTool = {
  name: 'bulk-ad-bid-change',
  title: 'Change many ad bids',
  input: z.object({
    bids: z.array(z.object({
      targetId: z.string().trim().min(1).max(64).describe('Nexus ad target id (targetId in ad-targets)'),
      bidCents: z.coerce.number().int().min(1).max(100_000).describe('its new bid, in minor units of its campaign\'s currency'),
      source: sourceArg,
    })).max(BULK_LIST_MAX).optional().describe(`targets with their new bids, at most ${BULK_LIST_MAX}; or leave it out and give a selection and percent (up to ${BULK_MAX})`),
    campaignId: z.string().trim().min(1).max(64).optional().describe('only targets of this campaign (Nexus id): the selection, or a filter on the list'),
    adGroupId: z.string().trim().min(1).max(64).optional().describe('only targets of this ad group (Nexus id)'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only targets in this marketplace, e.g. IT'),
    search: z.string().trim().min(1).max(100).optional().describe('with a selection: only targets whose text, campaign or ad group name contains this'),
    percent: z.coerce.number().min(-90).max(100).optional().describe('with a selection: move every selected enabled target\'s bid by this percent (−90 to +100)'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  // AA-W2-6 (Owner D-W2-1 = A, D-W2-3 = A) — still stored as an approval at every door; the business may let Claude's
  // request run by its rule, only inside its limits and the ads strategy of every row. One request is one run of the
  // business's daily cap; its rows count against the strategy's daily limits per market.
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: BULK_BID_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits),
  undo: BULK_BID_UNDO,
  description:
    `Change many Amazon Sponsored Products bids in one request: a list of targets with their new bids (up to ${BULK_LIST_MAX}), `
    + `or a selection (campaign, ad group or market, optionally a text; up to ${BULK_MAX} targets) moved by a percent. `
    + 'Nothing changes until a person approves it in Nexus, or the person who asked confirms it in Claude with their '
    + 'authenticator code when the business set it so — unless the business lets it run by its rule, inside its limits '
    + 'and the ads strategy of every row (by default only cuts, at most 50 targets; a raise waits for a person). '
    + 'The preview counts what changes and what is left as it is, '
    + 'by reason (suppressed bids are never raised, pinned or non-SP campaigns, bid bounds, a campaign Amazon\'s write '
    + 'gate refuses, unchanged), shows the first 20 changes and the total per currency, where it lands, and each limit '
    + 'with where it comes from. Approved, '
    + 'every write carries the approval as its change set; undo-change reverses the whole set at once.',
  async handler(args, ctx) {
    return (await bulkDecision(args, { rule: { approvalId: ctx.approvalId } })).result
  },
  async execute(args, ctx) {
    // One decision: its preview is re-checked against what was approved (the basis fingerprints every write), and
    // its full list of writes — not the 20 lines shown — is what runs.
    const { result: fresh, writes: going } = await bulkDecision(args)
    const refusal = recheck(ctx, fresh, ['totals', 'basis', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const out = await bulkUpdateAdTargetBids({
      entries: going.map((g) => ({ adTargetId: g.targetId, bidCents: g.toCents, ...(g.source ? { evidence: withSource(null, g.source) } : {}) })),
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
      manual: run.manual, // 4A
      confirmOwnLimits: run.confirmOwnLimits, // 4A
    })
    // W3-1 — the recommendations of the rows that were written (or already held the bid) are settled.
    await settleSources(going.filter((g, i) => out.outcomes[i]?.ok).map((g) => g.source), run.changeSetId)
    const ids = going.map((g) => g.targetId)
    const now = await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, bidCents: true } })
    const sorted = (rows: Array<{ id: string; bidCents: number }>) => Object.fromEntries([...rows].sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.bidCents]))
    return {
      ok: out.failed === 0,
      ...(out.failed ? { error: `Partly run: ${out.applied} queued, ${out.failed} refused by the bid write. Undo-change reverses what was queued.` } : {}),
      data: { applied: out.applied, skipped: out.skipped, failed: out.failed, reach: p.reach, changeSetId: run.changeSetId, note: 'Queued for Amazon: each bid is sent after the 5-minute cancel window. approval-status follows them.' },
      change: {
        // W3-1 — the writes this change made (its undo reverses only them) and the recommendations it settled.
        before: {
          changeSetId: run.changeSetId, bids: sorted(going.map((g) => ({ id: g.targetId, bidCents: g.fromCents }))),
          actionLogIds: out.outcomes.map((o) => o.actionLogId).filter((id): id is string => !!id),
          ...sourcesRecord(going.filter((g, i) => out.outcomes[i]?.ok).map((g) => g.source)),
        },
        after: { bids: sorted(now) },
      },
    }
  },
}

// ── suppress-campaign / restore-campaign (A8) ─────────────────────────────────────────────────────

/** What suppression state a campaign is in, as a suppress / restore change records it and undo compares it. */
async function suppressionState(campaignId: string): Promise<{ campaignId: string; suppressed: boolean; by: string | null }> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true } })
  return { campaignId, suppressed: !!c?.bidsSuppressedAt, by: c?.bidsSuppressedAt ? (c.bidsSuppressedBy ?? null) : null }
}

async function suppressPreview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  // W3-1 — a source names this campaign's own retail-readiness recommendation, or the request is refused.
  const changeSource = sourceOf(args.source)
  const wrongSource = sourceRefusal(changeSource, recommendationIdFor.retail(campaignId))
  if (wrongSource) return { ok: false, error: `Not queued: ${wrongSource}.` }
  const campaign = await campaignForChange(campaignId)
  if (!campaign) return { ok: false, error: `campaign ${campaignId} not found` }
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  if (campaign.bidsSuppressedAt) {
    return { ok: false, error: `${campaign.name}'s bids are already suppressed (by ${campaign.bidsSuppressedBy ?? 'an unrecorded actor'} since ${campaign.bidsSuppressedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC).` }
  }
  // ADS AUTONOMY W1-6 — the stop bid: the ads strategy's for this campaign (its market, the lower across its products),
  // else the 2-cent floor. A stop is low bids whatever stop method the strategy names.
  const stop = (await stopBidsFor([{ id: campaign.id, marketplace: campaign.marketplace }])).get(campaign.id) ?? { cents: SUPPRESSION_FLOOR_CENTS, source: null }
  const floor = stop.cents
  const floorWords = stop.source ? `the stop bid of ${floor} cents (${strategySourceWords(stop.source)})` : 'the 2-cent floor'
  const [targets, groups] = await Promise.all([
    prisma.adTarget.count({ where: { adGroup: { campaignId }, isNegative: false, bidCents: { gt: floor }, suppressedFromBidCents: null } }),
    adGroupSuppressionCounts(campaignId, floor),
  ])
  if (!targets && !groups.aboveFloor) return { ok: false, error: `Every bid of ${campaign.name} is already at the floor: there is nothing to lower.` }
  const intent = { campaignId, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents: floor }], isSuppression: true }
  const reach = await checkLiveReach(intent)
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(campaignId)
  // AA-W2-9 — what a run by rule is judged on: the campaign as one change (its bids go down together, from the highest
  // above the stop bid to it: a stop's low bid, which no lowest bid and no step binds), the ads strategy where it lands
  // (a protected product's ads are never stopped by rule) and the gate as the rule's write (a stop passes a halt).
  const [topTarget, topGroup] = await Promise.all([
    prisma.adTarget.aggregate({ where: { adGroup: { campaignId }, isNegative: false, bidCents: { gt: floor }, suppressedFromBidCents: null }, _max: { bidCents: true } }),
    highestAdGroupBidAbove(campaignId, floor),
  ])
  const highest = Math.max(topTarget._max.bidCents ?? 0, topGroup ?? 0)
  const rule = await ruleFactsFor({
    tool: 'suppress-campaign',
    limits: SUPPRESS_LIMITS,
    items: [{ entity: { kind: 'campaign', id: campaignId }, change: { field: 'bid', fromCents: highest, toCents: floor, forced: true } }],
    writes: [{ ...intent, label: `campaign "${campaign.name}"` }],
    approvalId: ctx?.approvalId,
  })
  return {
    ok: true,
    preview: {
      action: 'suppress-campaign',
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      moves: { targets, adGroups: groups.aboveFloor },
      stopBidCents: floor,
      stopBidFrom: stop.source ? strategySourceWords(stop.source) : 'the 2-cent floor (the ads strategy sets no stop bid here)',
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...rule,
      ...sourcePreview(changeSource),
      effect: `Lowers every bid of ${campaign.name} to ${floorWords} — ${targets} target${targets === 1 ? '' : 's'} and ${groups.aboveFloor} ad group default${groups.aboveFloor === 1 ? '' : 's'} — so it stops winning auctions without being paused. Each bid is remembered; restore-campaign puts them back.`,
    },
  }
}

/** AA-W2-9 — suppress-campaign's Claude limits: the kit's alone (a stop only lowers: no raise to bound). */
const SUPPRESS_LIMITS = adKitLimits({ maxItems: 1 })

const suppressCampaign: AgentTool = {
  name: 'suppress-campaign',
  title: 'Stop a campaign (no pause)',
  input: z.object({ campaignId: campaignIdArg, why: whyArg, source: sourceArg }),
  requires: [F.adsBidsEdit],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  // AA-W2-9 — a stop may run by the business's rule, only inside its limits and the ads strategy (never the campaign of
  // a protected product), and only where the gate lets the rule's own write through. It only lowers: no raise limit.
  strategyBound: 'amazon-ads',
  maxClaudeTrust: 'auto',
  limits: SUPPRESS_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits),
  // A person who may stop a campaign without seeing ad spend sees its stop bid as before; the strategy's money is hidden.
  restrictedFields: strategyFactsMoney(['stopBidCents']),
  undo: {
    current: (change) => suppressionState(String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')),
    request: (change) => {
      const campaignId = (change.after as { campaignId?: unknown } | null)?.campaignId
      return typeof campaignId === 'string' && campaignId ? { tool: 'restore-campaign', args: { campaignId, why: 'undo of a suppression' } } : { refusal: 'This change does not name its campaign.' }
    },
    undone: unsettleChange,
  },
  description:
    'Stop an Amazon Sponsored Products campaign the Nexus way: never paused — every keyword and target bid and every ad '
    + "group default bid goes to the stop bid the ads strategy sets for it (the 2-cent floor when it sets none; bids already "
    + 'lower stay), and each bid is remembered; restore-campaign brings it back in about a minute. Nothing changes until '
    + 'it is approved: in Nexus, or the person who asked confirms it in Claude with their authenticator code when the '
    + `business set it so. ${BY_RULE_WORDS} — never the campaign of a product the strategy protects. The preview counts `
    + 'what moves, where it lands (live at Amazon or sandbox) and the ads strategy\'s limits that apply. Refused, and not '
    + 'queued, when it is already suppressed or Amazon\'s write gate would refuse it (the live-write allowlist; a halt '
    + 'does not block lowering). restore-campaign (or undo-change) puts the bids back.',
  async handler(args, ctx) {
    return suppressPreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await suppressPreview(args, ctx)
    // W1-6 — the stop bid is material: a strategy change since the approval stops the run.
    const refusal = recheck(ctx, fresh, ['moves', 'reach', 'stopBidCents'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; reach: StoredReach; effect: string; stopBidCents: number }
    const run = approvedRun(ctx, String(args.why ?? '') || 'no-pause stop: bids floored instead of pausing')
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const changeSource = sourceOf(args.source)
    const moved = await suppressCampaignBids(p.campaign.id, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, floorCents: p.stopBidCents, ...(changeSource ? { evidence: withSource(null, changeSource) } : {}) })
    const now = await suppressionState(p.campaign.id)
    if (!now.suppressed) return notRun('Not run: the campaign was not suppressed (it changed meanwhile). Nothing changed.')
    await settleSources([changeSource], run.changeSetId)
    return {
      ok: true,
      data: { campaignId: p.campaign.id, moved, reach: p.reach, changeSetId: run.changeSetId, note: 'Bids floored and remembered; each lowered bid is sent to Amazon at once.' },
      change: { before: { campaignId: p.campaign.id, suppressed: false, by: null, changeSetId: run.changeSetId, ...sourcesRecord([changeSource]) }, after: now },
    }
  },
}

async function restorePreview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const campaign = await campaignForChange(campaignId)
  if (!campaign) return { ok: false, error: `campaign ${campaignId} not found` }
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  const refused = liftSuppressionRefusal(campaign)
  if (refused) return { ok: false, error: `${campaign.name} is not restored here: ${refused}.` }
  const [remembered, groups] = await Promise.all([
    // W1-6b — what the restore gives back: not the ad groups floored on their own (a product over its monthly cap).
    prisma.adTarget.findMany({
      where: { adGroup: { campaignId, bidsSuppressedAt: null }, suppressedFromBidCents: { not: null } },
      select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true, adGroupId: true },
      orderBy: { id: 'asc' },
    }),
    adGroupSuppressionCounts(campaignId, SUPPRESSION_FLOOR_CENTS),
  ])
  // W1-5 — the bid each target goes back to, as the run decides it: the remembered bid, held inside the campaign's own
  // bounds, the bid policies and the ads strategy band of its ad group (it was refused above them: a silent stop).
  const back = await restoreBidsFor(campaignId, remembered.map((t) => ({ ...t, suppressedFromBidCents: t.suppressedFromBidCents as number })))
  const toCents = (t: (typeof remembered)[number]) => back.get(t.id)?.cents ?? (t.suppressedFromBidCents as number)
  const top = remembered.reduce<(typeof remembered)[number] | null>((best, t) => (!best || toCents(t) > toCents(best) ? t : best), null)
  const highest = top ? toCents(top) : 0
  const held = remembered.filter((t) => back.get(t.id)?.heldBy)
  const intent = { campaignId, adGroupId: top?.adGroupId ?? null, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents: highest || null }], isSuppression: true }
  const reach = await checkLiveReach(intent)
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const currency = campaignCurrency(campaign)
  const bound = await alsoChangedBy(campaignId)
  // AA-W2-9 — what a run by rule is judged on: the campaign as one restart (its daily budget spends again, in full, in
  // the month's forecast and the market's daily budget increase by rule), the bids it puts back (already held inside
  // the ads strategy's band, W1-5) and the gate as the rule's write.
  const rule = await ruleFactsFor({
    tool: 'restore-campaign',
    limits: RESTORE_LIMITS,
    items: [{ entity: { kind: 'campaign', id: campaignId }, change: { field: 'status', from: 'LOW_BIDS', to: 'ENABLED', dailyBudgetCents: Math.round(Number(campaign.dailyBudget) * 100) } }],
    writes: [{ ...intent, label: `campaign "${campaign.name}"` }],
    approvalId: ctx?.approvalId,
  })
  return {
    ok: true,
    preview: {
      action: 'restore-campaign',
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      suppressedBy: campaign.bidsSuppressedBy,
      currency,
      restores: { targets: remembered.length, adGroups: groups.remembered },
      bids: remembered.slice(0, LINES_SHOWN).map((t) => ({
        targetId: t.id, text: t.expressionValue, fromCents: t.bidCents, toCents: toCents(t),
        ...(back.get(t.id)?.heldBy ? { rememberedCents: t.suppressedFromBidCents, heldBy: back.get(t.id)!.heldBy } : {}),
      })),
      // Every remembered bid: a change to any of them (another suppression, a manual edit) stops the run. W1-5 — and a
      // held bid's value: a limit that moved after approval stops it too.
      basis: createHash('sha256').update(remembered.map((t) => `${t.id}:${t.bidCents}:${t.suppressedFromBidCents}${back.get(t.id)?.heldBy ? `:${toCents(t)}` : ''}`).join('|')).digest('base64url').slice(0, 32),
      highestRestoredBidCents: highest,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...(groups.ownFloors ? { staysFloored: { adGroups: groups.ownFloors } } : {}),
      ...rule,
      effect: `Puts back the bids ${campaign.name} had before it was suppressed: ${remembered.length} target${remembered.length === 1 ? '' : 's'} and ${groups.remembered} ad group default${groups.remembered === 1 ? '' : 's'}${highest ? `, the highest ${amountLabel(highest, currency)}` : ''}${held.length ? `; ${held.length} at a bid limit instead of the bid it had (each line says which)` : ''}. The campaign serves again.${groups.ownFloors ? ` ${groups.ownFloors} ad group${groups.ownFloors === 1 ? ' stays' : 's stay'} at ${groups.ownFloors === 1 ? 'its' : 'their'} own floor (a product over its monthly cap in the ads strategy) until the 1st or until that cap is raised.` : ''}`,
    },
  }
}

/** AA-W2-9 — restore-campaign's Claude limits: the kit's, and the highest bid it may put back (0: every restore waits). */
const RESTORE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxRestoredBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe('the highest bid a restore may put back without a person, in minor units of the campaign\'s currency; 0 = every restore waits for a person'),
})

/** AA-W2-9 — the highest bid a restore puts back, within this tool's limit (0 by default: every restore waits). */
function restoreRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const highest = Number((preview as { highestRestoredBidCents?: unknown } | null | undefined)?.highestRestoredBidCents)
  if (!Number.isFinite(highest)) return 'the preview does not say the highest bid it puts back; a person decides'
  const max = typeof limits.maxRestoredBidCents === 'number' ? limits.maxRestoredBidCents : 0
  const currency = String((preview as { currency?: unknown }).currency ?? 'EUR')
  if (highest <= max) return null
  return `its highest restored bid is ${amountLabel(highest, currency)}, more than the ${amountLabel(max, currency)} this tool's limits let run without a person${max === 0 ? ' (0: every restore waits for a person)' : ''}; a person decides`
}

const restoreCampaign: AgentTool = {
  name: 'restore-campaign',
  title: 'Restore a suppressed campaign',
  input: z.object({ campaignId: campaignIdArg, why: whyArg }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // AA-W2-9 — it may run by the business's rule, only inside its limits and the ads strategy (D-W2-1 = A; D-W2-6 = A:
  // starting a campaign's spend is its own kind).
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: RESTORE_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? restoreRefusal(preview, limits),
  undo: {
    current: (change) => suppressionState(String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')),
    request: (change) => {
      const campaignId = (change.after as { campaignId?: unknown } | null)?.campaignId
      return typeof campaignId === 'string' && campaignId ? { tool: 'suppress-campaign', args: { campaignId, why: 'undo of a restore' } } : { refusal: 'This change does not name its campaign.' }
    },
  },
  description:
    'Put back the bids an Amazon Sponsored Products campaign had before it was suppressed (the no-pause stop), so it '
    + 'serves again. Only a suppression a person set is lifted here — never one an engine set (dayparting, the retail '
    + 'guard, budget enforcement own theirs). Nothing changes until it is approved; spend resumes. '
    + `${BY_RULE_WORDS}: no bid put back above the highest its limits allow (0 by default: every restore waits for a `
    + 'person), within the market\'s daily budget increase by rule (its daily budget spends again) and keeping the '
    + 'month\'s spend forecast under its monthly cap. The preview lists the bids it restores in the campaign\'s currency, '
    + 'where it lands and the ads strategy\'s limits that apply.',
  async handler(args, ctx) {
    return restorePreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await restorePreview(args, ctx)
    const refusal = recheck(ctx, fresh, ['suppressedBy', 'basis', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; suppressedBy: string | null; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || 'restore after a no-pause stop')
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const restored = await restoreCampaignBids(p.campaign.id, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
    const now = await suppressionState(p.campaign.id)
    const change = { before: { campaignId: p.campaign.id, suppressed: true, by: p.suppressedBy, changeSetId: run.changeSetId }, after: now }
    if (now.suppressed) {
      return { ok: false, error: `Partly restored: ${restored} bid${restored === 1 ? '' : 's'} put back, some not; the campaign stays suppressed until all are. Approve again to retry.`, change }
    }
    return { ok: true, data: { campaignId: p.campaign.id, restored, reach: p.reach, changeSetId: run.changeSetId }, change }
  },
}

// ── set-campaign-live-writes (A12) ────────────────────────────────────────────────────────────────

const LIVE_WRITES_TOOL = 'set-campaign-live-writes'
/** AA-W2-9 — set-campaign-live-writes' Claude limits: on by rule at most this many a day, only Claude's own campaigns. */
const LIVE_WRITES_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaignsOnPerDay: z.number().int().min(0).max(50).default(0)
    .describe('the most campaigns Claude may put on the live-write allowlist by rule in 24 hours; 0 = every one waits for a person (taking one off is never held)'),
  allowAnyCampaign: z.boolean().default(false)
    .describe('let a campaign Claude did not create go on the allowlist by rule; never by default'),
})

/**
 * AA-W2-9 (D-W2-6 = A) — the request of this business that created the campaign, when a Claude request did
 * (create-ad-campaign records `after.campaignId`); null for one a person or a sync made.
 */
async function createdByClaudeRequest(campaignId: string): Promise<{ approvalId: string; at: string } | null> {
  const made = await prisma.agentChange.findFirst({
    where: { toolName: 'create-ad-campaign', after: { path: ['campaignId'], equals: campaignId } },
    orderBy: { executedAt: 'asc' },
    select: { approvalId: true, executedAt: true },
  })
  return made ? { approvalId: made.approvalId, at: made.executedAt.toISOString() } : null
}

/** AA-W2-9 — campaigns put ON the allowlist by the business's rule in the last 24 hours (`excludeApprovalId`: this one). */
async function allowlistedByRuleToday(excludeApprovalId?: string | null): Promise<number> {
  const since = new Date(Date.now() - SET_WINDOW_MS)
  const on = { path: ['enabled'], equals: true }
  const [single, steps] = await Promise.all([
    prisma.agentApproval.count({ where: { toolName: LIVE_WRITES_TOOL, decisionVia: 'auto', decidedAt: { gte: since }, args: on, ...(excludeApprovalId ? { id: { not: excludeApprovalId } } : {}) } }),
    prisma.agentPlanStep.count({ where: { toolName: LIVE_WRITES_TOOL, status: { not: 'skipped' }, args: on, approval: { decisionVia: 'auto', decidedAt: { gte: since } }, ...(excludeApprovalId ? { approvalId: { not: excludeApprovalId } } : {}) } }),
  ])
  return single + steps
}

async function liveWritesPreview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const enabled = args.enabled === true || args.enabled === 'true'
  const campaign = await campaignForChange(campaignId)
  if (!campaign) return { ok: false, error: `campaign ${campaignId} not found` }
  if (campaign.liveBidWritesEnabled === enabled) {
    return { ok: false, error: `${campaign.name} is already ${enabled ? 'on' : 'off'} the live-write allowlist.` }
  }
  const [profile, bound] = await Promise.all([adsProfileFor(campaign.marketplace).catch(() => null), alsoChangedBy(campaign.id)])
  const connectionLive = !!profile && profile.mode === 'production' && profile.writesEnabledAt != null
  // AA-W2-9 — what a run by rule is judged on (on only: off is a brake): who made the campaign, how many were put on by
  // rule today, and the ads strategy where it lands (the engines that would then write it hold it, C4).
  const createdBy = enabled ? await createdByClaudeRequest(campaign.id) : null
  const onByRuleToday = enabled ? await allowlistedByRuleToday(ctx?.approvalId) : 0
  // A Nexus switch: no write for the gate to judge (the writes it lets through are judged when they write).
  const facts = await ruleFactsFor({ tool: LIVE_WRITES_TOOL, limits: LIVE_WRITES_LIMITS, items: [{ entity: { kind: 'campaign', id: campaign.id }, change: { field: 'liveWrites', from: campaign.liveBidWritesEnabled, to: enabled }, nexusOnly: true }], writes: [], approvalId: ctx?.approvalId })
  return {
    ok: true,
    preview: {
      action: 'set-campaign-live-writes',
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      liveWrites: { from: campaign.liveBidWritesEnabled, to: enabled },
      connection: profile ? { profileId: profile.profileId, mode: profile.mode, writesEnabled: profile.writesEnabledAt != null } : null,
      ...(enabled ? { createdBy, onByRuleToday } : {}),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...facts,
      effect: enabled
        ? `Puts ${campaign.name} on the live-write allowlist: approved changes${bound.automations.length ? ' and its rules and schedules' : ''} may then write its bids, budget and placements at Amazon${connectionLive ? '' : ' — once Amazon ads writes are live and its market\'s connection allows writes (today they would not reach Amazon)'}.`
        : `Takes ${campaign.name} off the live-write allowlist: no write reaches Amazon for it any more (bids already sent stay where they are; nothing is paused).`,
    },
  }
}

/**
 * AA-W2-9 — off the allowlist is a brake: inside at any limit. On, by rule: only a campaign a Claude request created in
 * this business (unless allowAnyCampaign), at most maxCampaignsOnPerDay a day (0 by default), inside the ads strategy.
 */
function liveWritesWithin(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { liveWrites?: { to?: unknown }; createdBy?: unknown; onByRuleToday?: unknown }
  if (p.liveWrites?.to === false) return null
  const common = ruleRefusal(preview, limits)
  if (common) return common
  if (!p.createdBy && limits.allowAnyCampaign !== true) {
    return 'only a campaign a Claude request created in this business goes on the live-write allowlist by rule (allowAnyCampaign is off); a person decides'
  }
  const max = typeof limits.maxCampaignsOnPerDay === 'number' ? limits.maxCampaignsOnPerDay : 0
  const today = typeof p.onByRuleToday === 'number' ? p.onByRuleToday : Number.POSITIVE_INFINITY
  if (today + 1 > max) {
    return max === 0
      ? 'this tool\'s limits let no campaign go on the live-write allowlist by rule (maxCampaignsOnPerDay 0); a person decides'
      : `${today} campaign${today === 1 ? '' : 's'} went on the live-write allowlist by rule in the last 24 hours, and this tool's limits allow ${max} a day; a person decides`
  }
  return null
}

const setCampaignLiveWrites: AgentTool = {
  name: 'set-campaign-live-writes',
  title: 'Allow live writes to a campaign',
  input: z.object({
    campaignId: campaignIdArg,
    enabled: z.boolean().describe('true: on the live-write allowlist (approved and automated writes may reach Amazon); false: off it'),
    why: whyArg,
  }),
  requires: [F.adsCampaignsManage, F.adsAutomationManage],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // AA-W2-9 (D-W2-1 = A, D-W2-6 = A) — it may run by the business's rule: off at any limit (a brake); on only for a
  // campaign Claude itself created, inside its limits and the ads strategy.
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // A Nexus switch: nothing is sent to Amazon by it (it decides what later writes may reach).
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: LIVE_WRITES_LIMITS,
  withinLimits: liveWritesWithin,
  restrictedFields: strategyFactsMoney(),
  undo: {
    async current(change) {
      const campaignId = String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')
      const c = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { liveBidWritesEnabled: true } })
      return { campaignId, enabled: c?.liveBidWritesEnabled ?? null }
    },
    request(change) {
      const before = (change.before ?? {}) as { campaignId?: string; enabled?: boolean }
      if (!before.campaignId || typeof before.enabled !== 'boolean') return { refusal: 'This change does not record the setting it replaced.' }
      return { tool: 'set-campaign-live-writes', args: { campaignId: before.campaignId, enabled: before.enabled, why: 'undo of an earlier allowlist change' } }
    },
  },
  description:
    'Put an Amazon campaign on the live-write allowlist, or take it off. Only an allowlisted campaign takes a live '
    + 'write from an approved ad change, a rule or a schedule (d2); a person\'s own edit on the Nexus screens passes it. '
    + 'A campaign launched from the Nexus screens (the campaign wizards, a blueprint, an AI goal) is put on it the moment '
    + 'it exists; one made by create-ad-campaign or found by a sync starts off it. It is a Nexus switch and sends nothing '
    + `to Amazon itself. Nothing changes until it is approved. ${BY_RULE_WORDS}: taking a campaign off (a brake) at any `
    + 'limit; putting one on only for a campaign a Claude request created in this business, at most as many a day as its '
    + 'limits allow (0 by default: each waits for a person), and never one a rule or schedule also moves. The preview '
    + 'says whether its market\'s connection would let writes through today, which rules may then write to it, and who '
    + 'created the campaign.',
  async handler(args, ctx) {
    return liveWritesPreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await liveWritesPreview(args, ctx)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as { campaign: { id: string }; liveWrites: { from: boolean; to: boolean }; effect: string }
    const approved = (ctx.approvedPreview as { liveWrites?: { from?: unknown } } | undefined)?.liveWrites
    if (approved && approved.from !== p.liveWrites.from) return notRun('Not run: the allowlist setting changed since it was approved. Nothing changed.')
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const out = await setLiveWrites(p.campaign.id, p.liveWrites.to, `${run.actor} (${run.reason})`)
    if (out.error) return notRun(`Not run: ${out.error}.`)
    return {
      ok: true,
      data: { campaignId: p.campaign.id, liveWrites: p.liveWrites.to, changeSetId: run.changeSetId },
      change: { before: { campaignId: p.campaign.id, enabled: p.liveWrites.from }, after: { campaignId: p.campaign.id, enabled: p.liveWrites.to } },
    }
  },
}

export const ADS_CHANGE_TOOLS: AgentTool[] = [setCampaignBudget, setPlacementMultipliers, bulkAdBidChange, suppressCampaign, restoreCampaign, setCampaignLiveWrites, undoAdChange]
