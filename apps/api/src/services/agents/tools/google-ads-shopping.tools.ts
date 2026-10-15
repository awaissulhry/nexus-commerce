/**
 * Google Ads Shopping (2026-10-15, G4) — a Standard Shopping campaign's inventory filter and Shopping settings. Each a
 * Nexus change: a preview Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as
 * that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-inventory-filter   set, change or clear the campaign's inventory filter (its LISTING_SCOPE criterion: up to
 *                                 7 conditions — item id, brand, condition, channel, channel exclusivity, product type
 *                                 or category levels, custom labels)
 *   set-google-shopping-settings  feed label (or none), local products, brand exclusions ignored for Shopping ads
 *                                 (priority: set-google-campaign; the Merchant Center account cannot change)
 *
 * The builders and what Google allows: marketing/google-ads/change-shopping.ts.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange, type GoogleDraftBuilder,
} from './google-ads-kit.js'
import {
  inventoryFilterDraft, inventoryFilterRecordAfterRun, inventoryFilterRecordNow, inventoryFilterUndoArgs, MAX_FILTER_CONDITIONS, shoppingSettingsDraft,
  shoppingSettingsNow, type InventoryFilterRecord, type InventoryFilterRequest, type ShoppingSettingsRecord, type ShoppingSettingsRequest,
} from '../../marketing/google-ads/change-shopping.js'
import { liveShoppingState } from '../../marketing/google-ads/live-shopping.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import { dimensionArg, dimensionValueArg } from './google-ads-product-groups.tools.js'

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
  reversibility: 'full' as const,
  requires: [F.adsCampaignsManage] as const,
}

type Stamped<T> = T & { accountId?: string; customerId?: string }

// ── set-google-inventory-filter ─────────────────────────────────────────────────────────────────────────────────

const filterRequest = (args: Record<string, unknown>): InventoryFilterRequest => ({
  campaignId: String(args.campaignId ?? ''),
  filter: args.filter as InventoryFilterRequest['filter'],
  clear: args.clear === true,
})

const buildFilter = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = filterRequest(args)
  return inventoryFilterDraft(customerResource(account.target), request, await liveShoppingState(account.target, request.campaignId))
}

const filterUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? null) as Stamped<InventoryFilterRecord> | null
    if (!after?.campaignId || !/^\d+$/.test(after.campaignId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const state = await liveShoppingState(account.target, after.campaignId)
    return { ...inventoryFilterRecordNow(after, state), accountId: account.accountId, customerId: account.customerId }
  },
  request(change: ToolChange) {
    const before = (change.before ?? null) as Stamped<InventoryFilterRecord> | null
    const undo = inventoryFilterUndoArgs(before)
    if ('refusal' in undo) return undo
    return { tool: 'set-google-inventory-filter', args: { ...(before?.accountId ? { accountId: before.accountId } : {}), ...undo.args, why: 'undo of an earlier inventory filter change' } }
  },
}

const setGoogleInventoryFilter: AgentTool = {
  ...common,
  name: 'set-google-inventory-filter',
  title: 'Change a Shopping inventory filter',
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Standard Shopping campaign'),
    filter: z.array(z.object({ dimension: dimensionArg, value: dimensionValueArg }).describe('one condition: a dimension and its value'))
      .min(1).max(MAX_FILTER_CONDITIONS).optional()
      .describe(`the whole inventory filter from now: up to ${MAX_FILTER_CONDITIONS} conditions, each dimension once, ALL must hold for a product to be advertised (product type / category levels in order from 1)`),
    clear: z.boolean().optional().describe('true = remove the inventory filter: every product of the feed can be advertised again — SPENDS MONEY'),
    why: googleWhyArg,
  }),
  description:
    'Set, change or clear the inventory filter of ONE Standard Shopping campaign of the business\'s chosen Google Ads '
    + 'account: the products it may advertise at all (Google calls it the listing scope). Up to 7 conditions on item id, '
    + 'brand, condition, channel, channel exclusivity, product type or category (levels in order from 1) and custom labels '
    + '0–4; every condition must hold. Google keeps one filter per campaign and cannot change it in place, so a change '
    + 'removes the old one and makes the new one in the same request. Narrowing is safe; clearing it, or a filter that lets '
    + 'products in that the old one left out, is marked SPENDS MONEY. The product groups of its ad groups still set the bids. '
    + 'Undo puts the old filter back (or none).' + GOOGLE_CHANGE_RULES,
  undo: filterUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildFilter(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildFilter(args), (draft, responses) => {
    const after = inventoryFilterRecordAfterRun(draft.after as InventoryFilterRecord, responses)
    return { data: { campaignId: after.campaignId, filter: after.filter, criterionId: after.criterionId }, before: draft.before, after }
  }),
}

// ── set-google-shopping-settings ────────────────────────────────────────────────────────────────────────────────

const settingsRequest = (args: Record<string, unknown>): ShoppingSettingsRequest => ({
  campaignId: String(args.campaignId ?? ''),
  ...(typeof args.feedLabel === 'string' ? { feedLabel: args.feedLabel } : {}),
  ...(typeof args.localInventory === 'boolean' ? { localInventory: args.localInventory } : {}),
  ...(typeof args.ignoreBrandExclusions === 'boolean' ? { ignoreBrandExclusions: args.ignoreBrandExclusions } : {}),
})

const buildSettings = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = settingsRequest(args)
  return shoppingSettingsDraft(customerResource(account.target), request, await liveShoppingState(account.target, request.campaignId))
}

const settingsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? null) as Stamped<ShoppingSettingsRecord> | null
    if (!after?.campaignId || !/^\d+$/.test(after.campaignId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const state = await liveShoppingState(account.target, after.campaignId)
    if (!state.campaign) return null
    const now = shoppingSettingsNow(state.campaign)
    const settings = Object.fromEntries(Object.keys(after.settings ?? {}).map((k) => [k, now[k as keyof typeof now]]))
    return { campaignId: after.campaignId, settings, accountId: account.accountId, customerId: account.customerId }
  },
  request(change: ToolChange) {
    const before = (change.before ?? null) as Stamped<ShoppingSettingsRecord> | null
    if (!before?.campaignId || !before.settings || !Object.keys(before.settings).length) return { refusal: 'This change does not record the Shopping settings it replaced.' }
    return { tool: 'set-google-shopping-settings', args: { ...(before.accountId ? { accountId: before.accountId } : {}), campaignId: before.campaignId, ...before.settings, why: 'undo of an earlier Shopping settings change' } }
  },
}

const setGoogleShoppingSettings: AgentTool = {
  ...common,
  name: 'set-google-shopping-settings',
  title: 'Change a campaign\'s Shopping settings',
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Standard Shopping campaign'),
    feedLabel: z.string().trim().min(1).max(20).optional()
      .describe('the feed label of the products it advertises (up to 20 of A–Z, 0–9, - and _), or none = every feed of the Merchant Center account (SPENDS MONEY)'),
    localInventory: z.boolean().optional().describe('local products (sold in local stores) on or off; on = SPENDS MONEY'),
    ignoreBrandExclusions: z.boolean().optional().describe('true = Google ignores the brand exclusions for its Shopping ads (SPENDS MONEY); false = they apply'),
    why: googleWhyArg,
  }),
  description:
    'Change the Shopping settings Google lets change on ONE existing Standard Shopping campaign of the business\'s chosen '
    + 'Google Ads account: the feed label (or none: every feed of the Merchant Center account), local products, and '
    + 'whether brand exclusions are ignored for its Shopping ads. Priority is set-google-campaign; the Merchant Center '
    + 'account cannot change on a Shopping campaign (Google: immutable). Only what is named changes; the preview shows each '
    + 'from → to. Another or no feed label, local products on and brand exclusions ignored are marked SPENDS MONEY. Undo '
    + 'puts the old settings back.' + GOOGLE_CHANGE_RULES,
  undo: settingsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSettings(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSettings(args), (draft) => ({ data: { campaignId: args.campaignId }, before: draft.before, after: draft.after })),
}

export const GOOGLE_ADS_SHOPPING_TOOLS: AgentTool[] = [setGoogleInventoryFilter, setGoogleShoppingSettings]
