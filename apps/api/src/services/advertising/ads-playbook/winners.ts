/**
 * ADS PLAYBOOK PB-6c — the winners view: which of ONE product's search terms win where they run, which are declining or
 * lost, and the next step for each, in the Owner's order (rule 2: "If we're getting results, we never shuffle them; we
 * keep them. If the results are compromised … adjustments, maybe in the bids or placement percentage … maybe we can
 * create a separate campaign each time to have more control").
 *
 *   state        winning   it meets the harvest bar where it runs now, its ACoS not over the target
 *                declining it meets the bar with its ACoS over the target, or it met the bar in the window before and
 *                          still sells, under the bar now
 *                lost      it met the bar in the window before and sold nothing in this one
 *                unproven  it met the bar in neither (counted, not listed)
 *   next step    closeOldPlace  PB-6c handover B — the term has its own campaign (a hero) and the hero proved itself
 *                             (its exact keyword meets the harvest bar there): this old place is to be closed, a
 *                             negative exact here (the playbook's isolation rule proposes it; the lock lets it, L1b).
 *                             Until the hero proves, both run.
 *                a winning term is kept where it is: no step. A declining or lost one, first that applies —
 *                bid          auto-bid is on it: switched on for this business and the account dial at AUTO, the
 *                             campaign on the live-write allowlist, not at a floor and held by no one else (a pin, an
 *                             hourly plan, a goal plan), the keyword that serves it live, not at a floor, its bid set by no
 *                             person, a target ACoS you set, and its bid strictly inside the strategy's band: auto-bid
 *                             already moves it toward the target every run
 *                none         an hourly plan holds the campaign, or its slot plays the performance role: the Owner's
 *                             Hourly Bids own its bids and placements — reported only, never a placement or a move
 *                placement    a research slot (Auto, Broad, Phrase) or the term's own campaign, on the allowlist: its
 *                             placement percentages (set-placement-multipliers) — a campaign setting, so the entry says how
 *                             many other terms it touches
 *                ownCampaign  a campaign of its own (apply-ads-playbook op hero, hero.ts): one exact keyword, born at the
 *                             2¢ floor and off the allowlist, waiting for a person; the term keeps running where it is
 *                             until that campaign proves itself (handover B)
 *
 * No number of its own. The bar is the ads strategy's harvest group for the term's ad group (the bar the harvest and the
 * lock ask, ads-harvest.service.ts homeWinners, with the rules' fallbacks where the strategy sets none) over the
 * strategy's harvest window; "the window before" is as long, just before it. The target is the one auto-bid steers by
 * (the campaign's own, the strategy's, the account default: configuredTargetAcos); the band is the strategy's. Two
 * strategies give two answers. The numbers are the search-term totals the harvest reads (searchTermTotals).
 *
 * Scope (the Owner's rule 3): only this product's own campaigns — its playbook's slot links in the market (its heroes
 * too), each ad group advertising nothing but this product family (familyOnly; the rest named). Another product buying
 * the same term is never read here. Reads only, through the business-scoped client.
 */
import prisma from '../../../db.js'
import { HARVEST_DEFAULTS } from '@nexus/shared/ads-rule-window'
import { homeWinners, meetsHarvest, searchTermTotals, winnerKey } from '../ads-harvest.service.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { strategyBidReader } from '../ads-strategy/bids.js'
import { openTermsStrategy, sourceLabel, strategyMarketOf, termsForAdGroups, type StrategyTerms } from '../ads-strategy/terms.js'
import { configuredTargetAcos, readOwnerTargets } from '../ads-target-acos-resolver.js'
import { familyOfProducts, familyOnly, homeOf, positivesIn } from '../ads-winner-lock.js'
import { loadProductPlaybook } from './build-preview.js'
import type { Slot } from './doc.js'
import { HERO_PREFIX, heroRefusal, isHeroKey } from './hero.js'

export type WinnerState = 'winning' | 'declining' | 'lost' | 'unproven'
export type WinnerStep = 'closeOldPlace' | 'bid' | 'placement' | 'ownCampaign' | 'none'

