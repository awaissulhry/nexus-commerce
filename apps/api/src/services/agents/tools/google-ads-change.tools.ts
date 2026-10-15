/**
 * Google Ads changes (2026-10-15, Owner's brief "full write control of Google Ads through Nexus") — PR 1: budgets and
 * shared negative keyword lists. Every tool here is a Nexus change: a preview Google has checked (validate_only), an
 * approvalId, a person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-budget          make a shared budget, change daily amounts, put campaigns on a budget (or their own)
 *   set-google-negative-list   make a negative keyword list, add / remove its keywords, attach / detach campaigns
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { budgetChangeDraft, budgetRecordAfterRun, type BudgetChangeRecord, type BudgetChangeRequest } from '../../marketing/google-ads/change-budgets.js'
import { createdListId, listChangeDraft, type ListChangeRecord, type ListChangeRequest } from '../../marketing/google-ads/change-lists.js'
import { keywordKey, liveBudgets, liveCampaigns, liveNegativeLists } from '../../marketing/google-ads/live.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers (the shared registry names none of them). */
/** Money keys of set-google-budget's previews and answers: its sentences quote amounts, so they are money too. */
const GOOGLE_BUDGET_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, ownBudgetCents: ADSPEND } as const

// ── set-google-budget ───────────────────────────────────────────────────────────────────────────────────────────

const budgetRequest = (args: Record<string, unknown>): BudgetChangeRequest => ({
  create: args.create as BudgetChangeRequest['create'],
  amounts: args.amounts as BudgetChangeRequest['amounts'],
  campaigns: args.campaigns as BudgetChangeRequest['campaigns'],
})

const buildBudget = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const campaigns = await liveCampaigns(account.target)
  const budgets = await liveBudgets(account.target, campaigns)
  return budgetChangeDraft(customerResource(account.target), account.currency, budgetRequest(args), { budgets, campaigns })
}

const budgetUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BudgetChangeRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const campaigns = await liveCampaigns(account.target)
    const budgets = await liveBudgets(account.target, campaigns)
    return {
      amounts: (after.amounts ?? []).map((a) => ({ budgetId: a.budgetId, budgetCents: budgets.find((b) => b.budgetId === a.budgetId)?.amountCents ?? null })),
      campaigns: (after.campaigns ?? []).map((c) => ({ campaignId: c.campaignId, budgetId: campaigns.find((x) => x.campaignId === c.campaignId)?.budget?.budgetId ?? null })),
      ...('createdBudgetId' in after ? { createdBudgetId: after.createdBudgetId } : {}),
      accountId: account.accountId,
      customerId: account.customerId,
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as BudgetChangeRecord & { accountId?: string }
    const amounts = (before.amounts ?? []).filter((a) => typeof a.budgetCents === 'number' && a.budgetCents > 0)
    if (amounts.length !== (before.amounts ?? []).length) return { refusal: 'This change does not record every amount it replaced.' }
    const campaigns = before.campaigns ?? []
    if (campaigns.some((c) => !c.budgetId)) return { refusal: 'A campaign of this change had no budget before it: there is nothing to put back.' }
    if (!amounts.length && !campaigns.length) return { refusal: 'This change replaced nothing that can be put back (it only made a budget: remove it in Google Ads, or leave it unused — an unused budget spends nothing).' }
    const created = (change.after as BudgetChangeRecord | null)?.createdBudgetId
    return {
      tool: 'set-google-budget',
      args: {
        ...(before.accountId ? { accountId: before.accountId } : {}),
        ...(amounts.length ? { amounts } : {}),
        ...(campaigns.length ? { campaigns: campaigns.map((c) => ({ campaignId: c.campaignId, budgetId: c.budgetId! })) } : {}),
        why: `undo of an earlier budget change${created ? ' (the budget it made stays, unused: it spends nothing)' : ''}`,
      },
    }
  },
}

const setGoogleBudget: AgentTool = {
  name: 'set-google-budget',
  title: 'Change Google Ads budgets',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsBudgetsEdit, ADSPEND],
  restrictedFields: GOOGLE_BUDGET_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    create: z.object({
      name: z.string().trim().min(1).max(255).describe('the new shared budget\'s name (unique in the account)'),
      budgetCents: googleCentsArg('its daily amount'),
    }).optional().describe('make a new SHARED budget (several campaigns can use it); it spends nothing until an enabled campaign uses it'),
    amounts: z.array(z.object({
      budgetId: googleIdArg('the budget'),
      budgetCents: googleCentsArg('its new daily amount'),
    })).max(20).optional().describe('new daily amounts of existing budgets (shared or a campaign\'s own); a raise is marked SPENDS MONEY'),
    campaigns: z.array(z.object({
      campaignId: googleIdArg('the campaign'),
      budgetId: z.string().trim().regex(/^(\d{1,20}|new)$/).optional().describe('the budget it uses from now: a budget id, or "new" for the budget of create'),
      ownBudgetCents: googleCentsArg('a new budget of its own (takes it off a shared budget)').optional(),
    })).max(50).optional().describe('which budget each campaign uses: budgetId (an existing budget, or "new") or ownBudgetCents (its own new budget), one of them'),
    why: googleWhyArg,
  }),
  description:
    'Google Ads budgets of the business\'s chosen Google Ads account: make a shared budget (create), change the daily '
    + 'amount of budgets (amounts), and choose the budget each campaign uses (campaigns: attach to a shared budget or the '
    + 'new one, or detach to a budget of its own). All in one request. Amounts are minor units (cents) of the account\'s '
    + 'currency. A raise, and a campaign moved to a bigger budget, are marked SPENDS MONEY. Undo puts the old amounts and '
    + 'budgets back (a budget it made stays, unused).' + GOOGLE_CHANGE_RULES,
  undo: budgetUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildBudget(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildBudget(args), (draft, responses) => {
    const after = budgetRecordAfterRun(draft.after as BudgetChangeRecord, responses)
    return { data: { createdBudgetId: after.createdBudgetId ?? null, campaigns: after.campaigns }, before: draft.before, after }
  }),
}

