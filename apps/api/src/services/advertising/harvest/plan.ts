/**
 * HARVEST ENGINE — the plan of one harvest item: pure (no database, no clock of its own). The page, Claude and the rules
 * plan here; the brain keeps its own decision (brain/harvest.ts decideHarvests) and only writes through the engine.
 *
 *   destination  the one asked (`to`: an ad group of the product's own campaigns, or a new campaign of this change set), else
 *                the suggested place in the brain's order: the Owner's stored destination → the product's playbook slot
 *                (EXACT) → its one ad group of that match → the best of several → a NEW campaign (the product's funnel
 *                campaign for the match: one campaign, one ad group, in the product's portfolio, the SP Super Wizard's
 *                naming). An ad group that cannot take it now is named, never silently replaced.
 *   landing      B1 / B10 (2026-10-10): a copy of the keyword already ENABLED there → nothing created, its sources still
 *                blocked; a PAUSED copy → enabled as the landing; an ARCHIVED copy, or a negative there that blocks it →
 *                that place cannot take it (a harvest there would block the sources for a keyword that does not serve).
 *   sources      EVERY ad group of the product where the term ran gets the negative (Owner 10-08 + D3: a person's and
 *                Claude's harvest too): negative exact; a PHRASE harvest blocks a broad or auto source with a negative
 *                phrase. Left as they are, each named: the destination itself, the Owner's stored negateAtSource off (his
 *                saved choice wins; the request may switch it), a negative already there, a protected term (never negated).
 *   funnel       the Owner's match-type funnel (10-09): exact → negative exact in the product's phrase / broad / auto ad
 *                groups; phrase → negative phrase in its broad / auto ad groups — besides the sources, in the same change
 *                set (`funnel: false` leaves them). Never where the product's own keyword is the term (it would block it).
 *   bid          the asked bid, else the bid brain's goal bid (brain/harvest.ts startBid: the same number the Bid page
 *                shows), else the term's observed CPC held inside the strategy's lowest and highest bid (B12).
 *   refusal      why the item cannot be harvested now, in words (null: it can). Nothing is ever dropped silently (B5).
 */
import { DEFAULT_CUSTOM_NAME_TOKENS, generateCampaignRows } from '@nexus/shared/ads-sp-wizard'
import { chooseDestination, destinationRefusal, startBid, type HarvestGroup, type HarvestProductFacts, type StoredDestinationFact } from '../brain/harvest.js'
import type { TermDecision } from '../brain/terms.js'
import type { BlockState, HarvestMatch } from './write.js'
import type { LandingDecision } from '../harvest-landing-guard.js'

export type ActorKind = 'BRAIN' | 'PERSON' | 'CLAUDE' | 'RULE'

/** The engine's lowest start bid (the engines' 5-cent floor). */
export const MIN_START_BID_CENTS = 5
/** A new campaign's name is at most this long (Amazon). */
export const CAMPAIGN_NAME_MAX = 128
/** The keyword type a harvest campaign's name carries (the SP Super Wizard's custom naming). */
export const HARVEST_KEYWORD_TYPE = 'Harvest'

export interface Hold { kind: 'destination' | 'protected' | 'sibling' | 'source' | 'cap' | 'lever' | 'record' | 'bid' | 'home'; label: string; reason: string }

/** One item a request asks for (the preview body's `items[]`). */
export interface PlanItemRequest {
  candidateId: string
  to?: { adGroupId: string } | { newCampaign: string }
  match?: HarvestMatch
  bidCents?: number
  negateSource?: boolean
  funnel?: boolean
}

/** What the planner knows of the term in the product (the ledger's decision; null when the term has no evidence). */
export interface PlanTerm {
  term: string
  isAsin: boolean
  decision: TermDecision | null
  sources: ReadonlyArray<{ adGroupId: string; clicks: number }>
}

/** What a destination ad group holds of this keyword now: the ONE landing check's decision (harvest-landing-guard.ts). */
export type LandingFacts = LandingDecision

