/**
 * Ads brain page A1 — ONE place that answers a brain read, for Claude and for the page alike.
 *
 * Claude's `ads-brain` and `bid-brain` tools (agents/tools/ads-brain.tools.ts, ads-bid-brain.tools.ts) and the brain's
 * web routes (routes/advertising-brain.routes.ts) both import from here: the input each view takes (zod, with the words
 * Claude reads), the keys that are ad-spend money (hidden whole from a person without financials.adspend.view), and the
 * dispatch to the view's own read function. So the page and Claude always read the same thing.
 *
 * Read only: nothing here writes, in Nexus or at Amazon. No view takes a clock from its caller: `now` is never an input.
 */
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import { BRAIN_MAP_VIEWS, brainClashes, brainMap, brainSetup, DEFAULT_EVIDENCE_DAYS, MAX_EVIDENCE_DAYS } from './read-map.js'
import { brainMoney } from './budget-read.js'
import { brainTerms, DEFAULT_TERMS_LIMIT, MAX_TERMS_LIMIT } from './terms-read.js'
import { TERM_STATES } from './terms.js'
import { brainNegatives, DEFAULT_NEGATIVES_LIMIT, MAX_NEGATIVES_LIMIT } from './negatives-read.js'
import { brainState } from './state-read.js'
import { brainHours } from './hours-proposal.js'
import { brainHarvest, DEFAULT_HARVEST_LIMIT, MAX_HARVEST_LIMIT } from './harvest-read.js'
import { HARVEST_STATUSES } from './harvest.js'
import { brainReport } from './cycle-read.js'
import { brainBidding } from './bidding-mode-read.js'
import { brainStructure, DEFAULT_STRUCTURE_LIMIT, MAX_STRUCTURE_LIMIT } from './structure-read.js'
import { STRUCTURE_STATUSES } from './structure.js'
import { brainRetire } from './retire-run.js'
import { brainProof } from './proof-read.js'
import { PROOF_WEEKS_DEFAULT, PROOF_WEEKS_MAX, PROOF_WEEKS_MIN } from './proof.js'
import { BRAIN_VIEWS as BID_BRAIN_VIEWS, readBidBrain, type BrainReadArgs } from '../bid-brain/read.js'

export { BRAIN_MAP_VIEWS, BID_BRAIN_VIEWS }

/** A money permission (agents/tool-types.ts FieldPermission, without importing the agents layer). */
type MoneyPermission = (typeof FIELDS)[keyof typeof FIELDS]
type MoneyKeys = Readonly<Record<string, MoneyPermission>>

/** One brain read's answer: the view's data, or a refusal in words. */
export type ViewAnswer = { data: unknown } | { error: string }

const ID = z.string().trim().min(1).max(64)
const PCT = z.coerce.number().min(1).max(500)

// ── ads-brain ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The portfolio cap amount (a setting) and the money an Owner's lock may hold are ad-spend money. AB-7 — the money view
 * puts every amount, percent of spend and sentence naming one under a `money` key: hidden whole without the permission.
 * AB-9 — the terms view puts every amount (spend, sales, CPC, order value, profit per click, bids, the spend gate, the
 * ACoS bound) under `money` keys too. AB-13 — so does the hours view (amounts, ACoS and the sentences naming them). AB-10 — the negatives view puts every amount (spend, sales, the spend gate) under `money`. AB-11 — the harvest view's start bids,
 * candidate money, first budgets and judged ACoS too. AB-17 — the bidding view's stack cents and its tests' figures too.
 */
export const BRAIN_VIEW_MONEY: MoneyKeys = Object.fromEntries(
  ['portfolioCapCents', 'dailyBudgetCents', 'amountCents', 'money'].map((key) => [key, FIELDS.financialsAdspendView]),
)

