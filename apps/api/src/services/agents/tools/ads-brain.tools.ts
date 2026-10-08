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
 *   terms    AB-9 — a product's term ledger in shadow (brain/terms-read.ts): one decision per search term or keyword
 *            (targeted, harvest candidate, owned by a sibling, protected, negated, negate candidate, watch) with its why,
 *            the market arbiter's leads on the terms sibling products meet on, the clashes the ledger removes; stored by
 *            the daily shadow, else decided now (a dry run); with market alone, the market's ledgers
 *   negatives AB-10 — a product's negatives (brain/negatives-read.ts): the day decided now — adds (the product's set, waste,
 *            n-gram phrases, isolation, consolidation), retirements of duplicates, revives — each with where, its level
 *            and what became of it (logged, asked, written, refused, rejected); every campaign and ad group against the
 *            negatives limit; the campaigns the brain leaves; the shadow and the cap; the log of 30 days. With market
 *            alone, the market's logs
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { BRAIN_MAP_VIEWS, brainClashes, brainMap, brainSetup, DEFAULT_EVIDENCE_DAYS, MAX_EVIDENCE_DAYS } from '../../advertising/brain/read-map.js'
import { brainMoney } from '../../advertising/brain/budget-read.js'
import { brainTerms, DEFAULT_TERMS_LIMIT, MAX_TERMS_LIMIT } from '../../advertising/brain/terms-read.js'
import { TERM_STATES } from '../../advertising/brain/terms.js'
import { brainNegatives, DEFAULT_NEGATIVES_LIMIT, MAX_NEGATIVES_LIMIT } from '../../advertising/brain/negatives-read.js'
import type { AgentTool, FieldPermission } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)

/**
 * The portfolio cap amount (a setting) and the money an Owner's lock may hold are ad-spend money. AB-7 — the money view
 * puts every amount, percent of spend and sentence naming one under a `money` key: hidden whole without the permission.
 * AB-9 — the terms view puts every amount (spend, sales, CPC, order value, profit per click, bids, the spend gate, the
 * ACoS bound) under `money` keys too. AB-10 — the negatives view puts every amount (spend, sales, the spend gate) under `money`.
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
      .describe('map (default): who owns each lever of each campaign today; clashes: two automatic writers on one campaign\'s lever, and the known gaps; setup: what is not set up or held off, with the fix; money: a product\'s money plan in shadow — envelope, pace, brake, portfolio cap, campaign budgets — or a market\'s split; terms: a product\'s term ledger in shadow — one decision per search term, the market arbiter\'s leads, the clashes it removes — or a market\'s ledgers; negatives: a product\'s negatives — the day\'s adds, retirements and revives with their level and outcome, every campaign and ad group against the limit — or a market\'s logs'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (business-overview). map: with productId; alone, or omitted, the products the brain knows there (or in every market); clashes, money and terms: required'),
    productId: ID.optional().describe('map / clashes / money / terms / negatives: one product (a variation names its parent), its Nexus id'),
    campaignId: ID.optional().describe('map: one Amazon campaign, its Nexus id (ad-campaigns)'),
    days: z.coerce.number().int().min(1).max(MAX_EVIDENCE_DAYS).default(DEFAULT_EVIDENCE_DAYS)
      .describe(`map / clashes: how many days of the action log count as evidence of who wrote (default ${DEFAULT_EVIDENCE_DAYS}, max ${MAX_EVIDENCE_DAYS})`),
    state: z.enum(TERM_STATES).optional().describe('terms: only the terms in this state'),
    limit: z.coerce.number().int().min(1).max(Math.max(MAX_TERMS_LIMIT, MAX_NEGATIVES_LIMIT)).default(DEFAULT_TERMS_LIMIT)
      .describe(`terms: how many terms to list (default ${DEFAULT_TERMS_LIMIT}, max ${MAX_TERMS_LIMIT}); the counts per state cover every term. negatives: how many of each list (default ${DEFAULT_NEGATIVES_LIMIT}, max ${MAX_NEGATIVES_LIMIT})`),
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
    + 'today\'s, and the intraday ladder — each with its why; with market alone, the market\'s split. view terms (market, '
    + 'optionally productId and state; SHADOW — nothing is written): with productId, the product\'s term ledger — one '
    + 'decision per search term its own campaigns saw in 60 settled days and per keyword or ASIN they target or negate: '
    + 'TARGETED (it has an exact home), HARVEST_CANDIDATE (it converts: graduate it to exact, its source negated exact), '
    + 'OWNED_BY_SIBLING (a sibling product leads it in the market), PROTECTED (a protected term, the product\'s brand word or '
    + 'a winner: never negated), NEGATED, NEGATE_CANDIDATE (0 orders after the pooled test — n ≈ 3 ÷ the product\'s pooled '
    + 'conversion rate — and spend past 1.5 target CPAs) or WATCH — each with its why, since when, what holds it (the lever '
    + 'off, the Owner\'s lock, the day\'s cap of 20 negatives and 10 keywords); one state per term, so a term is never '
    + 'harvested and negated at once; the market arbiter\'s leads on the terms sibling products meet on (the Owner\'s pin, '
    + 'else the brand word, else the highest pooled profit per click, then orders; the others never harvest it and bid at '
    + 'most 0.8 × the lead\'s bid); the clashes it removes; harvest candidates with no destination yet. Stored by the daily '
    + 'shadow for an enrolled product whose negatives or harvest lever is OBSERVE or higher, else decided now (a dry run, '
    + 'never stored). With market alone, the products with a ledger there. view negatives (market, optionally productId): '
    + 'with productId, the product\'s negatives for the day decided now (a dry run, stored nowhere — the daily run decides the '
    + 'same way, logs it and acts at each campaign\'s level of the negatives lever: OBSERVE logs, PROPOSE asks a person once a '
    + 'day in one change plan, AUTO writes as the brain through the one negative write service and the retire queue, after '
    + 'the shadow days and only under the live server switch): the adds — the product\'s own negative set from its playbook, '
    + 'waste negatives (0 orders after the pooled test and the spend gate) where the term still served, n-gram phrases (a word '
    + 'that wastes across terms, never one in a term that converts, is targeted, led, protected or the brand), isolation '
    + '(a term with a live exact home negated exact in the product\'s other ad groups; where it converts only once its home '
    + 'converts too) and consolidation near the limit — each with its place (campaign or ad group), match, level, status and '
    + 'why; the retirements of duplicates near the limit; the revives (a negative over the product\'s own keyword, a '
    + 'protected term, a term it now leads, or one that converted where it is blocked; a person\'s negative only on a '
    + 'person\'s yes); every campaign and ad group with its negatives against the warning (800), the maximum (950) and '
    + 'Amazon\'s 1,000; the campaigns the brain leaves (excluded, locked, lever off, not running); the shadow days and the '
    + 'day\'s cap (20 new negatives); the log of 30 days. A product not enrolled is decided as if at the default level. With '
    + 'market alone, the products with a log there. The portfolio cap '
    + 'amount and everything under a money key are ad-spend money. Nexus only: it reads what Nexus stored and asks Amazon nothing.',
  handler: async (args) => {
    const a = args as { view?: string; market?: string; productId?: string; campaignId?: string; days?: number; state?: string; limit?: number }
    const out = a.view === 'clashes' ? await brainClashes(a)
      : a.view === 'setup' ? await brainSetup(a)
        : a.view === 'money' ? await brainMoney(a)
          : a.view === 'terms' ? await brainTerms(a)
            : a.view === 'negatives' ? await brainNegatives(a)
              : await brainMap(a)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_BRAIN_TOOLS: AgentTool[] = [adsBrain]
