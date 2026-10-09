/**
 * ONE BRAIN AB-16 — the structure lever of one product in one market (design 2026-10-08-ads-one-brain/DESIGN.md §2.9, §2.6
 * N2, §4 step 3 "structure (weekly)", §5, §8 row AB-16, §10 D1 = B and D2 = A; INDUSTRY-2026-10.md §2.6, §2.7, §6 U4). Pure:
 * no database and no clock. brain/structure-load.ts loads the facts, brain/structure-run.ts stores the decisions and asks
 * a person, brain/structure-golive.ts answers the code rule's question for a brain-built campaign.
 *
 *   SKC        a single-keyword campaign: ONE campaign with ONE exact keyword for a term of the product, so its placement
 *              percentages and its hours can follow that term alone (Amazon sets both per campaign [PER-4]; Quartile learns
 *              per keyword × placement × hour only on single-keyword campaigns [QRT-2], [QRT-3]). Proposed when the term —
 *                orders   carries at least `skcOrderSharePct` (15 %) of the product's ad orders over the 30 settled days, with
 *                         at least SKC_MIN_ORDERS orders of its own (I: a share of a handful of orders is noise; Scale
 *                         Insights' bar for a term of its own is 3 orders [SCI-4]);
 *                hours    has an hour curve of its own: its hourly conversion index differs from the rest of its campaign
 *                         by at least `skcHourCurvePct` points in one part of the day (the painting's own envelope, §2.3),
 *                         over HOUR_CURVE_WEEKS weeks of the Marketing Stream's ad-group hours (BB-16) — measurable only
 *                         where the term carries most of its ad group's clicks (the stream has no keyword grain);
 *                winner   is a term whose next step in the playbook's winners view is a campaign of its own (winners.ts:
 *                         declining or lost where it runs, its bid and placement rungs closed).
 *              It must already have an exact home in the product's own campaigns (a term without one is the harvest's to
 *              place first, AB-11 — its own new campaign is one keyword too), not run alone in a campaign of its own
 *              already, and not be led by a sibling product (the market arbiter, AB-9). An ASIN stays a product target.
 *              The builder: the playbook's hero (apply-ads-playbook op hero, linked as slot hero:<term>, started by the
 *              playbook's START) for a product the playbook runs — never for a term winning where it runs (PB-6c keeps a
 *              winner where it wins, the Owner's rule 2: held, named); create-ad-campaign (the Single Campaign builder's
 *              own launch) for a product without a playbook. Born at the 2-cent floor with its planned bid remembered and
 *              off the live-write allowlist (the builders' own way); the term keeps running where it runs now — nothing is
 *              negated or lowered there; its old place closes only once the new campaign proves itself, by a separate
 *              request (the winners view's handover). After its go-live the bid brain graduates its bid.
 *   SPLIT      a campaign that advertises several products (shared: no product's brain owns it, D2 = A) → one campaign
 *              per product through replicate-ad-structure: the same keywords, product targets, auto groups and negatives,
 *              each copy advertising ONE product's own SKUs. Its migration plan: bids copied as they are (the bid brain
 *              then steers each), negatives copied, the terms the product's own campaigns already buy left out of its copy
 *              (one owner per term), every other keyword accepted on the record (it overlaps only the shared campaign);
 *              each copy's first budget its product's share of the shared campaign's spend, held to the first-budget cap of
 *              an enrolled product; history stays with the shared campaign (Amazon cannot move it); the shared campaign
 *              goes to low bids once every copy is live (suppress-campaign, the Owner's temporary stop) — never paused or
 *              archived by the split. Held when an ad cannot be tied to a product, the Owner excluded the campaign or keeps
 *              an enrolled product's structure lever with him, or a product of it has no SKU Nexus knows.
 *   PORTFOLIO  the product's own campaigns outside its one portfolio → moved into it (N2: a portfolio cap can follow a
 *              product only where the portfolio holds that product alone; set-campaign-settings, day-to-day). The product's
 *              portfolio: its playbook's portfolio when that holds no other product's campaign, else the portfolio holding
 *              only its campaigns (the most of them). None: held, named (create one, then the move is proposed). Off with
 *              `ownPortfolio`; held while the Owner locks the portfolioCap lever; a campaign he excluded is left.
 *   level      the structure lever (brain/settings.ts): OBSERVE logs each proposal (shadow); PROPOSE asks a person for each
 *              build, each go-live and each move — the env ceiling NEXUS_ADS_BRAIN_STRUCTURE_MODE=live (and the brain's own
 *              NEXUS_BID_BRAIN_MODE=live) lets it ask, anything else only logs; LOCKED keeps proposals as recommendations.
 *              AUTO is never offered: the brain never creates, splits or moves a campaign without a person's approval.
 *   caps       §2.9 / §5, shared with the harvest's new campaigns: at most `newCampaignsPerWeek` (2) new campaigns per
 *              product per week, MARKET_NEW_CAMPAIGNS_PER_WEEK (6) per market, `skcMax` (20) single-keyword campaigns per
 *              product; a first budget at most `firstBudgetPctOfEnvelope` (10 %) of the day's share of the envelope (at
 *              least Amazon's lowest). A split takes one campaign per product from the market's cap and one from the
 *              deciding product's.
 *   go-live    D1 = B: a campaign the brain built for an enrolled product goes live with a normal approval while it is
 *              inside the caps (goLiveVerdict); outside them the code rule stays as it was (ads-code-rule.ts).
 *   template   each build declares who owns each lever of the new campaign (templateOwners; I, IND §2.7), so a build can
 *              never create a conflict.
 *   words      no money and no ACoS figure in a `why`; amounts sit under `money` keys (the read tool hides them).
 */
