/**
 * ads-effective-cpc.ts — THE MOST ONE CLICK CAN COST AT AMAZON once a placement adjustment and the bidding strategy
 * have multiplied the bid. The one formula.
 *
 * 6e (2026-10-04; review G.3, Owner decision D4). Amazon multiplies a Sponsored Products bid twice before the auction:
 *
 *   1. the placement adjustment, 0–900%: `bid × (1 + pct/100)` (+300% is ×4.00);
 *   2. the bidding strategy: "dynamic bids – up and down" (`AUTO_FOR_SALES`) may raise that by up to 100% at Top of
 *      search and up to 50% on every other placement; "down only" (`LEGACY_FOR_SALES`) and fixed bids (`MANUAL`) never
 *      raise it.
 *
 * So 900% with up and down is 20× the bid at Top of search, and every Nexus bid ceiling bound only the bid itself. The
 * write gate now measures a placement raise by this module (`placementRaiseOverCeiling`); the bid grid's "effective max
 * CPC" column and the rank engine's strategy headroom read the same table, so the three cannot drift.
 *
 * Amounts are in hundredths of the market's currency (cents), like every Nexus ads column.
 */

export const PLACEMENT_TOP = 'PLACEMENT_TOP'
export const PLACEMENT_REST_OF_SEARCH = 'PLACEMENT_REST_OF_SEARCH'
export const PLACEMENT_PRODUCT_PAGE = 'PLACEMENT_PRODUCT_PAGE'
export const SITE_AMAZON_BUSINESS = 'SITE_AMAZON_BUSINESS'

/** The placements every Sponsored Products campaign has, set or not (Amazon Business only where Amazon offers it). */
const STANDARD_PLACEMENTS = [PLACEMENT_TOP, PLACEMENT_REST_OF_SEARCH, PLACEMENT_PRODUCT_PAGE] as const

/** How far "dynamic bids – up and down" may raise a bid, per placement (1 = +100%). Any other placement: +50%. */
export const UP_AND_DOWN_UPLIFT: Readonly<Record<string, number>> = {
  [PLACEMENT_TOP]: 1.0,
  [PLACEMENT_REST_OF_SEARCH]: 0.5,
  [PLACEMENT_PRODUCT_PAGE]: 0.5,
  [SITE_AMAZON_BUSINESS]: 0.5,
}
const OTHER_PLACEMENT_UPLIFT = 0.5

const LABEL: Record<string, string> = {
  [PLACEMENT_TOP]: 'Top of search',
  [PLACEMENT_REST_OF_SEARCH]: 'Rest of search',
  [PLACEMENT_PRODUCT_PAGE]: 'Product pages',
  [SITE_AMAZON_BUSINESS]: 'Amazon Business',
}

export interface PlacementPct {
  placement: string
  percentage: number
}

/** True for "dynamic bids – up and down", in Amazon's code (`AUTO_FOR_SALES`) or the Ads API patch form (`autoForSales`). */
export function raisesBids(strategy: string | null | undefined): boolean {
  return (strategy ?? '').replace(/_/g, '').toLowerCase() === 'autoforsales'
}

/** What the strategy may add on this placement, as a fraction of the adjusted bid (0 when it never raises). */
export function strategyUplift(strategy: string | null | undefined, placement: string): number {
  if (!raisesBids(strategy)) return 0
  return UP_AND_DOWN_UPLIFT[placement] ?? OTHER_PLACEMENT_UPLIFT
}

/** The largest uplift the strategy allows on any placement — 1 (Top of search) for up and down, 0 otherwise. */
export function maxStrategyUplift(strategy: string | null | undefined): number {
  return raisesBids(strategy) ? Math.max(...Object.values(UP_AND_DOWN_UPLIFT), OTHER_PLACEMENT_UPLIFT) : 0
}

/** The factor a bid is multiplied by on one placement: (1 + pct/100) × (1 + strategy uplift). */
export function placementFactor(pct: number, placement: string, strategy: string | null | undefined): number {
  const p = Number.isFinite(pct) && pct > 0 ? pct : 0
  return (1 + p / 100) * (1 + strategyUplift(strategy, placement))
}

function pctMap(list: readonly PlacementPct[] | null | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of list ?? []) {
    const pct = Number(x?.percentage)
    if (x?.placement) m.set(String(x.placement), Number.isFinite(pct) ? pct : 0)
  }
  return m
}

/**
 * The most one click can cost on any placement, in cents (rounded), and the placement that allows it. Placements the
 * list does not name count at 0% — up and down still raises a bid at Top of search with no adjustment there.
 */
export function effectiveMaxCpc(
  bidCents: number,
  placements: readonly PlacementPct[] | null | undefined,
  strategy: string | null | undefined,
): { cents: number; placement: string; pct: number } {
  const pcts = pctMap(placements)
  let best = { cents: 0, placement: PLACEMENT_TOP as string, pct: 0 }
  let bestRaw = -1
  for (const placement of new Set<string>([...STANDARD_PLACEMENTS, ...pcts.keys()])) {
    const pct = pcts.get(placement) ?? 0
    const raw = bidCents * placementFactor(pct, placement, strategy)
    if (raw > bestRaw) { bestRaw = raw; best = { cents: Math.round(raw), placement, pct: pct > 0 ? pct : 0 } }
  }
  return best
}

