/**
 * ONE BRAIN AB-11 — the harvest module of one product in one market (design 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9,
 * §4 step 4, §5, §8 row AB-11, §10; INDUSTRY-2026-10.md §2.6). Pure: no database and no clock. brain/harvest-load.ts
 * loads the facts, brain/harvest-run.ts acts on the decisions and stores them, brain/harvest-write.ts writes.
 *
 *   from         the term ledger's HARVEST_CANDIDATEs (brain/terms.ts): a term that converts and has no home, which no
 *                sibling product leads. A term with a home (TARGETED) is never harvested: a winner stays where it wins.
 *   ladder       a term climbs once, from where it ran (auto, broad, phrase, or another keyword's close variant) straight to
 *                the top rung — an EXACT keyword (an ASIN: a product target) — with a negative exact in its sources, so the
 *                exact keyword is the term's one owner (Owner 10-08 ~19:20 UTC: harvest follows industry best practice —
 *                Teikametrics and Scale Insights graduate to exact the same way, IND §2.6 — with the safety net below).
 *                Never down, never sideways; a harvested term is never harvested again. (The manual harvest-search-term
 *                tool keeps its own rules: this is the brain's harvest.)
 *   destination  the first that applies, each only where it can take it now (a manual ad group of the product's own
 *                campaigns with the right role, serving — campaign and ad group enabled, bids not suppressed — and the
 *                Owner's campaign settings allow it: not excluded, the harvest lever not off or locked, the term not locked):
 *                  stored    the Owner's harvest destination for the source (set-harvest-destination): his choice wins
 *                            whole — one that cannot take it now holds the harvest, it never falls back to another
 *                  playbook  the product's exact slot (AdsPlaybookLink): a term with the product's brand word goes to its
 *                            brand slot, else to its category slot; an ASIN to its product-target slot
 *                  own       the product's one exact ad group (an ASIN: its one product-target ad group)
 *                  ranked    the best of several: its role from its name, then the most keywords (the one in use); a tie
 *                            on both is named, and at AUTO it asks a person instead
 *                  new       none exists: a NEW campaign through a Nexus builder (create-ad-campaign, the Single Campaign
 *                            builder's own launch: born at the floor, off the live-write allowlist) — always a normal
 *                            approval (D1 = B), at PROPOSE and AUTO alike, inside the caps; never when the Owner keeps the
 *                            structure lever off or locked, and never while an exact ad group exists that only cannot
 *                            serve now (that is named instead)
 *   size         the harvest test's orders rise with the destination's size (Perpetua [PER-2]: 1 below 15 keywords, 2 below
 *                900, then more); the ledger judged it against its own guess, so it is asked again of the ad group chosen.
 *   sources      every ad group of the product where the term ran, but the destination, gets the negative EXACT (an ASIN: a
 *                negative product target) in the SAME change set: the source stops paying for it and the exact keyword is
 *                its one owner (no cannibalisation). Left as they are, each named: a campaign the Owner excluded, one whose
 *                negatives lever he locked or whose harvest lever is off, the term or the ad group locked; a negative that
 *                already stands. The Owner's stored destination with negateAtSource off keeps every source (his choice).
 *                A protected term (AdKeywordProtection) can never be negated anywhere, so the pair could never be whole:
 *                held — a person can still harvest it without the source negative (harvest-search-term negateSource false).
 *   start bid    the bid brain's goal maths (bid-brain/recipe.ts bidForAcos): target ACoS × CR̂ × AOV̂ ÷ r̂, with the term's
 *                CR̂ and AOV̂ pooled term → product → category → market, held at the cautious bid where the 80 % lower bound
 *                of CR̂ meets the band top, r̂ the default 0.85 (a new keyword has no paid CPC of its own); inside the strategy's
 *                lowest and highest bid, the destination campaign's own bounds and the 5¢ engine floor.
 *   level        the change set's level is the lowest of the destination campaign's harvest lever and every negated source's
 *                (the more careful wins). OBSERVE logs it (shadow). PROPOSE asks a person (one approval for the pair).
 *                AUTO writes it as the brain. A new campaign is a request a person decides at PROPOSE and AUTO alike. With
 *                the env ceiling not live (harvest-load.ts harvestCeiling) every level only logs what it would do.
 *   caps         §5: at most `harvestPerDay` new keywords per product per day (proposals included), at most
 *                `newCampaignsPerWeek` new campaigns per product per week, MARKET_NEW_CAMPAIGNS_PER_WEEK per market, at most
 *                `skcMax` harvest campaigns per product; one graduation per term per GRADUATION_COOLDOWN_DAYS (a term a person
 *                declined, or one put back, waits as long; one the gate refused or Amazon failed, which never graduated,
 *                is decided again the next day).
 *   judge        the safety net: after the attribution window (7 days SP) + 72 hours for keyword changes to take full
 *                effect [TEC-6] — never the next day: the keyword's own record since it landed against the evidence it was
 *                harvested on. WORSE: 0 orders in the clicks that make "it stopped converting" a 95 % call at its
 *                harvest-time CR̂, or an ACoS above the band top and clearly worse than before. Then the undo — the pair put
 *                back as a pair (harvest-write.ts undoHarvest: the source negatives retired, then the keyword paused) — is
 *                proposed to a person here; auto-undo (AB-15, brain/harvest-undo.ts) puts it back alone at its AUTO.
 *   words        no money and no ACoS figure in a `why` (the read tool strips the numbers by key, so the words never carry one).
 */