import { AMAZON_MIN_BUDGET_CENTS, CAMPAIGN_NAME_MAX, MARKET_NEW_CAMPAIGNS_PER_WEEK } from './harvest.js'
import { PARTS, partWords, poolCurves, type HourCell } from './hours-research.js'
import type { LeverEffective } from './terms.js'

export const STRUCTURE_KINDS = ['SKC', 'SPLIT', 'PORTFOLIO'] as const
export type StructureKind = (typeof STRUCTURE_KINDS)[number]
export const isStructureKind = (v: unknown): v is StructureKind => typeof v === 'string' && (STRUCTURE_KINDS as readonly string[]).includes(v)

export const STRUCTURE_STATUSES = ['SHADOW', 'HELD', 'PROPOSED', 'BUILT', 'LIVE_PROPOSED', 'LIVE', 'DONE', 'DECLINED', 'FAILED'] as const
export type StructureStatus = (typeof STRUCTURE_STATUSES)[number]
export const isStructureStatus = (v: unknown): v is StructureStatus => typeof v === 'string' && (STRUCTURE_STATUSES as readonly string[]).includes(v)
/** In flight or placed: the key is never decided again (a campaign is built once). */
export const STANDING_STATUSES: readonly StructureStatus[] = ['PROPOSED', 'BUILT', 'LIVE_PROPOSED', 'LIVE', 'DONE']
/** Ended without standing: decided again after COOLDOWN_DAYS. */
export const ENDED_STATUSES: readonly StructureStatus[] = ['DECLINED', 'FAILED']
/** A declined or failed proposal (or go-live) is not asked again for this long (as a declined harvest). */
export const COOLDOWN_DAYS = 30

/** §2.9 b — the window the order share is read over, in settled days. */
export const SKC_WINDOW_DAYS = 30
/** A term needs this many orders of its own before its share counts (I; Scale Insights' bar for a term of its own [SCI-4]). */
export const SKC_MIN_ORDERS = 3
/** §2.9 b — the weeks of hourly data the hour-curve test reads, and the days of them it needs at least. */
export const HOUR_CURVE_WEEKS = 4
export const HOUR_CURVE_MIN_DAYS = 21
/** The term's own side of the hour curve needs this many (1-day) orders (as the research's market curve, hours-research.ts). */
export const HOUR_CURVE_MIN_ORDERS = 10
/** The stream has no keyword grain: a term's hours are its ad group's only where it carries this share of the group's clicks. */
export const HOUR_CURVE_TERM_SHARE = 0.6
/** replicate-ad-structure takes at most this many skipped and accepted keywords each. */
export const MAX_SPLIT_TERMS = 250
/** set-campaign-settings moves at most this many campaigns in one request. */
export const MAX_MOVE = 100
/** Who asks: the brain, as a system principal (never a person). */
export const STRUCTURE_ASKER = 'Nexus ads brain'
export { MARKET_NEW_CAMPAIGNS_PER_WEEK }

/** The builders and tools a structure proposal goes through (Owner rule: only Nexus's own builders). */
export const STRUCTURE_TOOLS = {
  create: 'create-ad-campaign',
  playbook: 'apply-ads-playbook',
  replicate: 'replicate-ad-structure',
  settings: 'set-campaign-settings',
  liveWrites: 'set-campaign-live-writes',
  restore: 'restore-campaign',
  suppress: 'suppress-campaign',
} as const

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pct = (x: number) => Math.round(x * 1000) / 10

export const skcKey = (productId: string, term: string) => `skc:${productId}:${term}`
export const splitKey = (campaignId: string) => `split:${campaignId}`
export const portfolioKey = (productId: string) => `portfolio:${productId}`

// ── Facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SkcReason = 'orders' | 'hours' | 'winner'

/** The hour-curve test of one term: measured (its distance and the part of the day it differs most in) or why not. */
export type HourTest =
  | { measured: true; distancePct: number; part: number; termOrders: number; restOrders: number; days: number }
  | { measured: false; why: string }

/** One term of the product's own campaigns over the settled window. */
export interface SkcTermFact {
  /** Normalised (brain/terms.ts termKey). */
  term: string
  isAsin: boolean
  orders: number
  clicks: number
  spendCents: number
  salesCents: number
  /** Its exact keyword in the product's own campaigns (the one with the most clicks); null: no exact home. */
  home: { campaignId: string; campaignName: string; adGroupId: string; targetId: string; bidCents: number | null; campaignPositives: number } | null
  /** A campaign of the product that runs it alone already (a single-keyword campaign, a hero), by name; null: none. */
  ownCampaign: string | null
  /** The sibling product the market arbiter gave it to (AB-9); null: none, or this product. */
  ledBy: string | null
  hours: HourTest
  /** The playbook winners view (winners.ts): its state where it runs and its next step; null: no entry (or no playbook). */
  winner: { state: 'winning' | 'declining' | 'lost' | 'unproven'; nextStep: string; why: string } | null
}

