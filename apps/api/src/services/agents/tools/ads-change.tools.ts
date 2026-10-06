/**
 * MCP full control A6–A10, A12 (docs/mcp-full-control/sections/01-ads.md §3, §6) — Claude's Amazon ad change tools
 * beyond the fleet's three (ads-propose.tools.ts). Every one follows the rules in ads-change-kit.ts: preview first
 * with the A3 guards, refused and not queued when Amazon's write gate would refuse it, run only as an approved
 * request (as the approver, changeSetId = the approval), re-checked in `execute`, and never pausing anything (d3).
 *
 *   set-campaign-budget (A6)        a campaign's daily budget, in its own currency; the campaign's budget bounds and
 *                                   (live) the gate's value cap, spend ceilings and daily budget-movement bound refuse
 *   set-placement-multipliers (A6)  top-of-search / product-pages / rest-of-search adjustments (0–900 %)
 *   bulk-ad-bid-change (A7)         up to 500 target bids in one request — a list, or a selection moved by a percent;
 *                                   every exclusion counted by its reason; one change set, undone as one
 *   suppress-campaign (A8)          the no-pause stop: every bid of the campaign to the 2-cent floor, remembered
 *   restore-campaign (A8)           puts the remembered bids back — only a suppression a person set (`user:`), never an
 *                                   engine's
 *   set-campaign-live-writes (A12)  the per-campaign live-write allowlist (d2): only an allowlisted campaign takes a
 *                                   live write. A Nexus switch (no Amazon call), always asked, never run without a person
 *   undo-ad-change (A10)   puts back an ad change: an approved request's whole change set (changeSetId = its approval
 *                          id) or one recorded change (actionLogId, from ad-changes), through the rollback service;
 *                          negatives the request created are retired (archived at Amazon — that removes a block, it
 *                          stops no ad).
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
import { adGroupCampaigns, adGroupSuppressionCounts } from '../../advertising/ads-entity-lookup.service.js'
import { restoreCampaignBids, suppressCampaignBids, SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { stopBidsFor, strategySourceWords } from '../../advertising/ads-strategy/effective.js'
import { amountLabel, campaignCurrency, checkLiveReach, liftSuppressionRefusal, suppressionOf, type AdWriteIntent, type LiveReach } from './ads-tool-guards.js'
import { alsoChangedBy, approvedRun, changeClampedBid, notRun, reachNote, reachRefusal, recheck, spOnlyRefusal, storedReach, type StoredReach } from './ads-change-kit.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'

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

/** Where the restore lands: every campaign it touches must answer the same, or it is refused. */
async function reachOfRestore(rows: UndoRow[], negatives: UndoNegative[]): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }> }> {
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
  const profiles = new Set<string>()
  for (const [campaignId, entry] of [...byCampaign].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const reach = await checkLiveReach({ campaignId, marketplace: entry.marketplace, changes: entry.changes })
    if (reach.reach === 'refused') return { refused: reach }
    if (reach.reach === 'live') profiles.add(reach.profileId)
  }
  // Some of it live, some in sandbox: it is live (that is what reaches Amazon), on every profile named.
  return { reach: profiles.size ? { reach: 'live', profileId: [...profiles].sort().join(',') } : { reach: 'sandbox' } }
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

/** The negatives an approved request created (its recorded change), still standing — undo retires them. */
async function negativesCreatedBy(changeSetId: string): Promise<UndoNegative[]> {
  const change = await prisma.agentChange.findFirst({ where: { approvalId: changeSetId }, orderBy: { executedAt: 'desc' }, select: { after: true } })
  const listed = ((change?.after ?? null) as { negatives?: Array<{ targetId?: unknown; keywordText?: unknown }> } | null)?.negatives ?? []
  const ids = listed.map((n) => String(n.targetId ?? '')).filter(Boolean)
  if (!ids.length) return []
  // 5f — status decides, as in retireNegatives: a stale `retiredAt` from a failed retire blocks nothing.
  const standing = await prisma.adTarget.findMany({
    where: { id: { in: ids }, isNegative: true, status: { not: 'ARCHIVED' } },
    select: { id: true, expressionValue: true },
  })
  return standing.map((t) => ({ targetId: t.id, keywordText: t.expressionValue }))
}

async function undoPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const changeSetId = typeof args.changeSetId === 'string' ? args.changeSetId.trim() : ''
  const actionLogId = typeof args.actionLogId === 'string' ? args.actionLogId.trim() : ''
  if (!changeSetId && !actionLogId) {
    return { ok: false, error: 'Name the ad change to undo: changeSetId (the approvalId of an approved ad request) or actionLogId (undoActionLogId in ad-changes).' }
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
      return finish({ mode: 'action', actionLogId }, rows, [], 1)
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
  return finish({ mode: 'set', changeSetId: setId }, inWindow.map(rowOut), negatives, inWindow.length)
}

async function finish(source: Record<string, unknown>, rows: UndoRow[], negatives: UndoNegative[], total: number): Promise<ToolResult> {
  const reach = await reachOfRestore(rows, negatives)
  if ('refused' in reach) return { ok: false, error: reachRefusal(reach.refused) }
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
      effect: `Undo ${parts.join(', and ')}. A bid or budget changed since by someone else is overwritten with the earlier value.`,
    },
  }
}

