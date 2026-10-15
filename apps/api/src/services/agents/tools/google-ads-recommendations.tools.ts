/**
 * Google Ads changes, G5 (2026-10-15, Owner's brief "full control of Google Ads through Nexus") — Google's
 * recommendations. Every tool here is a Nexus change a person approves in Nexus; it runs as that person, never by rule
 * (google-ads-kit.ts).
 *
 *   apply-google-recommendations     apply recommendations of one type (with the overrides Google allows). Google cannot
 *                                    check an apply first (no validate_only): the preview says so, and the run reads each
 *                                    recommendation again and sends it only if it is still there, unchanged. Undo: Google
 *                                    cannot un-apply; Nexus puts back the daily amount a budget recommendation replaced
 *   dismiss-google-recommendations   dismiss recommendations of one type (no check first either); never undone
 *   set-google-auto-apply            switch Google's auto-apply on or off per recommendation type (Google checks it:
 *                                    validate_only); turning it on for a type that spends is SPENDS MONEY
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleWhyArg, GOOGLE_CHANGE_RULES, GOOGLE_UNCHECKED_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder, type GoogleSender,
} from './google-ads-kit.js'
import {
  applyDraft, autoApplyDraft, AUTO_APPLY_TYPES, BUDGET_UNDO_TYPES, dismissDraft, NOT_CHECKED_APPLY, NOT_CHECKED_DISMISS,
  type ApplyRecord, type ApplyRequest, type AutoApplyRecord,
} from '../../marketing/google-ads/change-recommendations.js'
import { liveAutoApply, liveRecommendations, RECOMMENDATION_ID } from '../../marketing/google-ads/live-recommendations.js'
import { liveBudgets, liveCampaigns } from '../../marketing/google-ads/live.js'
import { RECOMMENDATION_RESULT, sendRecommendations } from '../../marketing/google-ads/recommendation-client.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of apply-google-recommendations' previews and answers: its sentences and tables quote budgets, bids and Google's cost estimates. */
const APPLY_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, budgetCents: ADSPEND, targetCpaCents: ADSPEND, bidCents: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

const recommendationIdArg = z.string().trim().regex(RECOMMENDATION_ID, 'a recommendation id (google-ad-details view recommendations)')
  .describe('the recommendation (its recommendationId from google-ad-details view recommendations)')

// ── apply-google-recommendations ────────────────────────────────────────────────────────────────────────────────

const applySender: GoogleSender = {
  notChecked: NOT_CHECKED_APPLY,
  send: (target, operations) => sendRecommendations(target, 'apply', operations),
}

const buildApply = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request: ApplyRequest = { items: (args.recommendations as ApplyRequest['items'] | undefined) ?? [] }
  const customer = customerResource(account.target)
  const { recommendations, detailsRead } = await liveRecommendations(account.target, customer, request.items.map((i) => i.recommendationId))
  const campaigns = await liveCampaigns(account.target)
  const budgets = recommendations.some((r) => r.budgetId) ? await liveBudgets(account.target, campaigns) : []
  return applyDraft(customer, account.currency, request, { recommendations, detailsRead, campaigns, budgets })
}

/** Exact only for budget recommendations: the daily amount each replaced, set again through set-google-budget. */
const applyUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ApplyRecord & { accountId?: string; customerId?: string }
    const applied = after.applied ?? []
    if (!applied.every((a) => BUDGET_UNDO_TYPES.has(a.type) && a.budgetId)) return change.after
    const account = await recordAccount(after)
    if (!account) return null
    const budgets = await liveBudgets(account.target)
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      applied: applied.map((a) => ({ ...a, budgetCents: budgets.find((b) => b.budgetId === a.budgetId)?.amountCents ?? null })),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<ApplyRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<ApplyRecord> & { accountId?: string }
    const applied = before.applied ?? []
    const other = applied.find((a) => !BUDGET_UNDO_TYPES.has(a.type))
    if (!applied.length) return { refusal: 'This change records no recommendation it applied.' }
    if (other) {
      return { refusal: `Google cannot un-apply a recommendation, and a ${other.type.toLowerCase().replace(/_/g, ' ')} one is not something Nexus can put back exactly: change it back by hand (set-google-campaign, set-google-keywords, set-google-status …).` }
    }
    const amounts = applied.map((a) => ({ budgetId: a.budgetId, budgetCents: a.budgetCents }))
    if (amounts.some((a) => !a.budgetId || typeof a.budgetCents !== 'number' || a.budgetCents <= 0)) return { refusal: 'This change does not record every daily amount it replaced.' }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-budget',
      args: { ...(accountId ? { accountId } : {}), amounts, why: 'undo of an applied Google budget recommendation (the old daily amount)' },
    }
  },
}