/** The `ads-brain` input: every view's arguments, with the words Claude reads (the route parses its query with it). */
export const BRAIN_VIEW_INPUT = z.object({
  view: z.enum(BRAIN_MAP_VIEWS).default('map')
    .describe('retire: what retire-ads-writers would switch off for a product once every lever is AUTO or the Owner\'s choice (and what stays, each with why), what is retired now; proof: the A/B proof — each brain product against a matched comparison product, ad profit, ACoS, TACoS and orders with 95 % intervals, or not enough data yet. structure: a product\'s structure proposals — single-keyword campaigns, splits of shared campaigns, the move into its portfolio — decided now beside what the brain stored, with each request and whether a go-live is inside the caps; or a market\'s. map (default): who owns each lever of each campaign today; clashes: two automatic writers on one campaign\'s lever, and the known gaps; setup: what is not set up or held off, with the fix; money: a product\'s money plan in shadow — envelope, pace, brake, portfolio cap, campaign budgets, the off-Amazon lane — or a market\'s split; terms: a product\'s term ledger in shadow — one decision per search term, the market arbiter\'s leads, the clashes it removes — or a market\'s ledgers; state: each campaign\'s pause or resume decided now (it never archives), with its cause and horizon, beside what the brain logged; hours: one product\'s hourly research and painted plan with its approval (market and productId); negatives: a product\'s negatives — the day\'s adds, retirements and revives with their level and outcome, every campaign and ad group against the limit — or a market\'s logs; harvest: a product\'s harvests — destination, sources and their negatives, start bid, the request a person decides, the judgement after the attribution window + 72 h — or a market\'s; report: the day\'s product report the product cycle stored — what each lever did or would do in shadow, ad sales against spend, what waits for the Owner, clashes, his locks — or a market\'s newest reports; bidding: each campaign\'s Amazon bidding strategy decided now (fixed, down only, up and down) with its rule, its switchback test and the approval clock (N4), or a market\'s tests and requests'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional()
    .describe('one Amazon market code (business-overview). map: with productId; alone, or omitted, the products the brain knows there (or in every market); clashes, money, terms, state, hours, negatives, harvest, report, structure, bidding, retire and proof: required'),
  productId: ID.optional().describe('map / clashes / money / terms / state / hours / negatives / harvest / report / structure / bidding / retire / proof: one product (a variation names its parent), its Nexus id'),
  day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('report: the data day (YYYY-MM-DD) of the cycle to read; omitted, the newest'),
  weeks: z.coerce.number().int().min(PROOF_WEEKS_MIN).max(PROOF_WEEKS_MAX).optional().describe(`proof: how many weeks to compare (${PROOF_WEEKS_MIN}–${PROOF_WEEKS_MAX}, default ${PROOF_WEEKS_DEFAULT})`),
  since: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('proof, with productId: the day the brain started acting on the product (YYYY-MM-DD); omitted, the day Nexus recorded (the bid brain took a campaign live, or a lever went to AUTO)'),
  campaignId: ID.optional().describe('map: one Amazon campaign, its Nexus id (ad-campaigns)'),
  days: z.coerce.number().int().min(1).max(MAX_EVIDENCE_DAYS).default(DEFAULT_EVIDENCE_DAYS)
    .describe(`map / clashes: how many days of the action log count as evidence of who wrote (default ${DEFAULT_EVIDENCE_DAYS}, max ${MAX_EVIDENCE_DAYS})`),
  state: z.enum(TERM_STATES).optional().describe('terms: only the terms in this term state (view state takes no filter)'),
  status: z.enum([...new Set([...HARVEST_STATUSES, ...STRUCTURE_STATUSES])] as [string, ...string[]]).optional().describe(`harvest: only the harvests in this status (${HARVEST_STATUSES.join(', ')}); structure: only the proposals in this status (${STRUCTURE_STATUSES.join(', ')})`),
  limit: z.coerce.number().int().min(1).max(Math.max(MAX_TERMS_LIMIT, MAX_NEGATIVES_LIMIT, MAX_HARVEST_LIMIT, MAX_STRUCTURE_LIMIT)).default(DEFAULT_TERMS_LIMIT)
    .describe(`terms: how many terms to list (default ${DEFAULT_TERMS_LIMIT}, max ${MAX_TERMS_LIMIT}); the counts per state cover every term. negatives: how many of each list (default ${DEFAULT_NEGATIVES_LIMIT}, max ${MAX_NEGATIVES_LIMIT}). harvest: how many harvests (default ${DEFAULT_HARVEST_LIMIT}, max ${MAX_HARVEST_LIMIT}). structure: how many stored proposals (default ${DEFAULT_STRUCTURE_LIMIT}, max ${MAX_STRUCTURE_LIMIT})`),
})

/** The arguments one brain view reads (what BRAIN_VIEW_INPUT parses to; a caller may also pass them unparsed). */
export interface BrainViewArgs {
  view?: string
  market?: string
  productId?: string
  campaignId?: string
  days?: number
  state?: string
  status?: string
  limit?: number
  day?: string
  weeks?: number
  since?: string
}

/**
 * One brain view: the view's own read function (map when the view is not named). `opts.now` is the clock of the views that
 * read one (default: each view's own, the database's or the process's); a second parameter, so neither the tool's input
 * nor a route's query can set it — tests pin it.
 */
export async function readBrainView(a: BrainViewArgs, opts: { now?: Date } = {}): Promise<ViewAnswer> {
  const clock = opts.now ? { now: opts.now } : {}
  const at = { ...a, ...clock }
  return a.view === 'clashes' ? brainClashes(a, clock)
    : a.view === 'setup' ? brainSetup(a, clock)
      : a.view === 'money' ? brainMoney(at)
        : a.view === 'terms' ? brainTerms(at)
          : a.view === 'state' ? brainState(at)
            : a.view === 'negatives' ? brainNegatives(at)
              : a.view === 'hours' ? brainHours(a, opts.now)
                : a.view === 'harvest' ? brainHarvest(at)
                  : a.view === 'report' ? brainReport(a)
                    : a.view === 'structure' ? brainStructure(a, opts.now)
                      : a.view === 'bidding' ? brainBidding(at)
                        : a.view === 'retire' ? brainRetire(a)
                          : a.view === 'proof' ? brainProof(a)
                            : brainMap(a, clock)
}

// ── bid-brain ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bids, targets and the why (which names bids and the order value) are ad-spend money. */
export const BID_BRAIN_MONEY: MoneyKeys = Object.fromEntries(
  ['currentCents', 'decidedCents', 'goalBidCents', 'whatIfCents', 'aimPct', 'bandLoPct', 'bandHiPct', 'expectedAcosPct', 'targetAcosPct', 'why',
    // BB-21 — a probe's bids, its days' bids and what each side cost.
    'centerCents', 'highCents', 'lowCents', 'bidCents', 'costCents', 'stoppedWhy']
    .map((key) => [key, FIELDS.financialsAdspendView]),
)

/** The `bid-brain` input: every view's arguments, with the words Claude reads (the route parses its query with it). */
export const BID_BRAIN_VIEW_INPUT = z.object({
  view: z.enum(BID_BRAIN_VIEWS).default('why')
    .describe('why (default): each keyword\'s newest decision and why; what-if: decided again now with targetAcosPct (and a band); diff: per day, the brain against what today\'s writers set, with conflicts and churn; calibration: the attribution lag curve per market (and product) and how well its nowcast predicted the newest settled days; hour-factors: per product, the learned hour factor of each hour of the week against the approved hourly plan\'s, with its confidence and what it would apply inside each cell\'s limits; probes: the switchback probes that measure each keyword\'s bid elasticity ε and ε per product'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional()
    .describe('one Amazon market code (the shadow runs on IT and DE); omit with no campaign, keyword or product for both'),
  campaignId: ID.optional().describe('one Amazon campaign, its Nexus id (ad-campaigns)'),
  targetId: ID.optional().describe('one keyword or target, its Nexus id (ad-targets)'),
  productId: ID.optional().describe('one product (a parent covers its variations), its Nexus id: every keyword of the ad groups advertising it'),
  targetAcosPct: PCT.optional().describe('what-if: the target ACoS to decide with, a percent (20 = 20 %)'),
  bandLoPct: PCT.optional().describe('what-if: the bottom of the ACoS band, a percent (the brain leaves a bid alone inside the band)'),
  bandHiPct: PCT.optional().describe('what-if: the top of the ACoS band, a percent'),
  days: z.coerce.number().int().min(1).max(30).default(7).describe('diff: how many days back (default 7, max 30)'),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('why and what-if: how many keywords, the biggest moves first (default 50, max 200); hour-factors: how many products (at most 20); probes: how many probes, the newest first'),
})

/** One bid-brain view, on the scheduler's settled window (BB-14: primed first, as the runs read it). */
export async function readBidBrainView(args: BrainReadArgs): Promise<ViewAnswer> {
  await (await import('../ads-settled-facts.js')).primeSettledWindow()
  return readBidBrain(args)
}

// ── for the routes ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The HTTP status of a read's refusal: 404 when it names something that is not in this business (a product, a campaign,
 * a keyword — another business's ids read as not found), else 400 (the question was not one the view answers). Pure.
 */
export function readRefusalStatus(error: string): 404 | 400 {
  return /\bnot found\b|^No (product|campaign|keyword or target) \S+ in this business\b/i.test(error) ? 404 : 400
}
