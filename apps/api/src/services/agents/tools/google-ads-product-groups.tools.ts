/**
 * Google Ads changes (2026-10-15, Owner's brief "full write control of Google Ads through Nexus") — PR 4: the product
 * groups of a Standard Shopping ad group. A Nexus change: a preview Google has checked (validate_only), an approvalId, a
 * person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-product-groups   rebuild the tree as "All products" split by item ID ("everything else" EXCLUDED unless
 *                               asked), give the whole tree of any shape (tree: brand, category / product type levels,
 *                               custom labels, condition, channel, channel exclusivity, item id, nested), edit the tree
 *                               as it is (add, subdivide, remove, removeTree), or change the bids of its product groups,
 *                               exclude them or advertise them again
 *
 * The builders and Google's listing group rules: marketing/google-ads/change-product-groups.ts, change-product-tree.ts,
 * product-tree.ts.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import {
  MAX_ITEM_IDS, productGroupChangeDraft, productGroupRecordAfterRun, productGroupRecordNow, productGroupUndoArgs, type ProductGroupChangeRecord,
  type ProductGroupRequest,
} from '../../marketing/google-ads/change-product-groups.js'
import { liveProductGroupTree } from '../../marketing/google-ads/live-product-groups.js'
import { DIMENSIONS, MAX_TREE_NODES } from '../../marketing/google-ads/product-tree.js'
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
  tree: args.tree as ProductGroupRequest['tree'],
  inTwoSteps: args.inTwoSteps === true,
  add: args.add as ProductGroupRequest['add'],
  subdivide: args.subdivide as ProductGroupRequest['subdivide'],
  remove: args.remove as string[] | undefined,
  removeTree: args.removeTree === true,
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
/** Google's Shopping dimensions (product-tree.ts DIMENSIONS). */
export const dimensionArg = z.enum(DIMENSIONS)
  .describe('ITEM_ID, BRAND, CONDITION (NEW/USED/REFURBISHED), CHANNEL (ONLINE/LOCAL), CHANNEL_EXCLUSIVITY (SINGLE_CHANNEL/MULTI_CHANNEL), PRODUCT_TYPE_1…5, CATEGORY_1…5 (Google product category ids), CUSTOM_LABEL_0…4')
export const dimensionValueArg = z.string().trim().min(1).max(750)
  .describe('a value of that dimension: an item id, a brand, a product type or custom label text, a Google product category id (digits), NEW/USED/REFURBISHED, ONLINE/LOCAL, SINGLE_CHANNEL/MULTI_CHANNEL')
const unitBidArg = googleCentsArg('a unit: its bid (a click)').optional()
const unitExcludedArg = z.boolean().optional().describe('a unit: true = excluded (never advertised here); give this or bidCents')
/** One product group of a tree as a person gives it: flat, its parent by index, parents first (product-tree.ts TreeSpecNode). */
export const treeNodeArg = z.object({
  parent: z.coerce.number().int().min(0).max(MAX_TREE_NODES - 1).optional().describe('the index of its parent in the list; left out only for the root ("All products"), which comes first'),
  value: dimensionValueArg.optional(),
  everythingElse: z.boolean().optional().describe('true = "everything else" of the parent\'s dimension (every split needs exactly one)'),
  split: dimensionArg.optional().describe('split it further by this dimension (no bid of its own); left out = a unit with bidCents or excluded'),
  bidCents: unitBidArg,
  excluded: unitExcludedArg,
}).describe('one product group: the root (no parent), or a value / everythingElse of its parent\'s split; split further, or a unit with a bid or excluded')

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
    tree: z.array(treeNodeArg).max(MAX_TREE_NODES).optional()
      .describe('the WHOLE tree as it should be, any shape: a flat list, the root ("All products") first, each other product group naming its parent by index. What already stands keeps its id and statistics; the rest is made, changed or removed. Alone (not with other arguments)'),
    inTwoSteps: z.boolean().optional()
      .describe('tree only: when Google must remove a split before the new tree can be made (it refuses both in one request), do it in two changes — this one removes only what must go; ask the same request again after it ran for step 2'),
    add: z.array(z.object({
      parentId: googleIdArg('the split (a subdivision) to add it under'),
      value: dimensionValueArg,
      bidCents: unitBidArg,
      excluded: unitExcludedArg,
    })).max(MAX_TREE_NODES).optional().describe('new product groups (units) under existing splits, by that split\'s dimension: their products leave "everything else" there'),
    subdivide: z.array(z.object({
      criterionId: googleIdArg('the unit to split further'),
      split: dimensionArg,
      children: z.array(z.object({ value: dimensionValueArg, bidCents: unitBidArg, excluded: unitExcludedArg })).min(1).max(MAX_TREE_NODES).describe('the values it is split into, each a unit with a bid or excluded'),
      everythingElse: z.object({ bidCents: unitBidArg, excluded: unitExcludedArg }).describe('the "everything else" of the new split: a bid, or excluded'),
    })).max(50).optional().describe('split existing units one level further (the unit is replaced by a split with the same products: a new id)'),
    remove: z.array(googleIdArg('a product group to remove (a unit, or a split with everything under it)')).max(MAX_TREE_NODES).optional()
      .describe('remove product groups: their products fall under "everything else" of their parent. Removing a split must be a request of its own (Google refuses it next to anything it makes or changes)'),
    removeTree: z.boolean().optional().describe('true = remove the whole tree: the ad group shows no products until a tree is built again. Alone'),
    why: googleWhyArg,
  }),
  description:
    'The product groups of ONE Standard Shopping ad group of the business\'s chosen Google Ads account, in one of four ways. '
    + '(1) itemIds: "All products" split by item ID (bidCents or itemBids, excludeItemIds); "everything else" (every other '
    + 'product of the feed) is EXCLUDED unless includeEverythingElse gives it a bid. (2) tree: the whole tree of ANY shape, '
    + 'split by item ID, brand, condition, channel, channel exclusivity, product type or category (levels 1–5, in order) or '
    + 'custom label 0–4, nested; what already stands keeps its id and statistics. (3) The tree as it is: add units under a '
    + 'split, subdivide a unit, remove a product group or a split (its products fall under "everything else"), removeTree; '
    + 'bids, exclude and include may go with them. (4) bids, exclude, include alone (by criterionId, google-ads-live view '
    + 'product-groups). Google refuses to remove a split in a request that makes or changes product groups: a removal of a '
    + 'split is a request of its own, and a tree that needs one is done in two steps (inTwoSteps: step 1 removes, the same '
    + 'request again makes the rest; the preview says where the products fall in between). Bids are whole cents of the '
    + 'account\'s currency. The preview shows before → after and warns when an "everything else" is not excluded; product '
    + 'groups that can now be advertised, bid raises and products that fall under an advertised "everything else" are '
    + 'marked SPENDS MONEY. Undo puts the old tree back as it was (bids, exclusions, splits; product groups made again get '
    + 'new ids) — in two steps when a unit must come back where a split now stands — or the old bids and exclusions.' + GOOGLE_CHANGE_RULES,
  undo: productGroupUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildProductGroups(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildProductGroups(args), (draft, responses) => {
    const after = productGroupRecordAfterRun(draft.after as ProductGroupChangeRecord, responses)
    return { data: { campaignId: after.campaignId, adGroupId: after.adGroupId, tree: after.tree }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_PRODUCT_GROUPS_TOOLS: AgentTool[] = [setGoogleProductGroups]
