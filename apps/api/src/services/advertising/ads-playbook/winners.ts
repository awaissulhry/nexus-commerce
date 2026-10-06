/**
 * ADS PLAYBOOK PB-6c — the winners view: which of ONE product's search terms win where they run, which are declining or
 * lost, and the next step for each, in the Owner's order (rule 2: "If we're getting results, we never shuffle them; we
 * keep them. If the results are compromised … adjustments, maybe in the bids or placement percentage … maybe we can
 * create a separate campaign each time to have more control").
 *
 *   windows      SETTLED, as every ads decision reads them (ads-settled-window.ts): the strategy's harvest window ending
 *                at the attribution lag, and "the window before" as long, just before it. Nexus keeps search terms 90
 *                days (ads-reports.service.ts): where the window before reaches past them, the two cannot be compared,
 *                and a term that does not win now is `unproven` — never declining, never given a step
 *   state        winning   it meets the harvest bar in the settled window, its ACoS not over the target
 *                declining it meets the bar with its ACoS over the target, or it met the bar in the window before and
 *                          still sells, under the bar now
 *                lost      it met the bar in the window before and sold nothing in this one
 *                unproven  it met the bar in neither, or the windows cannot be compared (counted, not listed)
 *   next step    first that applies —
 *                closeOldPlace  handover B: the term has its own campaign (a hero) and the hero itself meets the harvest
 *                             bar: its OLD exact keyword goes to low bids — the strategy's stop bid, at least the bid
 *                             tool's lowest (bulk-ad-bid-change): the Owner's temporary stop, undone in about a minute;
 *                             never a negative over his own keyword — a request a person decides; an old
 *                             research place is negated exact by the playbook's isolation rule (its card). Never where an
 *                             hourly plan or a performance slot holds the campaign (reported only), never over a floor
 *                none         a winning term is kept where it is; an unproven one has nothing to keep or repair
 *                none         a floor or a pause holds it (its campaign, its ad group, its keyword — stock, a monthly cap,
 *                             a person's or a playbook's STOP, a phase): named, its owner lifts it; nothing is proposed
 *                             around a floor
 *                bid          auto-bid is on it: it runs for this business (its switch and the server's cron flag:
 *                             liveRunRefusal), the account dial is AUTO, the campaign is on the live-write allowlist and
 *                             held by no one else (a pin, an hourly plan, a goal plan), the keyword that serves it is live,
 *                             its bid set by no person, it spent in auto-bid's own settled window, a target ACoS you set
 *                             reaches it, and its bid is strictly inside the strategy's band
 *                none         an hourly plan holds the campaign, or its slot plays the performance role: the Owner's
 *                             Hourly Bids own its bids and placements — reported only, never a placement or a move
 *                placement    a research slot (Auto, Broad, Phrase) or the term's own campaign, on the allowlist: its
 *                             placement percentages (set-placement-multipliers) — a campaign setting, so the entry says how
 *                             many other terms it touches
 *                ownCampaign  a campaign of its own (apply-ads-playbook op hero, hero.ts): one exact keyword, born at the
 *                             2¢ floor and off the allowlist, waiting for a person; the term keeps running where it is
 *                             until that campaign proves itself (handover B)
 *
 * No number of its own. The bar is the ads strategy's harvest group for the term's ad group (the rules' fallbacks where
 * the strategy sets none, as the harvest's), the target the one auto-bid steers by (the campaign's own, the strategy's,
 * the account default: configuredTargetAcos), the band the strategy's. Two strategies give two answers.
 *
 * Scope (the Owner's rule 3): only this product's own campaigns — its playbook's slot links in the market (its heroes
 * too), each ad group advertising nothing but this product family (familyOnly; the rest named). Another product buying
 * the same term is never read here. Reads only, through the business-scoped client.
 */
import prisma from '../../../db.js'
import { ACTION_WINDOW, HARVEST_DEFAULTS } from '@nexus/shared/ads-rule-window'
import { meetsHarvest } from '../ads-harvest.service.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { SEARCH_TERM_DAYS_KEPT, settledBounds, settledEndText, settledWhere } from '../ads-settled-window.js'
import { strategyBidReader } from '../ads-strategy/bids.js'
import { openTermsStrategy, sourceLabel, strategyMarketOf, termsForAdGroups, type StrategyTerms } from '../ads-strategy/terms.js'
import { configuredTargetAcos, readOwnerTargets } from '../ads-target-acos-resolver.js'
import { familyOfProducts, familyOnly, homeOf, positivesIn } from '../ads-winner-lock.js'
import { loadProductPlaybook } from './build-preview.js'
import type { Slot } from './doc.js'
import { HERO_PREFIX, heroRefusal, isHeroKey } from './hero.js'

export type WinnerState = 'winning' | 'declining' | 'lost' | 'unproven'
export type WinnerStep = 'closeOldPlace' | 'bid' | 'placement' | 'ownCampaign' | 'none'

