/**
 * BID BRAIN BB-3 — from one market's rows to the facts `decide` takes (pure: the loaders read, this assembles).
 *
 *   pools      target → the same keyword text in the product's other campaigns → ad group → product family → market
 *              (category waits for a later step). A level holding exactly the same keywords as the one below it is
 *              left out, so a keyword is never shrunk toward itself.
 *   goal       the campaign's own target ACoS, else the ads strategy's target as written (ACoS or TACoS, and its band,
 *              BB-5), else the account default — the order every bid engine uses today (W0, Owner: the campaign's target
 *              wins); a TACoS target takes the family's 30-day Amazon sales against its ad sales
 *   limits     the strategy's lowest and highest bid and largest change, and the campaign's own bounds
 *   overrides  a stop floor (budget or a stop by Claude), or a keyword floored with its bid remembered → STOP; a retail-guard floor → STOCK (not buyable); a Min-bid
 *              window → MIN-BID HOUR; pinned bids, a person's bid of the last 60 days or a BidHold row → PIN; a HELD
 *              enrollment → AUTO-UNDO FREEZE
 *   brakes     the engine posture stopped (kill switch, halt, dial OFF), data older than 48 hours, a paused campaign or
 *              ad group
 */
import type { TargetFacts, Overrides } from './decide.js'
import { NO_EVIDENCE, type Evidence, type PoolNode } from './estimator.js'
import { BRAIN_PHASES, type BrainPhase, type GoalInputs } from './goal.js'

export interface CampaignRow {
  id: string
  status: string
  pinBids: boolean
  pinnedBy: string | null
  bidsSuppressedAt: Date | null
  bidsSuppressedFloorCents: number | null
  bidsSuppressedBy: string | null
  minBidCents: number | null
  maxBidCents: number | null
  /** Campaign.dynamicBidding.targetAcos as stored (a fraction), unchecked. */
  ownTargetAcos: unknown
  /** On the live-write allowlist: the brain decides only for these. */
  allowlisted: boolean
}

export interface AdGroupRow {
  id: string
  campaignId: string
  status: string
  bidsSuppressedAt: Date | null
  bidsSuppressedFloorCents: number | null
  bidsSuppressedBy: string | null
  /** Product families advertised (Product.parentId ?? Product.id), sorted. */
  families: string[]
}

export interface TargetRow {
  id: string
  adGroupId: string
  kind: string
  expressionType: string
  expressionValue: string
  bidCents: number
  /** Set while a stop holds the keyword at a floor (the no-pause policy): the bid to restore. */
  suppressedFromBidCents: number | null
}

/** The strategy as the brain reads it for one ad group (null: no strategy row in force). */
export interface StrategyRead {
  target: { kind: 'ACOS' | 'TACOS'; pct: number } | null
  /** The first ACoS target down the chain. */
  acosPct: number | null
  band: { loPct: number | null; hiPct: number | null } | null
  goal: string | null
  minBidCents: number | null
  maxBidCents: number | null
  maxChangePct: number | null
}

export interface MarketRows {
  market: string
  dataDay: string
  campaigns: ReadonlyMap<string, CampaignRow>
  adGroups: ReadonlyMap<string, AdGroupRow>
  targets: readonly TargetRow[]
  evidence: ReadonlyMap<string, Evidence>
  /** BB-5 — each keyword's ad sales over the 30 settled days, in cents (TACoS). */
  adSales30?: ReadonlyMap<string, number>
  /** Listing price per family, in cents. */
  prices: ReadonlyMap<string, number>
}

export interface RunRows {
  /** Brakes that stop the whole market (posture, stale data). */
  marketBrakes: readonly string[]
  strategy: ReadonlyMap<string, StrategyRead>
  accountDefaultPct: number | null
  /** Targets a person set (or approved) a bid for in the last 60 days. */
  personHeld: ReadonlySet<string>
  /** Active BidHold rows: campaign-wide (targetId null) or per target. */
  holds: ReadonlyArray<{ campaignId: string; targetId: string | null; kind: string; by: string; until: Date | null }>
  /** Enrollment mode per campaign (HELD → freeze). */
  enrollments: ReadonlyMap<string, { mode: string; heldBy: string | null; heldUntil: Date | null }>
  lastSteps: ReadonlyMap<string, { dataDay: string; fromCents: number; toCents: number }>
  /** BB-5 — each family's total Amazon sales in the market over the 30 settled days, in cents (read for TACoS only). */
  familySales?: ReadonlyMap<string, number>
}