// ── set-google-negative-list ───────────────────────────────────────────────────────────────────────────────────

const listRequest = (args: Record<string, unknown>): ListChangeRequest => ({
  listId: args.listId as string | undefined,
  create: args.create as ListChangeRequest['create'],
  addKeywords: args.addKeywords as ListChangeRequest['addKeywords'],
  removeKeywords: args.removeKeywords as ListChangeRequest['removeKeywords'],
  attachCampaignIds: args.attachCampaignIds as string[] | undefined,
  detachCampaignIds: args.detachCampaignIds as string[] | undefined,
})

const buildList = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = listRequest(args)
  const lists = await liveNegativeLists(account.target, request.listId)
  const campaigns = await liveCampaigns(account.target)
  return listChangeDraft(customerResource(account.target), request, { lists, campaigns })
}

const listUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ListChangeRecord & { accountId?: string; customerId?: string }
    if (!after.listId || !/^\d+$/.test(after.listId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const list = (await liveNegativeLists(account.target, after.listId)).find((l) => l.listId === after.listId)
    if (!list) return null
    const has = new Set((list.keywords ?? []).map((k) => keywordKey(k.text, k.matchType)))
    const on = new Set(list.campaigns.map((c) => c.campaignId))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      added: after.added.filter((k) => has.has(keywordKey(k.text, k.matchType))),
      removed: after.removed.filter((k) => !has.has(keywordKey(k.text, k.matchType))),
      attached: after.attached.filter((id) => on.has(id)),
      detached: after.detached.filter((id) => !on.has(id)),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as ListChangeRecord & { accountId?: string }
    if (!after.listId || !/^\d+$/.test(after.listId)) return { refusal: 'This change does not record the list it changed.' }
    if (!after.added.length && !after.removed.length && !after.attached.length && !after.detached.length) {
      return { refusal: 'This change only made the list: there is nothing to put back (an empty list that no campaign uses does nothing).' }
    }
    return {
      tool: 'set-google-negative-list',
      args: {
        ...(after.accountId ? { accountId: after.accountId } : {}),
        listId: after.listId,
        ...(after.removed.length ? { addKeywords: after.removed } : {}),
        ...(after.added.length ? { removeKeywords: after.added } : {}),
        ...(after.detached.length ? { attachCampaignIds: after.detached } : {}),
        ...(after.attached.length ? { detachCampaignIds: after.attached } : {}),
        why: `undo of an earlier negative keyword list change${after.created ? ' (the list it made stays)' : ''}`,
      },
    }
  },
}

const listKeywordArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the keyword (at most 80 characters, 10 words)'),
  matchType: matchTypeArg,
})

const setGoogleNegativeList: AgentTool = {
  name: 'set-google-negative-list',
  title: 'Change a Google negative keyword list',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    listId: googleIdArg('the negative keyword list').optional(),
    create: z.object({ name: z.string().trim().min(1).max(255).describe('the new list\'s name (unique in the account)') }).optional()
      .describe('make a new shared negative keyword list (give listId or create, not both)'),
    addKeywords: z.array(listKeywordArg).max(250).optional().describe('negative keywords to add (already there: skipped)'),
    removeKeywords: z.array(listKeywordArg).max(250).optional().describe('negative keywords to remove (text and match type as in the list)'),
    attachCampaignIds: z.array(googleIdArg('a campaign')).max(50).optional().describe('campaigns that use the list from now'),
    detachCampaignIds: z.array(googleIdArg('a campaign')).max(50).optional().describe('campaigns that stop using the list'),
    why: googleWhyArg,
  }),
  description:
    'A shared negative keyword list of the business\'s chosen Google Ads account: make one (create), add and remove its '
    + 'keywords (EXACT, PHRASE or BROAD), and attach it to campaigns or take it off them. All in one request. Removing '
    + 'keywords or taking the list off a campaign lets more searches show the ads (said in the warnings). Undo puts the '
    + 'keywords and campaigns back as they were.' + GOOGLE_CHANGE_RULES,
  undo: listUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildList(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildList(args), (draft, responses) => {
    const request = listRequest(args)
    const after = structuredClone(draft.after) as ListChangeRecord
    if (request.create) after.listId = createdListId(responses, request) ?? 'new'
    return { data: { listId: after.listId }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_CHANGE_TOOLS: AgentTool[] = [setGoogleBudget, setGoogleNegativeList]