/** One product of a shared campaign, as a split plans its copy. */
export interface SplitProductFact {
  productId: string
  label: string
  /** Its SKUs advertised in the shared campaign (each copy advertises its own only). */
  skus: string[]
  enrolled: boolean
  /** Its structure lever (product level); NOT_ENROLLED for a product not in the brain. */
  structure: LeverEffective
  structureWhy: string
  /** Its share of the shared campaign's spend over the window (null: no product-ad report rows). */
  spendShare: number | null
  /** Enrolled: its first-budget cap (firstBudgetCap); null when not enrolled. */
  firstBudgetCapCents: number | null
  /** The keywords of the shared campaign its own campaigns already buy (normalised): left out of its copy. */
  ownBought: string[]
}

export interface SharedCampaignFact {
  campaignId: string
  name: string
  status: string
  dailyBudgetCents: number
  products: SplitProductFact[]
  /** Ads Nexus cannot tie to a product (ASIN / SKU): a split cannot place them. */
  unresolved: string[]
  /** The Owner excluded the campaign from the brain (why), or null. */
  excluded: string | null
  /** Its positive keywords (normalised, unique). */
  keywords: string[]
  counts: { keywords: number; productTargets: number; autoGroups: number; negatives: number }
}

/** A portfolio that holds some of the product's own campaigns. */
export interface PortfolioFact {
  portfolioId: string
  name: string | null
  /** The product's own campaigns in it. */
  own: string[]
  /** Other campaigns in it (another product's, shared or untied). */
  others: number
}

