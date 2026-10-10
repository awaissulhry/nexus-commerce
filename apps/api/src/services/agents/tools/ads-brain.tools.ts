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
 *            (a dry run, any product) beside the newest plan the shadow logged; with market alone, the market's split;
 *            AB-18 — the off-Amazon lane (brain/off-amazon.ts): its share of spend, its ACoS against the band top, the
 *            verdict and the line for the Owner (could not verify the setting in the API: never asked or written)
 *   terms    AB-9 — a product's term ledger in shadow (brain/terms-read.ts): one decision per search term or keyword
 *            (targeted, harvest candidate, owned by a sibling, protected, negated, negate candidate, watch) with its why,
 *            the market arbiter's leads on the terms sibling products meet on, the clashes the ledger removes; stored by
 *            the daily shadow, else decided now (a dry run); with market alone, the market's ledgers
 *   state    AB-12 — the state lever (brain/state-read.ts): each campaign of a product decided now (a dry run: pause for a
 *            stop of 3 days or more, resume when it ends, pause a campaign dead for weeks (never archive), keep — each with its
 *            cause, horizon and why) beside the newest decision the brain logged; its pauses in force, requests waiting,
 *            the day's pause cap; with market alone, the market's
 *   hours    AB-13 — one product's hourly research and painted plan (brain/hours-proposal.ts brainHours): the market's
 *            hourly dynamics pooled product → category → market with its confidence, the before / after grid, the
 *            expected effect and the status of its approval; decided now (stored nowhere) when nothing is stored yet
 *   negatives AB-10 — a product's negatives (brain/negatives-read.ts): the day decided now — adds (the product's set, waste,
 *            n-gram phrases, isolation, consolidation), retirements of duplicates, revives — each with where, its level
 *            and what became of it (logged, asked, written, refused, rejected); every campaign and ad group against the
 *            negatives limit; the campaigns the brain leaves; the shadow and the cap; the log of 30 days. With market
 *            alone, the market's logs
 *   harvest  AB-11 — a product's harvests (brain/harvest-read.ts): each harvest candidate's destination and how it was
 *            chosen, its sources and their negatives, its start bid, the request a person decides, the pair's state and
 *            the judgement after the attribution window + 72 h; the caps used; the gaps; with market alone, the market's
 *   report   AB-14 — the day's product report the product cycle stored (brain/cycle-read.ts): what each lever did, or
 *            would do in shadow, and why, in the cycle's order; ad sales against spend; what waits for the Owner; clashes;
 *            what his locks hold; the change set every write of the cycle carries. With market alone, each product's
 *            newest report in one line
 *   structure AB-16 — a product's structure proposals (brain/structure-read.ts): the weekly decision decided now (a dry run)
 *            beside what the brain stored — single-keyword campaigns (orders share, own hour curve, the playbook's winners
 *            view), splits of shared campaigns with their migration plan, the move into the product's portfolio — each with
 *            its builder and request, the owners of the new campaign's levers, the requests a person decides, and whether a
 *            built campaign's go-live is inside the caps (a normal approval, D1 = B); the caps used. With market alone,
 *            the market's
 *   bidding  AB-17 — the bidding-strategy lever (brain/bidding-mode-read.ts): each campaign's Amazon bidding strategy decided
 *            now (fixed, down only, up and down — the rule and its evidence, the stack against the CPC ceiling, what holds
 *            it), beside the newest decision logged; the switchback tests and their verdicts; the N4 clock (until when a
 *            switch asks a person) and the spacing; with market alone, the tests running and the requests waiting
 *   retire   AB-20 — the duplicate writers of a product (brain/retire-run.ts): whether every lever is AUTO or the Owner's own
 *            choice, exactly which rules, budget schedules, pools, dayparting schedules, coverage sets and autopilot plans
 *            retire-ads-writers would switch off and which stay (each with why), what is switched off now and what a
 *            give-back would do with each; with market alone, each enrolled product in one line
 *   proof    AB-20 — the A/B proof (brain/proof-read.ts): each brain product against a matched comparison product without the
 *            brain (same market, category, price band and spend level), difference-in-differences over 4–6 weeks (or before
 *            and after, or a matched level), ad profit, ACoS, TACoS and ad orders with 95 % intervals — or not enough data yet,
 *            and why; the margin it uses and where it comes from
 */
import { FEATURES as F } from '@nexus/shared/permissions'
import { BRAIN_VIEW_INPUT, BRAIN_VIEW_MONEY, readBrainView, type BrainViewArgs } from '../../advertising/brain/read-view.js'
import type { AgentTool } from '../tool-types.js'

