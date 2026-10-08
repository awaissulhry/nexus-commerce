/**
 * ONE BRAIN AB-3 — `ads-brain`: Claude reads the brain's map (design 2026-10-08-ads-one-brain/DESIGN.md §3, §6, §8).
 * Read only: it changes nothing, in Nexus or at Amazon. The logic is advertising/brain/read-map.ts (the Owner's own page
 * can call the same functions; Claude builds no screen, §10).
 *
 *   map      who owns each of the 12 levers of each campaign today (the brain live or in shadow, a named engine, a rule,
 *            the Owner, or nobody), the brain's resolved settings with their source, excluded and shared campaigns, drift
 *   clashes  where two automatic writers can act on one campaign's lever, from what is set up and from the action log, and
 *            the known gaps (harvest vs negate, a harvest with no destination, sibling products on one keyword, and —
 *            AB-4 — Amazon's own rules on brain campaigns, from the daily read: brain/native-rules.ts)
 *   setup    the tools that are not set up or are held off, with what starts them, and the brain's own setup
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { BRAIN_MAP_VIEWS, brainClashes, brainMap, brainSetup, DEFAULT_EVIDENCE_DAYS, MAX_EVIDENCE_DAYS } from '../../advertising/brain/read-map.js'
import type { AgentTool, FieldPermission } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)

/** The portfolio cap amount (a setting) and the money an Owner's lock may hold are ad-spend money. */
const BRAIN_MAP_MONEY: Readonly<Record<string, FieldPermission>> = Object.fromEntries(
  ['portfolioCapCents', 'dailyBudgetCents', 'amountCents'].map((key) => [key, FIELDS.financialsAdspendView]),
)

const adsBrain: AgentTool = {
  name: 'ads-brain',
  title: 'Ads brain map',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: BRAIN_MAP_MONEY,
  input: z.object({
    view: z.enum(BRAIN_MAP_VIEWS).default('map')
      .describe('map (default): who owns each lever of each campaign today; clashes: two automatic writers on one campaign\'s lever, and the known gaps; setup: what is not set up or held off, with the fix'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (business-overview). map: with productId; alone, or omitted, the products the brain knows there (or in every market); clashes: required'),
    productId: ID.optional().describe('map / clashes: one product (a variation names its parent), its Nexus id'),
    campaignId: ID.optional().describe('map: one Amazon campaign, its Nexus id (ad-campaigns)'),
    days: z.coerce.number().int().min(1).max(MAX_EVIDENCE_DAYS).default(DEFAULT_EVIDENCE_DAYS)
      .describe(`map / clashes: how many days of the action log count as evidence of who wrote (default ${DEFAULT_EVIDENCE_DAYS}, max ${MAX_EVIDENCE_DAYS})`),
  }),
  description:
    'Read the ads brain\'s map for Amazon Sponsored Products: one brain per product and market will run every lever (bids, '
    + 'ad group bids, hours, placements, state, budgets, portfolio cap, negatives, harvest, structure, bidding strategy, '
    + 'off-Amazon). view map (default): with productId and market, the product\'s brain — each lever\'s level and what it '
    + 'does (with its source: the brain\'s default, or the Owner\'s product or campaign override, who and when), the '
    + 'settings, the campaigns its choice does not reach and the drift — and for each of its campaigns (own and shared) '
    + 'every lever\'s owner today: the brain (live, or watching in shadow), a named engine (Hourly bid plans, classic '
    + 'dayparting, the bid optimiser, Top-of-Search defense, coverage, autopilot, budget schedules or pools), a rule by '
    + 'name, the Owner (a lock, pinned bids, held keywords) or nobody, with every writer set up and every one that wrote in '
    + 'the last days; with campaignId, one campaign; with market alone (or nothing), the products the brain knows there (or in every market). view clashes '
    + '(market, optionally productId): every campaign lever two automatic writers can act on (set up at Auto, or wrote), '
    + 'and the known gaps — a keyword targeted and blocked in one place, a harvest rule with no stored destination (it '
    + 'never negates its source), keywords two products bid on, and Amazon\'s own rules on brain campaigns: each budget '
    + 'rule (read from Amazon once a day) or Amazon-run bidding strategy that acts on one is a clash, and an enrolled '
    + 'product\'s brain refuses to take that lever to AUTO while it is attached; optimization rules and schedule bid rules are "could not read" '
    + '(no API read Nexus could verify). Safety owners (retail guard, budget enforcement, auto-undo, the write reconcile) always pass and are '
    + 'never a clash. view setup: the engines that are not set up or are held off, with what starts them, and the '
    + 'brain\'s own setup (its server switch, products LIVE one campaign at a time but not enrolled). The portfolio cap '
    + 'amount is ad-spend money. Nexus only: it reads what Nexus stored and asks Amazon nothing.',
  handler: async (args) => {
    const a = args as { view?: string; market?: string; productId?: string; campaignId?: string; days?: number }
    const out = a.view === 'clashes' ? await brainClashes(a)
      : a.view === 'setup' ? await brainSetup(a)
        : await brainMap(a)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_BRAIN_TOOLS: AgentTool[] = [adsBrain]