/** A placement raise that takes one click's most past a ceiling. */
export interface PlacementBreach {
  placement: string
  fromPct: number
  toPct: number
  /** The highest bid the campaign can pay, in cents. */
  highestBidCents: number
  /** What the strategy may add there (0 when it never raises). */
  uplift: number
  /** The most one click could cost there after the write, in cents (rounded up: it is past the ceiling). */
  effectiveCents: number
  ceilingCents: number
  /** The highest whole adjustment that stays at or under the ceiling there; -1 when the bid alone is over it. */
  fitsPct: number
}

/**
 * Whether the write raises any placement — by its adjustment or by a strategy that raises bids more — measured per
 * placement, without bids (the bid multiplies before and after alike). A placement the write does not name keeps its
 * value: the live write merges onto Amazon's current settings (G.4). False means the write only lowers or holds.
 */
export function raisesAnyPlacement(args: {
  prior: readonly PlacementPct[] | null | undefined
  next: readonly PlacementPct[]
  strategy: string | null | undefined
  /** The strategy this write sets, when it sets one. */
  nextStrategy?: string | null
}): boolean {
  return raisedPlacements(args).length > 0
}

function raisedPlacements(args: {
  prior: readonly PlacementPct[] | null | undefined
  next: readonly PlacementPct[]
  strategy: string | null | undefined
  nextStrategy?: string | null
}): Array<{ placement: string; fromPct: number; toPct: number; factor: number }> {
  const before = pctMap(args.prior)
  const after = pctMap(args.next)
  const nextStrategy = args.nextStrategy ?? args.strategy
  const out: Array<{ placement: string; fromPct: number; toPct: number; factor: number }> = []
  for (const placement of new Set<string>([...STANDARD_PLACEMENTS, ...before.keys(), ...after.keys()])) {
    const fromPct = before.get(placement) ?? 0
    const toPct = after.get(placement) ?? fromPct
    const was = placementFactor(fromPct, placement, args.strategy)
    const factor = placementFactor(toPct, placement, nextStrategy)
    if (factor > was) out.push({ placement, fromPct, toPct, factor })
  }
  return out
}

/** Floating-point noise, in cents — never a tolerance a real cost could hide in. */
const EPS = 1e-9

/**
 * Owner decision D4 — a placement raise may not take one click's most past the ceiling. Null when the write passes:
 * no ceiling or no bid known (nothing to measure against), no placement raised (a lowering always passes), or every
 * raised placement stays at or under the ceiling. Otherwise the raised placement that goes furthest past it.
 */
export function placementRaiseOverCeiling(args: {
  highestBidCents: number | null | undefined
  ceilingCents: number | null | undefined
  prior: readonly PlacementPct[] | null | undefined
  next: readonly PlacementPct[]
  strategy: string | null | undefined
  nextStrategy?: string | null
}): PlacementBreach | null {
  const bid = args.highestBidCents
  const ceiling = args.ceilingCents
  if (bid == null || !(bid > 0) || ceiling == null || !(ceiling > 0)) return null
  const strategy = args.nextStrategy ?? args.strategy
  let worst: { raw: number; breach: PlacementBreach } | null = null
  for (const r of raisedPlacements(args)) {
    // Exact, not rounded: the rank engine's cap (`cpcCapPct`) floors to the same arithmetic, so a raise it capped to a
    // ceiling is never refused here for a fraction of a cent. EPS absorbs floating-point noise only.
    const raw = bid * r.factor
    if (raw <= ceiling + EPS || (worst && raw <= worst.raw)) continue
    const uplift = strategyUplift(strategy, r.placement)
    worst = {
      raw,
      breach: {
        placement: r.placement, fromPct: r.fromPct, toPct: r.toPct, highestBidCents: bid, uplift,
        effectiveCents: Math.ceil(raw - EPS), ceilingCents: ceiling,
        fitsPct: Math.max(-1, Math.floor(100 * (ceiling / (bid * (1 + uplift)) - 1) + EPS)),
      },
    }
  }
  return worst?.breach ?? null
}

/** "Top of search", "Rest of search", …; the code itself for a placement Nexus has no name for. */
export function placementLabel(placement: string): string {
  return LABEL[placement] ?? placement
}

const eur = (cents: number): string => `€${(cents / 100).toFixed(2)}`
const times = (f: number): string => `×${f.toFixed(2)}`

/**
 * The one sentence that refuses the raise: what one click could cost, how, the ceiling and where it comes from (`source`
 * reads after "the ceiling from", e.g. `the bid policy "…"`), and what still fits.
 */
export function effectiveCpcRefusal(breach: PlacementBreach, source: string): string {
  const what = breach.fromPct === breach.toPct
    ? `Switching to "dynamic bids – up and down" with ${placementLabel(breach.placement)} at ${breach.toPct}%`
    : `Raising ${placementLabel(breach.placement)} from ${breach.fromPct}% to ${breach.toPct}%`
  const how = `highest bid ${eur(breach.highestBidCents)} ${times(1 + breach.toPct / 100)} for the placement`
    + (breach.uplift > 0 ? ` ${times(1 + breach.uplift)} for "dynamic bids – up and down"` : '')
  const fits = breach.fitsPct >= 0
    ? `At most ${Math.min(breach.fitsPct, 900)}% fits under that ceiling there.`
    : `Even at 0% one click there can cost more than that ceiling, so no placement raise fits: lower the bids first.`
  return `${what} would let one click cost up to ${eur(breach.effectiveCents)} (${how}), above the ${eur(breach.ceilingCents)} ceiling from ${source}, so nothing was sent to Amazon. ${fits} Lowering a placement is always allowed.`
}