export interface PlanProduct {
  productId: string
  market: string
  label: string
  facts: HarvestProductFacts
  portfolioId: string | null
  storedFor: (term: string, match: HarvestMatch | 'PRODUCT') => StoredDestinationFact | null
  /** Source ad groups a person paused harvesting from. */
  paused: ReadonlySet<string>
  /** The brain runs this product (enrolled, its harvest lever acting): a rule then leaves the campaigns its levers hold. */
  brainRuns: boolean
}

const LEVER_HOLDS = ['OBSERVE', 'PROPOSE', 'AUTO', 'LOCKED']

export type PlannedDestination =
  | { kind: 'existing'; how: 'chosen' | 'stored' | 'playbook' | 'own' | 'ranked'; adGroupId: string; campaignId: string; status: 'will-create' | 'already-there' | 're-enable'; existingTargetId: string | null; why: string }
  | { kind: 'new'; how: 'new' | 'chosen'; key: string; why: string }

export interface PlannedItem {
  candidateId: string
  productId: string
  market: string
  term: string
  isAsin: boolean
  match: HarvestMatch
  refusal: string | null
  hold: Hold | null
  destination: PlannedDestination | null
  bid: { cents: number; why: string } | null
  sources: BlockState[]
  funnel: BlockState[]
  /** The Owner's stored destination says not to block the sources (shown; the request may switch it). */
  storedKeepsSources: boolean
  /** The evidence it is harvested on (the ledger's window; money under `money`), for its judgement after window + 72 h. */
  harvestedOn: { impressions: number; clicks: number; orders: number; cr: number; money: { spendCents: number; salesCents: number } } | null
}