/** A term's search-term totals in one ad group over one settled window. */
export interface TermResults { orders: number; clicks: number; costCents: number; salesCents: number }
/** The harvest bar a term is judged on (the strategy's harvest group, or the rules' fallbacks). */
export interface WinnerBar { minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number }

const acosOf = (r: TermResults | null) => (r && r.salesCents > 0 ? Math.round((r.costCents / r.salesCents) * 1000) / 10 : null)
const meets = (r: TermResults | null, bar: WinnerBar) => !!r && r.orders > 0 && meetsHarvest(r, bar)

/**
 * Pure — a term's state where it runs: winning, declining, lost or unproven, judged on the bar and the target given (no
 * number of its own), with the sentence that says why. `comparable` false: the window before cannot be read (it reaches
 * past the search terms Nexus keeps), so a term that does not win now is unproven.
 */
export function classifyWinner(input: { current: TermResults | null; previous: TermResults | null; comparable?: boolean; bar: WinnerBar; targetAcosPct: number | null }): { state: WinnerState; why: string } {
  const { current, previous, bar, targetAcosPct } = input
  const days = `${bar.windowDays} days`
  const acos = acosOf(current)
  const over = targetAcosPct != null && acos != null && acos > targetAcosPct
  if (meets(current, bar) && !over) return { state: 'winning', why: `it meets the harvest bar where it runs, over the settled ${days}` }
  if (input.comparable === false) {
    return { state: 'unproven', why: `cannot compare: the ${days} before reach past the ${SEARCH_TERM_DAYS_KEPT} days of search terms Nexus keeps, so it is not judged declining and nothing is proposed` }
  }
  if (meets(current, bar)) return { state: 'declining', why: `it meets the harvest bar over the settled ${days}, but its ACoS is over the target` }
  if (meets(previous, bar)) {
    return current && current.orders > 0
      ? { state: 'declining', why: `it met the harvest bar in the ${days} before and sells less now: under the bar over the settled ${days}` }
      : { state: 'lost', why: `it met the harvest bar in the ${days} before and sold nothing over the settled ${days}` }
  }
  return { state: 'unproven', why: `it met the harvest bar in neither window of ${days}` }
}

/** What the next step of one term is judged on (winnerReview reads them). */
export interface LadderFacts {
  state: WinnerState
  /** Auto-bid for this business now: it runs (its switch, the server's cron flag) and the account dial is AUTO. */
  autoBid: { on: boolean; why: string }
  /** A floor or a pause on the term's campaign, ad group or keyword, naming who set it; null when none. */
  held: string | null
  campaign: {
    liveWrites: boolean
    holder: 'pinned' | 'hourlyPlan' | 'goalPlan' | null
    /** Its slot plays the performance rank role. */
    performance: boolean
    /** Its slot is a research one: Auto, Broad, Phrase. */
    research: boolean
    /** It is a term's own campaign (a hero). */
    hero: boolean
  }
  /**
   * The keyword or target that serves the term; null when Nexus cannot tell. `exact`: it is the term's own exact keyword
   * here. `spent`: it spent in auto-bid's own settled window (what auto-bid moves a bid on).
   */
  servedBy: { bidCents: number; live: boolean; personSet: boolean; spent: boolean; exact: boolean } | null
  /** The target ACoS auto-bid steers by (a number someone set); null when none is set. */
  targetAcosPct: number | null
  band: { minBidCents: number | null; maxBidCents: number | null }
  /** The term's own campaign, when it has one (proven: its exact keyword meets the harvest bar there); else why it cannot have one (null: it can). */
  hero: { exists: { key: string; campaignName: string; proven: boolean } | null; refusal: string | null }
}

export interface LadderRung { step: Exclude<WinnerStep, 'none' | 'closeOldPlace'>; open: boolean; why: string }

const HOLDER_WORDS: Record<NonNullable<LadderFacts['campaign']['holder']>, string> = {
  pinned: 'a pin holds its bids', hourlyPlan: 'an hourly plan holds its bids', goalPlan: 'a goal plan holds its bids',
}
const RANK_HELD = "an hourly plan holds its campaign, or its slot plays the performance role: the Owner's Hourly Bids own its bids and placements — reported only"

/** Why auto-bid is not on this term's bid, or null when it is. */
function bidBlocker(f: LadderFacts): string | null {
  if (!f.autoBid.on) return f.autoBid.why
  if (!f.campaign.liveWrites) return 'its campaign is off the live-write allowlist: no engine writes to it'
  if (f.campaign.holder) return HOLDER_WORDS[f.campaign.holder]
  if (!f.servedBy) return 'Nexus cannot tell which keyword or target serves it'
  if (!f.servedBy.live) return 'the keyword that serves it is not live at Amazon'
  if (f.servedBy.personSet) return 'a person set its bid in the last 60 days: auto-bid leaves it'
  if (!f.servedBy.spent) return "it spent nothing in auto-bid's own settled window: auto-bid has nothing to move its bid on"
  if (f.targetAcosPct == null) return 'no target ACoS you set reaches it (the campaign, the ads strategy or the account default)'
  const { minBidCents: min, maxBidCents: max } = f.band
  if (min != null && f.servedBy.bidCents <= min) return "its bid is at the strategy's lowest bid: auto-bid cannot lower it"
  if (max != null && f.servedBy.bidCents >= max) return "its bid is at the strategy's highest bid: auto-bid cannot raise it"
  return null
}