const undoAdChange: AgentTool = {
  name: 'undo-ad-change',
  title: 'Undo an ad change',
  input: z.object({
    changeSetId: z.string().trim().min(1).max(64).optional()
      .describe('the change set to put back: the approvalId of an approved ad request (its writes carry it), or an import\'s change set'),
    actionLogId: z.string().trim().min(1).max(64).optional()
      .describe('one recorded change to put back (undoActionLogId in ad-changes); a change in a set reverses with its whole set'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the approver and kept in the ads audit'),
  }),
  requires: [F.adsBidsEdit, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  // The undo of an undo is asking for the change again; nothing here re-applies it.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Put back an Amazon ad change: every write of an approved ad request (changeSetId = its approvalId) or one '
    + 'recorded change (actionLogId from ad-changes). Bids, budgets and placements return to the values before them '
    + 'through the rollback service (within 24 hours for a change set); negative keywords the request created are '
    + 'retired. Nothing changes until a person approves it in Nexus. The preview lists every write it reverses and '
    + 'where it lands (live or sandbox); refused, and not queued, when Amazon\'s write gate would refuse it. It is not '
    + 'itself undone: to redo, ask for the change again.',
  async handler(args) {
    return undoPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await undoPreview(args)
    const refusal = recheck(ctx, fresh, ['source', 'rows', 'negatives'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { source: { mode: 'set' | 'action'; changeSetId?: string; actionLogId?: string }; rows: UndoRow[]; negatives: UndoNegative[]; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const rollback = p.rows.length
      ? p.source.mode === 'set'
        ? await rollbackByChangeSetId({ changeSetId: p.source.changeSetId!, actor: run.actor, reason: run.reason, manual: run.manual })
        : await rollbackByActionLogId({ actionLogId: p.source.actionLogId!, actor: run.actor, reason: run.reason, manual: run.manual })
      : null
    let retired: { retired: number; refused: number; failed: number } | null = null
    if (p.negatives.length) {
      const { retireNegatives } = await import('../../advertising/negatives-retire.service.js')
      const out = await retireNegatives({ adTargetIds: p.negatives.map((n) => n.targetId), actor: run.actor, retireReason: run.reason })
      retired = { retired: out.summary.retired + out.summary.removedLocal, refused: out.summary.refused, failed: out.summary.failed }
    }
    // The request this put back is undone now (also when it was asked for directly, not through undo-change).
    if (p.source.mode === 'set' && p.source.changeSetId) {
      await prisma.agentChange.updateMany({
        where: { approvalId: p.source.changeSetId, undoneAt: null },
        data: { undoneAt: new Date(), undoneByApprovalId: run.changeSetId },
      })
    }
    const failed = (rollback?.failed ?? 0) + (retired?.failed ?? 0) + (retired?.refused ?? 0)
    const data = {
      reversed: rollback?.reversed ?? 0,
      skipped: rollback?.skipped ?? 0,
      failed: rollback?.failed ?? 0,
      ...(rollback?.reason ? { note: rollback.reason } : {}),
      details: (rollback?.details ?? []).slice(0, ROWS_SHOWN),
      ...(retired ? { negatives: retired } : {}),
    }
    if (failed) return { ok: false, data, error: `Partly undone: ${data.reversed} write${data.reversed === 1 ? '' : 's'} put back, ${failed} not. The rest stays as it was; approve again to retry.` }
    return { ok: true, data }
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

async function budgetPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const proposed = Math.round(Number(args.dailyBudgetCents))
  if (!campaignId || !Number.isFinite(proposed) || proposed <= 0) return { ok: false, error: 'campaignId and a dailyBudgetCents above 0 are required' }
  const campaign = await campaignForChange(campaignId)
  const refused = campaignRefusal(campaign, campaignId, 'budget')
  if (refused) return { ok: false, error: refused }
  const c = campaign!
  const currency = campaignCurrency(c)
  const current = Math.round(Number(c.dailyBudget) * 100)
  if (proposed === current) return { ok: false, error: `The daily budget of ${c.name} is already ${amountLabel(current, currency)}.` }
  // 3A + 4A — the campaign's own min/max budget is HIS limit: not a refusal here. The gate (asked as the approver)
  // reports it in `reach.pastOwnLimits`, the card warns before he approves, and approving sends it anyway.
  const reach = await checkLiveReach({ campaignId: c.id, marketplace: c.marketplace, changes: [{ field: 'dailyBudget', valueCents: proposed }] })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(c.id)
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
      effect: `Sets the daily budget of ${c.name} from ${amountLabel(current, currency)} to ${amountLabel(proposed, currency)}.`,
    },
  }
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
}

const setCampaignBudget: AgentTool = {
  name: 'set-campaign-budget',
  title: 'Change a campaign budget',
  input: z.object({
    campaignId: campaignIdArg,
    dailyBudgetCents: z.coerce.number().int().positive().describe('new daily budget in minor units (cents) of the campaign\'s own currency'),
    why: whyArg,
  }),
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_CAMPAIGN_BUDGET_UNDO,
  description:
    'Set the daily budget of an Amazon Sponsored Products campaign, in the campaign\'s own currency (never converted). '
    + 'Nothing changes until a person approves it in Nexus; a raise always waits for a person. The preview shows the '
    + 'budget now and after, where it lands (live at Amazon or sandbox), and the rules that may change it again. Refused, '
    + 'and not queued, outside the campaign\'s own budget bounds, on a budget pin, or when Amazon\'s write gate would '
    + 'refuse it (live-write allowlist, the value cap, spend ceilings, the daily budget-movement bound). Undo puts the '
    + 'old budget back.',
  async handler(args) {
    return budgetPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await budgetPreview(args)
    const refusal = recheck(ctx, fresh, ['currentBudgetCents', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; currentBudgetCents: number; proposedBudgetCents: number; currency: string; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const out = await updateCampaignWithSync({
      campaignId: p.campaign.id,
      patch: { dailyBudget: p.proposedBudgetCents / 100 },
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
      manual: run.manual, // 4A — a person approved it: his own click
      confirmOwnLimits: run.confirmOwnLimits, // 4A — his approval is his "Send anyway" (the card warned him)
    })
    if (!out.ok) return notRun(`Not run: the budget write was refused (${out.error ?? 'unknown'}). Nothing changed.`)
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
        before: { campaignId: p.campaign.id, dailyBudgetCents: p.currentBudgetCents, changeSetId: run.changeSetId },
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

const pctLine = (v: Record<PlacementKey, number | null>) => PLACEMENTS.map((p) => `${p.label} ${v[p.key] ?? 0}%`).join(', ')

async function placementPreview(args: Record<string, unknown>): Promise<ToolResult> {
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
  const reach = await checkLiveReach({ campaignId: c.id, marketplace: c.marketplace, changes: [{ field: 'placementBidding', valueCents: null }] })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(c.id)
  const raises = PLACEMENTS.filter((p) => (proposed[p.key] ?? 0) > (current[p.key] ?? 0)).map((p) => p.label)
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
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_PLACEMENTS_UNDO,
  description:
    'Set the placement bid adjustments of an Amazon Sponsored Products campaign: top of search, product pages, rest '
    + 'of search, each 0–900 %. Nothing changes until a person approves it in Nexus; it always waits for a person (a '
    + 'raise raises every bid there). The preview shows the adjustments now and after and where it lands (live at '
    + 'Amazon or sandbox). Refused, and not queued, on a placement pin or when Amazon\'s write gate would refuse it. '
    + 'Approved, it is sent at once. Undo puts the old adjustments back.',
  async handler(args) {
    return placementPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await placementPreview(args)
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
  bids?: Array<{ targetId: string; bidCents: number }>
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

type BulkWrite = { targetId: string; fromCents: number; toCents: number }

/** A bulk request decided: its preview (20 lines shown), and every write it makes (all of them). */
async function bulkDecision(args: Record<string, unknown>): Promise<{ result: ToolResult; writes: BulkWrite[] }> {
  const a = args as BulkArgs
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
  const { entries } = await clampBidsByCeiling(kept.map((k) => ({ adTargetId: k.t.id, bidCents: k.wanted })))
  const changing: Array<{ t: BulkTarget; to: number }> = []
  kept.forEach((k, i) => {
    const to = changeClampedBid(k.t.bidCents, entries[i].bidCents, k.t.campaign.dynamicBidding)
    const verdict = suppressionOf({ id: k.t.id, bidCents: k.t.bidCents, suppressedFromBidCents: k.t.suppressedFromBidCents }, to)
    if (verdict === 'suppressed') return void excluded.push({ targetId: k.t.id, why: 'suppressed' })
    if (verdict === 'low-unflagged') return void excluded.push({ targetId: k.t.id, why: 'lowUnflagged' })
    if (to === k.t.bidCents) return void excluded.push({ targetId: k.t.id, why: 'unchanged' })
    // 3A + 4A — the campaign's own min/max bid is HIS limit: the gate reports it (pastOwnLimits) and the card warns.
    changing.push({ t: k.t, to })
  })
  // Live reach per campaign: bounds are an interval, so the lowest and the highest new bid answer for all between.
  const byCampaign = new Map<string, Array<{ t: BulkTarget; to: number }>>()
  for (const c of changing) byCampaign.set(c.t.campaign.id, [...(byCampaign.get(c.t.campaign.id) ?? []), c])
  const profiles = new Set<string>()
  const refusedCampaigns = new Map<string, string>()
  const pastOwnLimits: Array<{ limit: string; reason: string }> = [] // 3A + 4A — for the card's warning
  for (const [campaignId, list] of [...byCampaign].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const values = [...new Set([Math.min(...list.map((l) => l.to)), Math.max(...list.map((l) => l.to))])]
    for (const value of values) {
      const reach = await checkLiveReach({ campaignId, marketplace: list[0].t.campaign.marketplace, changes: [{ field: 'bid', valueCents: value }] })
      if (reach.reach === 'refused') { refusedCampaigns.set(campaignId, reach.reason); break }
      if (reach.reach === 'live') {
        profiles.add(reach.profileId)
        for (const l of reach.pastOwnLimits ?? []) if (!pastOwnLimits.some((x) => x.reason === l.reason)) pastOwnLimits.push(l)
      }
    }
  }
  const going = changing.filter((c) => !refusedCampaigns.has(c.t.campaign.id))
  for (const c of changing.filter((x) => refusedCampaigns.has(x.t.campaign.id))) {
    excluded.push({ targetId: c.t.id, why: 'refusedByGate', detail: refusedCampaigns.get(c.t.campaign.id) })
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
  const writes = going.map((g) => ({ targetId: g.t.id, fromCents: g.t.bidCents, toCents: g.to }))
  return { writes, result: {
    ok: true,
    preview: {
      action: 'bulk-ad-bid-change',
      mode: a.bids?.length ? 'list' : 'selection',
      ...(a.percent != null ? { percent: a.percent } : {}),
      totals: { asked: read.asked.length, changing: going.length, excluded: counts },
      changes: going.slice(0, LINES_SHOWN).map((g) => ({ targetId: g.t.id, text: g.t.text, campaignName: g.t.campaign.name, currency: campaignCurrency(g.t.campaign), fromCents: g.t.bidCents, toCents: g.to })),
      ...(going.length > LINES_SHOWN ? { moreChanges: going.length - LINES_SHOWN } : {}),
      excludedLines: excluded.slice(0, LINES_SHOWN).map((e) => ({ targetId: e.targetId, why: e.detail ? `${EXCLUSION_WORDS[e.why]}: ${e.detail}` : EXCLUSION_WORDS[e.why] })),
      byCurrency,
      // Every target's id, starting bid and new bid: a move on any of the 500 is caught, not only on the 20 shown.
      basis: createHash('sha256').update(going.map((g) => `${g.t.id}:${g.t.bidCents}:${g.to}`).join('|')).digest('base64url').slice(0, 32),
      reach,
      reachNote: reachNote(reach),
      alsoChangedBy: bound,
      effect: `Moves ${going.length} bid${going.length === 1 ? '' : 's'} (${Object.entries(byCurrency).map(([cur, v]) => `${v.deltaCents >= 0 ? '+' : '−'}${amountLabel(Math.abs(v.deltaCents), cur)} in total per click on ${v.targets}`).join('; ')})${excluded.length ? `; ${excluded.length} left as they are` : ''}.`,
    },
  } }
}

const countBy = (list: Array<{ why: Exclusion }>) => {
  const out: Partial<Record<Exclusion, number>> = {}
  for (const e of list) out[e.why] = (out[e.why] ?? 0) + 1
  return out
}

/** C2 — undo of a bulk bid change: undo-ad-change reverses its change set as one (never a part of it). */
export const BULK_BID_UNDO: ToolUndo = {
  async current(change) {
    const ids = Object.keys(((change.after as { bids?: Record<string, number> } | null)?.bids) ?? {})
    const rows = ids.length ? await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, bidCents: true } }) : []
    return { bids: Object.fromEntries(rows.sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.bidCents])) }
  },
  request(change) {
    const changeSetId = (change.before as { changeSetId?: unknown } | null)?.changeSetId
    if (typeof changeSetId !== 'string' || !changeSetId) return { refusal: 'This change does not name the request that made it.' }
    return { tool: 'undo-ad-change', args: { changeSetId, why: 'undo of a bulk bid change' } }
  },
}

const bulkAdBidChange: AgentTool = {
  name: 'bulk-ad-bid-change',
  title: 'Change many ad bids',
  input: z.object({
    bids: z.array(z.object({
      targetId: z.string().trim().min(1).max(64).describe('Nexus ad target id (targetId in ad-targets)'),
      bidCents: z.coerce.number().int().min(1).max(100_000).describe('its new bid, in minor units of its campaign\'s currency'),
    })).max(BULK_LIST_MAX).optional().describe(`targets with their new bids, at most ${BULK_LIST_MAX}; or leave it out and give a selection and percent (up to ${BULK_MAX})`),
    campaignId: z.string().trim().min(1).max(64).optional().describe('only targets of this campaign (Nexus id): the selection, or a filter on the list'),
    adGroupId: z.string().trim().min(1).max(64).optional().describe('only targets of this ad group (Nexus id)'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only targets in this marketplace, e.g. IT'),
    search: z.string().trim().min(1).max(100).optional().describe('with a selection: only targets whose text, campaign or ad group name contains this'),
    percent: z.coerce.number().min(-90).max(100).optional().describe('with a selection: move every selected enabled target\'s bid by this percent (−90 to +100)'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: BULK_BID_UNDO,
  description:
    `Change many Amazon Sponsored Products bids in one request: a list of targets with their new bids (up to ${BULK_LIST_MAX}), `
    + `or a selection (campaign, ad group or market, optionally a text; up to ${BULK_MAX} targets) moved by a percent. `
    + 'Nothing changes until a person '
    + 'approves it in Nexus; it always waits for a person. The preview counts what changes and what is left as it is, '
    + 'by reason (suppressed bids are never raised, pinned or non-SP campaigns, bid bounds, a campaign Amazon\'s write '
    + 'gate refuses, unchanged), shows the first 20 changes and the total per currency, and where it lands. Approved, '
    + 'every write carries the approval as its change set; undo-change reverses the whole set at once.',
  async handler(args) {
    return (await bulkDecision(args)).result
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
      entries: going.map((g) => ({ adTargetId: g.targetId, bidCents: g.toCents })),
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
      manual: run.manual, // 4A
      confirmOwnLimits: run.confirmOwnLimits, // 4A
    })
    const ids = going.map((g) => g.targetId)
    const now = await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, bidCents: true } })
    const sorted = (rows: Array<{ id: string; bidCents: number }>) => Object.fromEntries([...rows].sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.bidCents]))
    return {
      ok: out.failed === 0,
      ...(out.failed ? { error: `Partly run: ${out.applied} queued, ${out.failed} refused by the bid write. Undo-change reverses what was queued.` } : {}),
      data: { applied: out.applied, skipped: out.skipped, failed: out.failed, reach: p.reach, changeSetId: run.changeSetId, note: 'Queued for Amazon: each bid is sent after the 5-minute cancel window. approval-status follows them.' },
      change: {
        before: { changeSetId: run.changeSetId, bids: sorted(going.map((g) => ({ id: g.targetId, bidCents: g.fromCents }))) },
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

async function suppressPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
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
  const reach = await checkLiveReach({ campaignId, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents: floor }], isSuppression: true })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(campaignId)
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
      effect: `Lowers every bid of ${campaign.name} to ${floorWords} — ${targets} target${targets === 1 ? '' : 's'} and ${groups.aboveFloor} ad group default${groups.aboveFloor === 1 ? '' : 's'} — so it stops winning auctions without being paused. Each bid is remembered; restore-campaign puts them back.`,
    },
  }
}

const suppressCampaign: AgentTool = {
  name: 'suppress-campaign',
  title: 'Stop a campaign (no pause)',
  input: z.object({ campaignId: campaignIdArg, why: whyArg }),
  requires: [F.adsBidsEdit],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: {
    current: (change) => suppressionState(String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')),
    request: (change) => {
      const campaignId = (change.after as { campaignId?: unknown } | null)?.campaignId
      return typeof campaignId === 'string' && campaignId ? { tool: 'restore-campaign', args: { campaignId, why: 'undo of a suppression' } } : { refusal: 'This change does not name its campaign.' }
    },
  },
  description:
    'Stop an Amazon Sponsored Products campaign the Nexus way: never paused — every keyword and target bid and every ad '
    + "group default bid goes to the stop bid the ads strategy sets for it (the 2-cent floor when it sets none; bids already "
    + 'lower stay), and each bid is remembered. Nothing changes until a person approves '
    + 'it: in Nexus, or the person who asked confirms it in Claude with their authenticator code when the business set '
    + 'it so. The preview counts what moves and where it lands (live at Amazon or sandbox). Refused, and not '
    + 'queued, when it is already suppressed or Amazon\'s write gate would refuse it (the live-write allowlist; a halt '
    + 'does not block lowering). restore-campaign (or undo-change) puts the bids back.',
  async handler(args) {
    return suppressPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await suppressPreview(args)
    // W1-6 — the stop bid is material: a strategy change since the approval stops the run.
    const refusal = recheck(ctx, fresh, ['moves', 'reach', 'stopBidCents'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; reach: StoredReach; effect: string; stopBidCents: number }
    const run = approvedRun(ctx, String(args.why ?? '') || 'no-pause stop: bids floored instead of pausing')
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const moved = await suppressCampaignBids(p.campaign.id, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, floorCents: p.stopBidCents })
    const now = await suppressionState(p.campaign.id)
    if (!now.suppressed) return notRun('Not run: the campaign was not suppressed (it changed meanwhile). Nothing changed.')
    return {
      ok: true,
      data: { campaignId: p.campaign.id, moved, reach: p.reach, changeSetId: run.changeSetId, note: 'Bids floored and remembered; each lowered bid is sent to Amazon at once.' },
      change: { before: { campaignId: p.campaign.id, suppressed: false, by: null, changeSetId: run.changeSetId }, after: now },
    }
  },
}

async function restorePreview(args: Record<string, unknown>): Promise<ToolResult> {
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
      select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true },
      orderBy: { id: 'asc' },
    }),
    adGroupSuppressionCounts(campaignId, SUPPRESSION_FLOOR_CENTS),
  ])
  const highest = Math.max(0, ...remembered.map((t) => t.suppressedFromBidCents as number))
  const reach = await checkLiveReach({ campaignId, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents: highest || null }], isSuppression: true })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const currency = campaignCurrency(campaign)
  const bound = await alsoChangedBy(campaignId)
  return {
    ok: true,
    preview: {
      action: 'restore-campaign',
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      suppressedBy: campaign.bidsSuppressedBy,
      currency,
      restores: { targets: remembered.length, adGroups: groups.remembered },
      bids: remembered.slice(0, LINES_SHOWN).map((t) => ({ targetId: t.id, text: t.expressionValue, fromCents: t.bidCents, toCents: t.suppressedFromBidCents })),
      // Every remembered bid: a change to any of them (another suppression, a manual edit) stops the run.
      basis: createHash('sha256').update(remembered.map((t) => `${t.id}:${t.bidCents}:${t.suppressedFromBidCents}`).join('|')).digest('base64url').slice(0, 32),
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...(groups.ownFloors ? { staysFloored: { adGroups: groups.ownFloors } } : {}),
      effect: `Puts back the bids ${campaign.name} had before it was suppressed: ${remembered.length} target${remembered.length === 1 ? '' : 's'} and ${groups.remembered} ad group default${groups.remembered === 1 ? '' : 's'}${highest ? `, the highest ${amountLabel(highest, currency)}` : ''}. The campaign serves again.${groups.ownFloors ? ` ${groups.ownFloors} ad group${groups.ownFloors === 1 ? ' stays' : 's stay'} at ${groups.ownFloors === 1 ? 'its' : 'their'} own floor (a product over its monthly cap in the ads strategy) until the 1st or until that cap is raised.` : ''}`,
    },
  }
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
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
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
    + 'guard, budget enforcement own theirs). Nothing changes until a person approves it in Nexus; it always waits for '
    + 'a person (spend resumes). The preview lists the bids it restores in the campaign\'s currency and where it lands.',
  async handler(args) {
    return restorePreview(args)
  },
  async execute(args, ctx) {
    const fresh = await restorePreview(args)
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

async function liveWritesPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const enabled = args.enabled === true || args.enabled === 'true'
  const campaign = await campaignForChange(campaignId)
  if (!campaign) return { ok: false, error: `campaign ${campaignId} not found` }
  if (campaign.liveBidWritesEnabled === enabled) {
    return { ok: false, error: `${campaign.name} is already ${enabled ? 'on' : 'off'} the live-write allowlist.` }
  }
  const [profile, bound] = await Promise.all([adsProfileFor(campaign.marketplace).catch(() => null), alsoChangedBy(campaign.id)])
  const connectionLive = !!profile && profile.mode === 'production' && profile.writesEnabledAt != null
  return {
    ok: true,
    preview: {
      action: 'set-campaign-live-writes',
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      liveWrites: { from: campaign.liveBidWritesEnabled, to: enabled },
      connection: profile ? { profileId: profile.profileId, mode: profile.mode, writesEnabled: profile.writesEnabledAt != null } : null,
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      effect: enabled
        ? `Puts ${campaign.name} on the live-write allowlist: approved changes${bound.automations.length ? ' and its rules and schedules' : ''} may then write its bids, budget and placements at Amazon${connectionLive ? '' : ' — once Amazon ads writes are live and its market\'s connection allows writes (today they would not reach Amazon)'}.`
        : `Takes ${campaign.name} off the live-write allowlist: no write reaches Amazon for it any more (bids already sent stay where they are; nothing is paused).`,
    },
  }
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
  requiresApprovalDefault: true,
  // A Nexus switch: nothing is sent to Amazon by it (it decides what later writes may reach).
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
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
    + 'to Amazon itself. Nothing changes until a person approves it in Nexus; it always waits for a person. The preview '
    + 'says whether its market\'s connection would let writes through today and which rules may then write to it.',
  async handler(args) {
    return liveWritesPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await liveWritesPreview(args)
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
