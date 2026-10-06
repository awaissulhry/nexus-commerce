/**
 * ADS AUTONOMY W1-5 — the strategy as the BID engines and the write gate read it: per ad group, the ACoS target the bid
 * optimiser steers by and the three bid limits (lowest bid, highest bid, largest change per action), each with the row
 * that supplied it.
 *
 *   target   W0's resolver takes it as the `strategy` source, after the caller's own number and the campaign's own target
 *            and before the account default (ads-target-acos-resolver.ts; Owner decision: the campaign's target wins)
 *   band     every limit binds and the stricter one wins: the write gate adds the strategy band to the campaign's own
 *            bounds and the bid policies (entityBoundsDenial), and the engines clamp to it first, so they are not refused
 *   step     the mutation layer's step clamp takes the lower of the campaign's largest change and the strategy's
 *
 * Who is bound: engines, rules, schedules and changes that run by rule are refused past the band (and clamp first). The
 * band is one of the Owner's OWN limits (PR #401, 3A/4A: his own limits warn, never block his own edits): a person's own
 * write past it, or a Claude request he approves, is warned and goes when he confirms ("Send anyway", or his approval
 * after the card's warning). The largest change never rewrites a person's edit (CM-19): past it, his edit is sent with a
 * warning. A restore puts back what was, inside every limit in force, for whoever restores.
 *
 * "No row → today's behaviour": a market without a row setting a bid field costs one indexed read and changes nothing.
 * Ad groups resolve the safer value across their products (resolve.ts); a market with only a market row needs no catalog.
 */
import prisma from '../../../db.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import { openStrategy, type EffectiveStrategy, type StrategyView } from './effective.js'
import { pctToFraction } from './fields.js'
import type { ResolvedStrategy, StrategySource } from './resolve.js'
import { strategyWords } from './source-words.js'

export { strategyWords }

// ── What an engine takes ──────────────────────────────────────────────────────────────────────────

/** One strategy number in force, with the row that supplied it. */
export interface StrategyLimit {
  value: number
  source: StrategySource
}

/** The strategy's bid limits for one ad group (or a campaign, or a market); null: the strategy says nothing. */
export interface StrategyBidLimits {
  minBidCents: StrategyLimit | null
  maxBidCents: StrategyLimit | null
  maxChangePct: StrategyLimit | null
}

/** The strategy's ACoS target for one ad group: a FRACTION (the resolver's unit), its percent, and its row. */
export interface StrategyTarget {
  targetAcos: number
  targetAcosPct: number
  source: StrategySource
}

export const NO_LIMITS: StrategyBidLimits = Object.freeze({ minBidCents: null, maxBidCents: null, maxChangePct: null })

export const hasLimits = (l: StrategyBidLimits | null | undefined): l is StrategyBidLimits =>
  !!l && (l.minBidCents != null || l.maxBidCents != null || l.maxChangePct != null)

/** The market code strategy rows are kept under ('IT'), from a campaign's marketplace (a code or an Amazon id). */
export function strategyMarket(marketplace: string | null | undefined): string | null {
  const code = normalizeMarketplaceCode(marketplace, '')
  return code ? code.toUpperCase() : null
}

const numberLimit = (resolved: ResolvedStrategy, key: 'minBidCents' | 'maxBidCents' | 'maxChangePct'): StrategyLimit | null => {
  const f = resolved.fields.get(key)
  return typeof f?.value === 'number' && f.source ? { value: f.value, source: f.source } : null
}

export function limitsOf(e: EffectiveStrategy): StrategyBidLimits {
  return { minBidCents: numberLimit(e.resolved, 'minBidCents'), maxBidCents: numberLimit(e.resolved, 'maxBidCents'), maxChangePct: numberLimit(e.resolved, 'maxChangePct') }
}

export function targetOf(e: EffectiveStrategy): StrategyTarget | null {
  const f = e.resolved.fields.get('targetAcosPct')
  const fraction = pctToFraction(f?.value)
  return fraction != null && f?.source ? { targetAcos: fraction, targetAcosPct: f.value as number, source: f.source } : null
}

