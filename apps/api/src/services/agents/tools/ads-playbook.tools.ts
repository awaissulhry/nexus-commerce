/**
 * ADS PLAYBOOK PB-2 — ads-playbook: Claude reads HOW a product's Amazon ads are built and run (AdsPlaybookTemplate,
 * AdsPlaybook), per market and per category or product inside a market, through the one read the playbook screens use
 * (ads-playbook/read.ts):
 *
 *   effective  the playbook a product, a category or a market follows, each section with the row or template it came
 *              from; the product's own fields (enrolled, state, terms, budget, base bid, phase recipes); the slots it
 *              would be built from; what it owns; why it cannot compile yet; the strategy in force beside it (the phase)
 *   rows       every playbook row of a market
 *   templates  the business's templates (templateId: one, with its whole doc)
 *   history    the recorded changes of a template or of a market's rows
 *   capture    what a template captured from live campaigns would hold (a preview; nothing saved)
 *
 * Read only, Nexus only: no marketplace call. Honest: nothing reads a playbook yet (no engine, rule or Claude change);
 * an approved apply compiles it in a later step. Money (the product's budget and base bid, the least budget per slot,
 * the recipes' targets and bids, the strategy's numbers) sits only under the keys PLAYBOOK_MONEY names: a person without
 * financials.adspend.view gets the same answer minus exactly those keys.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { PLAYBOOK_MONEY } from '../../advertising/ads-playbook/doc.js'
import { PLAYBOOK_VIEWS, readPlaybook, type PlaybookReadArgs } from '../../advertising/ads-playbook/read.js'
import type { AgentTool, FieldPermission } from '../tool-types.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const ID = z.string().trim().min(1).max(64)

const adsPlaybook: AgentTool = {
  name: 'ads-playbook',
  title: 'Ads playbook',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: PLAYBOOK_MONEY as Readonly<Record<string, FieldPermission>>,
  input: z.object({
    channel: z.preprocess(upper, z.enum(['AMAZON'])).default('AMAZON')
      .describe('AMAZON (default): the playbook covers Amazon Sponsored Products in this release'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (IT, DE, FR, ES, UK; business-overview lists them); omit for every market with a playbook or a campaign. capture needs one'),
    view: z.enum(PLAYBOOK_VIEWS).default('effective')
      .describe('effective (default): the playbook one scope follows, each part with its source; rows: every playbook row of a market; templates: the templates (templateId: one with its doc); history: recorded changes; capture: what a template captured from live campaigns would hold (nothing saved)'),
    productId: ID.optional().describe('effective or history: one product (a variation or a parent), its Nexus id'),
    sku: z.string().trim().min(1).max(100).optional().describe("instead of productId: the product's SKU in this business"),
    categoryId: ID.optional().describe('effective or history: one category, its Nexus id (catalog-structure)'),
    templateId: ID.optional().describe('templates: one template, with its whole doc; history: that template\'s changes'),
    campaignIds: z.array(ID).min(1).max(50).optional()
      .describe('capture: the live campaigns to capture, their Nexus ids (campaignId in ad-campaigns); or portfolioId, or namePrefix'),
    portfolioId: z.string().trim().min(1).max(64).optional().describe('capture: every campaign of this Amazon portfolio (its Amazon portfolio id)'),
    namePrefix: z.string().trim().min(1).max(120).optional().describe('capture: every campaign whose name starts with this'),
    productToken: z.string().trim().min(1).max(60).optional()
      .describe("capture: the product's token in the campaign names (the word each campaign name of the set carries); it is taken out of the names, and a keyword holding it counts as brand"),
    competitorTokens: z.array(z.string().trim().min(1).max(60)).max(30).optional()
      .describe('capture: rival brand words, so a keyword holding one counts as competitor (a well-named campaign says it anyway)'),
    limit: z.coerce.number().int().min(1).max(100).default(20).describe('history: how many changes (default 20, max 100)'),
  }),
  description:
    "Read the business's Amazon Ads playbook: HOW a product's ads are built and run — the campaign set (slots: Auto, "
    + 'brand / competitor / category keywords by match type, product targeting), their names and portfolio, how the '
    + "product's daily budget splits, the start-bid ladder, placements, how harvested search terms flow between campaigns "
    + 'and which cross-negatives keep them apart, the hourly bid plans per rank role (performance, research), and the '
    + 'phase table (what changes in LAUNCH, GROW, PROFIT, CLEAR_STOCK, DEFEND and when to propose the next). A template is '
    + 'made once and reused; a playbook row per market, category or product names one and overrides parts of it (product '
    + '→ its parent → the deepest primary category → the market → the template; each part whole). view effective (default) '
    + "gives what one product, category or market follows, every part with its source, the product's own fields (enrolled "
    + '— a product is in only when its own row says so —, state, terms, daily budget, base bid, phase recipes), the slots '
    + 'it would be built from, what it owns (links), why it cannot compile yet, and the ads strategy in force beside it: '
    + "the phase is the strategy's goal, and the strategy's numbers are what the engines obey. view rows lists a market's "
    + 'rows; templates the templates; history the changes; capture what a template captured from live campaigns would hold '
    + '(campaignIds, portfolioId or namePrefix, with productToken): slots, naming, budget shares, bid ladder, placements, '
    + "hourly plans by rank role and the product's terms — nothing is saved. Nothing reads a playbook yet: no engine, rule "
    + 'or Claude change follows it until an approved apply compiles it. Budgets, bids and targets are ad-spend money: '
    + 'hidden from a person without permission to see ad spend. Nexus only; reads nothing from Amazon.',
  handler: async (args) => {
    const out = await readPlaybook(args as PlaybookReadArgs)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_PLAYBOOK_TOOLS: AgentTool[] = [adsPlaybook]