export interface StructureProductFacts {
  productId: string
  market: string
  label: string
  /** The structure lever (product level). */
  level: LeverEffective
  levelWhy: string
  /** The env ceiling of the structure's requests (both switches live). */
  ceiling: { live: boolean; why: string }
  /** The Owner's kill switch on the structure lever (AB-15), in words; null: none. */
  killed: string | null
  settings: { newCampaignsPerWeek: number; skcMax: number; skcOrderSharePct: number; skcHourCurvePct: number; ownPortfolio: boolean }
  windowDays: number
  /** The product's ad orders in its own campaigns over the window (the share's denominator, same source as the terms'). */
  productOrders: number
  terms: SkcTermFact[]
  shared: SharedCampaignFact[]
  /** The product's own campaigns (not archived) with their portfolio, and whether the Owner leaves them to the brain. */
  own: Array<{ campaignId: string; name: string; portfolioId: string | null; left: string | null }>
  portfolios: PortfolioFact[]
  /** Its playbook in the market: the row, whether the product is enrolled in it, and its portfolio link. Null: none. */
  playbook: { id: string; enrolled: boolean; portfolioId: string | null } | null
  /** What a create-ad-campaign SKC is built from; null with `newCampaignRefusal` when it cannot be. */
  newCampaign: { skus: string[]; dailyBudgetCents: number; budgetWhy: string; takenNames: ReadonlySet<string> } | null
  newCampaignRefusal: string | null
  /** The Owner locked the portfolioCap lever (why), or null. */
  portfolioLock: string | null
  /** This week's new campaigns (the harvest's and the structure's) and the standing single-keyword campaigns. */
  used: { campaignsThisWeek: number; marketCampaignsThisWeek: number; skcs: number }
  /** The structure records by key (a standing one is never decided again; an ended one waits its cooldown). */
  records: ReadonlyMap<string, { status: StructureStatus; changedAt: Date }>
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One request a person decides: a single tool call, or a change plan of several (one approval). */
export type StructureRequest =
  | { tool: string; args: Record<string, unknown> }
  | { plan: { title: string; steps: Array<{ tool: string; args: Record<string, unknown> }> } }

export type StructureAct = 'log' | 'propose' | 'none'

export interface StructureDecision {
  kind: StructureKind
  key: string
  productId: string
  term: string | null
  /** SPLIT: the shared campaign. */
  campaignId: string | null
  reasons: SkcReason[]
  /** log: shadow (stored, nothing asked) · propose: ask a person · none: held (why in heldBy). */
  act: StructureAct
  level: 'OBSERVE' | 'PROPOSE' | null
  builder: string | null
  request: StructureRequest | null
  /** Who owns each lever of the new campaign (templateOwners), for a build. */
  owners: Record<string, string> | null
  /** SPLIT: the migration plan in words. */
  migration: string[] | null
  heldBy: string | null
  why: string
  /** What it stands on; money under `money`. */
  evidence: Record<string, unknown>
}

/** The day's share of the monthly envelope a new campaign may start with, at least Amazon's lowest daily budget. Pure. */
export function firstBudgetCap(envelopeCents: number | null | undefined, month: string | null | undefined, pctOfEnvelope: number): { cents: number; why: string } {
  const [y, m] = (month ?? '').split('-').map(Number)
  const days = y && m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 30
  const share = envelopeCents && envelopeCents > 0 ? Math.floor((envelopeCents / days) * (pctOfEnvelope / 100)) : null
  if (share == null) return { cents: AMAZON_MIN_BUDGET_CENTS, why: 'Amazon\'s lowest daily budget: the money shadow (AB-7) planned no envelope for this product' }
  return share < AMAZON_MIN_BUDGET_CENTS
    ? { cents: AMAZON_MIN_BUDGET_CENTS, why: `${pctOfEnvelope} % of the day's share of the product's monthly envelope, raised to Amazon's lowest daily budget` }
    : { cents: share, why: `${pctOfEnvelope} % of the day's share of the product's monthly envelope (the money shadow's plan, AB-7)` }
}

/** A single-keyword campaign's name: "{product} | {market} | SKC | {term}", new in the market (a number added when taken). */
export function skcCampaignName(label: string, market: string, term: string, taken: ReadonlySet<string>): string {
  const base = `${label.trim() || 'Product'} | ${market} | SKC | ${term}`.slice(0, CAMPAIGN_NAME_MAX)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 100; n++) {
    const suffix = ` (${n})`
    const named = `${base.slice(0, CAMPAIGN_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(named.toLowerCase())) return named
  }
  return `${base.slice(0, CAMPAIGN_NAME_MAX - 9)} (${term.length})`
}

/**
 * Who owns each lever of a campaign the brain builds (I, IND §2.7: a template declares it, so a build can never create a
 * conflict). Pure.
 */
export function templateOwners(kind: 'SKC' | 'SPLIT'): Record<string, string> {
  const common = {
    bids: 'the product\'s brain (bids lever): born at the 2-cent floor with its planned bids remembered; after its go-live the bid brain graduates each bid toward the goal, at most one step a data day',
    budgets: 'the product\'s brain (budgets lever): a first budget held to the first-budget cap, then sized to its expected spend inside the pace',
    state: 'the product\'s brain (state lever): its pauses for long stops and for weeks without an impression (never an archive)',
    negatives: 'the product\'s negative set, copied to every campaign of the product by the negatives lever (AB-10) — never a negative over its own keyword',
    portfolio: 'the product\'s one portfolio (N2): a campaign born outside it is proposed for the move',
    biddingStrategy: 'down only at birth; the bidding-strategy lever decides later (AB-17)',
  }
  return kind === 'SKC'
    ? {
      ...common,
      placementsAndHours: 'its own: the campaign\'s placement percentages and its hourly plan follow this one term (the reason a single-keyword campaign exists)',
      harvest: 'a destination for its own term only, never a harvest source (one exact keyword: no search term to mine)',
      term: 'the term keeps running where it runs now (a winner is never moved); its old place closes only by a separate request once this campaign proves itself',
    }
    : {
      ...common,
      placementsAndHours: 'copied from the shared campaign, set at its go-live; then its own product\'s hourly plan',
      harvest: 'the shared campaign\'s role, for its own product only: an auto or broad copy stays a harvest source, its harvests go to the product\'s own exact ad group',
      term: 'the same targets as the shared campaign for one product; the terms the product\'s own campaigns already buy are left out (one owner per term)',
    }
}

// ── Hours (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The hour-curve distance of a term from the rest of its campaign: both curves by part of the day (6 × 4 hours,
 * brain/hours-research.ts poolCurves), the term's conversion index shrunk toward the rest's the Gamma–Poisson way (the rest
 * is the term's prior: a few lucky orders do not make a curve of its own), each normalised to its own traffic. The
 * distance is the largest gap between the two indexes, in points (30 = the painting's whole envelope of one move). Pure.
 */
export function hourCurveDistance(term: readonly HourCell[], rest: readonly HourCell[]): { distancePct: number; part: number; termOrders: number; restOrders: number } {
  const restCurves = poolCurves(rest, null)
  const termCurves = poolCurves(term, restCurves)
  let best = 0
  let part = 0
  for (let p = 0; p < PARTS; p++) {
    const gap = Math.abs(termCurves.part.cr[p] - restCurves.part.cr[p])
    if (gap > best) { best = gap; part = p }
  }
  return { distancePct: Math.round(best * 1000) / 10, part, termOrders: termCurves.total.orders, restOrders: restCurves.total.orders }
}

// ── Deciding ─────────────────────────────────────────────────────────────────────────────────────────────────────

const UNTOUCHABLE: readonly LeverEffective[] = ['OFF', 'EXCLUDED', 'NOT_ENROLLED']

/** The level a decision is taken at, and what it does with it (log, ask, or hold), given the lever, the kill and the ceiling. */
function actOf(f: StructureProductFacts): { act: StructureAct; level: 'OBSERVE' | 'PROPOSE' | null; heldBy: string | null } {
  if (f.level === 'LOCKED') return { act: 'none', level: null, heldBy: `${f.levelWhy}: a recommendation only, nothing is asked` }
  if (f.killed) return { act: 'log', level: f.level === 'PROPOSE' ? 'PROPOSE' : 'OBSERVE', heldBy: `the structure lever is ${f.killed}: logged only, nothing is asked` }
  if (f.level === 'PROPOSE') return f.ceiling.live ? { act: 'propose', level: 'PROPOSE', heldBy: null } : { act: 'log', level: 'PROPOSE', heldBy: `${f.ceiling.why}: it would ask a person` }
  return { act: 'log', level: 'OBSERVE', heldBy: null }
}

/** Whether a key may be decided now: never while it stands, not during an ended one's cooldown. */
function keyFree(f: StructureProductFacts, key: string, now: Date): boolean {
  const r = f.records.get(key)
  if (!r) return true
  if ((STANDING_STATUSES as readonly string[]).includes(r.status)) return false
  if ((ENDED_STATUSES as readonly string[]).includes(r.status)) return now.getTime() - r.changedAt.getTime() >= COOLDOWN_DAYS * 86_400_000
  return true
}

/** Which of the three reasons a term meets (pure). */
export function skcReasons(t: SkcTermFact, f: Pick<StructureProductFacts, 'productOrders' | 'settings'>): { reasons: SkcReason[]; words: string[] } {
  const reasons: SkcReason[] = []
  const words: string[] = []
  const share = f.productOrders > 0 ? t.orders / f.productOrders : 0
  if (t.orders >= SKC_MIN_ORDERS && share * 100 >= f.settings.skcOrderSharePct) {
    reasons.push('orders')
    words.push(`it brought ${pct(share)} % of the product's ad orders (${plural(t.orders, 'order')} of ${f.productOrders}; the bar is ${f.settings.skcOrderSharePct} % and ${SKC_MIN_ORDERS} orders)`)
  }
  if (t.hours.measured && t.hours.distancePct >= f.settings.skcHourCurvePct) {
    reasons.push('hours')
    words.push(`its hourly conversion differs from the rest of its campaign by ${t.hours.distancePct} points at ${partWords(t.hours.part)} (the bar is ${f.settings.skcHourCurvePct}): its own campaign can follow its own hours`)
  }
  if (t.winner?.nextStep === 'ownCampaign') {
    reasons.push('winner')
    words.push(`the playbook's winners view names a campaign of its own as its next step (${t.winner.state} where it runs)`)
  }
  return { reasons, words }
}