/** A term's search-term totals in one ad group over one window. */
export interface TermResults { orders: number; clicks: number; costCents: number; salesCents: number }
/** The harvest bar a term is judged on (the strategy's harvest group, or the rules' fallbacks). */
export interface WinnerBar { minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number }

const acosOf = (r: TermResults | null) => (r && r.salesCents > 0 ? Math.round((r.costCents / r.salesCents) * 1000) / 10 : null)
const meets = (r: TermResults | null, bar: WinnerBar) => !!r && r.orders > 0 && meetsHarvest(r, bar)

/**
 * Pure — a term's state where it runs: winning, declining, lost or unproven, judged on the bar and the target given (no
 * number of its own), with the sentence that says why.
 */
export function classifyWinner(input: { current: TermResults | null; previous: TermResults | null; bar: WinnerBar; targetAcosPct: number | null }): { state: WinnerState; why: string } {
  const { current, previous, bar, targetAcosPct } = input
  const days = `${bar.windowDays} days`
  if (meets(current, bar)) {
    const acos = acosOf(current)
    if (targetAcosPct != null && acos != null && acos > targetAcosPct) return { state: 'declining', why: `it meets the harvest bar over the last ${days}, but its ACoS is over the target` }
    return { state: 'winning', why: `it meets the harvest bar where it runs, over the last ${days}` }
  }
  if (meets(previous, bar)) {
    return current && current.orders > 0
      ? { state: 'declining', why: `it met the harvest bar in the ${days} before and sells less now: under the bar over the last ${days}` }
      : { state: 'lost', why: `it met the harvest bar in the ${days} before and sold nothing over the last ${days}` }
  }
  return { state: 'unproven', why: `it met the harvest bar in neither window of ${days}` }
}