const applyGoogleRecommendations: AgentTool = {
  ...common,
  name: 'apply-google-recommendations',
  title: 'Apply Google Ads recommendations',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, F.adsBidsEdit, ADSPEND],
  restrictedFields: APPLY_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    recommendations: z.array(z.object({
      recommendationId: recommendationIdArg,
      budgetCents: googleCentsArg('your daily budget instead of Google\'s (campaign budget, opt-ins, broad match, set target), or the amount to move (move unused budget)').optional(),
      targetCpaCents: googleCentsArg('your target CPA instead of Google\'s (Target CPA opt-in, set target CPA)').optional(),
      targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('your target ROAS instead of Google\'s, as a ratio (3 = 300 %)'),
      multiplier: z.coerce.number().min(0.01).max(100).optional().describe('raise target CPA (above 1) / lower target ROAS (below 1): your factor instead of Google\'s'),
      matchType: matchTypeArg.optional(),
      bidCents: googleCentsArg('a keyword recommendation: your max CPC').optional(),
    })).min(1).max(100).describe('recommendations of ONE type (Google applies one type per request), each with optional overrides'),
    why: googleWhyArg,
  }),
  description:
    'Apply Google\'s recommendations in the business\'s chosen Google Ads account (ids from google-ad-details view '
    + 'recommendations), all of ONE type per request, with the overrides Google allows: your budget, target CPA, target '
    + 'ROAS, multiplier, keyword match type or bid. Google CANNOT check an apply first (no validate_only): the preview '
    + 'says what it changes from the live account, and when it runs Nexus reads each recommendation again and sends it '
    + 'only if it is still there, unchanged. A budget raise, bidding handed to Google, a higher target CPA, a lower '
    + 'target ROAS, new keywords or ads that can serve, and wider networks or match types are marked SPENDS MONEY. '
    + 'Types that make new campaigns (Performance Max upgrades, catch-all Shopping) are refused: Nexus makes new '
    + 'campaigns paused. Undo: Google cannot un-apply; for a budget recommendation undo sets the old daily amount again, '
    + 'any other type is changed back by hand.' + GOOGLE_UNCHECKED_CHANGE_RULES,
  undo: applyUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildApply(args), applySender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildApply(args), (draft, responses) => ({
    data: { applied: responses.map((r) => r[RECOMMENDATION_RESULT]?.resourceName ?? null) },
    before: draft.before,
    after: draft.after,
  }), applySender),
}

// ── dismiss-google-recommendations ─────────────────────────────────────────────────────────────────────────────

const dismissSender: GoogleSender = {
  notChecked: NOT_CHECKED_DISMISS,
  send: (target, operations) => sendRecommendations(target, 'dismiss', operations),
}

const buildDismiss = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const ids = (args.recommendationIds as string[] | undefined) ?? []
  const customer = customerResource(account.target)
  const { recommendations } = await liveRecommendations(account.target, customer, ids)
  const campaigns = await liveCampaigns(account.target)
  return dismissDraft({ recommendationIds: ids }, { recommendations, campaigns })
}