/** Each ad group's strategy; a market holding only its market row answers without reading the catalog. */
async function adGroupsIn(view: StrategyView, adGroupIds: readonly string[]): Promise<Map<string, EffectiveStrategy>> {
  if (view.empty || (!view.index.categories.size && !view.index.products.size)) {
    const market = view.forMarket()
    return new Map(adGroupIds.map((id) => [id, market]))
  }
  return view.forAdGroups(adGroupIds)
}

/** One indexed read: does any strategy row of this market set a lowest bid, a highest bid or a largest change? */
export async function marketSetsBidLimits(market: string, channel = 'AMAZON'): Promise<boolean> {
  const row = await prisma.adsStrategy.findFirst({
    where: { channel, market, OR: [{ minBidCents: { not: null } }, { maxBidCents: { not: null } }, { maxChangePct: { not: null } }] },
    select: { id: true },
  })
  return row != null
}

/**
 * The bid limits ONE write is held to: its ad group's (the safer value across the ad group's products), else — for a
 * write that names no ad group (a new ad group, a campaign-level probe) — its campaign's. Cheap first: a market with no
 * bid field set answers NO_LIMITS after one indexed read.
 */
export async function bidLimitsFor(args: { marketplace: string | null | undefined; adGroupId?: string | null; campaignId?: string | null }): Promise<StrategyBidLimits> {
  const market = strategyMarket(args.marketplace)
  if (!market || !(await marketSetsBidLimits(market))) return NO_LIMITS
  const view = await openStrategy(market)
  if (args.adGroupId) return limitsOf((await adGroupsIn(view, [args.adGroupId])).get(args.adGroupId) ?? view.forMarket())
  if (args.campaignId && (view.index.categories.size || view.index.products.size)) {
    return limitsOf((await view.forCampaigns([args.campaignId])).get(args.campaignId) ?? view.forMarket())
  }
  return limitsOf(view.forMarket())
}

/**
 * An engine run's reader: each market opened once, each ad group resolved once (its target and its limits). A market
 * without a usable row gives nothing, so every ad group there keeps today's behaviour.
 */
export function strategyBidReader() {
  const views = new Map<string, Promise<StrategyView>>()
  const viewOf = (market: string) => {
    let v = views.get(market)
    if (!v) views.set(market, (v = openStrategy(market)))
    return v
  }
  return {
    async forAdGroups(subjects: ReadonlyArray<{ adGroupId: string; marketplace: string | null | undefined }>): Promise<Map<string, { limits: StrategyBidLimits; target: StrategyTarget | null }>> {
      const byMarket = new Map<string, Set<string>>()
      for (const s of subjects) {
        const market = strategyMarket(s.marketplace)
        if (market) byMarket.set(market, (byMarket.get(market) ?? new Set()).add(s.adGroupId))
      }
      const out = new Map<string, { limits: StrategyBidLimits; target: StrategyTarget | null }>()
      for (const [market, ids] of byMarket) {
        const view = await viewOf(market)
        if (view.empty) continue
        for (const [id, e] of await adGroupsIn(view, [...ids])) {
          const limits = limitsOf(e)
          const target = targetOf(e)
          if (hasLimits(limits) || target) out.set(id, { limits, target })
        }
      }
      return out
    },
  }
}