import { crLowerBound80, DEFAULT_CPC_RATIO } from '../bid-brain/estimator.js'
import { bidForAcos, clampToRange, limitRange } from '../bid-brain/recipe.js'
import {
  brandWordIn, harvestOrdersNeeded, negateClicksNeeded, termEstimate,
  type LeverEffective, type ProductContext, type TermDecision, type TermEvidence,
} from './terms.js'

export const HARVEST_STATUSES = [
  'SHADOW', 'HELD', 'PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'REFUSED', 'FAILED', 'DECLINED', 'UNDO_PROPOSED', 'UNDONE',
] as const
export type HarvestStatus = (typeof HARVEST_STATUSES)[number]
export const isHarvestStatus = (v: unknown): v is HarvestStatus => typeof v === 'string' && (HARVEST_STATUSES as readonly string[]).includes(v)

/** A harvest in flight or placed for good: the term is never decided again (one owner per term; it climbs once). */
export const STANDING_STATUSES: readonly HarvestStatus[] = ['PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED']
/** A harvest that ended without a keyword that stands: the term may be decided again after the cooldown. */
export const ENDED_STATUSES: readonly HarvestStatus[] = ['REFUSED', 'FAILED', 'DECLINED', 'UNDONE']

/** The brain's actor for the harvest (the write gate's leverWriterOf reads `automation:ads-brain-…` as the brain). */
export const HARVEST_ACTOR = 'automation:ads-brain-harvest'
/** Sponsored Products' attribution window, and the hours a keyword change takes to take full effect ([TEC-6]). */
export const ATTRIBUTION_DAYS = 7
export const SETTLE_HOURS = 72
export const JUDGE_AFTER_MS = ATTRIBUTION_DAYS * 86_400_000 + SETTLE_HOURS * 3_600_000
/** After this many days a harvest with too little data to call worse is kept for good. */
export const JUDGE_HORIZON_DAYS = 30
/** Clicks after landing a converting harvest needs before its ACoS can be called clearly worse. */
export const MIN_JUDGE_CLICKS = 20
/** "Clearly worse": an ACoS above the band top and this many times the one it was harvested on. */
export const WORSE_ACOS_FACTOR = 1.25
/** §2.8: ≤ 1 graduation per term per 30 days (a declined or undone harvest waits as long). */
export const GRADUATION_COOLDOWN_DAYS = 30
/** A harvest the gate refused or Amazon failed never graduated: it is decided again the next day. */
export const RETRY_AFTER_DAYS = 1
/** How long an ended harvest's term waits before it is decided again. */
export const cooldownDays = (status: HarvestStatus): number => (status === 'REFUSED' || status === 'FAILED' ? RETRY_AFTER_DAYS : GRADUATION_COOLDOWN_DAYS)
/** §2.9 / §5: ≤ 6 new campaigns per market per week. */
export const MARKET_NEW_CAMPAIGNS_PER_WEEK = 6
/** Amazon's lowest daily budget (minor units): a new campaign's first budget never goes below it. */
export const AMAZON_MIN_BUDGET_CENTS = 100
/** A new campaign's name is at most this long (create-ad-campaign). */
export const CAMPAIGN_NAME_MAX = 128

