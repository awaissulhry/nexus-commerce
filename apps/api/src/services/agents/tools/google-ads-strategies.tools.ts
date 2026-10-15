/**
 * Google Ads changes, G5 (2026-10-15, Owner's brief "full control of Google Ads through Nexus") — portfolio bid
 * strategies. Every tool here is a Nexus change: a preview Google has checked (validate_only), an approvalId, a person
 * approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-bid-strategy      make a portfolio strategy (Target CPA, Target ROAS, Maximize clicks with a max CPC,
 *                                Target impression share, Maximize conversions / conversion value with targets) and
 *                                change a strategy's name, targets and bid limits; undo puts the old values back
 *   remove-google-bid-strategy   remove a strategy for good — only when the person asked, and never while campaigns use it
 *
 * Putting a campaign on a portfolio strategy is set-google-campaign (bidding PORTFOLIO).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange, type GoogleDraftBuilder } from './google-ads-kit.js'
import {
  NEW_STRATEGY, strategyChangeDraft, strategyRecordAfterRun, strategyRemoveDraft, type StrategyFields, type StrategyRecord, type StrategyRequest,
} from '../../marketing/google-ads/change-strategies.js'
import { liveStrategies, liveStrategyCampaigns, STRATEGY_SCHEMES } from '../../marketing/google-ads/live-strategies.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of the strategy tools' previews and answers (their tables and sentences quote targets and bid limits). */
const STRATEGY_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, targetCpaCents: ADSPEND, maxCpcCents: ADSPEND, minCpcCents: ADSPEND, targetRoas: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** A setting: a value sets it; null takes it off (a change only). */
const clearable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional()
const settings = {
  targetCpaCents: clearable(googleCentsArg('the target cost per conversion (TARGET_CPA, MAXIMIZE_CONVERSIONS); null takes it off')),
  targetRoas: clearable(z.coerce.number().min(0.01).max(1000).describe('the target ROAS as a ratio, 3 = 300 % (TARGET_ROAS, MAXIMIZE_CONVERSION_VALUE); null takes it off')),
  maxCpcCents: clearable(googleCentsArg('the max CPC Google may bid (every scheme); null takes it off')),
  minCpcCents: clearable(googleCentsArg('the min CPC Google bids (TARGET_CPA, TARGET_ROAS, the two MAXIMIZE_CONVERSION ones); null takes it off')),
  location: z.enum(['ANYWHERE_ON_PAGE', 'TOP_OF_PAGE', 'ABSOLUTE_TOP_OF_PAGE']).optional().describe('TARGET_IMPRESSION_SHARE: where on the results page'),
  impressionSharePercent: z.coerce.number().gt(0).max(100).optional().describe('TARGET_IMPRESSION_SHARE: the share of searches to show there, in percent (e.g. 70)'),
}

// ── set-google-bid-strategy ─────────────────────────────────────────────────────────────────────────────────────

const strategyRequest = (args: Record<string, unknown>): StrategyRequest => ({
  create: args.create as StrategyRequest['create'],
  change: args.change as StrategyRequest['change'],
})

const buildStrategy = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = strategyRequest(args)
  const customer = customerResource(account.target)
  const strategies = await liveStrategies(account.target)
  const ids = (request.change ?? []).map((c) => c.strategyId).filter((id) => strategies.some((s) => s.strategyId === id))
  const campaigns = await liveStrategyCampaigns(account.target, customer, ids)
  return strategyChangeDraft(customer, account.currency, request, { strategies, campaigns })
}

const strategyUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as StrategyRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveStrategies(account.target)
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      strategies: (after.strategies ?? []).map((written) => {
        const now = live.find((s) => s.strategyId === written.strategyId)
        const out: Record<string, unknown> = { strategyId: written.strategyId }
        for (const key of Object.keys(written)) if (key !== 'strategyId') out[key] = now ? (now as unknown as Record<string, unknown>)[key] ?? null : 'removed'
        return out
      }),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<StrategyRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<StrategyRecord> & { accountId?: string }
    const strategies = (before.strategies ?? []) as StrategyFields[]
    if (!strategies.length) {
      return { refusal: 'This change only made a portfolio bid strategy: there is nothing to put back (it spends nothing while no campaign uses it; remove-google-bid-strategy removes it).' }
    }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-bid-strategy',
      args: { ...(accountId ? { accountId } : {}), change: strategies, why: `undo of an earlier bid strategy change${after.created && after.created.strategyId !== NEW_STRATEGY ? ' (the strategy it made stays)' : ''}` },
    }
  },
}

