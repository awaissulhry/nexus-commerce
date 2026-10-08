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
 *   BB-8       the overrides from their sources too, so the brain can carry them out where it is the one bid writer:
 *              stock (every product of the ad group out of stock or without the Buy Box → STOCK not buyable at the
 *              stop bid; every product short of cover → STOCK, the goal bid × 0.5–1), the playbook (a campaign it
 *              built and has not started, or a slot its phase floors → PHASE; a playbook STOP → STOP), an auto-undo
 *              BidHold → AUTO-UNDO FREEZE (no raise) rather than a pin; a LAUNCH product's day of its ramp and the
 *              break-even ACoS of the ad group's products (goal.ts); and, when the last decision lowered the bid by an
 *              override, the bid before it (decide.ts `restore`)
 */
import type { TargetFacts, Overrides, DecisionLayer } from './decide.js'
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
  /** BB-8 — the products advertised (their own ids), sorted: break-even is read per product. */
  productIds?: string[]
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
  /** BB-8 — the strategy's stop bid for the ad group (null: none set; the 2¢ floor then). */
  stopBidCents?: number | null
  /** BB-8 — LAUNCH only: days since the goal became LAUNCH on the row that sets it (null: not known). */
  launchDay?: number | null
}

/** BB-8 — an ad group's stock, as the brain reads it (ads-stock-risk.service.ts judges it). */
export type StockFact =
  | { kind: 'notBuyable'; stopBidCents: number; by: string }
  | { kind: 'lowCover'; factor: number; by: string }

/** BB-8 — what a playbook holds on a campaign: built and not started, floored by its phase, or stopped. */
export interface PlaybookFact { kind: 'notStarted' | 'phaseFloor' | 'stopped'; floorCents: number; label: string }

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
  /** BB-8 — per ad group: its stock (absent: nothing to say). */
  stock?: ReadonlyMap<string, StockFact>
  /** BB-8 — per campaign: what a playbook holds on it. */
  playbook?: ReadonlyMap<string, PlaybookFact>
  /** BB-8 — per keyword: the brain's last decision lowered it by an override; the bid of its last decision before. */
  lowered?: ReadonlyMap<string, { layer: DecisionLayer; heldCents: number; beforeCents: number | null }>
  /** BB-8 — per ad group: the revenue-weighted break-even ACoS of its products with usable profit data (a fraction). */
  breakEven?: ReadonlyMap<string, number>
}

/** Every product of an ad group out of stock (or without the Buy Box) → not buyable; every product short → its cover. */
export function stockFactOf(g: { risk: string; products: ReadonlyArray<{ units: number; daysOfCover: number | null; lowBelowDays: number | null; hasBuyBox: boolean | null }> }, stopBidCents: number): StockFact | null {
  const n = g.products.length
  if (!n) return null
  if (g.risk === 'out-of-stock') return { kind: 'notBuyable', stopBidCents, by: `out of stock (${n} product${n === 1 ? '' : 's'})` }
  if (g.products.every((p) => p.hasBuyBox === false)) return { kind: 'notBuyable', stopBidCents, by: `no Buy Box (${n} product${n === 1 ? '' : 's'})` }
  if (g.risk !== 'low-stock') return null
  // The shortest cover against its own line: 0.5 at none left, 1 at the line.
  let ratio = 1
  let words = ''
  for (const p of g.products) {
    if (p.daysOfCover == null || p.lowBelowDays == null || p.lowBelowDays <= 0) continue
    const r = Math.max(0, Math.min(1, p.daysOfCover / p.lowBelowDays))
    if (r < ratio) { ratio = r; words = `${p.daysOfCover} days of cover against a ${p.lowBelowDays}-day line` }
  }
  const factor = Math.round((0.5 + 0.5 * ratio) * 100) / 100
  return factor < 1 ? { kind: 'lowCover', factor, by: `low stock: ${words}` } : null
}

/** BB-8 — a stock fact as the override `decide` takes. */
export function stockOverride(f: StockFact): NonNullable<Overrides['stock']> {
  return f.kind === 'notBuyable' ? { notBuyable: true, stopBidCents: f.stopBidCents, by: f.by } : { coverFactor: f.factor, by: f.by }
}