/**
 * Pure — the next step for one term, first that applies (the Owner's order: bid, then placement, then a campaign of its
 * own; a proven hero's old place first), with every rung and why it is open or closed.
 */
export function winnerLadder(f: LadderFacts): { nextStep: WinnerStep; why: string; ladder: LadderRung[] } {
  const own = f.hero.exists
  const rankHeld = f.campaign.holder === 'hourlyPlan' || f.campaign.performance
  if (own && !f.campaign.hero && own.proven) {
    const proven = `its own campaign ("${own.campaignName}") meets the harvest bar`
    if (rankHeld) return { nextStep: 'none', why: `hero proven (${proven}), but ${RANK_HELD}`, ladder: [] }
    if (f.held) return { nextStep: 'none', why: `hero proven (${proven}); this old place is held already — ${f.held}`, ladder: [] }
    return f.servedBy?.exact
      ? { nextStep: 'closeOldPlace', why: `hero proven → old keyword to the floor: ${proven}, so its exact keyword here goes to low bids (the Owner's temporary stop, undone in about a minute; never a negative) — a request a person decides`, ladder: [] }
      : { nextStep: 'closeOldPlace', why: `hero proven → old place to be closed: ${proven}, so the playbook's isolation rule negates it exact here (its card: a person decides)`, ladder: [] }
  }
  if (f.state === 'winning') {
    return { nextStep: 'none', why: own && !f.campaign.hero ? `winning where it runs: it stays there, and its own campaign ("${own.campaignName}") runs too until that campaign meets the harvest bar` : 'winning where it runs: it stays there — no bid, placement or move is proposed', ladder: [] }
  }
  if (f.state === 'unproven') return { nextStep: 'none', why: 'it has not proven itself here: nothing to keep or repair', ladder: [] }
  if (f.held) return { nextStep: 'none', why: `${f.held}: the one who set it lifts it — no bid, placement or campaign of its own is proposed around a floor or a pause`, ladder: [] }
  const ladder: LadderRung[] = []
  const blocked = bidBlocker(f)
  ladder.push(blocked
    ? { step: 'bid', open: false, why: blocked }
    : { step: 'bid', open: true, why: 'auto-bid already moves its bid toward the target every run, inside the band: let it work' })
  ladder.push(rankHeld ? { step: 'placement', open: false, why: RANK_HELD }
    : !f.campaign.liveWrites ? { step: 'placement', open: false, why: 'its campaign is off the live-write allowlist: a placement is refused there' }
      : !(f.campaign.research || f.campaign.hero) ? { step: 'placement', open: false, why: 'placements move only on a research slot (Auto, Broad, Phrase) or the term\'s own campaign: here they would move every term of the campaign' }
        : { step: 'placement', open: true, why: 'its campaign\'s placement percentages (set-placement-multipliers): a campaign setting, so every term of the campaign moves with it' })
  ladder.push(rankHeld ? { step: 'ownCampaign', open: false, why: RANK_HELD }
    : f.campaign.hero ? { step: 'ownCampaign', open: false, why: 'it is the term\'s own campaign already' }
      : own ? { step: 'ownCampaign', open: false, why: `it has its own campaign already ("${own.campaignName}"): it runs there too` }
        : f.hero.refusal ? { step: 'ownCampaign', open: false, why: f.hero.refusal }
          : { step: 'ownCampaign', open: true, why: 'a campaign of its own (apply-ads-playbook op hero): one exact keyword, born at the 2-cent floor and off the allowlist, waiting for a person; the term keeps running here until it proves itself' })
  const first = ladder.find((r) => r.open)
  if (first) return { nextStep: first.step, why: first.why, ladder }
  return { nextStep: 'none', why: rankHeld ? RANK_HELD : 'no step applies now (each rung says why)', ladder }
}

// ── The review (DB) ───────────────────────────────────────────────────────────────────────────────

/** A term's results as the view lists them: spend under the ad-spend money key. */
export interface TermLine { orders: number; clicks: number; spendCents: number; salesCents: number; acosPct: number | null }