const setGoogleBidStrategy: AgentTool = {
  ...common,
  name: 'set-google-bid-strategy',
  title: 'Make or change a Google bid strategy',
  reversibility: 'full',
  requires: [F.adsBidsEdit, F.adsCampaignsManage, ADSPEND],
  restrictedFields: STRATEGY_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    create: z.object({
      name: z.string().trim().min(1).max(255).describe('the new strategy\'s name (unique in the account)'),
      scheme: z.enum(STRATEGY_SCHEMES as unknown as [string, ...string[]]).describe('TARGET_CPA, TARGET_ROAS, MAXIMIZE_CLICKS (with a max CPC), TARGET_IMPRESSION_SHARE, MAXIMIZE_CONVERSIONS or MAXIMIZE_CONVERSION_VALUE'),
      ...settings,
    }).optional().describe('make a new portfolio bid strategy (no campaign uses it yet: it spends nothing)'),
    change: z.array(z.object({
      strategyId: googleIdArg('the portfolio bid strategy'),
      name: z.string().trim().min(1).max(255).optional().describe('its new name'),
      ...settings,
    })).max(20).optional().describe('new name, targets or bid limits of existing strategies (a strategy\'s scheme cannot change: make a new one)'),
    why: googleWhyArg,
  }),
  description:
    'Portfolio bid strategies of the business\'s chosen Google Ads account: make one (Target CPA, Target ROAS, Maximize '
    + 'clicks with a max CPC, Target impression share with place and share, Maximize conversions or conversion value '
    + 'with optional targets; min / max CPC where Google takes them) and change a strategy\'s name, targets and bid '
    + 'limits (null takes a target or limit off). Amounts are minor units (cents) of the account\'s currency. A higher '
    + 'target CPA, a lower target ROAS, a higher or removed max CPC, a higher min CPC or impression share, a higher place '
    + 'on the page, or a target taken off, on a strategy enabled campaigns use, is marked SPENDS MONEY. A campaign is put '
    + 'on a strategy with set-google-campaign (bidding PORTFOLIO). Undo puts the old values back (a strategy it made '
    + 'stays, unused).' + GOOGLE_CHANGE_RULES,
  undo: strategyUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildStrategy(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildStrategy(args), (draft, responses) => {
    const after = strategyRecordAfterRun(draft.after as StrategyRecord, responses)
    return { data: { createdStrategyId: after.created?.strategyId ?? null, changed: after.strategies.length }, before: draft.before, after }
  }),
}

// ── remove-google-bid-strategy ──────────────────────────────────────────────────────────────────────────────────

const buildRemove = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const ids = (args.strategyIds as string[] | undefined) ?? []
  const customer = customerResource(account.target)
  const strategies = await liveStrategies(account.target)
  const campaigns = await liveStrategyCampaigns(account.target, customer, ids.filter((id) => strategies.some((s) => s.strategyId === id)))
  return strategyRemoveDraft(customer, account.currency, ids, { strategies, campaigns })
}

const removeGoogleBidStrategy: AgentTool = {
  ...common,
  name: 'remove-google-bid-strategy',
  title: 'Remove a Google bid strategy (for good)',
  reversibility: 'none',
  requires: [F.adsBidsEdit, F.adsCampaignsManage, ADSPEND],
  restrictedFields: STRATEGY_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    strategyIds: z.array(googleIdArg('a portfolio bid strategy')).min(1).max(20).describe('the strategies to remove'),
    confirmRemove: z.literal(true).describe('true: the person asked for exactly this removal'),
    why: googleWhyArg,
  }),
  description:
    'REMOVE (delete) portfolio bid strategies of the business\'s chosen Google Ads account. Use it ONLY when the person '
    + 'asked for that removal (confirmRemove true). A strategy campaigns still use is refused, with their names: move them '
    + 'to another bidding first (set-google-campaign). A removal cannot be undone.' + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildRemove(args), (draft) => ({ data: { removed: (draft.after as { removed: unknown[] }).removed }, before: draft.before, after: draft.after })),
}

export const GOOGLE_ADS_STRATEGY_TOOLS: AgentTool[] = [setGoogleBidStrategy, removeGoogleBidStrategy]
