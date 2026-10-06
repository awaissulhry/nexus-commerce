/**
 * ADS AUTONOMY W1-2 — ads-strategy: Claude reads the Owner's Amazon Ads strategy (AdsStrategy), per market and per
 * category or product inside a market, through the one read the strategy screens use (ads-strategy/read.ts):
 *
 *   effective  every number in force for a market, a category, a product, a campaign or an ad group, each with the row
 *              it came from; the older settings that also bind; the campaigns whose own target ACoS wins; what Claude
 *              may do alone per kind of ad action
 *   rows       every strategy row of a market, and the older settings at the same grains
 *   history    the recorded changes, newest first
 *
 * Read only, Nexus only: no marketplace call. Honest about readers: no engine, rule or Claude door acts on the
 * strategy yet (every field's `readBy` is empty, `notReadYet` lists them all); W1 wires the readers one by one.
 * Money (targets, bids, caps, spend thresholds) sits only under the keys STRATEGY_MONEY names: a person without
 * financials.adspend.view gets the same answer minus exactly those keys.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { STRATEGY_MONEY } from '../../advertising/ads-strategy/fields.js'
import { readStrategy, STRATEGY_VIEWS, type StrategyReadArgs } from '../../advertising/ads-strategy/read.js'
import type { AgentTool, FieldPermission } from '../tool-types.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const ID = z.string().trim().min(1).max(64)

const adsStrategy: AgentTool = {
  name: 'ads-strategy',
  title: 'Ads strategy',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: STRATEGY_MONEY as Readonly<Record<string, FieldPermission>>,
  input: z.object({
    channel: z.preprocess(upper, z.enum(['AMAZON'])).default('AMAZON')
      .describe('AMAZON (default): the strategy covers Amazon Sponsored Products in this release'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (IT, DE, FR, ES, UK; business-overview lists them); omit for every market with a strategy or a campaign. A campaign or an ad group answers in its own market'),
    view: z.enum(STRATEGY_VIEWS).default('effective')
      .describe('effective (default): every number in force for one scope, with the row it came from; rows: every strategy row of the market and the older settings at the same grains; history: the recorded changes, newest first'),
    productId: ID.optional().describe('effective or history: one product (a variation or a parent), its Nexus id'),
    sku: z.string().trim().min(1).max(100).optional().describe("instead of productId: the product's SKU in this business"),
    categoryId: ID.optional().describe('effective or history: one category, its Nexus id (catalog-structure)'),
    campaignId: ID.optional()
      .describe('effective: one Amazon campaign, its Nexus id (campaignId in ad-campaigns): every product of its ad groups, the safer value per field'),
    adGroupId: ID.optional()
      .describe('effective: one ad group, its Nexus id (adGroupId in ad-targets): its products, the safer value per field'),
    limit: z.coerce.number().int().min(1).max(100).default(20).describe('history: how many changes (default 20, max 100)'),
  }),
  description:
    "Read the business's Amazon Ads strategy: what the Owner set per market, and per category or product inside a market "
    + '(goal and why, target ACoS or TACoS, monthly spend cap, lowest and highest bid, largest bid change, most actions per '
    + 'run, protection, harvest and negate thresholds, how a temporary stop works, and what Claude may do alone per kind of '
    + 'ad action). view effective (default) gives every number in force for a market, a category, a product, a campaign '
    + 'or an ad group, each with its source (product, its parent, the deepest primary category, or the market) and version; '
    + 'several products in one ad group take the safer number per field and name the product it came from; a category or '
    + 'product row always belongs to one market. It also lists the older settings that still bind (campaign bid limits, '
    + 'bid and harvest policies, the budget plan), the campaigns whose own target ACoS wins over the strategy, and the '
    + "business's own Claude level per ad tool. view rows lists every strategy row of a market; view history the changes. "
    + 'No engine, rule or Claude door acts on the strategy yet: readBy is empty on every field and notReadYet lists them, '
    + 'so every engine works as before. Targets, bids, caps and spend thresholds are ad-spend money: hidden from a person '
    + 'without permission to see ad spend. Nexus only; reads nothing from Amazon.',
  handler: async (args) => {
    const out = await readStrategy(args as StrategyReadArgs)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_STRATEGY_TOOLS: AgentTool[] = [adsStrategy]