/** The single-keyword campaigns of the product, in the order they take the caps: winners first, then by orders. Pure. */
function decideSkcs(f: StructureProductFacts, now: Date, take: { campaigns: number; market: number; skcs: number }): StructureDecision[] {
  const out: StructureDecision[] = []
  const base = actOf(f)
  const ranked = f.terms
    .map((t) => ({ t, ...skcReasons(t, f) }))
    .filter((x) => x.reasons.length && !x.t.isAsin && !x.t.ownCampaign)
    // A term with no exact home is the harvest's to place first — unless the playbook's winners view asks for its own campaign.
    .filter((x) => x.t.home || x.reasons.includes('winner'))
    .filter((x) => keyFree(f, skcKey(f.productId, x.t.term), now))
    .sort((a, b) => Number(b.reasons.includes('winner')) - Number(a.reasons.includes('winner')) || b.t.orders - a.t.orders || a.t.term.localeCompare(b.t.term))
  for (const { t, reasons, words } of ranked) {
    const evidence: Record<string, unknown> = {
      orders: t.orders, clicks: t.clicks, productOrders: f.productOrders, windowDays: f.windowDays,
      sharePct: f.productOrders > 0 ? pct(t.orders / f.productOrders) : null,
      hours: t.hours, winner: t.winner, home: t.home ? { campaignId: t.home.campaignId, campaignName: t.home.campaignName, adGroupId: t.home.adGroupId, campaignPositives: t.home.campaignPositives } : null,
      money: { spendCents: t.spendCents, salesCents: t.salesCents, homeBidCents: t.home?.bidCents ?? null },
    }
    const d: StructureDecision = {
      kind: 'SKC', key: skcKey(f.productId, t.term), productId: f.productId, term: t.term, campaignId: null, reasons,
      act: base.act, level: base.level, builder: null, request: null, owners: templateOwners('SKC'), migration: null, heldBy: base.heldBy,
      why: `a campaign of its own for "${t.term}": ${words.join('; ')}`, evidence,
    }
    const held = (why: string): StructureDecision => ({ ...d, act: 'none', heldBy: why })
    if (t.ledBy) { out.push(held(`the market arbiter gave "${t.term}" to its sibling product ${t.ledBy} (AB-9): this product does not build around it`)); continue }
    // The builder: the playbook's hero for a product the playbook runs, else the Single Campaign builder.
    if (f.playbook?.enrolled) {
      if (t.winner?.state === 'winning') {
        out.push(held(`"${t.term}" wins where it runs: the playbook keeps a winner where it wins (PB-6c, the Owner's rule 2), so the brain builds no campaign of its own around it — a person may still build one`))
        continue
      }
      d.builder = STRUCTURE_TOOLS.playbook
      d.request = { tool: STRUCTURE_TOOLS.playbook, args: { op: 'hero', market: f.market, productId: f.productId, term: t.term, why: d.why.slice(0, 300) } }
    } else {
      if (!f.newCampaign) { out.push(held(`a campaign of its own cannot be built: ${f.newCampaignRefusal ?? 'unknown'}`)); continue }
      if (!t.home) { out.push(held(`"${t.term}" has no exact keyword in the product's own campaigns: the harvest places it first (AB-11)`)); continue }
      const bid = t.home.bidCents && t.home.bidCents >= 2 ? t.home.bidCents : null
      if (!bid) { out.push(held(`its exact keyword in "${t.home.campaignName}" has no bid to plan from`)); continue }
      const name = skcCampaignName(f.label, f.market, t.term, f.newCampaign.takenNames)
      d.builder = STRUCTURE_TOOLS.create
      d.request = {
        tool: STRUCTURE_TOOLS.create,
        args: {
          market: f.market, name, skus: f.newCampaign.skus, dailyBudgetCents: f.newCampaign.dailyBudgetCents, defaultBidCents: bid,
          keywords: [{ text: t.term, matchType: 'EXACT', bidCents: bid }], biddingStrategy: 'down', why: d.why.slice(0, 300),
        },
      }
      d.evidence = { ...d.evidence, campaignName: name, budgetWhy: f.newCampaign.budgetWhy, money: { ...(d.evidence.money as object), dailyBudgetCents: f.newCampaign.dailyBudgetCents, plannedBidCents: bid } }
    }
    const capHit = take.campaigns >= f.settings.newCampaignsPerWeek ? `past this week's cap of ${plural(f.settings.newCampaignsPerWeek, 'new campaign')} for this product (§5)`
      : take.market >= MARKET_NEW_CAMPAIGNS_PER_WEEK ? `past this week's cap of ${plural(MARKET_NEW_CAMPAIGNS_PER_WEEK, 'new campaign')} in ${f.market} (§5)`
        : take.skcs >= f.settings.skcMax ? `past the cap of ${plural(f.settings.skcMax, 'single-keyword campaign')} for this product (§2.9)` : null
    if (capHit) { out.push(held(`${capHit}: held for a later week`)); continue }
    if (d.act !== 'none') { take.campaigns++; take.market++; take.skcs++ }
    out.push(d)
  }
  return out
}