export interface WinnerEntry {
  term: string
  slot: string
  hero?: true
  campaignId: string
  campaignName: string
  adGroupId: string
  /** The keyword or target that serves the term, as Amazon's search-term rows name it (an exact home first). */
  servedBy: { adTargetId: string; text: string; match: string; bidCents: number } | null
  state: WinnerState
  why: string
  bar: { minOrders: number; minClicks: number; harvestMaxAcosPct: number | null; windowDays: number; source: string }
  target: { targetAcosPct: number; source: string } | null
  /** The settled window, and the one before it (null: no results there, or it cannot be compared). */
  current: TermLine | null
  previous: TermLine | null
  /** A floor or a pause that holds it, naming who set it. */
  held?: string
  nextStep: WinnerStep
  nextWhy: string
  ladder: LadderRung[]
  /** placement: the campaign and how many other terms with clicks a change there moves too. */
  placement?: { campaignId: string; otherTerms: number; tool: 'set-placement-multipliers' }
  /** ownCampaign: the request that asks for it. */
  ownCampaign?: { tool: 'apply-ads-playbook'; args: { op: 'hero'; market: string; productId: string; term: string } }
  /** The term's own campaign, when it has one (proven: it meets the harvest bar there). */
  heroOf?: { key: string; campaignId: string; campaignName: string; proven: boolean }
  /**
   * closeOldPlace: how the old place closes — its exact keyword to the floor (the request that asks for it: one bid, a
   * person decides; undo puts the bid back), or the isolation rule's negative exact in a research slot (its card).
   */
  closeOldPlace?: {
    how: 'floor' | 'isolation'
    by: string
    request: { tool: 'bulk-ad-bid-change'; args: { bids: Array<{ targetId: string; bidCents: number }>; why: string } } | null
  }
}

export interface WinnerReview {
  market: string
  product: { productId: string; sku: string }
  playbook: { id: string; version: number; state: string | null } | null
  scope: { adGroups: number; excluded: Array<{ slot: string; campaignId: string; adGroupId: string | null; why: string }> }
  autoBid: { on: boolean; why: string }
  counts: Record<WinnerState, number>
  /** Declining and lost first, then winning (the terms asked for: unproven ones too). */
  entries: WinnerEntry[]
  listed: number
  warnings: string[]
}

const MAX_LISTED = 100
/** A term's key in one ad group (Amazon's ad-group id and the normalised term). */
const SEP = '\u0000'
const termKey = (externalAdGroupId: string, query: string) => `${externalAdGroupId}${SEP}${normaliseNegTerm(query)}`
const ORDER: Record<WinnerState, number> = { lost: 0, declining: 1, winning: 2, unproven: 3 }
const lineOf = (r: TermResults | null): TermLine | null => (r ? { orders: r.orders, clicks: r.clicks, spendCents: r.costCents, salesCents: r.salesCents, acosPct: acosOf(r) } : null)
const add = (a: TermResults | undefined, b: TermResults): TermResults => ({ orders: (a?.orders ?? 0) + b.orders, clicks: (a?.clicks ?? 0) + b.clicks, costCents: (a?.costCents ?? 0) + b.costCents, salesCents: (a?.salesCents ?? 0) + b.salesCents })

/**
 * Every term × ad group over ONE settled window (ads-settled-window.ts: `windowDays` days ending at the attribution lag,
 * `offsetDays` further back), summed by normalised term — the days every ads decision may read.
 */
async function settledTermTotals(windowDays: number, adGroupExternalIds: readonly string[], offsetDays = 0): Promise<Map<string, TermResults>> {
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'adGroupId'],
    where: { adGroupId: { in: [...adGroupExternalIds] }, ...settledWhere(windowDays, { offsetDays }) },
    _sum: { clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const out = new Map<string, TermResults>()
  for (const r of rows) {
    const key = termKey(r.adGroupId, r.query)
    out.set(key, add(out.get(key), { orders: r._sum.orders7d ?? 0, clicks: r._sum.clicks ?? 0, costCents: Math.round(Number(r._sum.costMicros ?? 0n) / 10_000), salesCents: r._sum.sales7dCents ?? 0 }))
  }
  return out
}

/** Can the window before (as long, just before the settled one) be read: does it end inside the search terms Nexus keeps? */
function comparableWindow(windowDays: number, now = new Date()): boolean {
  const kept = new Date(now)
  kept.setUTCDate(kept.getUTCDate() - SEARCH_TERM_DAYS_KEPT)
  kept.setUTCHours(0, 0, 0, 0)
  return settledBounds(windowDays, 'SPONSORED_PRODUCTS', { now, offsetDays: windowDays }).since.getTime() >= kept.getTime()
}

/**
 * Auto-bid for this business now: it runs (its switch and the server's cron flag, as its own live run asks:
 * liveRunRefusal) and the account dial is AUTO. Never throws.
 */
async function autoBidNow(): Promise<{ on: boolean; why: string }> {
  try {
    const { liveRunRefusal } = await import('../ads-engine-lock.js')
    const { readEnginePosture } = await import('../ads-engine-guard.js')
    const refusal = await liveRunRefusal('auto-bid')
    if (refusal) return { on: false, why: `auto-bid does not run: ${refusal}` }
    const posture = await readEnginePosture()
    if (posture.posture !== 'auto') return { on: false, why: `auto-bid writes no bid now: ${posture.why}` }
    return { on: true, why: 'auto-bid runs for this business and the account dial is AUTO' }
  } catch (e) {
    return { on: false, why: `whether auto-bid runs could not be read: ${(e as Error).message.slice(0, 120)}` }
  }
}