/** BB-8 — a playbook fact as an override: a STOP for a stopped playbook, else its PHASE floor. */
export function playbookOverride(p: PlaybookFact): Partial<Overrides> {
  if (p.kind === 'stopped') return { stop: { bidCents: p.floorCents, by: `a playbook STOP (${p.label})` } }
  return { phase: { ...(p.kind === 'notStarted' ? { notStarted: true as const } : {}), floorCents: p.floorCents, by: p.kind === 'notStarted' ? `the playbook ${p.label} has not started` : `the phase of playbook ${p.label} floors this slot` } }
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

/**
 * BB-8 — a campaign's floor and its ad group's floor together: when both say the same kind (two stops, say the monthly
 * cap on the campaign and a product cap on the ad group), the lower floor wins, as for any two overrides.
 */
export function mergeFloors(campaign: Partial<Overrides> | null, group: Partial<Overrides> | null): Overrides {
  const out: Overrides = { ...campaign }
  if (!group) return out
  const lower = <T>(a: T | null | undefined, b: T | null | undefined, cents: (x: T) => number): T | null | undefined =>
    a == null ? b : b == null ? a : cents(b) < cents(a) ? b : a
  if (group.stop !== undefined) out.stop = lower(out.stop, group.stop, (x) => x.bidCents)
  if (group.minBidHour !== undefined) out.minBidHour = lower(out.minBidHour, group.minBidHour, (x) => x.floorCents)
  if (group.stock !== undefined) out.stock = lower(out.stock, group.stock, (x) => ('notBuyable' in x ? x.stopBidCents : Number.MAX_SAFE_INTEGER))
  return out
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
    const goal: GoalInputs = {
      ...goalTarget(campaign, s, run.accountDefaultPct), band: s?.band ?? null, phase,
      // BB-8 — the LAUNCH ramp's day and the profit cap (goal.ts); absent data: the goal says so.
      ...(phase === 'LAUNCH' ? { launchDay: s?.launchDay ?? null } : {}),
      breakEvenAcos: run.breakEven?.get(group.id) ?? null,
    }
    // BB-5 — a TACoS target: the family's total sales against its ad sales over 30 days (goal.ts converts the aim).
    if (goal.target?.kind === 'TACOS' && fam) {
      const totalCents = group.families.reduce((n, f) => n + (run.familySales?.get(f) ?? 0), 0)
      const adCents = (groupsByFamily.get(fam) ?? []).reduce((n, id) => n + (byGroup.get(id) ?? []).reduce((k, x) => k + (m.adSales30?.get(x.id) ?? 0), 0), 0)
      goal.sales = { totalCents, adCents }
    }

    // Overrides.
    const overrides: Overrides = mergeFloors(floorOverride(campaign.bidsSuppressedBy, campaign.bidsSuppressedFloorCents, campaign.bidsSuppressedAt), floorOverride(group.bidsSuppressedBy, group.bidsSuppressedFloorCents, group.bidsSuppressedAt))
    // A keyword a stop floored on its own keeps its remembered bid: the stop decides until it lifts.
    if (!overrides.stop && !overrides.stock && !overrides.minBidHour && t.suppressedFromBidCents != null) {
      overrides.stop = { bidCents: t.bidCents, by: `a stop (its ${t.suppressedFromBidCents}¢ bid remembered)` }
    }
    // BB-8 — stock from its source (an ad group's products), unless a retail-guard floor already says so.
    const stock = run.stock?.get(group.id)
    if (stock && !overrides.stock) overrides.stock = stockOverride(stock)
    // BB-8 — what a playbook holds: a STOP where none is in force yet, its PHASE floor otherwise.
    const pb = run.playbook?.get(campaign.id)
    if (pb) {
      const o = playbookOverride(pb)
      if (o.stop && !overrides.stop) overrides.stop = o.stop
      if (o.phase) overrides.phase = o.phase
    }
    const holds = run.holds.filter((h) => h.campaignId === campaign.id && (h.targetId == null || h.targetId === t.id))
    // BB-8 — an auto-undo hold freezes (lowering still allowed); every other hold pins.
    const hold = holds.find((h) => h.kind !== 'AUTO_UNDO')
    const undoHold = holds.find((h) => h.kind === 'AUTO_UNDO')
    if (campaign.pinBids) overrides.pin = { by: campaign.pinnedBy ? `bids pinned by ${campaign.pinnedBy}` : 'pinned bids' }
    else if (hold) overrides.pin = { by: `${hold.kind.toLowerCase()} hold by ${hold.by}`, until: day(hold.until) }
    else if (run.personHeld.has(t.id)) overrides.pin = { by: 'a person (their bid of the last 60 days)' }
    const enrollment = run.enrollments.get(campaign.id)
    if (enrollment?.mode === 'HELD') overrides.freeze = { by: enrollment.heldBy ?? 'a hold' }
    else if (undoHold) overrides.freeze = { by: `${undoHold.by}${undoHold.until ? ` until ${day(undoHold.until)}` : ''}` }

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
      restore: run.lowered?.get(t.id) ?? null,
    })
  }
  return out
}