/** The split of one shared campaign into one campaign per product (D2 = A). Pure. */
function decideSplit(f: StructureProductFacts, c: SharedCampaignFact, now: Date, take: { campaigns: number; market: number }): StructureDecision | null {
  const key = splitKey(c.campaignId)
  if (!keyFree(f, key, now) || String(c.status) !== 'ENABLED') return null
  const base = actOf(f)
  const products = [...c.products].sort((a, b) => a.label.localeCompare(b.label) || a.productId.localeCompare(b.productId))
  const evidence: Record<string, unknown> = {
    products: products.map((p) => ({ productId: p.productId, label: p.label, skus: p.skus.length, enrolled: p.enrolled, structure: p.structure, spendSharePct: p.spendShare == null ? null : pct(p.spendShare), ownBought: p.ownBought.length })),
    unresolved: c.unresolved, counts: c.counts, money: { dailyBudgetCents: c.dailyBudgetCents },
  }
  const d: StructureDecision = {
    kind: 'SPLIT', key, productId: f.productId, term: null, campaignId: c.campaignId, reasons: [], act: base.act, level: base.level,
    builder: STRUCTURE_TOOLS.replicate, request: null, owners: templateOwners('SPLIT'), migration: null, heldBy: base.heldBy,
    why: `"${c.name}" advertises ${plural(products.length, 'product')} (${products.map((p) => p.label).join(', ')}): no product's brain owns it (D2 = A) — one campaign per product, the same targets, each with its own product's ads`,
    evidence,
  }
  const held = (why: string): StructureDecision => ({ ...d, act: 'none', heldBy: why })
  if (c.excluded) return held(`the Owner excluded "${c.name}" from the brain (${c.excluded}): no split is proposed`)
  if (c.unresolved.length) return held(`"${c.name}" carries ${plural(c.unresolved.length, 'ad')} Nexus cannot tie to a product (${c.unresolved.slice(0, 3).join(', ')}): a split cannot place ${c.unresolved.length === 1 ? 'it' : 'them'} — a person splits it`)
  // The Owner keeps an enrolled product's structure with him: no split around him. The strictest enrolled level wins.
  const kept = products.find((p) => p.enrolled && (UNTOUCHABLE.includes(p.structure) || p.structure === 'LOCKED'))
  if (kept) return held(`the structure lever of ${kept.label} is ${kept.structure} (${kept.structureWhy}): the split waits for the Owner`)
  if (products.some((p) => p.enrolled && p.structure === 'OBSERVE') && d.act === 'propose') { d.act = 'log'; d.level = 'OBSERVE'; d.heldBy = 'another enrolled product of the campaign keeps its structure lever in shadow: logged only' }
  const noSku = products.find((p) => !p.skus.length)
  if (noSku) return held(`${noSku.label} has no SKU Nexus knows in "${c.name}": its copy could not advertise it`)
  if (c.keywords.length > MAX_SPLIT_TERMS) return held(`"${c.name}" holds ${plural(c.keywords.length, 'keyword')}: more than one copy request carries (${MAX_SPLIT_TERMS}) — a person splits it in parts`)
  // The caps: one new campaign per product from the market's week, one from the deciding product's.
  if (take.campaigns >= f.settings.newCampaignsPerWeek) return held(`past this week's cap of ${plural(f.settings.newCampaignsPerWeek, 'new campaign')} for this product (§5): held for a later week`)
  if (take.market + products.length > MARKET_NEW_CAMPAIGNS_PER_WEEK) return held(`its ${plural(products.length, 'copy', 'copies')} would pass this week's cap of ${plural(MARKET_NEW_CAMPAIGNS_PER_WEEK, 'new campaign')} in ${f.market} (§5): held for a later week`)

  const shares = products.map((p) => p.spendShare)
  const known = shares.every((s) => s != null) && shares.reduce<number>((n, s) => n + (s ?? 0), 0) > 0
  const steps = products.map((p, i) => {
    const share = known ? (shares[i] ?? 0) : 1 / products.length
    const byShare = Math.max(AMAZON_MIN_BUDGET_CENTS, Math.round(c.dailyBudgetCents * share))
    const budget = p.firstBudgetCapCents != null ? Math.min(byShare, Math.max(AMAZON_MIN_BUDGET_CENTS, p.firstBudgetCapCents)) : byShare
    const own = new Set(p.ownBought)
    const skip = c.keywords.filter((k) => own.has(k))
    const accept = c.keywords.filter((k) => !own.has(k))
    return {
      product: p, budget, skip, accept,
      args: {
        sourceMarket: f.market, campaignIds: [c.campaignId], sourceProductToken: p.label, market: f.market, productToken: p.label,
        skus: p.skus, naming: { suffix: ` | ${p.label}`.slice(0, 40) },
        bidPolicy: { mode: 'copy' }, budgetPolicy: { mode: 'fixed', value: budget },
        ...(skip.length ? { skipTerms: skip } : {}), ...(accept.length ? { acceptTerms: accept } : {}),
        why: `Ads brain split of "${c.name}" (D2 = A): ${p.label}'s own copy`.slice(0, 300),
      },
    }
  })
  d.request = { plan: { title: `Ads brain — split "${c.name}" into one campaign per product`.slice(0, 120), steps: steps.map((s) => ({ tool: STRUCTURE_TOOLS.replicate, args: s.args })) } }
  d.migration = [
    `Build: ${plural(products.length, 'copy', 'copies')} through replicate-ad-structure, one per product (${products.map((p) => p.label).join(', ')}) — the same ${plural(c.counts.keywords, 'keyword')}, ${plural(c.counts.productTargets, 'product target')}, ${plural(c.counts.autoGroups, 'auto group')} and ${plural(c.counts.negatives, 'negative')}, each copy advertising only its own product's SKUs; born at the 2-cent floor and off the live-write allowlist.`,
    'Bids: each keyword at the shared campaign\'s own bid (copied), remembered at the floor until the go-live; then the bid brain steers it, pooling each keyword\'s evidence across the product\'s campaigns.',
    `Negatives: copied as they are; the product's own negative set comes with the negatives lever (AB-10). Terms a product's own campaigns already buy are left out of its copy (one owner per term)${steps.some((s) => s.skip.length) ? ` — ${steps.filter((s) => s.skip.length).map((s) => `${s.product.label}: ${plural(s.skip.length, 'term')}`).join('; ')}` : ''}; every other keyword is accepted on the record, as it overlaps only the shared campaign.`,
    `Budgets: each copy starts at its product's share of the shared campaign's ${known ? 'spend over the window' : 'budget (no product-ad report: an equal share)'}, held to an enrolled product's first-budget cap; the budgets lever sizes it from there.`,
    'History: Amazon cannot move a campaign\'s history — it stays with the shared campaign, in Amazon and in Nexus; each copy starts fresh from the copied bids.',
    'Go-live: a normal approval inside the caps (D1 = B) — each copy on the live-write allowlist with its planned bids back; outside the caps the approver\'s code, as before.',
    `Then: once every copy is live, "${c.name}" goes to low bids (suppress-campaign — the Owner's temporary stop, undone in about a minute), a request a person decides; it is never paused or archived by the split.`,
  ]
  d.evidence = { ...evidence, copies: steps.map((s) => ({ productId: s.product.productId, label: s.product.label, skip: s.skip.length, accept: s.accept.length, money: { dailyBudgetCents: s.budget } })) }
  if (d.act !== 'none') { take.campaigns++; take.market += products.length }
  return d
}