export type Level = 'OBSERVE' | 'PROPOSE' | 'AUTO'
const LEVEL_RANK: Record<Level, number> = { OBSERVE: 0, PROPOSE: 1, AUTO: 2 }
export const isActLevel = (v: unknown): v is Level => v === 'OBSERVE' || v === 'PROPOSE' || v === 'AUTO'
/** The more careful of the levels (null when none acts). */
export function lowestLevel(levels: ReadonlyArray<LeverEffective>): Level | null {
  let out: Level | null = null
  for (const l of levels) {
    if (!isActLevel(l)) return null
    if (out == null || LEVEL_RANK[l] < LEVEL_RANK[out]) out = l
  }
  return out
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── Facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type GroupRole = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT' | null

/** One ad group of the product's own campaigns (brain/ownership.ts: a campaign that advertises this product only). */
export interface HarvestGroup {
  id: string
  name: string
  campaignId: string
  campaignName: string
  /** harvest-destination.service.ts roleOf: name first, then the majority of its keywords. */
  role: GroupRole
  roleFromName: boolean
  /** The campaign's targeting is manual (an auto campaign can never take a keyword). */
  manual: boolean
  /** Positive keywords and product targets in it now (the harvest threshold rises with its size). */
  keywords: number
  productTargets: number
  /** It serves now: campaign and ad group enabled, the campaign's bids not suppressed. Else why not. */
  serving: boolean
  notServing: string | null
  /** Its campaign's own bid bounds (Campaign.minBidCents / maxBidCents). */
  campaignMinCents: number | null
  campaignMaxCents: number | null
}

/** The Owner's settings of one campaign for this product (brain/settings.ts, the campaign's overrides over the product's). */
export interface HarvestCampaignSettings {
  name: string
  excluded: boolean
  harvest: LeverEffective
  negatives: LeverEffective
  harvestWhy: string
  negativesWhy: string
  /** Terms locked on the lever (lock refs "term:<text>", normalised) and ad groups locked on the negatives lever. */
  harvestTermLocks: ReadonlySet<string>
  negativesTermLocks: ReadonlySet<string>
  negativesAdGroupLocks: ReadonlySet<string>
}

/** The Owner's stored harvest destination for a candidate's main source (AdsHarvestDestination, the first grain that covers it). */
export interface StoredDestinationFact {
  adGroupId: string
  negateAtSource: boolean
  grain: string
  /** It is one of this product's own ad groups. */
  own: boolean
}

/** A playbook slot of the product (AdsPlaybookLink kind slot): its key and the ad group it holds. */
export interface SlotFact { key: string; campaignId: string; adGroupId: string | null }

/** A harvest the product already has (AdsBrainHarvest), as the decision reads it. */
export interface HarvestRecordLite { term: string; status: HarvestStatus; changedAt: Date; landedAt: Date | null }

/** One candidate: the ledger's decision and the ad groups of the product where the term ran (clicks per ad group). */
export interface HarvestCandidateFacts {
  decision: TermDecision
  sources: ReadonlyArray<{ adGroupId: string; clicks: number }>
  stored: StoredDestinationFact | null
}

/** What a new campaign for a harvest is built from (null: it cannot be built — `newCampaignRefusal` says why). */
export interface NewCampaignFacts {
  /** The product's Nexus SKUs its own campaigns advertise (one product ad each). */
  skus: string[]
  /** The first daily budget (≤ firstBudgetPctOfEnvelope of the day's envelope, at least Amazon's minimum) and its why. */
  dailyBudgetCents: number
  budgetWhy: string
  /** The product's name token for the campaign name ("{product} | {market} | Exact | {term}"). */
  productLabel: string
  /** Names already taken in the market (a new campaign's name must be new there). */
  takenNames: ReadonlySet<string>
}

export interface HarvestProductFacts {
  productId: string
  market: string
  ctx: ProductContext
  groups: ReadonlyMap<string, HarvestGroup>
  campaigns: ReadonlyMap<string, HarvestCampaignSettings>
  slots: readonly SlotFact[]
  /** The ads strategy's lowest and highest bid per ad group (and for the market, for a new campaign). Money. */
  strategyLimits: ReadonlyMap<string, { minBidCents: number | null; maxBidCents: number | null }>
  marketLimits: { minBidCents: number | null; maxBidCents: number | null }
  /** The structure lever for the product (a new campaign): OFF, LOCKED or EXCLUDED keep new campaigns with the Owner. */
  structure: LeverEffective
  structureWhy: string
  records: ReadonlyMap<string, HarvestRecordLite>
  /** Used today / this week before this run: keywords proposed or written, new campaigns proposed, harvest campaigns. */
  used: { keywordsToday: number; campaignsThisWeek: number; marketCampaignsThisWeek: number; skcs: number }
  caps: { harvestPerDay: number; newCampaignsPerWeek: number; skcMax: number; marketCampaignsPerWeek: number }
  /** The env ceiling: live lets PROPOSE ask and AUTO write; otherwise every level only logs (and why). */
  ceiling: { live: boolean; why: string }
  newCampaign: NewCampaignFacts | null
  newCampaignRefusal: string | null
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────────────────────────

export type SourceAction = 'negate' | 'standing' | 'skipped' | 'kept'
export interface SourcePlan {
  adGroupId: string
  campaignId: string
  clicks: number
  role: GroupRole
  action: SourceAction
  why: string
}

export type DestinationHow = 'stored' | 'playbook' | 'own' | 'ranked' | 'new'
export type HarvestDestinationPlan =
  | { kind: 'EXISTING'; how: Exclude<DestinationHow, 'new'>; adGroupId: string; campaignId: string; keywords: number; why: string; tie?: string[] }
  | { kind: 'NEW_CAMPAIGN'; how: 'new'; why: string; plan: NewCampaignPlan }
  | { kind: 'NONE'; why: string }

export interface NewCampaignPlan {
  name: string
  skus: string[]
  dailyBudgetCents: number
  defaultBidCents: number
  keywords: Array<{ text: string; matchType: 'EXACT'; bidCents: number }>
  productTargets: string[]
  budgetWhy: string
}

/** What this run does with a decision: log it (shadow), ask a person, write it (AUTO), or nothing (held). */
export type HarvestAct = 'log' | 'propose' | 'write' | 'none'

export interface HarvestEvidence {
  impressions: number
  clicks: number
  orders: number
  windowDays: number
  cr: number
  harvest: { by: 'owner' | 'brain'; words: string; ordersNeeded: number }
  /** Money: the candidate's spend, sales, order value and CPC (the read tool hides the key). */
  money: { spendCents: number; salesCents: number; aovCents: number | null; cpcCents: number | null }
}

export interface HarvestDecision {
  term: string
  isAsin: boolean
  outcome: 'pair' | 'new-campaign' | 'held'
  act: HarvestAct
  level: Level | null
  destination: HarvestDestinationPlan
  sources: SourcePlan[]
  bid: { cents: number; why: string } | null
  heldBy: string | null
  why: string
  evidence: HarvestEvidence
}

const UNTOUCHABLE: readonly LeverEffective[] = ['OFF', 'LOCKED', 'EXCLUDED', 'NOT_ENROLLED']

function leverWords(lever: 'harvest' | 'negatives' | 'structure', effective: LeverEffective, where: string): string {
  if (effective === 'OFF') return `the ${lever} lever is OFF on ${where}: today's engines run it`
  if (effective === 'LOCKED') return `the Owner locked the ${lever} lever of ${where} at his own value`
  if (effective === 'EXCLUDED') return `${where} is excluded from the brain by the Owner`
  return `${where} is not enrolled in the brain`
}

/** Why this ad group cannot take the harvested term now (null: it can). Pure. */
export function destinationRefusal(g: HarvestGroup | undefined, term: string, isAsin: boolean, facts: Pick<HarvestProductFacts, 'campaigns'>): string | null {
  if (!g) return 'it is not one of this product\'s own ad groups (the brain never harvests into another product\'s or a shared campaign)'
  const where = `campaign "${g.campaignName}"`
  if (!g.manual || g.role === 'AUTO') return `it is in an automatic campaign or ad group, which cannot take ${isAsin ? 'a product target' : 'a keyword'}`
  if (!isAsin && g.role !== 'EXACT') return `it is not an exact ad group (${g.role ? g.role.toLowerCase() : 'its role is unknown'}): a term climbs once, straight to exact`
  if (isAsin && g.productTargets === 0) return 'it holds no product targets'
  if (!g.serving) return `it does not serve now: ${g.notServing ?? 'paused'}`
  const cs = facts.campaigns.get(g.campaignId)
  if (!cs) return `the Owner's settings of ${where} could not be read`
  if (cs.excluded) return `${where} is excluded from the brain by the Owner`
  if (UNTOUCHABLE.includes(cs.harvest)) return leverWords('harvest', cs.harvest, where)
  if (cs.harvestTermLocks.has(term)) return `the Owner locked this term on the harvest lever of ${where}`
  return null
}

/** The rank of an ad group among several that could take it: its role from its name, then the most keywords. */
const rankKey = (g: HarvestGroup, isAsin: boolean) => [g.roleFromName ? 1 : 0, isAsin ? g.productTargets : g.keywords] as const

/**
 * Where the harvested term goes (see the header). `tie` lists the ad groups a ranked choice could not tell apart. Pure.
 */
export function chooseDestination(c: HarvestCandidateFacts, facts: HarvestProductFacts): HarvestDestinationPlan | { held: string } {
  const { term, isAsin } = c.decision
  const refusal = (id: string) => destinationRefusal(facts.groups.get(id), term, isAsin, facts)
  const existing = (how: Exclude<DestinationHow, 'new'>, g: HarvestGroup, why: string, tie?: string[]): HarvestDestinationPlan => ({
    kind: 'EXISTING', how, adGroupId: g.id, campaignId: g.campaignId, keywords: isAsin ? g.productTargets : g.keywords, why, ...(tie?.length ? { tie } : {}),
  })
  let note = ''
  // 1 — the Owner's stored destination wins whole.
  if (c.stored?.own) {
    const g = facts.groups.get(c.stored.adGroupId)!
    const no = refusal(c.stored.adGroupId)
    if (no) return { held: `the Owner's harvest destination (set-harvest-destination, ${c.stored.grain}) is ad group "${g?.name ?? c.stored.adGroupId}", which cannot take it now: ${no}` }
    return existing('stored', g, `the Owner's harvest destination (set-harvest-destination, ${c.stored.grain}): ad group "${g.name}" in campaign "${g.campaignName}"`)
  }
  if (c.stored && !c.stored.own) note = ' (the stored harvest destination is not one of this product\'s ad groups: the brain never harvests into another product\'s campaign)'
  // 2 — the product's playbook slot (brand terms to its brand slot, else its category slot; an ASIN to its product-target slot).
  const slotGroups = facts.slots
    .map((s) => ({ key: s.key, group: s.adGroupId ? facts.groups.get(s.adGroupId) : [...facts.groups.values()].find((g) => g.campaignId === s.campaignId && !refusal(g.id)) }))
    .filter((s): s is { key: string; group: HarvestGroup } => !!s.group && !refusal(s.group.id))
    .filter((s) => (isAsin ? s.group.productTargets > 0 || /pat|product/.test(s.key) : s.group.role === 'EXACT'))
    .sort((a, b) => a.key.localeCompare(b.key))
  if (slotGroups.length) {
    const brand = !isAsin ? brandWordIn(term, facts.ctx.brand) : null
    const pick = (brand ? slotGroups.find((s) => s.key.includes('brand')) : slotGroups.find((s) => s.key.includes('category')))
      ?? slotGroups.find((s) => !s.key.includes('brand')) ?? slotGroups[0]
    return existing('playbook', pick.group, `the product's playbook slot "${pick.key}"${brand ? ` (the term holds its brand word "${brand}")` : ''}: ad group "${pick.group.name}" in campaign "${pick.group.campaignName}"${note}`)
  }
  // 3 — the product's own exact (or product-target) ad groups.
  const kind = [...facts.groups.values()].filter((g) => g.manual && g.role !== 'AUTO' && (isAsin ? g.productTargets > 0 : g.role === 'EXACT'))
  const able = kind.filter((g) => !refusal(g.id))
  if (able.length === 1) return existing('own', able[0], `the product's ${isAsin ? 'product-target' : 'exact'} ad group "${able[0].name}" in campaign "${able[0].campaignName}"${note}`)
  if (able.length > 1) {
    const sorted = [...able].sort((a, b) => {
      const ka = rankKey(a, isAsin), kb = rankKey(b, isAsin)
      return kb[0] - ka[0] || kb[1] - ka[1] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    })
    const [top, second] = sorted
    const tied = rankKey(top, isAsin).join() === rankKey(second, isAsin).join()
    const tie = tied ? sorted.filter((g) => rankKey(g, isAsin).join() === rankKey(top, isAsin).join()).map((g) => g.id) : undefined
    return existing('ranked', top, `the best of ${plural(able.length, `${isAsin ? 'product-target' : 'exact'} ad group`)}: "${top.name}" in campaign "${top.campaignName}" (${top.roleFromName ? 'its role from its name, ' : ''}the most ${isAsin ? 'product targets' : 'keywords'})${tied ? `; it ties with ${plural(tie!.length - 1, 'other')} on both, so a person confirms it` : ''}${note}`, tie)
  }
  // An exact ad group exists but cannot take it now: say so — never a second structure beside one that only waits.
  if (kind.length) return { held: `the product's ${isAsin ? 'product-target' : 'exact'} ad group${kind.length === 1 ? '' : 's'} cannot take it now: ${kind.map((g) => `"${g.name}" — ${refusal(g.id)}`).join('; ')}` }
  // 4 — none: a new campaign through a Nexus builder, by approval (D1 = B).
  return { kind: 'NONE', why: `the product has no ${isAsin ? 'product-target' : 'exact'} ad group${note}` }
}

/** The new campaign's name: "{product} | {market} | Exact | {term}", new in the market (a number added when taken). */
export function newCampaignName(label: string, market: string, term: string, taken: ReadonlySet<string>): string {
  const base = `${label.trim() || 'Product'} | ${market} | Exact | ${term}`.slice(0, CAMPAIGN_NAME_MAX)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 100; n++) {
    const suffix = ` (${n})`
    const named = `${base.slice(0, CAMPAIGN_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(named.toLowerCase())) return named
  }
  return `${base.slice(0, CAMPAIGN_NAME_MAX - 9)} (${Date.now() % 10_000})`
}

/**
 * Every ad group of the product where the term ran, with what happens there (see the header). The destination itself is
 * kept (a negative there would block the new keyword). Pure.
 */
export function sourcePlans(c: HarvestCandidateFacts, destAdGroupId: string | null, facts: Pick<HarvestProductFacts, 'groups' | 'campaigns'>): SourcePlan[] {
  const { term } = c.decision
  const out: SourcePlan[] = []
  const ownerKeeps = !!c.stored?.own && c.stored.negateAtSource === false
  for (const s of [...c.sources].sort((a, b) => b.clicks - a.clicks || a.adGroupId.localeCompare(b.adGroupId))) {
    const g = facts.groups.get(s.adGroupId)
    if (!g) continue
    const cs = facts.campaigns.get(g.campaignId)
    const where = `campaign "${g.campaignName}"`
    const base = { adGroupId: g.id, campaignId: g.campaignId, clicks: s.clicks, role: g.role }
    const standing = c.decision.negatives.find((n) => (n.level === 'CAMPAIGN' ? n.campaignId === g.campaignId : n.adGroupId === g.id) && (n.match === 'EXACT' || n.match === 'PHRASE' || n.match === 'PRODUCT'))
    let action: SourceAction
    let why: string
    if (g.id === destAdGroupId) { action = 'kept'; why = 'the destination itself: a negative there would block the new keyword' }
    else if (ownerKeeps) { action = 'kept'; why = 'the Owner\'s harvest destination says not to negate the source (negateAtSource off): the term keeps running here too' }
    else if (!cs) { action = 'skipped'; why = `the Owner's settings of ${where} could not be read: the brain leaves it` }
    else if (cs.excluded) { action = 'skipped'; why = `${where} is excluded from the brain by the Owner: the brain leaves it` }
    else if (cs.negatives === 'LOCKED') { action = 'skipped'; why = `the Owner locked the negatives lever of ${where}: the brain leaves it` }
    else if (UNTOUCHABLE.includes(cs.harvest)) { action = 'skipped'; why = `${leverWords('harvest', cs.harvest, where)}: the brain leaves it` }
    else if (cs.negativesTermLocks.has(term) || cs.harvestTermLocks.has(term)) { action = 'skipped'; why = `the Owner locked this term on ${where}: the brain leaves it` }
    else if (cs.negativesAdGroupLocks.has(g.id)) { action = 'skipped'; why = `the Owner locked the negatives of ad group "${g.name}": the brain leaves it` }
    else if (standing) { action = 'standing'; why = `a negative already blocks it in ad group "${g.name}"` }
    else { action = 'negate'; why = `negative exact in ad group "${g.name}" (${g.role ? g.role.toLowerCase() : 'where it ran'}), in the same change set: the source stops paying for it` }
    out.push({ ...base, action, why })
  }
  return out
}

/**
 * The start bid (see the header): goal = target × CR̂ × AOV̂ ÷ r̂, held at the cautious bid, inside the limits. Null with
 * why when it cannot be computed (no target ACoS, no order value). Pure.
 */
export function startBid(decision: Pick<TermDecision, 'evidence'>, ctx: Pick<ProductContext, 'targetAcos' | 'bandTop' | 'pool'>, limits: {
  minBidCents?: number | null; maxBidCents?: number | null; campaignMinCents?: number | null; campaignMaxCents?: number | null
}): { cents: number; why: string } | { refusal: string } {
  if (!ctx.targetAcos) return { refusal: 'no target ACoS is set for this product anywhere (strategy, account): the start bid cannot be computed' }
  const node = termEstimate(decision.evidence, ctx.pool).node
  const aov = node.aovCents
  if (aov == null || !(aov > 0)) return { refusal: 'no order value is known up the chain: the start bid cannot be computed' }
  const aim = ctx.targetAcos.value
  const hi = ctx.bandTop?.value ?? aim
  const ratio = DEFAULT_CPC_RATIO
  const goal = bidForAcos(aim, node.cr, aov, ratio)
  const cautious = bidForAcos(hi, crLowerBound80(node), aov, ratio)
  const want = Math.round(Math.min(goal, cautious))
  const range = limitRange({ minBidCents: limits.minBidCents ?? null, maxBidCents: limits.maxBidCents ?? null, campaignMinCents: limits.campaignMinCents ?? null, campaignMaxCents: limits.campaignMaxCents ?? null })
  const clamped = clampToRange(want, range)
  const why = `the bid brain's goal bid — target ACoS (${ctx.targetAcos.source}) × the term's pooled conversion rate (${node.level}, ${plural(node.clicks, 'click')}) × its order value ÷ r̂ ${ratio} (the default: a new keyword has no paid CPC of its own)`
    + `${cautious < goal ? ', held at the cautious bid where the 80 % lower bound of its conversion rate meets the band top' : ''}`
    + `${clamped.held ? `, held by ${clamped.held}` : ''}`
  return { cents: clamped.cents, why }
}

/** The candidate's evidence as a record keeps it (money under `money`). Pure. */
export function harvestEvidence(d: TermDecision, windowDays: number): HarvestEvidence {
  const e: TermEvidence = d.evidence
  return {
    impressions: e.impressions, clicks: e.clicks, orders: e.orders, windowDays, cr: Number(d.tests.cr.toFixed(6)),
    harvest: { by: d.tests.harvest.by, words: d.tests.harvest.words, ordersNeeded: d.tests.harvest.ordersNeeded },
    money: { spendCents: e.spendCents, salesCents: e.salesCents, aovCents: d.tests.aovCents, cpcCents: d.tests.cpcCents != null ? Math.round(d.tests.cpcCents) : null },
  }
}

/**
 * One decision per candidate, in the ledger's order (the most orders first), inside the day's and the week's caps. A term
 * with a harvest in flight or placed is not decided again; one that ended (declined, refused, undone) waits the cooldown.
 * `now` only dates the cooldown. Pure.
 */
export function decideHarvests(candidates: readonly HarvestCandidateFacts[], facts: HarvestProductFacts, now: Date, windowDays: number): HarvestDecision[] {
  const out: HarvestDecision[] = []
  let keywords = facts.used.keywordsToday
  let campaigns = facts.used.campaignsThisWeek
  let market = facts.used.marketCampaignsThisWeek
  let skcs = facts.used.skcs
  const ordered = [...candidates]
    .filter((c) => c.decision.state === 'HARVEST_CANDIDATE')
    .sort((a, b) => b.decision.evidence.orders - a.decision.evidence.orders || b.decision.evidence.salesCents - a.decision.evidence.salesCents || a.decision.term.localeCompare(b.decision.term))
  for (const c of ordered) {
    const d = c.decision
    const record = facts.records.get(d.term)
    if (record && STANDING_STATUSES.includes(record.status)) continue
    if (record && ENDED_STATUSES.includes(record.status) && now.getTime() - record.changedAt.getTime() < cooldownDays(record.status) * 86_400_000) continue
    const evidence = harvestEvidence(d, windowDays)
    const held = (why: string, heldBy: string, destination: HarvestDestinationPlan = { kind: 'NONE', why: heldBy }, sources: SourcePlan[] = [], bid: HarvestDecision['bid'] = null, level: Level | null = null): HarvestDecision =>
      ({ term: d.term, isAsin: d.isAsin, outcome: 'held', act: 'none', level, destination, sources, bid, heldBy, why: `held: ${heldBy}${why ? `; ${why}` : ''}`, evidence })
    // The ledger's own holds (the product's lever, the Owner's term lock); its cap is replaced by the counted one below.
    if (d.heldBy && !d.capped) { out.push(held('', d.heldBy)); continue }
    if (d.lead && !d.lead.isThis) { out.push(held('', `product ${d.lead.leadProductId} leads this term in the market: this product never harvests it`)); continue }
    if (d.protection === 'protected-term') {
      out.push(held('a person can still harvest it without the source negative (harvest-search-term with negateSource false)', `${d.tests.protectionWhy ?? 'a protected term'} is never negated anywhere, so the pair (keyword and source negative) could never be whole`))
      continue
    }
    const chosen = chooseDestination(c, facts)
    if ('held' in chosen) { out.push(held('', chosen.held)); continue }

    if (chosen.kind === 'EXISTING') {
      const g = facts.groups.get(chosen.adGroupId)!
      // The size-scaled threshold, asked again of the ad group chosen (the brain's own test; the Owner's group wins whole).
      if (d.tests.harvest.by === 'brain') {
        const need = harvestOrdersNeeded(chosen.keywords)
        if (d.evidence.orders < need) { out.push(held('', `ad group "${g.name}" holds ${plural(chosen.keywords, d.isAsin ? 'product target' : 'keyword')}: a harvest there needs ${plural(need, 'order')}, the term has ${d.evidence.orders}`, chosen)); continue }
      }
      const sources = sourcePlans(c, chosen.adGroupId, facts)
      const limits = { ...(facts.strategyLimits.get(chosen.adGroupId) ?? facts.marketLimits), campaignMinCents: g.campaignMinCents, campaignMaxCents: g.campaignMaxCents }
      const bid = startBid(d, facts.ctx, limits)
      if ('refusal' in bid) { out.push(held('', bid.refusal, chosen, sources)); continue }
      const negated = sources.filter((s) => s.action === 'negate')
      const level = lowestLevel([facts.campaigns.get(chosen.campaignId)!.harvest, ...negated.map((s) => facts.campaigns.get(s.campaignId)!.harvest)])
      if (!level) { out.push(held('', 'a campaign of the change set is not run by the brain', chosen, sources, bid)); continue }
      if (keywords >= facts.caps.harvestPerDay) { out.push(held('', `past today's cap of ${plural(facts.caps.harvestPerDay, 'new keyword')} for this product (§5): held for a later day`, chosen, sources, bid, level)); continue }
      keywords++
      let act: HarvestAct = level === 'OBSERVE' ? 'log' : level === 'PROPOSE' ? 'propose' : 'write'
      let heldBy: string | null = null
      // A tie the ranking could not break is a person's choice: at AUTO the brain asks instead of picking.
      if (act === 'write' && chosen.tie?.length) { act = 'propose'; heldBy = 'several exact ad groups tie for it: a person confirms the one proposed (AUTO asks instead of picking)' }
      if (act !== 'log' && !facts.ceiling.live) { heldBy = `${facts.ceiling.why}: it would ${act === 'write' ? 'write it now' : 'ask a person'}`; act = 'log' }
      const kept = sources.filter((s) => s.action !== 'negate')
      const why = `graduate it to ${d.isAsin ? 'a product target' : 'exact'} in ${chosen.why}; ${negated.length ? `negative exact in ${plural(negated.length, 'source')} in the same change set` : 'no source to negate'}`
        + `${kept.length ? ` (${plural(kept.length, 'source')} left as ${kept.length === 1 ? 'it is' : 'they are'}: ${kept.map((s) => s.why).join('; ')})` : ''}; ${d.tests.harvest.words}`
      out.push({ term: d.term, isAsin: d.isAsin, outcome: 'pair', act, level, destination: chosen, sources, bid, heldBy, why, evidence })
      continue
    }

    // No destination: a new campaign through a Nexus builder, by approval (D1 = B).
    if (UNTOUCHABLE.includes(facts.structure)) { out.push(held('', `${chosen.why}, and ${leverWords('structure', facts.structure, 'this product')}: no new campaign is proposed`)); continue }
    if (!facts.newCampaign) { out.push(held('', `${chosen.why}, and a new campaign cannot be built: ${facts.newCampaignRefusal ?? 'unknown'}`)); continue }
    const bid = startBid(d, facts.ctx, facts.marketLimits)
    if ('refusal' in bid) { out.push(held('', bid.refusal)); continue }
    const level = lowestLevel([facts.ctx.levers.harvest])
    if (!level) { out.push(held('', leverWords('harvest', facts.ctx.levers.harvest, 'this product'))); continue }
    const capHit = campaigns >= facts.caps.newCampaignsPerWeek ? `past this week's cap of ${plural(facts.caps.newCampaignsPerWeek, 'new campaign')} for this product (§5)`
      : market >= facts.caps.marketCampaignsPerWeek ? `past this week's cap of ${plural(facts.caps.marketCampaignsPerWeek, 'new campaign')} in ${facts.market} (§5)`
        : skcs >= facts.caps.skcMax ? `past the cap of ${plural(facts.caps.skcMax, 'harvest campaign')} for this product (§2.9)`
          : keywords >= facts.caps.harvestPerDay ? `past today's cap of ${plural(facts.caps.harvestPerDay, 'new keyword')} for this product (§5)` : null
    const nc = facts.newCampaign
    const plan: NewCampaignPlan = {
      name: newCampaignName(nc.productLabel, facts.market, d.term, nc.takenNames),
      skus: nc.skus, dailyBudgetCents: nc.dailyBudgetCents, defaultBidCents: bid.cents,
      keywords: d.isAsin ? [] : [{ text: d.term, matchType: 'EXACT', bidCents: bid.cents }],
      productTargets: d.isAsin ? [d.term.toUpperCase()] : [], budgetWhy: nc.budgetWhy,
    }
    const destination: HarvestDestinationPlan = { kind: 'NEW_CAMPAIGN', how: 'new', why: `${chosen.why}: a new campaign "${plan.name}" through create-ad-campaign (the Single Campaign builder's own launch: born at the floor, off the live-write allowlist), approved by a person (D1 = B)`, plan }
    const sources = sourcePlans(c, null, facts)
    if (capHit) { out.push(held('', `${capHit}: held for a later week`, destination, sources, bid, level)); continue }
    keywords++; campaigns++; market++; skcs++
    let act: HarvestAct = level === 'OBSERVE' ? 'log' : 'propose'
    let heldBy: string | null = null
    if (act === 'propose' && !facts.ceiling.live) { heldBy = `${facts.ceiling.why}: it would ask a person`; act = 'log' }
    const negated = sources.filter((s) => s.action === 'negate').length
    out.push({
      term: d.term, isAsin: d.isAsin, outcome: 'new-campaign', act, level, destination, sources, bid, heldBy, evidence,
      why: `${destination.why}; once it is built and live, negative exact in ${plural(negated, 'source')}; ${d.tests.harvest.words}`,
    })
  }
  return out
}

// ── Judging ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Verdict = 'WAITING' | 'KEPT' | 'WORSE'

export interface JudgeInput {
  landedAt: Date
  now: Date
  /** Settled days of the keyword's own record since it landed (its first full day on). */
  settledDays: number
  /** The evidence it was harvested on (the ledger's window) and its pooled conversion rate then. */
  pre: { clicks: number; orders: number; spendCents: number; salesCents: number; cr: number }
  /** The keyword's own record since it landed (its destination ad group, its query). */
  post: TermEvidence
  /** The band top and the target (fractions), as the product's strategy holds them now. */
  bandTop: number | null
}

export interface Judgement {
  verdict: Verdict
  /** No later look changes it (kept for good, or worse: an undo is proposed). */
  final: boolean
  why: string
  /** Fractions and counts the verdict stands on (money under `money`). */
  numbers: { settledDays: number; clicksNeeded: number; postClicks: number; postOrders: number; preCr: number; money: { preAcos: number | null; postAcos: number | null; bandTop: number | null; postSpendCents: number; postSalesCents: number } }
}

/** The judgement of one harvest (see the header). Pure. */
export function judgeHarvest(j: JudgeInput): Judgement {
  const preAcos = j.pre.salesCents > 0 ? j.pre.spendCents / j.pre.salesCents : null
  const postAcos = j.post.salesCents > 0 ? j.post.spendCents / j.post.salesCents : null
  const need = negateClicksNeeded(j.pre.cr)
  const days = Math.floor((j.now.getTime() - j.landedAt.getTime()) / 86_400_000)
  const numbers = {
    settledDays: j.settledDays, clicksNeeded: need, postClicks: j.post.clicks, postOrders: j.post.orders, preCr: j.pre.cr,
    money: { preAcos, postAcos, bandTop: j.bandTop, postSpendCents: j.post.spendCents, postSalesCents: j.post.salesCents },
  }
  const record = `${plural(j.post.clicks, 'click')} and ${plural(j.post.orders, 'order')} in ${plural(j.settledDays, 'settled day')} since it landed`
  if (j.now.getTime() - j.landedAt.getTime() < JUDGE_AFTER_MS || j.settledDays < ATTRIBUTION_DAYS) {
    return { verdict: 'WAITING', final: false, why: `judged after the attribution window (${ATTRIBUTION_DAYS} days) + ${SETTLE_HOURS} hours of settled data, never earlier: ${record}`, numbers }
  }
  if (j.post.orders === 0 && j.post.clicks >= need) {
    return { verdict: 'WORSE', final: true, why: `${record}: at the conversion rate it was harvested on, 0 orders in ${need} clicks is a 95 % call that it stopped converting here — an undo is proposed (pause the keyword, retire the source negatives)`, numbers }
  }
  if (j.post.orders > 0 && postAcos != null && j.bandTop != null && postAcos > j.bandTop && (preAcos == null || postAcos > preAcos * WORSE_ACOS_FACTOR) && j.post.clicks >= MIN_JUDGE_CLICKS) {
    return { verdict: 'WORSE', final: true, why: `${record}: it converts, but its ACoS is above the band top and clearly worse than the evidence it was harvested on — an undo is proposed (pause the keyword, retire the source negatives)`, numbers }
  }
  if (j.post.orders > 0) return { verdict: 'KEPT', final: true, why: `${record}: it converts in its exact home at an ACoS within the band top or no worse than before — kept for good (its exact keyword stays the term's one owner)`, numbers }
  if (days >= JUDGE_HORIZON_DAYS) return { verdict: 'KEPT', final: true, why: `${record}: too little data in ${JUDGE_HORIZON_DAYS} days to call it worse (${need} clicks would) — kept`, numbers }
  return { verdict: 'WAITING', final: false, why: `${record}: too little data yet — ${need} clicks without an order, or ${MIN_JUDGE_CLICKS} with orders, would decide it`, numbers }
}