const dismissGoogleRecommendations: AgentTool = {
  ...common,
  name: 'dismiss-google-recommendations',
  title: 'Dismiss Google Ads recommendations',
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    recommendationIds: z.array(recommendationIdArg).min(1).max(100).describe('recommendations of ONE type to dismiss (Google dismisses one type per request)'),
    why: googleWhyArg,
  }),
  description:
    'Dismiss Google\'s recommendations in the business\'s chosen Google Ads account (ids from google-ad-details view '
    + 'recommendations), all of ONE type per request. Nothing in the account changes. Google cannot check a dismiss first '
    + '(no validate_only); when it runs Nexus reads each recommendation again and sends it only if it is still there. A '
    + 'dismiss cannot be undone, but Google still lets a dismissed recommendation be applied.' + GOOGLE_UNCHECKED_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildDismiss(args), dismissSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildDismiss(args), (draft) => ({
    data: { dismissed: (draft.after as { recommendations: unknown[] }).recommendations.length },
    before: draft.before,
    after: draft.after,
  }), dismissSender),
}

// ── set-google-auto-apply ───────────────────────────────────────────────────────────────────────────────────────

const autoApplyRequest = (args: Record<string, unknown>) => ({ types: (args.types as Array<{ type: string; status: 'ENABLED' | 'PAUSED' }> | undefined) ?? [] })

const buildAutoApply = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  autoApplyDraft(customerResource(account.target), autoApplyRequest(args), { subscriptions: await liveAutoApply(account.target) })

const autoApplyUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AutoApplyRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const now = await liveAutoApply(account.target)
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      types: (after.types ?? []).map((t) => ({ type: t.type, status: (now.find((s) => s.type === t.type)?.status ?? null) as AutoApplyRecord['types'][number]['status'] })),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<AutoApplyRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<AutoApplyRecord> & { accountId?: string }
    const types = before.types ?? []
    if (!types.length) return { refusal: 'This change records no auto-apply setting it changed.' }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-auto-apply',
      // A setting that was never made goes to PAUSED: Google never deletes one, and paused applies nothing.
      args: { ...(accountId ? { accountId } : {}), types: types.map((t) => ({ type: t.type, status: t.status === 'ENABLED' ? 'ENABLED' : 'PAUSED' })), why: 'undo of an earlier auto-apply change' },
    }
  },
}

const setGoogleAutoApply: AgentTool = {
  ...common,
  name: 'set-google-auto-apply',
  title: 'Switch Google Ads auto-apply on or off',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, F.adsBidsEdit],
  input: z.object({
    accountId: googleAccountArg,
    types: z.array(z.object({
      type: z.enum(AUTO_APPLY_TYPES).describe('the recommendation type'),
      status: z.enum(['ENABLED', 'PAUSED']).describe('ENABLED: Google applies this type by itself; PAUSED: it does not'),
    })).min(1).max(AUTO_APPLY_TYPES.length).describe('auto-apply per recommendation type'),
    why: googleWhyArg,
  }),
  description:
    'Switch Google\'s auto-apply on or off per recommendation type in the business\'s chosen Google Ads account (the '
    + 'types Google auto-applies). Turning it ON means: from now on Google applies these recommendations by itself, with '
    + 'no approval in Nexus (the preview says so plainly); '
    + 'for a type that can raise bids or budgets, hand bidding to Google, add keywords or ads, or widen networks and '
    + 'match types it is marked SPENDS MONEY. Turning it off (PAUSED) is a safe step. Google never deletes a setting; '
    + 'undo puts the old on/off back (one never set goes to off).' + GOOGLE_CHANGE_RULES,
  undo: autoApplyUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAutoApply(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAutoApply(args), (draft) => ({ data: { types: (draft.after as AutoApplyRecord).types }, before: draft.before, after: draft.after })),
}

export const GOOGLE_ADS_RECOMMENDATIONS_TOOLS: AgentTool[] = [applyGoogleRecommendations, dismissGoogleRecommendations, setGoogleAutoApply]