const add = (a: Evidence, b: Evidence): Evidence => ({ clicks: a.clicks + b.clicks, orders: a.orders + b.orders, salesCents: a.salesCents + b.salesCents, costCents: a.costCents + b.costCents })
const sum = (items: Iterable<Evidence>): Evidence => { let out = NO_EVIDENCE; for (const e of items) out = add(out, e); return out }
const familyKey = (g: AdGroupRow | undefined) => (g?.families.length ? g.families.join('|') : null)
const keywordKey = (t: TargetRow) => `${t.kind}|${t.expressionType}|${t.expressionValue.trim().toLowerCase()}`
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/**
 * The ad group's paid CPC ÷ bid, with today's bids standing in for the bids of the window: null under 10 clicks (the
 * estimator then takes 0.85).
 */
export function cpcRatioOf(targets: readonly TargetRow[], ev: (id: string) => Evidence): number | null {
  let cost = 0
  let clicks = 0
  let bidClicks = 0
  for (const t of targets) {
    const e = ev(t.id)
    cost += e.costCents
    clicks += e.clicks
    bidClicks += e.clicks * t.bidCents
  }
  return clicks >= 10 && bidClicks > 0 ? cost / bidClicks : null
}

/** Who floored a campaign or ad group, read as an override. Null: not floored. */
export function floorOverride(by: string | null, floorCents: number | null, at: Date | null): Partial<Overrides> | null {
  if (!at) return null
  const cents = floorCents ?? 2
  const who = by ?? 'an engine'
  if (/retail/i.test(who)) return { stock: { notBuyable: true, stopBidCents: cents, by: who } }
  if (/rank|daypart|min-?bid/i.test(who)) return { minBidHour: { floorCents: cents } }
  return { stop: { bidCents: cents, by: who } }
}

/** The target as the goal resolver reads it: the campaign's own, else the strategy's as written, else the account default. */
export function goalTarget(campaign: CampaignRow, s: StrategyRead | undefined, accountDefaultPct: number | null): Pick<GoalInputs, 'target' | 'acosFallbackPct'> {
  const own = campaign.ownTargetAcos
  if (typeof own === 'number' && Number.isFinite(own) && own > 0 && own <= 5) return { target: { kind: 'ACOS', pct: Math.round(own * 10_000) / 100 }, acosFallbackPct: null }
  if (s?.target) return { target: s.target, acosFallbackPct: s.acosPct ?? accountDefaultPct }
  if (accountDefaultPct != null && accountDefaultPct > 0) return { target: { kind: 'ACOS', pct: accountDefaultPct }, acosFallbackPct: null }
  return { target: null, acosFallbackPct: null }
}