/** Each campaign's bid limits in one market (the safer value across all its products): the autopilot's per-campaign band. */
export async function bidLimitsByCampaign(marketplace: string | null | undefined, campaignIds: readonly string[]): Promise<Map<string, StrategyBidLimits>> {
  const market = strategyMarket(marketplace)
  if (!market || !campaignIds.length || !(await marketSetsBidLimits(market))) return new Map()
  const view = await openStrategy(market)
  if (!view.index.categories.size && !view.index.products.size) return new Map(campaignIds.map((id) => [id, limitsOf(view.forMarket())]))
  return new Map([...(await view.forCampaigns(campaignIds))].map(([id, e]) => [id, limitsOf(e)]))
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

const SIDE_WORDS = { max: 'highest bid', min: 'lowest bid' } as const
export type BidSide = keyof typeof SIDE_WORDS
export const bidSideWords = (side: BidSide): string => SIDE_WORDS[side]

/** "the ads strategy's highest bid 120¢ (ads strategy: Helmets (IT), category, v3)". */
export function limitWords(side: BidSide, limit: StrategyLimit): string {
  return `the ${SIDE_WORDS[side]} ${limit.value}¢ (${strategyWords(limit.source)})`
}

// ── The arithmetic (pure) ─────────────────────────────────────────────────────────────────────────

/** Nexus's own engine floor (ads-mutation.service.ts): the step clamp never lands below it. */
const ENGINE_FLOOR_CENTS = 5

/** A bid band: each side a number in cents, with whatever names where it comes from. */
export interface Band<T extends { value: number }> {
  max: T | null
  min: T | null
}

export interface BandClamp<T extends { value: number }> {
  cents: number
  /** The side that moved the bid, and its limit; null when the band did not move it. */
  held: { side: BidSide; limit: T } | null
}
export type StrategyClamp = BandClamp<StrategyLimit>

/**
 * A bid held inside a band before it is written, so the write gate does not refuse it. The highest bid always binds.
 * The lowest bid binds every write except a FORCED lowering (`forced` with a current bid above the new one): the gate
 * exempts those from every minimum (a stop's low bid), so they are left as they are. Where the two sides cross, the
 * highest bid wins (it spends less).
 */
export function clampBid<T extends { value: number }>(wantCents: number, band: Band<T>, opts: { currentCents?: number | null; forced?: boolean } = {}): BandClamp<T> {
  const { max, min } = band
  if (max && wantCents > max.value) return { cents: max.value, held: { side: 'max', limit: max } }
  const forcedLowering = opts.forced === true && opts.currentCents != null && wantCents < opts.currentCents
  if (min && wantCents < min.value && !forcedLowering && (!max || min.value <= max.value)) return { cents: min.value, held: { side: 'min', limit: min } }
  return { cents: wantCents, held: null }
}

/** clampBid with the strategy's own band (its lowest and highest bid). */
export function clampToStrategy(wantCents: number, limits: StrategyBidLimits | null | undefined, opts: { currentCents?: number | null; forced?: boolean } = {}): StrategyClamp {
  return clampBid(wantCents, { max: limits?.maxBidCents ?? null, min: limits?.minBidCents ?? null }, opts)
}

/** True when the bid sits inside the strategy band (no band: always). */
export function insideBand(cents: number, limits: StrategyBidLimits | null | undefined): boolean {
  return !(limits?.maxBidCents && cents > limits.maxBidCents.value) && !(limits?.minBidCents && cents < limits.minBidCents.value)
}

export interface StepClamp {
  cents: number
  /** The largest change that applied (the lower of the campaign's and the strategy's), when one did. */
  pct: number | null
  /** Whose largest change it was: the strategy's only when it is the lower one. */
  by: 'campaign' | 'strategy' | null
  /** The strategy band moved the stepped bid back to its edge (a step may not stop a move into the band). */
  bandHeld: StrategyClamp['held']
}

/**
 * The mutation layer's step clamp (engines, rules and Claude; never a person's own edit, never a forced write), and the
 * preview's mirror of it (ads-change-kit.ts changeClampedBid): the largest change per action is the LOWER of the
 * campaign's `dynamicBidding.maxBidChangePct` and the strategy's `maxChangePct`. A bid asked for inside the strategy
 * band stays inside it: where a step would stop short of the band's edge, the edge wins (the band is the Owner's limit,
 * the step only its pace). A bid asked for outside the band is not moved into it here: the write gate refuses it.
 */
export function stepClamp(currentCents: number, wantedCents: number, campaignDynamicBidding: unknown, limits?: StrategyBidLimits | null): StepClamp {
  const own = Number((campaignDynamicBidding as { maxBidChangePct?: unknown } | null)?.maxBidChangePct)
  const campaignPct = Number.isFinite(own) && own > 0 ? own : null
  const strategyPct = limits?.maxChangePct?.value ?? null
  const pct = campaignPct != null && strategyPct != null ? Math.min(campaignPct, strategyPct) : campaignPct ?? strategyPct
  const by = pct == null ? null : strategyPct != null && pct === strategyPct && (campaignPct == null || strategyPct < campaignPct) ? 'strategy' : 'campaign'
  if (!(currentCents > 0) || pct == null) return { cents: wantedCents, pct: null, by: null, bandHeld: null }
  const maxUp = Math.round(currentCents * (1 + pct / 100))
  const maxDown = Math.round(currentCents * (1 - pct / 100))
  const stepped = Math.max(ENGINE_FLOOR_CENTS, Math.min(maxUp, Math.max(maxDown, wantedCents)))
  if (!insideBand(wantedCents, limits)) return { cents: stepped, pct, by, bandHeld: null }
  const band = clampToStrategy(stepped, limits)
  return { cents: band.cents, pct, by, bandHeld: band.held }
}

// ── Provenance on the write (AdWriteEvidence.sources) ─────────────────────────────────────────────

/**
 * Which level supplied a number a write used (design §3.2): `level` is the strategy row's (product, category, market)
 * or the older source's (explicit, campaign, account, profit, flat); `value` is in the number's own unit (a target as an
 * integer percent, a bid in cents, a change in percent).
 */
export interface WriteSource {
  level: string
  value: number
  /** An explicit target: whose ("this rule's target"). */
  from?: string
  scopeId?: string
  label?: string
  version?: number
  strategyId?: string
  via?: string
  product?: string
}
export type WriteSourceKey = 'targetAcosPct' | 'minBidCents' | 'maxBidCents' | 'maxChangePct'
export type WriteSources = Partial<Record<WriteSourceKey, WriteSource>>

export function strategySource(value: number, s: StrategySource): WriteSource {
  return {
    level: s.level, value, scopeId: s.scopeId, label: s.label, version: s.version, strategyId: s.strategyId,
    ...(s.via ? { via: s.via } : {}), ...(s.product ? { product: s.product } : {}),
  }
}

/** The strategy limits in force on a write, as evidence sources (nothing when the strategy sets none). */
export function limitSources(limits: StrategyBidLimits | null | undefined): WriteSources {
  const out: WriteSources = {}
  for (const key of ['minBidCents', 'maxBidCents', 'maxChangePct'] as const) {
    const l = limits?.[key]
    if (l) out[key] = strategySource(l.value, l.source)
  }
  return out
}

// ── What a run held back to the strategy, for its run line ────────────────────────────────────────

export interface BidHold {
  /** restore: a give-back put back below (or above) the remembered bid; base: the hourly base bid; bid: any other engine bid. */
  kind: 'restore' | 'base' | 'bid'
  side: BidSide
  /** Whose limit, in words (a strategy row, or the campaign's own bound or a bid policy for a restore). */
  source: string
  wantedCents: number
  writtenCents: number
}

/** A run's collector: the services add to it, the run line reads it. */
export interface BidHoldLog {
  holds: BidHold[]
}
export const newHoldLog = (): BidHoldLog => ({ holds: [] })

/**
 * The run line's note: how many bids a limit held, by kind and source. Nothing on a run nothing was held in.
 * e.g. " held=3 (base: 2 at the highest bid — ads strategy: Helmets (IT), market, v2; restore: 1 put back at the
 * highest bid, not the remembered one — Campaign.maxBidCents on c1)".
 */
export function holdNote(log: BidHoldLog | null | undefined): string {
  if (!log?.holds.length) return ''
  const groups = new Map<string, number>()
  for (const h of log.holds) {
    const what = h.kind === 'restore'
      ? `restore: put back at the ${SIDE_WORDS[h.side]}, not the remembered bid — ${h.source}`
      : `${h.kind}: at the ${SIDE_WORDS[h.side]} — ${h.source}`
    groups.set(what, (groups.get(what) ?? 0) + 1)
  }
  return ` held=${log.holds.length} (${[...groups].map(([what, n]) => `${n}× ${what}`).join('; ')})`
}