/** A new campaign a change set builds (the preview body's `newCampaigns[]`, resolved). */
export interface NewCampaignSpec {
  key: string
  productId: string
  /** R1 (release review) — the one market it is built in: an item of another market never goes into it. */
  market?: string
  match: HarvestMatch
  name: string
  adGroupName: string
  dailyBudgetCents: number
  portfolio: { id: string } | { newPortfolio: string } | null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const LOOSER: Record<HarvestMatch, ReadonlyArray<string>> = { EXACT: ['PHRASE', 'BROAD', 'AUTO'], PHRASE: ['BROAD', 'AUTO'] }

/** Why a person (or Claude, or a rule) cannot put the keyword in this ad group now; null when it can. Pure. */
export function placeRefusal(g: HarvestGroup | undefined, isAsin: boolean, landing: LandingFacts | null): string | null {
  if (!g) return 'it is not one of this product\'s own ad groups (a harvest goes into the product\'s own campaigns)'
  if (!g.manual || g.role === 'AUTO') return `it is an automatic ad group, which cannot take ${isAsin ? 'a product target' : 'a keyword'}`
  if (isAsin && g.productTargets === 0 && g.keywords > 0) return 'it is a keyword ad group: a product target goes into a product-target ad group'
  if (!isAsin && g.productTargets > 0 && g.keywords === 0) return 'it is a product-target ad group: a keyword goes into a keyword ad group'
  if (!g.serving) return `it does not serve now: ${g.notServing ?? 'paused'}`
  // The landing guard (B1 + B10): an archived copy or a negative that blocks the term holds the place; a keyword switched on
  // again that Amazon has not confirmed yet, or a destination that does not serve, is no landing now.
  if (landing?.kind === 'hold') return landing.why
  if ((landing?.kind === 'landed' || landing?.kind === 'create') && !landing.serves) return landing.why
  return null
}

/** The landing status in a destination that can take it (the guard's decision). Pure. */
export function landingOf(landing: LandingFacts | null): { status: 'will-create' | 'already-there' | 're-enable'; existingTargetId: string | null } {
  if (landing?.kind === 'landed') return { status: 'already-there', existingTargetId: landing.targetId }
  if (landing?.kind === 'enable') return { status: 're-enable', existingTargetId: landing.targetId }
  return { status: 'will-create', existingTargetId: null }
}

const roleRank = (g: HarvestGroup, isAsin: boolean) => [g.roleFromName ? 1 : 0, isAsin ? g.productTargets : g.keywords] as const

/**
 * The suggested place for a person's (Claude's, a rule's) harvest at this match: the brain's order, with a person's rules
 * for an ad group (the brain's levers do not hold a person). Pure.
 */
export function suggestDestination(p: PlanProduct, t: PlanTerm, match: HarvestMatch, landing: (adGroupId: string) => LandingFacts | null):
  | { kind: 'existing'; how: 'stored' | 'playbook' | 'own' | 'ranked'; group: HarvestGroup; why: string }
  | { kind: 'new'; why: string }
  | { kind: 'held'; hold: Hold } {
  const groups = p.facts.groups
  const can = (g: HarvestGroup) => !placeRefusal(g, t.isAsin, landing(g.id))
  const stored = p.storedFor(t.term, t.isAsin ? 'PRODUCT' : match)
  if (stored) {
    const g = groups.get(stored.adGroupId)
    if (!stored.own || !g) return { kind: 'held', hold: { kind: 'destination', label: 'Saved place not usable', reason: `Your saved harvest place (${stored.grain}) is not one of this product's own ad groups.` } }
    const no = placeRefusal(g, t.isAsin, landing(g.id))
    if (no) return { kind: 'held', hold: { kind: 'destination', label: 'Saved place blocked', reason: `Your saved harvest place "${g.name}" cannot take it now: ${no}.` } }
    return { kind: 'existing', how: 'stored', group: g, why: `your saved harvest place: "${g.name}" in "${g.campaignName}"` }
  }
  const wanted = (g: HarvestGroup) => g.manual && g.role !== 'AUTO' && (t.isAsin ? g.productTargets > 0 : g.role === match)
  if (match === 'EXACT' || t.isAsin) {
    for (const s of [...p.facts.slots].sort((a, b) => a.key.localeCompare(b.key))) {
      const g = s.adGroupId ? groups.get(s.adGroupId) : [...groups.values()].find((x) => x.campaignId === s.campaignId && wanted(x) && can(x))
      if (g && wanted(g) && can(g)) return { kind: 'existing', how: 'playbook', group: g, why: `the product's playbook slot "${s.key}": "${g.name}" in "${g.campaignName}"` }
    }
  }
  const kind = [...groups.values()].filter(wanted)
  const able = kind.filter(can)
  if (able.length === 1) return { kind: 'existing', how: 'own', group: able[0], why: `the product's ${match.toLowerCase()} ad group "${able[0].name}"` }
  if (able.length > 1) {
    const top = [...able].sort((a, b) => {
      const ka = roleRank(a, t.isAsin), kb = roleRank(b, t.isAsin)
      return kb[0] - ka[0] || kb[1] - ka[1] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    })[0]
    return { kind: 'existing', how: 'ranked', group: top, why: `the best of ${plural(able.length, `${match.toLowerCase()} ad group`)}: "${top.name}" (the most ${t.isAsin ? 'product targets' : 'keywords'})` }
  }
  if (kind.length) {
    return { kind: 'held', hold: { kind: 'destination', label: kind.every((g) => !g.serving) ? `${match === 'EXACT' ? 'Exact' : 'Phrase'} group paused` : 'Pick a place', reason: `The product's ${match.toLowerCase()} ad group${kind.length === 1 ? '' : 's'} cannot take it now: ${kind.map((g) => `"${g.name}" — ${placeRefusal(g, t.isAsin, landing(g.id))}`).join('; ')}.` } }
  }
  return { kind: 'new', why: `the product has no ${t.isAsin ? 'product-target' : match.toLowerCase()} ad group: a new campaign for it` }
}

/**
 * Every ad group of the product where the term ran, with what the harvest does there (see the header). The destination
 * itself is kept (a negative there would block the new keyword). Pure.
 */
export function sourceBlocks(p: PlanProduct, t: PlanTerm, match: HarvestMatch, destAdGroupId: string | null, opts: { negateSource?: boolean; storedKeeps: boolean; actor: ActorKind }): BlockState[] {
  const out: BlockState[] = []
  const negatives = t.decision?.negatives ?? []
  const protectedTerm = t.decision?.protection === 'protected-term'
  for (const s of t.sources) {
    const g = p.facts.groups.get(s.adGroupId)
    if (!g) continue
    const base = { adGroupId: g.id, campaignId: g.campaignId, clicks: s.clicks, role: g.role }
    const negMatch: HarvestMatch = match === 'PHRASE' && !t.isAsin && (g.role === 'BROAD' || g.role === 'AUTO') ? 'PHRASE' : 'EXACT'
    const standing = negatives.find((n) => (n.level === 'CAMPAIGN' ? n.campaignId === g.campaignId : n.adGroupId === g.id) && (n.match === 'EXACT' || n.match === 'PHRASE' || n.match === 'PRODUCT') && (negMatch === 'EXACT' || n.match === 'PHRASE'))
    const cs = p.facts.campaigns.get(g.campaignId)
    let action: BlockState['action']
    let why: string
    if (g.id === destAdGroupId) { action = 'kept'; why = 'the destination itself: a negative there would block the new keyword' }
    else if (p.paused.has(g.id)) { action = 'skipped'; why = 'harvesting from this source is paused (Sources): it is left as it is' }
    else if (opts.negateSource === false) { action = 'kept'; why = 'left running: the request asked not to block the sources' }
    else if (opts.storedKeeps && opts.negateSource !== true) { action = 'kept'; why = 'your saved harvest place says not to block the source: the term keeps running here too' }
    else if (protectedTerm) { action = 'skipped'; why = 'a protected term is never negated anywhere' }
    else if (opts.actor === 'RULE' && p.brainRuns && cs && !cs.excluded && LEVER_HOLDS.includes(String(cs.negatives))) { action = 'skipped'; why = 'the brain runs this campaign\'s negatives: a rule leaves it' }
    else if (standing) { action = 'standing'; why = `a negative already blocks it in "${g.name}"` }
    else { action = 'negate'; why = `negative ${negMatch.toLowerCase()} in "${g.name}" (${g.role ? g.role.toLowerCase() : 'where it ran'}): the source stops paying for it` }
    out.push({ ...base, action, why, negMatch })
  }
  return out
}

/**
 * The funnel blocks the add implies (the Owner's 10-09 funnel): the product's looser ad groups that are not a source, not
 * the destination, and do not hold the term as their own keyword. Pure.
 */
export function funnelBlocks(p: PlanProduct, t: PlanTerm, match: HarvestMatch, destAdGroupId: string | null, sources: readonly BlockState[]): BlockState[] {
  if (t.isAsin) return []
  if (t.decision?.protection === 'protected-term') return []
  const looser = LOOSER[match]
  const sourceIds = new Set(sources.map((s) => s.adGroupId))
  const ownKeywordIn = new Set((t.decision?.targets ?? []).map((x) => x.adGroupId))
  const negatives = t.decision?.negatives ?? []
  const out: BlockState[] = []
  for (const g of [...p.facts.groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    if (!g.role || !looser.includes(g.role) || g.id === destAdGroupId || sourceIds.has(g.id) || ownKeywordIn.has(g.id)) continue
    const standing = negatives.find((n) => (n.level === 'CAMPAIGN' ? n.campaignId === g.campaignId : n.adGroupId === g.id) && (match === 'EXACT' ? n.match === 'EXACT' || n.match === 'PHRASE' : n.match === 'PHRASE'))
    out.push({
      adGroupId: g.id, campaignId: g.campaignId, role: g.role, negMatch: match,
      action: standing ? 'standing' : 'negate',
      why: standing ? `a negative already blocks it in "${g.name}"` : `funnel: negative ${match.toLowerCase()} in "${g.name}" (${g.role.toLowerCase()}), so the ${match.toLowerCase()} keyword is the term's one owner`,
    })
  }
  return out
}

/** The start bid (see the header). Pure. */
export function startBidOf(p: PlanProduct, t: PlanTerm, destGroup: HarvestGroup | null, asked: number | undefined): { cents: number; why: string } | { refusal: string } {
  if (asked != null) {
    if (!Number.isFinite(asked) || asked < 2) return { refusal: 'the bid asked is below Amazon\'s lowest bid (2 cents)' }
    return { cents: Math.round(asked), why: 'the bid you set' }
  }
  const limits = destGroup
    ? { ...(p.facts.strategyLimits.get(destGroup.id) ?? p.facts.marketLimits), campaignMinCents: destGroup.campaignMinCents, campaignMaxCents: destGroup.campaignMaxCents }
    : p.facts.marketLimits
  if (t.decision) {
    const goal = startBid(t.decision, p.facts.ctx, limits)
    if (!('refusal' in goal)) return goal
    const cpc = t.decision.tests.cpcCents
    if (cpc != null && cpc > 0) {
      const lo = Math.max(MIN_START_BID_CENTS, limits.minBidCents ?? 0)
      const hi = limits.maxBidCents ?? Number.POSITIVE_INFINITY
      const cents = Math.round(Math.min(hi, Math.max(lo, cpc)))
      return { cents, why: `the term's observed cost per click${cents !== Math.round(cpc) ? ', held inside the strategy\'s lowest and highest bid' : ''} (${goal.refusal})` }
    }
    return { refusal: `no start bid: ${goal.refusal}, and the term has no click cost of its own — set a bid` }
  }
  return { refusal: 'no start bid: the term has no evidence in this product — set a bid' }
}

/** A new harvest campaign's name and ad group name: the SP Super Wizard's custom naming, new in the market. Pure. */
export function harvestCampaignName(label: string, match: HarvestMatch, taken: ReadonlySet<string>): { name: string; adGroupName: string } {
  const group = (label || 'Product').replace(/[·|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Product'
  const [row] = generateCampaignRows(group, 'custom', [{ name: HARVEST_KEYWORD_TYPE, matchTypes: [match], keywords: ['x'] }], ['keyword'], [...DEFAULT_CUSTOM_NAME_TOKENS])
  const base = (row?.name ?? `${group}-SP-Keyword-${match === 'EXACT' ? 'Exact' : 'Phrase'}-${HARVEST_KEYWORD_TYPE}`).slice(0, CAMPAIGN_NAME_MAX)
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()) && n < 100; n++) {
    const suffix = ` (${n})`
    name = `${base.slice(0, CAMPAIGN_NAME_MAX - suffix.length)}${suffix}`
  }
  return { name, adGroupName: `${name} Ad Group`.slice(0, CAMPAIGN_NAME_MAX) }
}

/**
 * Plan one item. `record` is the term's harvest record (any actor) when one exists; `newCampaign` the change set's new
 * campaign the item names (its key resolved), or null. Pure.
 */
export function planItem(a: {
  req: PlanItemRequest
  actor: ActorKind
  product: PlanProduct
  term: PlanTerm
  record: { status: string; actorKind: string; destAdGroupId?: string | null } | null
  waiting: boolean
  newCampaign: NewCampaignSpec | null
  landing: (adGroupId: string) => LandingFacts | null
}): PlannedItem {
  const { product: p, term: t } = a
  // A harvest left HALF_DONE (a paused keyword switched on, its blocks owed until Amazon confirmed it): harvesting the term
  // again completes it in the same place — the keyword stands there now, only the owed blocks are written.
  const completing = a.record?.status === 'HALF_DONE' && !!a.record.destAdGroupId
  const req: PlanItemRequest = completing && !a.req.to ? { ...a.req, to: { adGroupId: a.record!.destAdGroupId! } } : a.req
  const match: HarvestMatch = t.isAsin ? 'EXACT' : (req.match ?? 'EXACT')
  const base = { candidateId: req.candidateId, productId: p.productId, market: p.market, term: t.term, isAsin: t.isAsin, match }
  const stored = p.storedFor(t.term, t.isAsin ? 'PRODUCT' : match)
  const storedKeeps = !!stored?.own && stored.negateAtSource === false
  const e = t.decision?.evidence
  const harvestedOn = e ? { impressions: e.impressions, clicks: e.clicks, orders: e.orders, cr: Number((t.decision!.tests.cr ?? 0).toFixed(6)), money: { spendCents: e.spendCents, salesCents: e.salesCents } } : null
  const refuse = (hold: Hold, extra: Partial<PlannedItem> = {}): PlannedItem => ({ ...base, refusal: hold.reason, hold, destination: null, bid: null, sources: [], funnel: [], storedKeepsSources: storedKeeps, harvestedOn, ...extra })

  if (t.isAsin && req.match === 'PHRASE') return refuse({ kind: 'destination', label: 'ASIN: exact only', reason: 'An ASIN is harvested as a product target, never as a phrase keyword.' })
  if (a.waiting) return refuse({ kind: 'record', label: 'Waiting for you', reason: 'A harvest of this term already waits for a person: approve or reject it first.' })
  if (a.record && ['WRITING', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'UNDO_PROPOSED'].includes(a.record.status)) {
    return refuse({ kind: 'record', label: 'In progress', reason: `A harvest of this term is in progress (${a.record.status.toLowerCase().replace(/_/g, ' ')}): it finishes first.` })
  }
  if (a.record && a.record.status === 'DONE') return refuse({ kind: 'record', label: 'Harvested', reason: 'This term was harvested already: its keyword is its one home (undo it first to move it).' })
  const home = (t.decision?.targets ?? []).find((x) => x.match === 'EXACT' || (t.isAsin && x.match === 'PRODUCT') || (match === 'PHRASE' && x.match === 'PHRASE'))
  if (home && !(req.to && 'adGroupId' in req.to && home.adGroupId === req.to.adGroupId)) {
    const g = p.facts.groups.get(home.adGroupId)
    return refuse({ kind: 'home', label: 'Already a keyword', reason: `It is already a ${home.match.toLowerCase()} keyword of this product${g ? ` in "${g.name}"` : ''}: one owner per term.` })
  }
  if (a.actor === 'RULE' || a.actor === 'BRAIN') {
    if (t.decision?.lead && !t.decision.lead.isThis) return refuse({ kind: 'sibling', label: 'Another product leads', reason: `Product ${t.decision.lead.leadProductId} leads this term in the market: this product's automatic harvest leaves it.` })
    // D2 / B3 — a rule harvests only what passes the ONE bar (the strategy's group, else the brain's test).
    if (a.actor === 'RULE' && !t.decision?.tests.harvest.pass) return refuse({ kind: 'record', label: 'Below the bar', reason: 'It does not pass the harvest bar (the ads strategy\'s, else the brain\'s test): a rule leaves it.' })
  }
  // M5 — no harvest (a person's, Claude's, a rule's, the brain's) takes a term from a source a person paused.
  if (t.sources.length && t.sources.every((s) => p.paused.has(s.adGroupId))) return refuse({ kind: 'source', label: 'Source paused', reason: 'Harvesting from its source is paused (Sources): resume it first.' })

  // The destination: the one asked, else the suggested place.
  let destination: PlannedDestination | null = null
  let destGroup: HarvestGroup | null = null
  if (req.to && 'adGroupId' in req.to) {
    const g = p.facts.groups.get(req.to.adGroupId) ?? null
    const land = a.landing(req.to.adGroupId)
    const no = placeRefusal(g ?? undefined, t.isAsin, land)
    if (no) return refuse({ kind: 'destination', label: 'Place not usable', reason: `That ad group cannot take it: ${no}.` })
    if (a.actor === 'RULE') {
      const cs = p.facts.campaigns.get(g!.campaignId)
      if (p.brainRuns && cs && !cs.excluded && LEVER_HOLDS.includes(String(cs.harvest))) return refuse({ kind: 'lever', label: 'Brain decides', reason: 'The brain runs harvests in that campaign: a rule leaves it.' })
    }
    destGroup = g
    destination = { kind: 'existing', how: 'chosen', adGroupId: g!.id, campaignId: g!.campaignId, ...landingOf(land), why: `the ad group you chose: "${g!.name}" in "${g!.campaignName}"` }
  } else if (req.to && 'newCampaign' in req.to) {
    if (!a.newCampaign) return refuse({ kind: 'destination', label: 'New campaign missing', reason: `The new campaign "${req.to.newCampaign}" is not described in this change set.` })
    if (a.newCampaign.productId !== p.productId) return refuse({ kind: 'destination', label: 'Other product', reason: 'The new campaign is for another product: a harvest goes into its own product\'s campaigns.' })
    // R1 (release review) — a campaign belongs to one market: a term of another market never lands in it (its own market's
    // sources would be negated while its keyword served elsewhere).
    if (a.newCampaign.market && a.newCampaign.market !== p.market) return refuse({ kind: 'destination', label: 'Other market', reason: `The new campaign is in ${a.newCampaign.market}, this term in ${p.market}: a campaign belongs to one market — give each market its own new campaign.` })
    if (a.newCampaign.match !== match) return refuse({ kind: 'destination', label: 'Match differs', reason: `The new campaign is a ${a.newCampaign.match.toLowerCase()} campaign: harvest it as ${a.newCampaign.match.toLowerCase()}, or pick another place.` })
    destination = { kind: 'new', how: 'chosen', key: a.newCampaign.key, why: `the new campaign "${a.newCampaign.name}"` }
  } else if (a.actor === 'BRAIN' && match === 'EXACT') {
    const c = chooseDestination({ decision: t.decision!, sources: t.sources, stored: p.storedFor(t.term, t.isAsin ? 'PRODUCT' : 'EXACT') }, p.facts)
    if ('held' in c) return refuse({ kind: 'destination', label: 'Place blocked', reason: c.held })
    if (c.kind !== 'EXISTING') return refuse({ kind: 'destination', label: 'Needs a campaign', reason: c.why })
    destGroup = p.facts.groups.get(c.adGroupId)!
    const no = destinationRefusal(destGroup, t.term, t.isAsin, p.facts)
    if (no) return refuse({ kind: 'destination', label: 'Place blocked', reason: no })
    destination = { kind: 'existing', how: c.how, adGroupId: c.adGroupId, campaignId: c.campaignId, ...landingOf(a.landing(c.adGroupId)), why: c.why }
  } else {
    const s = suggestDestination(p, t, match, a.landing)
    if (s.kind === 'held') return refuse(s.hold)
    if (s.kind === 'new') return refuse({ kind: 'destination', label: 'Needs a campaign', reason: `${s.why[0].toUpperCase()}${s.why.slice(1)}: pick an ad group or a new campaign.` })
    if (a.actor === 'RULE') {
      const cs = p.facts.campaigns.get(s.group.campaignId)
      if (p.brainRuns && cs && !cs.excluded && LEVER_HOLDS.includes(String(cs.harvest))) return refuse({ kind: 'lever', label: 'Brain decides', reason: 'The brain runs harvests in that campaign: a rule leaves it.' })
    }
    destGroup = s.group
    destination = { kind: 'existing', how: s.how, adGroupId: s.group.id, campaignId: s.group.campaignId, ...landingOf(a.landing(s.group.id)), why: s.why }
  }

  const bid = startBidOf(p, t, destGroup, req.bidCents)
  if ('refusal' in bid) return refuse({ kind: 'bid', label: 'Needs a bid', reason: `${bid.refusal[0].toUpperCase()}${bid.refusal.slice(1)}.` }, { destination })
  const destAdGroupId = destination.kind === 'existing' ? destination.adGroupId : null
  const sources = sourceBlocks(p, t, match, destAdGroupId, { negateSource: req.negateSource, storedKeeps, actor: a.actor })
  const funnel = a.actor === 'BRAIN' || req.funnel === false ? [] : funnelBlocks(p, t, match, destAdGroupId, sources)
  return { ...base, refusal: null, hold: null, destination, bid, sources, funnel, storedKeepsSources: storedKeeps, harvestedOn }
}
