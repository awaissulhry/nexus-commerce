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
 *   money    AB-7 — a product's money plan in shadow (brain/budget-read.ts): its envelope, pace and brake, the portfolio-cap
 *            plan, each campaign's budget target against today's and the intraday ladder, each with its why — decided now
 *            (a dry run, any product) beside the newest plan the shadow logged; with market alone, the market's split
 *   state    AB-12 — the state lever (brain/state-read.ts): each campaign of a product decided now (a dry run: pause for a
 *            stop of 3 days or more, resume when it ends, propose to archive a campaign dead for weeks, keep — each with its
 *            cause, horizon and why) beside the newest decision the brain logged; its pauses in force, requests waiting,
 *            the day's pause cap; with market alone, the market's
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { BRAIN_MAP_VIEWS, brainClashes, brainMap, brainSetup, DEFAULT_EVIDENCE_DAYS, MAX_EVIDENCE_DAYS } from '../../advertising/brain/read-map.js'
import { brainMoney } from '../../advertising/brain/budget-read.js'
import { brainState } from '../../advertising/brain/state-read.js'
import type { AgentTool, FieldPermission } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)

/**
 * The portfolio cap amount (a setting) and the money an Owner's lock may hold are ad-spend money. AB-7 — the money view
 * puts every amount, percent of spend and sentence naming one under a `money` key: hidden whole without the permission.
 */
const BRAIN_MAP_MONEY: Readonly<Record<string, FieldPermission>> = Object.fromEntries(
  ['portfolioCapCents', 'dailyBudgetCents', 'amountCents', 'money'].map((key) => [key, FIELDS.financialsAdspendView]),
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
      .describe('map (default): who owns each lever of each campaign today; clashes: two automatic writers on one campaign\'s lever, and the known gaps; setup: what is not set up or held off, with the fix; money: a product\'s money plan in shadow — envelope, pace, brake, portfolio cap, campaign budgets — or a market\'s split; state: each campaign\'s pause, resume or archive proposal decided now, with its cause and horizon, beside what the brain logged'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (business-overview). map: with productId; alone, or omitted, the products the brain knows there (or in every market); clashes, money and state: required'),
    productId: ID.optional().describe('map / clashes / money / state: one product (a variation names its parent), its Nexus id'),
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
    + 'brain\'s own setup (its server switch, products LIVE one campaign at a time but not enrolled). view money (market, '
    + 'optionally productId; SHADOW — nothing is written): with productId, the product\'s money plan decided now (a dry '
    + 'run, any product) beside the newest plan the shadow logged (it logs only for a product whose budgets lever is '
    + 'OBSERVE or higher) — the month\'s envelope and where it comes from (its own monthly budget in the ads strategy, its '
    + 'playbook\'s daily budget × the days, or its share of the market\'s monthly budget by spend), the pace (projected '
    + 'month-end spend against the envelope; the aim is 90 %), the brake (above 95 % no raises, above 100 % bids step '
    + 'down 10 % a day, above 105 % the stop recipe on the weakest campaigns), the Amazon portfolio-cap plan (115 % of '
    + 'the envelope, the only hard cap; a portfolio holding another product\'s campaigns is "move first"), each '
    + 'campaign\'s budget target (expected spend at the goal bids ÷ 70 %, inside the pace and the day-move bound) against '
    + 'today\'s, and the intraday ladder — each with its why; with market alone, the market\'s split. The portfolio cap '
    + 'amount and everything under a money key are ad-spend money. view state (market, optionally productId; read only — '
    + 'nothing asked or sent): with productId, each of the product\'s campaigns decided now (a dry run, any product) at the '
    + 'level of its state lever — pause for a stop expected to last 3 days or more (out of stock with its restock date or '
    + 'lead time, the month\'s spend cap until the 1st, a playbook STOP, the Owner\'s long stop), resume when every cause '
    + 'has ended (back to its status before; the stop\'s bids, lanes and strategy are given back by its owner), propose to '
    + 'archive a campaign without an impression for weeks (only ever a proposal), or keep it — a short stop stays on low '
    + 'bids; each with its cause, horizon, any hold (a person\'s status change holds 60 days) and why — beside the '
    + 'newest decision the brain logged; the day\'s pause cap (3 a market) used and left; with market alone, the products '
    + 'watched, the brain\'s pauses in force, its requests waiting and what needs a person. '
    + 'Nexus only: it reads what Nexus stored and asks Amazon nothing.',
  handler: async (args) => {
    const a = args as { view?: string; market?: string; productId?: string; campaignId?: string; days?: number }
    const out = a.view === 'clashes' ? await brainClashes(a)
      : a.view === 'setup' ? await brainSetup(a)
        : a.view === 'money' ? await brainMoney(a)
          : a.view === 'state' ? await brainState(a)
            : await brainMap(a)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_BRAIN_TOOLS: AgentTool[] = [adsBrain]
