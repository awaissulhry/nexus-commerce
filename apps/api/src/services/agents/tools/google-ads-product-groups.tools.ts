/**
 * Google Ads changes (2026-10-15, Owner's brief "full write control of Google Ads through Nexus") — PR 4: the product
 * groups of a Standard Shopping ad group. A Nexus change: a preview Google has checked (validate_only), an approvalId, a
 * person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-product-groups   rebuild the tree as "All products" split by item ID ("everything else" EXCLUDED unless
 *                               asked), or change the bids of its product groups, exclude them or advertise them again
 *
 * The builder and Google's listing group rules: marketing/google-ads/change-product-groups.ts.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import {
  MAX_ITEM_IDS, productGroupChangeDraft, productGroupRecordNow, productGroupUndoArgs, type ProductGroupChangeRecord, type ProductGroupRequest,
} from '../../marketing/google-ads/change-product-groups.js'
import { liveProductGroupTree } from '../../marketing/google-ads/live-product-groups.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of this tool's preview and answer: its sentences quote bids, so they are money too. */
const PRODUCT_GROUP_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, skipped: ADSPEND, bidCents: ADSPEND } as const

/** A change's record, as the kit stamps it with the Google account it was made on. */
type Stamped = ProductGroupChangeRecord & { accountId?: string; customerId?: string }

const productGroupRequest = (args: Record<string, unknown>): ProductGroupRequest => ({
  campaignId: String(args.campaignId ?? ''),
  adGroupId: String(args.adGroupId ?? ''),
  itemIds: args.itemIds as string[] | undefined,
  bidCents: args.bidCents as number | undefined,
  itemBids: args.itemBids as ProductGroupRequest['itemBids'],
  excludeItemIds: args.excludeItemIds as string[] | undefined,
  includeEverythingElse: args.includeEverythingElse as ProductGroupRequest['includeEverythingElse'],
  bids: args.bids as ProductGroupRequest['bids'],
  exclude: args.exclude as string[] | undefined,
  include: args.include as ProductGroupRequest['include'],
})

const buildProductGroups = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = productGroupRequest(args)
  const live = await liveProductGroupTree(account.target, request.adGroupId)
  return productGroupChangeDraft(customerResource(account.target), account.currency, request, live)
}

const productGroupUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? null) as Stamped | null
    if (!after?.adGroupId || !/^\d+$/.test(after.adGroupId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveProductGroupTree(account.target, after.adGroupId)
    return { ...productGroupRecordNow(after, live.nodes), accountId: account.accountId, customerId: account.customerId }
  },
  request(change: ToolChange) {
    const undo = productGroupUndoArgs(change)
    if ('refusal' in undo) return undo
    const before = (change.before ?? {}) as Stamped
    return {
      tool: 'set-google-product-groups',
      args: { ...(before.accountId ? { accountId: before.accountId } : {}), ...undo.args, why: 'undo of an earlier product group change' },
    }
  },
}

const itemIdArg = z.string().max(200).describe('an item id: the product\'s offer id in the Merchant Center feed (1–50 characters)')

const setGoogleProductGroups: AgentTool = {
  name: 'set-google-product-groups',
  title: 'Change Google Shopping product groups',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, F.adsBidsEdit, ADSPEND],
  restrictedFields: PRODUCT_GROUP_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Standard Shopping campaign'),
    adGroupId: googleIdArg('the ad group of that campaign whose product groups change'),
    itemIds: z.array(itemIdArg).max(MAX_ITEM_IDS).optional()
      .describe('REBUILD the tree as "All products" split by item ID: one product group per item id, with a bid (bidCents, or its own in itemBids). Compared without case; at most 250 item ids with excludeItemIds'),
    bidCents: googleCentsArg('the bid (a click) of every item of itemIds that itemBids does not name').optional(),
    itemBids: z.array(z.object({ itemId: itemIdArg, bidCents: googleCentsArg('its bid (a click)') })).max(MAX_ITEM_IDS).optional()
      .describe('rebuild: a bid of its own for an item of itemIds'),
    excludeItemIds: z.array(itemIdArg).max(MAX_ITEM_IDS).optional()
      .describe('rebuild: item ids that get an EXCLUDED product group (never advertised in this ad group)'),
    includeEverythingElse: z.object({ bidCents: googleCentsArg('the bid (a click) of everything else') }).optional()
      .describe('rebuild: advertise "everything else" (every other product of the feed) at this bid instead of excluding it — SPENDS MONEY. Left out = everything else is EXCLUDED'),
    bids: z.array(z.object({ criterionId: googleIdArg('the product group (a unit)'), bidCents: googleCentsArg('its new bid (a click)') })).max(MAX_ITEM_IDS).optional()
      .describe('new bids of product groups of the tree as it is (criterionId from google-ads-live view product-groups); a raise is marked SPENDS MONEY'),
    exclude: z.array(googleIdArg('a product group (a unit) to exclude')).max(MAX_ITEM_IDS).optional()
      .describe('exclude product groups of the tree as it is (they stop being advertised); "everything else" can be excluded this way'),
    include: z.array(z.object({ criterionId: googleIdArg('an excluded product group'), bidCents: googleCentsArg('its bid (a click)') })).max(MAX_ITEM_IDS).optional()
      .describe('advertise excluded product groups again, each at a bid — SPENDS MONEY'),
    why: googleWhyArg,
  }),
  description:
    'The product groups of ONE Standard Shopping ad group of the business\'s chosen Google Ads account. Either rebuild the '
    + 'tree as "All products" split by item ID (itemIds with bidCents or itemBids, excludeItemIds): "everything else" (every '
    + 'other product of the feed) is EXCLUDED unless includeEverythingElse gives it a bid, and a tree already there is '
    + 'replaced in the same request; or change the product groups of the tree as it is: bids, exclude, include (by '
    + 'criterionId, google-ads-live view product-groups). Bids are whole cents of the account\'s currency. The preview shows '
    + 'the tree before → after and warns when "everything else" is not excluded; items that can now be advertised, bid '
    + 'raises and an included "everything else" are marked SPENDS MONEY. Undo puts the old bids back, or rebuilds the old '
    + 'tree when it was a single split by item ID (any other tree is put back by hand in Google Ads).' + GOOGLE_CHANGE_RULES,
  undo: productGroupUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildProductGroups(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildProductGroups(args), (draft) => {
    const after = draft.after as ProductGroupChangeRecord
    return { data: { campaignId: after.campaignId, adGroupId: after.adGroupId, tree: after.tree }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_PRODUCT_GROUPS_TOOLS: AgentTool[] = [setGoogleProductGroups]