const adsBrain: AgentTool = {
  name: 'ads-brain',
  title: 'Ads brain map',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  // The money keys, the input and the dispatch live in advertising/brain/read-view.ts: the brain page's routes read the
  // same views through the same code (ads brain page A1).
  restrictedFields: BRAIN_VIEW_MONEY,
  input: BRAIN_VIEW_INPUT,
  description:
    'Read the ads brain\'s map for Amazon Sponsored Products: one brain per product and market will run every lever (bids, '
    + 'ad group bids, hours, placements, state, budgets, portfolio cap, negatives, harvest, structure, bidding strategy, '
    + 'off-Amazon). view map (default): with productId and market, the product\'s brain — each lever\'s level and what it '
    + 'does (with its source: the brain\'s default, or the Owner\'s product or campaign override, who and when), the '
    + 'settings, the Owner\'s locks (a whole lever with his value, or one thing in it) with who, when and why — set-ads-brain '
    + 'changes them — the campaigns its choice does not reach and the drift — and for each of its campaigns (own and shared) '
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
    + 'today\'s, and the intraday ladder — each with its why; a logged plan also says what the money writer did with it '
    + '(AB-8: at PROPOSE the requests it asked a person for, at AUTO the budgets and caps it wrote, each hold with its '
    + 'reason); and the off-Amazon lane (offAmazon, AB-18): its share of the product\'s spend and its ACoS against the band '
    + 'top over 14 settled days from the placement report, judged at the offAmazon lever\'s level (no report, none reported, '
    + 'no band, too little, in band, above the band, limit suggested — above in both weeks), with a line for the Owner to set '
    + '"Limit off-Amazon spend" in Amazon\'s console on the campaigns named: Nexus could not verify which label Amazon gives '
    + 'off-Amazon placements (none reported is not "no spend") nor an API setting to limit them, so the brain never asks for '
    + 'or writes it; with market alone, the market\'s split and each product\'s off-Amazon share. view terms (market, '
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
    + 'never stored). With market alone, the products with a ledger there. The portfolio cap '
    + 'amount and everything under a money key are ad-spend money. view state (market, optionally productId; read only — '
    + 'nothing asked or sent): with productId, each of the product\'s campaigns decided now (a dry run, any product) at the '
    + 'level of its state lever — pause for a stop expected to last 3 days or more (out of stock with its restock date or '
    + 'lead time, the month\'s spend cap until the 1st, a playbook STOP, the Owner\'s long stop), resume when every cause '
    + 'has ended (back to its status before; the stop\'s bids, lanes and strategy are given back by its owner), propose to '
    + 'pause a campaign without an impression for weeks (never an archive; the brain never switches it on again), or keep it — a short stop stays on low '
    + 'bids; each with its cause, horizon, any hold (a person\'s status change holds 60 days) and why — beside the '
    + 'newest decision the brain logged; the day\'s pause cap (3 a market) used and left; with market alone, the products '
    + 'watched, the brain\'s pauses in force, its requests waiting and what needs a person. view hours (market and '
    + 'productId): the brain\'s research of the market\'s hourly dynamics for that product — traffic, cost per click and '
    + 'conversion by hour of the week, pooled product → category → market with how sure it is, weekday against weekend, '
    + 'the trend, the lanes — and the hourly plan it painted from it: the before / after grid (Monday first, a letter per '
    + 'hour; changed and locked hours marked), each hour that moves, the expected effect with its range, and the status '
    + '(shadow, proposed and waiting for a person as apply-brain-hourly-plan, applied as a new plan version, rejected, '
    + 'expired, held and why); with nothing stored yet, decided now and stored nowhere; its amounts, ACoS and the '
    + 'sentences naming them sit under money keys. '
    + 'view negatives (market, optionally productId): '
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
    + 'market alone, the products with a log there. '
    + 'view harvest (market, optionally productId and '
    + 'status): with productId, the product\'s harvests — for each harvest candidate of its ledger, where it goes (the Owner\'s '
    + 'stored harvest destination, the product\'s playbook exact slot, its exact ad group, or a new campaign through '
    + 'create-ad-campaign that a person approves), the start bid (the bid brain\'s goal bid inside the limits), every source '
    + 'where it ran and the negative exact it gets in the same change set (or why it is left), the level it was decided at '
    + '(OBSERVE logs it, PROPOSE asks a person with apply-brain-harvest, AUTO writes it), the pair\'s state (half done: a '
    + 'source negative the brain sends again), and the judgement after the attribution window + 72 h (worse: an undo is '
    + 'proposed); the caps used today and this week; the gaps. Stored by the daily run, else decided now (a dry run, never '
    + 'stored). With market alone, the products with harvests there. '
    + 'view report (market, optionally productId and day): the day\'s product report the product cycle stored (only while '
    + 'NEXUS_ADS_BRAIN_CYCLE is on; it runs each enrolled product\'s levers in the design\'s order once per new settled data '
    + 'day — stops and state, the term ledger, negatives, harvest, money, bids, hours — and its stops every hour): its status, '
    + 'the change set every write of the cycle carries in its evidence, each step\'s outcome (done, off, skipped, blocked by '
    + 'an earlier step it depends on, failed) with its why, and the report — what each lever did, or would do in shadow, and '
    + 'why; what waits for the Owner (each request with its approval id); clashes (a step in shadow that would hold raises '
    + 'where the bids raised); what his locks and exclusions hold; problems; what the hourly state passes did later; ad '
    + 'sales against spend for the data day, its week and the month\'s pace, under money keys — with the plain-words '
    + 'summary (no amounts) and the earlier days. With market alone, each product\'s newest report in one line. Nothing is '
    + 'decided now: a report exists only for a cycle that ran. '
    + 'view structure (market, optionally productId and status): with productId, the product\'s structure proposals — '
    + 'the weekly decision decided now (a dry run, stored nowhere; a product not enrolled at the default level) beside what '
    + 'the brain stored: a single-keyword campaign for a term that brings at least 15 % of the product\'s ad orders (and 3 '
    + 'orders), has an hour curve of its own, or whose next step in the playbook\'s winners view is a campaign of its own '
    + '(built through the playbook\'s hero or create-ad-campaign, born at the 2-cent floor and off the allowlist; the term '
    + 'keeps running where it runs; a winning term of a playbook product is held, as the playbook keeps a winner where it '
    + 'wins); a split of a campaign several products share into one campaign per product (replicate-ad-structure, with its '
    + 'migration plan for bids, negatives, budgets and history, the shared campaign to low bids once every copy is live); '
    + 'the move of the product\'s own campaigns into its one portfolio (set-campaign-settings) — each with its status '
    + '(shadow, held and why, asked, built, its go-live asked, live, done, declined, failed), its request, who owns each lever '
    + 'of the new campaign, the requests a person decides and their state, and for a built campaign whether its go-live is '
    + 'inside the caps (a normal approval, D1 = B) or not (the approver\'s code); the caps used and left (2 new campaigns a '
    + 'week per product, 6 per market, 20 single-keyword campaigns, shared with the harvest). The structure lever takes OFF, '
    + 'OBSERVE or PROPOSE, never AUTO: the brain never creates, splits or moves a campaign without a person\'s approval. With '
    + 'market alone, the products with proposals there. '
    + 'view bidding (market, optionally productId; read only — nothing asked or sent): with productId, each of the product\'s '
    + 'campaigns decided now (a dry run) at the level of its biddingStrategy lever — which of Amazon\'s strategies it should run: '
    + 'fixed where its hourly plan sets its placement % and the brain writes them, down only by default (new, LAUNCH, thin), '
    + 'up and down only where top of search converts at least 1.3× the campaign\'s average over 30 top-of-search orders and '
    + 'the bid stack with Amazon\'s raise (×2 at the top of search) stays inside the lane CPC ceiling — with the rule, its '
    + 'evidence and what holds it (a stop: the stop recipe owns the strategy; a person\'s own strategy for 60 days; the Owner\'s '
    + 'lock; the bids pin; Amazon\'s own strategy; the kill switch), beside the newest decision logged; the switchback tests '
    + '(each switch runs whole weeks, then the same days after against as many before: kept or switched back) and their '
    + 'verdicts; the spacing (one switch per 14 days); the N4 clock — for 30 days after the lever became the brain\'s every '
    + 'switch asks a person, at AUTO too; with market alone, the tests running and the requests waiting. The stack cents and '
    + 'the tests\' figures sit under money keys. '
    + 'view retire (market, optionally productId): with productId, whether every lever of the product\'s brain is AUTO or the Owner\'s '
    + 'own choice under the live server switch (each lever with why), exactly which configuration rows retire-ads-writers op retire would '
    + 'switch off — an ads rule, budget schedule, budget pool, classic dayparting schedule, coverage set or autopilot plan whose whole reach '
    + 'is the product\'s own campaigns and whose every lever the brain (or the Owner\'s lock) holds there — and which stay on, each with '
    + 'why (it reaches other campaigns, its bid asks are the bid brain\'s inputs, it also notifies, a lever not held, a window still '
    + 'owed), the writers with no row of their own, what is switched off now with what a give-back would do with each, the history '
    + 'and the request that waits; with market alone, each enrolled product in one line. '
    + 'view proof (market, optionally productId, weeks, since): the A/B proof — each brain product (enrolled and acting: the day the '
    + 'bid brain took one of its campaigns live or a lever went to AUTO, or since) against a matched comparison product without the '
    + 'brain (same market, same category, price within ×1.5, ad spend before within ×2, ads running since), difference-in-differences '
    + 'over 4–6 weeks of its own campaigns (before and after when no comparison fits; a matched level when it had no ads before): ad '
    + 'profit (ad sales × its margin − ad spend), ACoS, TACoS and ad orders, each with a 95 % interval and a verdict only with 4 settled '
    + 'weeks and 30 ad orders on each side — else not enough data yet, and why; the margin it uses (Nexus\'s daily true profit, else '
    + 'the cost price against the list price, else none) — amounts under money keys. '
    + 'Nexus only: it reads what Nexus stored and asks Amazon nothing.',
  handler: async (args) => {
    const out = await readBrainView(args as BrainViewArgs)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

export const ADS_BRAIN_TOOLS: AgentTool[] = [adsBrain]