/** The move of the product's own campaigns into its one portfolio (N2). Pure. */
function decidePortfolio(f: StructureProductFacts, now: Date): StructureDecision | null {
  const key = portfolioKey(f.productId)
  if (!f.settings.ownPortfolio || !keyFree(f, key, now)) return null
  const base = actOf(f)
  const movable = f.own.filter((c) => !c.left)
  // The product's portfolio: its playbook's when it holds no other product's campaign, else the one holding only its own.
  const alone = f.portfolios.filter((p) => p.others === 0).sort((a, b) => b.own.length - a.own.length || a.portfolioId.localeCompare(b.portfolioId))
  const playbookPortfolio = f.playbook?.portfolioId ? f.portfolios.find((p) => p.portfolioId === f.playbook!.portfolioId) ?? { portfolioId: f.playbook.portfolioId, name: null, own: [], others: 0 } : null
  const target = playbookPortfolio && playbookPortfolio.others === 0 ? playbookPortfolio : alone[0] ?? null
  const outside = target ? movable.filter((c) => c.portfolioId !== target.portfolioId) : movable
  if (!outside.length) return null
  const d: StructureDecision = {
    kind: 'PORTFOLIO', key, productId: f.productId, term: null, campaignId: null, reasons: [], act: base.act, level: base.level,
    builder: STRUCTURE_TOOLS.settings, request: null, owners: null, migration: null, heldBy: base.heldBy,
    why: target
      ? `${plural(outside.length, 'campaign')} of the product ${outside.length === 1 ? 'sits' : 'sit'} outside its portfolio "${target.name ?? target.portfolioId}" (N2: a portfolio cap follows a product only where the portfolio holds it alone): move ${outside.length === 1 ? 'it' : 'them'} in`
      : `the product's campaigns sit in no portfolio of their own (N2: a portfolio cap follows a product only where the portfolio holds it alone)`,
    evidence: {
      target: target ? { portfolioId: target.portfolioId, name: target.name, own: target.own.length, from: playbookPortfolio && target === playbookPortfolio ? 'playbook' : 'alone' } : null,
      campaigns: outside.map((c) => ({ campaignId: c.campaignId, name: c.name, from: c.portfolioId })),
      left: f.own.filter((c) => c.left).map((c) => ({ campaignId: c.campaignId, name: c.name, why: c.left })),
      mixed: f.portfolios.filter((p) => p.others > 0).map((p) => ({ portfolioId: p.portfolioId, name: p.name, own: p.own.length, others: p.others })),
    },
  }
  const held = (why: string): StructureDecision => ({ ...d, act: 'none', heldBy: why })
  if (f.portfolioLock) return held(`the Owner locked the portfolioCap lever (${f.portfolioLock}): no campaign is moved between portfolios`)
  if (!target) return held('no portfolio holds this product alone yet: create one (set-portfolio op create, a person approves it), and the brain proposes the moves into it')
  const moving = outside.slice(0, MAX_MOVE)
  d.request = { tool: STRUCTURE_TOOLS.settings, args: { campaigns: moving.map((c) => ({ campaignId: c.campaignId, portfolioId: target.portfolioId })), why: `Ads brain (N2): the product's campaigns into its one portfolio "${target.name ?? target.portfolioId}"`.slice(0, 300) } }
  if (outside.length > MAX_MOVE) d.why += ` (the first ${MAX_MOVE} now, the rest next week)`
  return d
}