/** Every allowlisted target of the market, as facts for `decide`. */
export function buildFacts(m: MarketRows, run: RunRows): TargetFacts[] {
  const ev = (id: string) => m.evidence.get(id) ?? NO_EVIDENCE
  const byGroup = new Map<string, TargetRow[]>()
  const byKeyword = new Map<string, TargetRow[]>()
  const groupsByFamily = new Map<string, string[]>()
  for (const t of m.targets) {
    byGroup.set(t.adGroupId, [...(byGroup.get(t.adGroupId) ?? []), t])
    const fam = familyKey(m.adGroups.get(t.adGroupId))
    if (fam) byKeyword.set(`${fam}#${keywordKey(t)}`, [...(byKeyword.get(`${fam}#${keywordKey(t)}`) ?? []), t])
  }
  for (const g of m.adGroups.values()) {
    const fam = familyKey(g)
    if (fam && byGroup.has(g.id)) groupsByFamily.set(fam, [...(groupsByFamily.get(fam) ?? []), g.id])
  }
  const groupEvidence = new Map([...byGroup].map(([id, ts]) => [id, sum(ts.map((t) => ev(t.id)))]))
  const familyEvidence = new Map([...groupsByFamily].map(([fam, ids]) => [fam, sum(ids.map((id) => groupEvidence.get(id)!))]))
  const market = sum(m.targets.map((t) => ev(t.id)))

  const out: TargetFacts[] = []
  for (const t of m.targets) {
    const group = m.adGroups.get(t.adGroupId)
    const campaign = group ? m.campaigns.get(group.campaignId) : undefined
    if (!group || !campaign?.allowlisted) continue
    const fam = familyKey(group)

    // The chain, most specific first; a level with the same members as the one below adds nothing.
    const chain: PoolNode[] = [{ level: 'target', evidence: ev(t.id), siblings: (byGroup.get(group.id) ?? []).map((s) => ev(s.id)) }]
    let members = 1
    const kw = fam ? byKeyword.get(`${fam}#${keywordKey(t)}`) ?? [] : []
    if (kw.length > members) { chain.push({ level: 'keyword', evidence: sum(kw.map((s) => ev(s.id))) }); members = kw.length }
    const inGroup = byGroup.get(group.id)?.length ?? 0
    if (inGroup > 1) chain.push({ level: 'adGroup', evidence: groupEvidence.get(group.id)!, siblings: fam ? (groupsByFamily.get(fam) ?? []).map((id) => groupEvidence.get(id)!) : undefined })
    if (fam && (groupsByFamily.get(fam)?.length ?? 0) > 1) chain.push({ level: 'product', evidence: familyEvidence.get(fam)!, siblings: [...familyEvidence.values()] })
    chain.push({ level: 'market', evidence: market })

    const s = run.strategy.get(group.id)
    const phase = s?.goal && (BRAIN_PHASES as readonly string[]).includes(s.goal) ? (s.goal as BrainPhase) : null
    const goal: GoalInputs = { ...goalTarget(campaign, s, run.accountDefaultPct), band: s?.band ?? null, phase }
    // BB-5 — a TACoS target: the family's total sales against its ad sales over 30 days (goal.ts converts the aim).
    if (goal.target?.kind === 'TACOS' && fam) {
      const totalCents = group.families.reduce((n, f) => n + (run.familySales?.get(f) ?? 0), 0)
      const adCents = (groupsByFamily.get(fam) ?? []).reduce((n, id) => n + (byGroup.get(id) ?? []).reduce((k, x) => k + (m.adSales30?.get(x.id) ?? 0), 0), 0)
      goal.sales = { totalCents, adCents }
    }

    // Overrides.
    const overrides: Overrides = { ...floorOverride(campaign.bidsSuppressedBy, campaign.bidsSuppressedFloorCents, campaign.bidsSuppressedAt), ...floorOverride(group.bidsSuppressedBy, group.bidsSuppressedFloorCents, group.bidsSuppressedAt) }
    // A keyword a stop floored on its own keeps its remembered bid: the stop decides until it lifts.
    if (!overrides.stop && !overrides.stock && !overrides.minBidHour && t.suppressedFromBidCents != null) {
      overrides.stop = { bidCents: t.bidCents, by: `a stop (its ${t.suppressedFromBidCents}¢ bid remembered)` }
    }
    const hold = run.holds.find((h) => h.campaignId === campaign.id && (h.targetId == null || h.targetId === t.id))
    if (campaign.pinBids) overrides.pin = { by: campaign.pinnedBy ? `bids pinned by ${campaign.pinnedBy}` : 'pinned bids' }
    else if (hold) overrides.pin = { by: `${hold.kind.toLowerCase()} hold by ${hold.by}`, until: day(hold.until) }
    else if (run.personHeld.has(t.id)) overrides.pin = { by: 'a person (their bid of the last 60 days)' }
    const enrollment = run.enrollments.get(campaign.id)
    if (enrollment?.mode === 'HELD') overrides.freeze = { by: enrollment.heldBy ?? 'a hold' }

    const brakes = [...run.marketBrakes]
    if (campaign.status !== 'ENABLED') brakes.push(`campaign ${campaign.status.toLowerCase()}`)
    if (group.status !== 'ENABLED') brakes.push(`ad group ${group.status.toLowerCase()}`)

    out.push({
      targetId: t.id,
      currentCents: t.bidCents,
      chain,
      parentCpcRatio: cpcRatioOf(byGroup.get(group.id) ?? [], ev),
      listPriceCents: group.families.map((f) => m.prices.get(f)).find((p) => p != null && p > 0) ?? null,
      goal,
      limits: {
        minBidCents: s?.minBidCents ?? null,
        maxBidCents: s?.maxBidCents ?? null,
        maxChangePct: s?.maxChangePct ?? null,
        campaignMinCents: campaign.minBidCents,
        campaignMaxCents: campaign.maxBidCents,
      },
      dataDay: m.dataDay,
      lastStep: run.lastSteps.get(t.id) ?? null,
      brakes,
      overrides,
    })
  }
  return out
}