/** What the next step of one declining or lost term is judged on (winnerReview reads them). */
export interface LadderFacts {
  state: WinnerState
  /** Auto-bid for this business now: switched on and the account dial at AUTO. */
  autoBid: { on: boolean; why: string }
  campaign: {
    liveWrites: boolean
    /** Who set the campaign's floor, when it is at one. */
    floored: string | null
    holder: 'pinned' | 'hourlyPlan' | 'goalPlan' | null
    /** Its slot plays the performance rank role. */
    performance: boolean
    /** Its slot is a research one: Auto, Broad, Phrase. */
    research: boolean
    /** It is a term's own campaign (a hero). */
    hero: boolean
  }
  /** The keyword or target that serves the term; null when Nexus cannot tell. */
  servedBy: { bidCents: number; live: boolean; suppressed: boolean; personSet: boolean } | null
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

/** Why auto-bid is not on this term's bid, or null when it is. */
function bidBlocker(f: LadderFacts): string | null {
  if (!f.autoBid.on) return f.autoBid.why
  if (!f.campaign.liveWrites) return 'its campaign is off the live-write allowlist: no engine writes to it'
  if (f.campaign.floored) return `its campaign is at a floor (${f.campaign.floored})`
  if (f.campaign.holder) return HOLDER_WORDS[f.campaign.holder]
  if (!f.servedBy) return 'Nexus cannot tell which keyword or target serves it'
  if (!f.servedBy.live) return 'the keyword that serves it is not live at Amazon'
  if (f.servedBy.suppressed) return 'the keyword that serves it is at a floor'
  if (f.servedBy.personSet) return 'a person set its bid in the last 60 days: auto-bid leaves it'
  if (f.targetAcosPct == null) return 'no target ACoS you set reaches it (the campaign, the ads strategy or the account default)'
  const { minBidCents: min, maxBidCents: max } = f.band
  if (min != null && f.servedBy.bidCents <= min) return "its bid is at the strategy's lowest bid: auto-bid cannot lower it"
  if (max != null && f.servedBy.bidCents >= max) return "its bid is at the strategy's highest bid: auto-bid cannot raise it"
  return null
}

/**
 * Pure — the next step for one term, first that applies (the Owner's order: bid, then placement, then a campaign of its
 * own), with every rung and why it is open or closed. A winning term is kept where it is: no step.
 */
export function winnerLadder(f: LadderFacts): { nextStep: WinnerStep; why: string; ladder: LadderRung[] } {
  const own = f.hero.exists
  if (own && !f.campaign.hero && own.proven) {
    return { nextStep: 'closeOldPlace', why: `hero proven → old place to be closed: its own campaign ("${own.campaignName}") meets the harvest bar, so a negative exact here sends its searches there (the playbook's isolation rule proposes it; a person decides). Until it is closed, both run`, ladder: [] }
  }
  if (f.state === 'winning') {
    return { nextStep: 'none', why: own && !f.campaign.hero ? `winning where it runs: it stays there, and its own campaign ("${own.campaignName}") runs too until that campaign meets the harvest bar` : 'winning where it runs: it stays there — no bid, placement or move is proposed', ladder: [] }
  }
  if (f.state === 'unproven') return { nextStep: 'none', why: 'it has not proven itself here: nothing to keep or repair', ladder: [] }
  const ladder: LadderRung[] = []
  const blocked = bidBlocker(f)
  ladder.push(blocked
    ? { step: 'bid', open: false, why: blocked }
    : { step: 'bid', open: true, why: 'auto-bid already moves its bid toward the target every run, inside the band: let it work' })
  const rankHeld = f.campaign.holder === 'hourlyPlan' || f.campaign.performance
  const held = 'an hourly plan holds its campaign, or its slot plays the performance role: the Owner\'s Hourly Bids own its bids and placements — reported only'
  ladder.push(rankHeld ? { step: 'placement', open: false, why: held }
    : !f.campaign.liveWrites ? { step: 'placement', open: false, why: 'its campaign is off the live-write allowlist: a placement is refused there' }
      : !(f.campaign.research || f.campaign.hero) ? { step: 'placement', open: false, why: 'placements move only on a research slot (Auto, Broad, Phrase) or the term\'s own campaign: here they would move every term of the campaign' }
        : { step: 'placement', open: true, why: 'its campaign\'s placement percentages (set-placement-multipliers): a campaign setting, so every term of the campaign moves with it' })
  ladder.push(rankHeld ? { step: 'ownCampaign', open: false, why: held }
    : f.campaign.hero ? { step: 'ownCampaign', open: false, why: 'it is the term\'s own campaign already' }
      : f.hero.exists ? { step: 'ownCampaign', open: false, why: `it has its own campaign already ("${f.hero.exists.campaignName}"): it runs there too` }
        : f.hero.refusal ? { step: 'ownCampaign', open: false, why: f.hero.refusal }
          : { step: 'ownCampaign', open: true, why: 'a campaign of its own (apply-ads-playbook op hero): one exact keyword, born at the 2-cent floor and off the allowlist, waiting for a person; the term keeps running here until it proves itself' })
  const first = ladder.find((r) => r.open)
  if (first) return { nextStep: first.step, why: first.why, ladder }
  return { nextStep: 'none', why: rankHeld ? held : 'no step applies now (each rung says why)', ladder }
}

// ── The review (DB) ───────────────────────────────────────────────────────────────────────────────

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
  current: { orders: number; clicks: number; costCents: number; salesCents: number; acosPct: number | null } | null
  previous: { orders: number; clicks: number; costCents: number; salesCents: number; acosPct: number | null } | null
  nextStep: WinnerStep
  nextWhy: string
  ladder: LadderRung[]
  /** placement: the campaign and how many other terms with clicks a change there moves too. */
  placement?: { campaignId: string; otherTerms: number; tool: 'set-placement-multipliers' }
  /** ownCampaign: the request that asks for it. */
  ownCampaign?: { tool: 'apply-ads-playbook'; args: { op: 'hero'; market: string; productId: string; term: string } }
  /** The term's own campaign, when it has one (proven: it meets the harvest bar there). */
  heroOf?: { key: string; campaignId: string; campaignName: string; proven: boolean }
  /** closeOldPlace: the negative that closes this old place, and the request that asks for it outside the rule's card. */
  closeOldPlace?: {
    negative: { text: string; match: 'EXACT'; adGroupId: string; campaignId: string }
    by: string
    request: { tool: 'create-negative-keyword'; args: { externalCampaignId: string; externalAdGroupId: string; keywordText: string; matchType: 'NEGATIVE_EXACT'; scope: 'AD_GROUP'; why: string } } | null
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
/** A term's key in one ad group (Amazon's ad-group id and the normalised term), as searchTermTotals keys its own. */
const SEP = '\u0000'
const termKey = (externalAdGroupId: string, query: string) => `${externalAdGroupId}${SEP}${normaliseNegTerm(query)}`
const ORDER: Record<WinnerState, number> = { lost: 0, declining: 1, winning: 2, unproven: 3 }
const results = (r: TermResults | null) => (r ? { ...r, acosPct: acosOf(r) } : null)
const add = (a: TermResults | undefined, b: TermResults): TermResults => ({ orders: (a?.orders ?? 0) + b.orders, clicks: (a?.clicks ?? 0) + b.clicks, costCents: (a?.costCents ?? 0) + b.costCents, salesCents: (a?.salesCents ?? 0) + b.salesCents })
const less = (wide: TermResults | undefined, recent: TermResults | undefined): TermResults | null => {
  if (!wide) return null
  const r = { orders: wide.orders - (recent?.orders ?? 0), clicks: wide.clicks - (recent?.clicks ?? 0), costCents: wide.costCents - (recent?.costCents ?? 0), salesCents: wide.salesCents - (recent?.salesCents ?? 0) }
  return r.orders || r.clicks || r.costCents || r.salesCents ? r : null
}

/** Auto-bid for this business now: its switch (as its cron reads it) and the account dial. Never throws. */
async function autoBidNow(): Promise<{ on: boolean; why: string }> {
  try {
    const { readEnginePosture } = await import('../ads-engine-guard.js')
    const { engineMode } = await import('../../automation/engine-switch.service.js')
    const [posture, gate] = await Promise.all([readEnginePosture(), engineMode('auto-bid', 'AUTO')])
    if (gate.mode === 'OFF') return { on: false, why: `auto-bid is switched off for this business${gate.note ? ` (${gate.note})` : ''}` }
    if (posture.posture !== 'auto') return { on: false, why: `auto-bid writes no bid now: ${posture.why}` }
    return { on: true, why: 'auto-bid runs for this business and the account dial is AUTO' }
  } catch (e) {
    return { on: false, why: `auto-bid's switch could not be read: ${(e as Error).message.slice(0, 120)}` }
  }
}

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
    select: { id: true, name: true, status: true, marketplace: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true, adGroups: { select: { id: true, status: true, externalAdGroupId: true } } },
  })
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const want = strategyMarketOf(market)
  type Group = { adGroupId: string; ext: string | null; campaignId: string; slot: string; marketplace: string | null }
  const excluded: WinnerReview['scope']['excluded'] = []
  const candidates: Group[] = []
  for (const l of links) {
    const c = byId.get(l.refId)
    if (!c) continue
    if (strategyMarketOf(c.marketplace) !== want) { excluded.push({ slot: l.key, campaignId: c.id, adGroupId: l.adGroupId, why: `its campaign runs in ${c.marketplace ?? 'no market'}, not ${market}` }); continue }
    for (const g of c.adGroups) {
      if (String(g.status) === 'ARCHIVED' || (l.adGroupId && g.id !== l.adGroupId)) continue
      candidates.push({ adGroupId: g.id, ext: g.externalAdGroupId, campaignId: c.id, slot: l.key, marketplace: c.marketplace })
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

  // The bar per ad group: the strategy's harvest group, else the rules' fallbacks (homeWinners' own).
  const strategy = await openTermsStrategy()
  const groupTerms = strategy ? await termsForAdGroups(strategy, placed.map((g) => ({ market: g.marketplace, externalAdGroupId: g.ext }))) : new Map<string, StrategyTerms>()
  const fallback: WinnerBar = { minOrders: HARVEST_DEFAULTS.minOrders, minClicks: 0, maxAcosPct: null, windowDays: HARVEST_DEFAULTS.windowDays }
  const barOf = new Map(placed.map((g) => {
    const h = groupTerms.get(`${strategyMarketOf(g.marketplace)}|${g.ext}`)?.harvest
    return [g.adGroupId, h ? { bar: h.group as WinnerBar, source: `the ads strategy: ${sourceLabel(h.source)}` } : { bar: fallback, source: 'the harvest rules\' defaults (the ads strategy sets no harvest group here)' }] as const
  }))

  // The totals: this window and the one before it (as long), per ad group and term — the harvest's own sums.
  const current = new Map<string, TermResults>()
  const wide = new Map<string, TermResults>()
  const byWindow = new Map<number, string[]>()
  for (const g of placed) { const w = barOf.get(g.adGroupId)!.bar.windowDays; byWindow.set(w, [...(byWindow.get(w) ?? []), g.ext]) }
  for (const [w, exts] of byWindow) {
    for (const [into, days] of [[current, w], [wide, w * 2]] as const) {
      for (const t of (await searchTermTotals(days, exts)).values()) {
        const key = termKey(t.externalAdGroupId, t.query)
        into.set(key, add(into.get(key), t))
      }
    }
  }

  // Which keyword or target served each term (Amazon's search-term rows name it), the exact home first.
  const widest = Math.max(...byWindow.keys()) * 2
  const matched = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'adGroupId', 'matchedKeywordId', 'matchedTargetId'],
    where: { date: { gte: new Date(Date.now() - widest * 86400_000) }, adGroupId: { in: placed.map((g) => g.ext) } },
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

  // The term's own campaigns (heroes), by term: proven once their live exact keyword meets the harvest bar there (the
  // bar the lock's L1b and the isolation ask: homeWinners, the harvest rules' fallbacks where the strategy sets none).
  const heroLinks = links.filter((l) => isHeroKey(l.key))
  const heroPositives = await positivesIn(heroLinks.map((l) => l.adGroupId).filter((id): id is string => !!id))
  const liveHeroes = heroLinks.filter((l) => {
    const home = l.adGroupId ? homeOf(l.key.slice(HERO_PREFIX.length), heroPositives.get(l.adGroupId) ?? []) : null
    return !!home?.live && home.adGroupId === l.adGroupId
  })
  const heroWins = await homeWinners(liveHeroes.map((l) => ({ term: l.key.slice(HERO_PREFIX.length), adGroupId: l.adGroupId! })), { defaults: { ...HARVEST_DEFAULTS } })
  const heroes = new Map(heroLinks.map((l) => {
    const term = l.key.slice(HERO_PREFIX.length)
    return [term, { key: l.key, campaignId: l.refId, campaignName: byId.get(l.refId)?.name ?? '?', proven: !!l.adGroupId && liveHeroes.includes(l) && heroWins.has(winnerKey(term, l.adGroupId)) }]
  }))

  // One entry per ad group and term.
  type Pending = { g: Group & { ext: string }; term: string; key: string }
  const groupOfExt = new Map(placed.map((g) => [g.ext, g]))
  const pending: Pending[] = []
  for (const key of new Set([...current.keys(), ...wide.keys()])) {
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
  const serving = new Map((servingIds.size
    ? await prisma.adTarget.findMany({ where: { id: { in: [...servingIds] } }, select: { id: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, status: true, externalTargetId: true, suppressedFromBidCents: true } })
    : []).map((t) => [t.id, t]))
  // Terms with clicks per campaign (what a placement change there moves too).
  const clicked = new Map<string, Set<string>>()
  for (const [key, r] of current) {
    const [ext, term] = key.split(SEP)
    const g = groupOfExt.get(ext)
    if (g && r.clicks > 0) clicked.set(g.campaignId, (clicked.get(g.campaignId) ?? new Set()).add(term))
  }

  const entries: WinnerEntry[] = []
  for (const p of pending) {
    const { bar, source } = barOf.get(p.g.adGroupId)!
    const cur = current.get(p.key) ?? null
    const prev = less(wide.get(p.key), current.get(p.key))
    const c = byId.get(p.g.campaignId)!
    const resolvedTarget = configuredTargetAcos({ adGroupId: p.g.adGroupId, campaignTargetAcos: owner.byCampaign.get(p.g.campaignId) }, { explicitTargetAcos: undefined, accountDefaultPct: owner.accountDefaultPct, strategyByAdGroup })
    const targetAcosPct = resolvedTarget ? Math.round(resolvedTarget.targetAcos * 1000) / 10 : null
    const { state, why } = classifyWinner({ current: cur, previous: prev, bar, targetAcosPct })
    counts[state]++
    if (state === 'unproven' && !asked) continue
    const servedId = servingOf.get(`${p.g.adGroupId}|${p.key}`)
    const t = servedId ? serving.get(servedId) : undefined
    const slot = slotOf.get(p.g.slot)
    const hero = isHeroKey(p.g.slot)
    const heroOf = heroes.get(p.term)
    const band = strat.get(p.g.adGroupId)?.limits
    const step = winnerLadder({
      state,
      autoBid,
      campaign: {
        liveWrites: c.liveBidWritesEnabled, floored: c.bidsSuppressedAt ? (c.bidsSuppressedBy || 'an unrecorded actor') : null, holder: holders.get(c.id) ?? null,
        performance: slot?.rankRole === 'performance',
        research: !!slot && (slot.targeting === 'AUTO' || (slot.targeting === 'KEYWORD' && slot.match !== 'EXACT')),
        hero,
      },
      servedBy: t ? { bidCents: t.bidCents, live: String(t.status) === 'ENABLED' && !!t.externalTargetId, suppressed: t.suppressedFromBidCents != null, personSet: personTargets.has(t.id) } : null,
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
      current: results(cur), previous: results(prev),
      nextStep: step.nextStep, nextWhy: step.why, ladder: step.ladder,
      ...(step.nextStep === 'placement' ? { placement: { campaignId: c.id, otherTerms: Math.max(0, (clicked.get(c.id)?.size ?? 0) - (cur && cur.clicks > 0 ? 1 : 0)), tool: 'set-placement-multipliers' as const } } : {}),
      ...(step.nextStep === 'ownCampaign' ? { ownCampaign: { tool: 'apply-ads-playbook' as const, args: { op: 'hero' as const, market, productId: product.id, term: p.term } } } : {}),
      ...(heroOf && heroOf.key !== p.g.slot ? { heroOf } : {}),
      ...(step.nextStep === 'closeOldPlace' ? {
        closeOldPlace: {
          negative: { text: p.term, match: 'EXACT' as const, adGroupId: p.g.adGroupId, campaignId: c.id },
          by: "the playbook's isolation rule: a card a person decides (or Claude inside his limits for negatives); never at once",
          request: c.externalCampaignId
            ? { tool: 'create-negative-keyword' as const, args: { externalCampaignId: c.externalCampaignId, externalAdGroupId: p.g.ext, keywordText: p.term, matchType: 'NEGATIVE_EXACT' as const, scope: 'AD_GROUP' as const, why: `"${p.term}" has its own campaign, which proved itself: close its old place here` } }
            : null,
        },
      } : {}),
    })
  }
  entries.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.current?.orders ?? 0) - (a.current?.orders ?? 0) || a.term.localeCompare(b.term))
  out.entries = entries.slice(0, MAX_LISTED)
  out.listed = out.entries.length
  if (entries.length > MAX_LISTED) warnings.push(`${entries.length} terms qualify; the first ${MAX_LISTED} are listed (declining and lost first)`)
  return { data: out }
}