/**
 * Every structure proposal of one product in one market, in the order they take the caps: splits first (a shared campaign
 * blocks the product's own portfolio and caps, D2), then single-keyword campaigns, then the portfolio move. Nothing when the
 * lever is OFF, excluded or the product not enrolled. Pure.
 */
export function decideStructure(f: StructureProductFacts, now: Date): StructureDecision[] {
  if (UNTOUCHABLE.includes(f.level)) return []
  const take = { campaigns: f.used.campaignsThisWeek, market: f.used.marketCampaignsThisWeek, skcs: f.used.skcs }
  const out: StructureDecision[] = []
  for (const c of [...f.shared].sort((a, b) => a.name.localeCompare(b.name) || a.campaignId.localeCompare(b.campaignId))) {
    const d = decideSplit(f, c, now, take)
    if (d) out.push(d)
  }
  out.push(...decideSkcs(f, now, take))
  const move = decidePortfolio(f, now)
  if (move) out.push(move)
  return out
}

// ── Going live (D1 = B) ──────────────────────────────────────────────────────────────────────────────────────────

export interface GoLiveFacts {
  kind: StructureKind
  status: string
  /** The campaign's product (the copy's, for a split) is enrolled in the brain in the market. */
  enrolled: boolean
  /** Its structure lever (product level), and why. */
  structure: LeverEffective
  structureWhy: string
  /** The campaign's daily budget now, and its first-budget cap. */
  budgetCents: number | null
  budgetCapCents: number
  /** The product's single-keyword campaigns already live, and the cap (SKC only). */
  liveSkcs: number
  skcMax: number
  /** The product's money brake (AB-7), or null without a plan. */
  brake: string | null
  /** The structure's kill switch for this product in this market, in words; null: not stopped. */
  killed: string | null
  /** The structure's env ceiling (NEXUS_BID_BRAIN_MODE and NEXUS_ADS_BRAIN_STRUCTURE_MODE both live). */
  ceiling: { live: boolean; why: string }
}

/** Brakes of the money plan that hold every raise: a go-live adds spend, so it is outside the caps while one holds. */
export const RAISE_HOLDING_BRAKES: readonly string[] = ['hold_raises', 'cut_bids', 'stop_weakest']

/**
 * Is this brain-built campaign's go-live inside the caps (D1 = B: a normal approval) — or outside them (the code rule as
 * before)? Every reason it is outside is named. Pure.
 */
export function goLiveVerdict(g: GoLiveFacts): { inside: boolean; why: string } {
  const outside: string[] = []
  if (g.status !== 'BUILT' && g.status !== 'LIVE_PROPOSED') outside.push(`the brain's record of it is ${g.status}, not built and waiting to go live`)
  if (!g.enrolled) outside.push('its product is not enrolled in the brain in this market')
  else if (g.structure !== 'PROPOSE') outside.push(`its product's structure lever is ${g.structure}, not PROPOSE (${g.structureWhy})`)
  if (g.killed) outside.push(`the structure's kill switch is on (${g.killed})`)
  if (!g.ceiling.live) outside.push(g.ceiling.why)
  if (g.budgetCents == null) outside.push('Nexus does not know its daily budget')
  else if (g.budgetCents > g.budgetCapCents) outside.push('its daily budget is above the first-budget cap (firstBudgetPctOfEnvelope of the day\'s envelope)')
  if (g.kind === 'SKC' && g.liveSkcs >= g.skcMax) outside.push(`the product already runs ${plural(g.liveSkcs, 'single-keyword campaign')} of the brain (skcMax ${g.skcMax})`)
  if (g.brake && RAISE_HOLDING_BRAKES.includes(g.brake)) outside.push(`the product's money brake holds every raise (${g.brake})`)
  return outside.length
    ? { inside: false, why: `outside the caps: ${outside.join('; ')} — the approver's authenticator code, as for any new structure going live` }
    : { inside: true, why: 'a campaign the ads brain built for an enrolled product, going live inside its caps (its first budget, the single-keyword campaigns, the money brake): a person\'s normal approval sends it (D1 = B)' }
}