/**
 * The targets that spent in auto-bid's own settled window, as auto-bid reads them (ads-bid-optimizer.service.ts: the
 * daily performance rows when its source is `daily`, else the target's own columns): a target that spent nothing there
 * is one auto-bid has nothing to move on.
 */
async function spentForAutoBid(targetIds: readonly string[]): Promise<Set<string>> {
  if (!targetIds.length) return new Set()
  const { resolveSource } = await import('../ads-bid-optimizer.service.js')
  if (resolveSource() === 'daily') {
    const rows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', localEntityId: { in: [...targetIds] }, ...settledWhere(ACTION_WINDOW.bid_to_target_acos.days as number) },
      _sum: { costMicros: true },
    })
    return new Set(rows.filter((r) => Number(r._sum.costMicros ?? 0) > 0 && r.localEntityId).map((r) => r.localEntityId!))
  }
  const rows = await prisma.adTarget.findMany({ where: { id: { in: [...targetIds] }, spendCents: { gt: 0 } }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

/** A floor or a pause, in words, naming who set it. */
const floorBy = (by: string | null | undefined) => (by?.trim() ? by : 'an actor Nexus did not record')

/**
 * ONE product's winners in ONE market (the view `winners`): every search term of its playbook campaigns, judged where
 * it runs, with its next step. `terms`: only these terms, unproven ones listed too (the hero's preview reads where its
 * term runs now).
 */
export async function winnerReview(args: { market: string; productId?: string; sku?: string; terms?: readonly string[] }): Promise<{ data: WinnerReview } | { status: 400 | 404; error: string }> {
  const loaded = await loadProductPlaybook({ market: args.market, productId: args.productId, sku: args.sku })
  if ('error' in loaded) return loaded
  const { market, product, resolved, row, links } = loaded
  const counts: Record<WinnerState, number> = { winning: 0, declining: 0, lost: 0, unproven: 0 }
  const base: WinnerReview = {
    market, product: { productId: product.id, sku: product.sku },
    playbook: row ? { id: row.id, version: row.version, state: row.state } : null,
    scope: { adGroups: 0, excluded: [] }, autoBid: { on: false, why: 'not read' }, counts, entries: [], listed: 0, warnings: [],
  }
  if (!row) return { status: 400, error: `${product.sku} has no product playbook row in ${market}: it has no playbook campaigns to read.` }
  if (!links.length) return { data: { ...base, warnings: [`The playbook holds no campaign for ${product.sku} in ${market} yet (build or adopt its slots first).`] } }
  const doc = resolved.doc
  const warnings: string[] = []
  if (!doc) warnings.push(`The playbook does not compile (${resolved.problems.join('; ') || 'no template'}): slot roles are unknown, so no placement or campaign of its own is proposed`)
  const slotOf = new Map<string, Slot>((doc?.structure.slots ?? []).map((s) => [s.key, s]))
  const asked = args.terms?.length ? new Set(args.terms.map(normaliseNegTerm)) : null

  // Scope: the slot links' campaigns in this market, their ad groups, this product family's only.
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: links.map((l) => l.refId) } },
    select: {
      id: true, name: true, status: true, marketplace: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true,
      adGroups: { select: { id: true, name: true, status: true, externalAdGroupId: true, bidsSuppressedAt: true, bidsSuppressedBy: true } },
    },
  })
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const want = strategyMarketOf(market)
  type Group = { adGroupId: string; ext: string | null; campaignId: string; slot: string; marketplace: string | null; status: string; floorBy: string | null; floored: boolean }
  const excluded: WinnerReview['scope']['excluded'] = []
  const candidates: Group[] = []
  for (const l of links) {
    const c = byId.get(l.refId)
    if (!c) continue
    if (strategyMarketOf(c.marketplace) !== want) { excluded.push({ slot: l.key, campaignId: c.id, adGroupId: l.adGroupId, why: `its campaign runs in ${c.marketplace ?? 'no market'}, not ${market}` }); continue }
    for (const g of c.adGroups) {
      if (String(g.status) === 'ARCHIVED' || (l.adGroupId && g.id !== l.adGroupId)) continue
      candidates.push({ adGroupId: g.id, ext: g.externalAdGroupId, campaignId: c.id, slot: l.key, marketplace: c.marketplace, status: String(g.status), floored: !!g.bidsSuppressedAt, floorBy: g.bidsSuppressedBy })
    }
  }
  const owned = await familyOnly(candidates.map((g) => g.adGroupId), await familyOfProducts([product.id]))
  for (const e of owned.excluded) {
    const g = candidates.find((x) => x.adGroupId === e.adGroupId)!
    excluded.push({ slot: g.slot, campaignId: g.campaignId, adGroupId: g.adGroupId, why: e.why })
  }
  const ok = new Set(owned.ok)
  const scope = candidates.filter((g) => ok.has(g.adGroupId))
  const placed = scope.filter((g): g is Group & { ext: string } => !!g.ext)
  const autoBid = await autoBidNow()
  const out: WinnerReview = { ...base, scope: { adGroups: scope.length, excluded }, autoBid, warnings }
  if (!placed.length) { warnings.push('None of the playbook\'s ad groups is at Amazon yet: there are no search terms to read'); return { data: out } }

  // The bar per ad group: the strategy's harvest group, else the harvest rules' fallbacks (the harvest's own).
  const strategy = await openTermsStrategy()
  const groupTerms = strategy ? await termsForAdGroups(strategy, placed.map((g) => ({ market: g.marketplace, externalAdGroupId: g.ext }))) : new Map<string, StrategyTerms>()
  const fallback: WinnerBar = { minOrders: HARVEST_DEFAULTS.minOrders, minClicks: 0, maxAcosPct: null, windowDays: HARVEST_DEFAULTS.windowDays }
  const barOf = new Map(placed.map((g) => {
    const h = groupTerms.get(`${strategyMarketOf(g.marketplace)}|${g.ext}`)?.harvest
    return [g.adGroupId, h ? { bar: h.group as WinnerBar, source: `the ads strategy: ${sourceLabel(h.source)}` } : { bar: fallback, source: 'the harvest rules\' defaults (the ads strategy sets no harvest group here)' }] as const
  }))

  // The totals: the settled window and the one before it (as long), per ad group and term — when it can be read.
  const current = new Map<string, TermResults>()
  const previous = new Map<string, TermResults>()
  const byWindow = new Map<number, string[]>()
  for (const g of placed) { const w = barOf.get(g.adGroupId)!.bar.windowDays; byWindow.set(w, [...(byWindow.get(w) ?? []), g.ext]) }
  const comparable = new Map([...byWindow.keys()].map((w) => [w, comparableWindow(w)]))
  for (const [w, exts] of byWindow) {
    for (const [k, r] of await settledTermTotals(w, exts)) current.set(k, r)
    if (comparable.get(w)) for (const [k, r] of await settledTermTotals(w, exts, w)) previous.set(k, r)
  }
  const blind = [...comparable.entries()].filter(([, c]) => !c).map(([w]) => w)
  if (blind.length) warnings.push(`A harvest window of ${blind.join(' / ')} days ${settledEndText()} and the window before it reach past the ${SEARCH_TERM_DAYS_KEPT} days of search terms Nexus keeps: those terms are judged on the settled window alone, and one that does not win now is unproven — nothing is proposed for it`)

  // Which keyword or target served each term (Amazon's search-term rows name it), the exact home first.
  const widest = Math.max(...byWindow.keys())
  const matched = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'adGroupId', 'matchedKeywordId', 'matchedTargetId'],
    where: { adGroupId: { in: placed.map((g) => g.ext) }, ...settledWhere(widest * 2) },
    _sum: { clicks: true, impressions: true },
  })
  const bestMatch = new Map<string, { id: string; clicks: number }>()
  for (const m of matched) {
    const id = m.matchedKeywordId ?? m.matchedTargetId
    if (!id) continue
    const key = termKey(m.adGroupId, m.query)
    const clicks = (m._sum.clicks ?? 0) * 1_000_000 + (m._sum.impressions ?? 0)
    if (!bestMatch.has(key) || bestMatch.get(key)!.clicks < clicks) bestMatch.set(key, { id, clicks })
  }
  const ids = placed.map((g) => g.adGroupId)
  const [positives, matchedTargets] = await Promise.all([
    positivesIn(ids),
    bestMatch.size ? prisma.adTarget.findMany({ where: { adGroupId: { in: ids }, externalTargetId: { in: [...new Set([...bestMatch.values()].map((m) => m.id))] } }, select: { id: true, adGroupId: true, externalTargetId: true } }) : Promise.resolve([]),
  ])
  const targetByExt = new Map(matchedTargets.map((t) => [`${t.adGroupId}|${t.externalTargetId}`, t.id]))

  // The owners and the numbers auto-bid reads: who holds each campaign, the bids a person set, the targets, the band.
  const campaignIds = [...new Set(placed.map((g) => g.campaignId))]
  const { autoBidHolders } = await import('../ads-auto-bid.service.js')
  const { personBidTargetIds } = await import('../bid-grid.service.js')
  const personTargets = await personBidTargetIds()
  const [holders, owner, strat] = await Promise.all([
    autoBidHolders(campaignIds, personTargets),
    readOwnerTargets(campaignIds),
    strategyBidReader().forAdGroups(placed.map((g) => ({ adGroupId: g.adGroupId, marketplace: g.marketplace }))),
  ])
  const strategyByAdGroup = new Map([...strat].filter(([, v]) => v.target).map(([k, v]) => [k, v.target!]))

  // One entry per ad group and term.
  type Pending = { g: Group & { ext: string }; term: string; key: string }
  const groupOfExt = new Map(placed.map((g) => [g.ext, g]))
  const pending: Pending[] = []
  for (const key of new Set([...current.keys(), ...previous.keys()])) {
    const [ext, term] = key.split(SEP)
    const g = groupOfExt.get(ext)
    if (!g || (asked && !asked.has(term))) continue
    pending.push({ g, term, key })
  }
  const servingIds = new Set<string>()
  const servingOf = new Map<string, string>()
  for (const p of pending) {
    const home = isHeroKey(p.g.slot) || slotOf.get(p.g.slot)?.match === 'EXACT' ? homeOf(p.term, positives.get(p.g.adGroupId) ?? []) : null
    const match = bestMatch.get(p.key)
    const id = home?.adTargetId ?? (match ? targetByExt.get(`${p.g.adGroupId}|${match.id}`) : undefined)
    if (id) { servingIds.add(id); servingOf.set(`${p.g.adGroupId}|${p.key}`, id) }
  }
  const [serving, spent] = await Promise.all([
    servingIds.size
      ? prisma.adTarget.findMany({ where: { id: { in: [...servingIds] } }, select: { id: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, status: true, externalTargetId: true, suppressedFromBidCents: true } }).then((rows) => new Map(rows.map((t) => [t.id, t])))
      : Promise.resolve(new Map<string, never>()),
    spentForAutoBid([...servingIds]),
  ])
  // The low bid an old exact keyword is proposed at: the strategy's stop bid for its campaign, at least the lowest bid the
  // bid tool sets (loaded when asked: a tool module).
  const { BULK_FLOOR_CENTS } = await import('../../agents/tools/ads-change.tools.js')
  const { stopBidsFor } = await import('../ads-strategy/effective.js')
  const stops = await stopBidsFor(campaignIds.map((id) => ({ id, marketplace: byId.get(id)?.marketplace ?? null })))
  const lowBidOf = (campaignId: string) => Math.max(BULK_FLOOR_CENTS, stops.get(campaignId)?.cents ?? 0)
  // Terms with clicks per campaign (what a placement change there moves too).
  const clicked = new Map<string, Set<string>>()
  for (const [key, r] of current) {
    const [ext, term] = key.split(SEP)
    const g = groupOfExt.get(ext)
    if (g && r.clicks > 0) clicked.set(g.campaignId, (clicked.get(g.campaignId) ?? new Set()).add(term))
  }

  // The term's own campaigns (heroes), by term: proven once their live exact keyword meets the harvest bar there, on
  // the same settled window and bar as every entry here. One still at the build's floor (its campaign or its keyword
  // waiting for START) is no home yet, as a keyword a sync added at the floor is none (PB-10, isolation.ts).
  const heroLinks = links.filter((l) => isHeroKey(l.key))
  const heroHomes = heroLinks.map((l) => {
    const g = placed.find((x) => x.slot === l.key)
    const home = g ? homeOf(l.key.slice(HERO_PREFIX.length), positives.get(g.adGroupId) ?? []) : null
    return { l, g, home: home && home.adGroupId === g?.adGroupId && home.live ? home : null }
  })
  const heroFloored = new Set((heroHomes.some((h) => h.home)
    ? await prisma.adTarget.findMany({ where: { id: { in: heroHomes.flatMap((h) => (h.home ? [h.home.adTargetId] : [])) }, suppressedFromBidCents: { not: null } }, select: { id: true } })
    : []).map((t) => t.id))
  const heroes = new Map(heroHomes.map(({ l, g, home }) => {
    const term = l.key.slice(HERO_PREFIX.length)
    const c = byId.get(l.refId)
    const waiting = !!c?.bidsSuppressedAt || (!!home && heroFloored.has(home.adTargetId))
    const proven = !!g && !!home && !waiting && meets(current.get(termKey(g.ext, term)) ?? null, barOf.get(g.adGroupId)!.bar)
    return [term, { key: l.key, campaignId: l.refId, campaignName: c?.name ?? '?', proven }]
  }))

  const entries: WinnerEntry[] = []
  for (const p of pending) {
    const { bar, source } = barOf.get(p.g.adGroupId)!
    const cur = current.get(p.key) ?? null
    const prev = previous.get(p.key) ?? null
    const c = byId.get(p.g.campaignId)!
    const resolvedTarget = configuredTargetAcos({ adGroupId: p.g.adGroupId, campaignTargetAcos: owner.byCampaign.get(p.g.campaignId) }, { explicitTargetAcos: undefined, accountDefaultPct: owner.accountDefaultPct, strategyByAdGroup })
    const targetAcosPct = resolvedTarget ? Math.round(resolvedTarget.targetAcos * 1000) / 10 : null
    const { state, why } = classifyWinner({ current: cur, previous: prev, comparable: comparable.get(bar.windowDays) ?? false, bar, targetAcosPct })
    counts[state]++
    if (state === 'unproven' && !asked) continue
    const servedId = servingOf.get(`${p.g.adGroupId}|${p.key}`)
    const t = servedId ? serving.get(servedId) : undefined
    const slot = slotOf.get(p.g.slot)
    const hero = isHeroKey(p.g.slot)
    const heroOf = heroes.get(p.term)
    const band = strat.get(p.g.adGroupId)?.limits
    // A floor or a pause on the campaign, the ad group or the keyword: named, and nothing is proposed around it.
    const held = String(c.status) === 'PAUSED' ? 'its campaign is paused'
      : c.bidsSuppressedAt ? `its campaign is at a floor set by ${floorBy(c.bidsSuppressedBy)}`
        : p.g.status === 'PAUSED' ? 'its ad group is paused'
          : p.g.floored ? `its ad group is at its own floor, set by ${floorBy(p.g.floorBy)} (stock, or a product's monthly cap)`
            : t && String(t.status) === 'PAUSED' ? 'the keyword that serves it is paused'
              : t && t.suppressedFromBidCents != null ? 'the keyword that serves it is at a floor (its bid remembered)'
                : null
    const exact = !!t && String(t.kind) === 'KEYWORD' && String(t.expressionType) === 'EXACT' && normaliseNegTerm(t.expressionValue) === p.term
    const step = winnerLadder({
      state,
      autoBid,
      held,
      campaign: {
        liveWrites: c.liveBidWritesEnabled, holder: holders.get(c.id) ?? null,
        performance: slot?.rankRole === 'performance',
        research: !!slot && (slot.targeting === 'AUTO' || (slot.targeting === 'KEYWORD' && slot.match !== 'EXACT')),
        hero,
      },
      servedBy: t ? { bidCents: t.bidCents, live: String(t.status) === 'ENABLED' && !!t.externalTargetId, personSet: personTargets.has(t.id), spent: spent.has(t.id), exact } : null,
      targetAcosPct,
      band: { minBidCents: band?.minBidCents?.value ?? null, maxBidCents: band?.maxBidCents?.value ?? null },
      hero: {
        exists: heroOf && heroOf.key !== p.g.slot ? { key: heroOf.key, campaignName: heroOf.campaignName, proven: heroOf.proven } : null,
        refusal: heroRefusal(p.term, doc, new Set()),
      },
    })
    entries.push({
      term: p.term, slot: p.g.slot, ...(hero ? { hero: true as const } : {}), campaignId: c.id, campaignName: c.name, adGroupId: p.g.adGroupId,
      servedBy: t ? { adTargetId: t.id, text: t.expressionValue || String(t.expressionType).toLowerCase(), match: String(t.kind) === 'KEYWORD' ? String(t.expressionType) : String(t.kind), bidCents: t.bidCents } : null,
      state, why,
      bar: { minOrders: bar.minOrders, minClicks: bar.minClicks, harvestMaxAcosPct: bar.maxAcosPct, windowDays: bar.windowDays, source },
      target: resolvedTarget && targetAcosPct != null ? { targetAcosPct, source: resolvedTarget.source === 'strategy' ? 'the ads strategy' : resolvedTarget.source === 'campaign' ? "the campaign's own target" : 'the account default' } : null,
      current: lineOf(cur), previous: lineOf(prev),
      ...(held ? { held } : {}),
      nextStep: step.nextStep, nextWhy: step.why, ladder: step.ladder,
      ...(step.nextStep === 'placement' ? { placement: { campaignId: c.id, otherTerms: Math.max(0, (clicked.get(c.id)?.size ?? 0) - (cur && cur.clicks > 0 ? 1 : 0)), tool: 'set-placement-multipliers' as const } } : {}),
      ...(step.nextStep === 'ownCampaign' ? { ownCampaign: { tool: 'apply-ads-playbook' as const, args: { op: 'hero' as const, market, productId: product.id, term: p.term } } } : {}),
      ...(heroOf && heroOf.key !== p.g.slot ? { heroOf } : {}),
      ...(step.nextStep === 'closeOldPlace' ? {
        closeOldPlace: exact && t
          ? {
            how: 'floor' as const,
            by: "a request a person decides (bulk-ad-bid-change: one bid, at the strategy's stop bid or the tool's lowest; its undo puts the bid back, about a minute to serve again)",
            request: { tool: 'bulk-ad-bid-change' as const, args: { bids: [{ targetId: t.id, bidCents: lowBidOf(c.id) }], why: `"${p.term}" has its own campaign, which proved itself: its old exact keyword goes to low bids (not a pause, not a negative)` } },
          }
          : { how: 'isolation' as const, by: "the playbook's isolation rule: a negative exact here, on its card (a person decides)", request: null },
      } : {}),
    })
  }
  entries.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.current?.orders ?? 0) - (a.current?.orders ?? 0) || a.term.localeCompare(b.term))
  out.entries = entries.slice(0, MAX_LISTED)
  out.listed = out.entries.length
  if (entries.length > MAX_LISTED) warnings.push(`${entries.length} terms qualify; the first ${MAX_LISTED} are listed (declining and lost first)`)
  return { data: out }
}
