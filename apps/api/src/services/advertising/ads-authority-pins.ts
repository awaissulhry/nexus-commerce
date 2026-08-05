/**
 * ACR.1.2b — per-dimension authority pins: "hands off placement / bids / budget".
 *
 * The entity bid bounds (ADX A1) say how FAR automation may move a number. These say
 * whether it may touch that number AT ALL, per dimension, per campaign. Until now the
 * only available answer was the live-write allowlist, which is all-or-nothing: an
 * operator who wanted to hold one campaign's budget by hand had to withdraw automation
 * from its bids and placements too.
 *
 * Pure on purpose. The gate's own file is where the DB reads live; the decision — which
 * dimension a write belongs to, and whether a pin refuses it — is arithmetic over a
 * field name and three booleans, and arithmetic should be testable without a database.
 *
 * ── Two properties worth stating, because both are easy to get wrong ──
 *
 * 1. AN UNMAPPED FIELD IS NOT PINNED. `status`, `name`, `portfolioId` and `endDate`
 *    resolve to no dimension, so no pin refuses them. A pin says "hands off this
 *    dimension", not "hands off this campaign" — that is what the allowlist is for, and
 *    conflating the two would give one concept two controls that eventually disagree.
 *
 * 2. SUPPRESSION IS EXEMPT FROM THE BIDS PIN, following ADX G1 and ACR.0.7 exactly.
 *    suppressCampaignBids drives bids to ~2¢; it is how the retail guard, budget
 *    stop-over-spend and Min-bid dayparting windows all stop delivery under the no-pause
 *    rule. A pin that blocked it would mean "I will manage bids myself" silently also
 *    meant "stop protecting me from overspend", and it would freeze bids HIGH at the
 *    moment we have most reason to want them low. The same asymmetry the halt has: a pin
 *    stops the machine reaching for more, never from letting go.
 *
 *    pinBudget gets NO such exemption. Budget pacing writes `dailyBudget`, which is an
 *    optimisation, not a safety action — stop-over-spend suppresses BIDS, not budgets.
 */

/** The three dimensions a campaign's authority can be withdrawn from, one at a time. */
export type AuthorityDimension = 'placement' | 'bids' | 'budget'

/** The pin columns, exactly as `Campaign` stores them. */
export interface AuthorityPins {
  pinPlacement: boolean
  pinBids: boolean
  pinBudget: boolean
  pinNote?: string | null
}

/**
 * Field name → dimension.
 *
 * Sourced from the mutation service's own vocabulary (`ads-mutation.service.ts` writes
 * `bid`, `defaultBid`, `dailyBudget`, `dailyBudgetCurrency`, `biddingStrategy`, `status`,
 * `name`, `portfolioId`, `endDate`) plus the placement names `updatePlacementBidding`
 * writes into `CampaignBidHistory` (`PLACEMENT_TOP` and friends). Anything absent is
 * deliberately absent — see property 1 above.
 *
 * `biddingStrategy` counts as BIDS rather than placement: it is how Amazon may adjust a
 * bid (down-only / up-and-down / fixed), which is a bid decision. The placement path
 * happens to push it alongside the multipliers, and that path names its dimension
 * explicitly instead of relying on this map.
 */
const FIELD_DIMENSION: Record<string, AuthorityDimension> = {
  // Bids — the same two fields ads-write-gate bounds, plus the strategy that governs them.
  bid: 'bids',
  defaultBid: 'bids',
  biddingStrategy: 'bids',
  // Budget.
  dailyBudget: 'budget',
  dailyBudgetCurrency: 'budget',
  // Placement multipliers. `updatePlacementBidding` passes its dimension explicitly, but
  // the names are mapped too so a queued placement write cannot slip past by taking the
  // generic path.
  placementBidding: 'placement',
  PLACEMENT_TOP: 'placement',
  PLACEMENT_PRODUCT_PAGE: 'placement',
  PLACEMENT_REST_OF_SEARCH: 'placement',
}

/** The dimension a single field belongs to, or null when no pin governs it. */
export function dimensionForField(field: string | null | undefined): AuthorityDimension | null {
  if (!field) return null
  return FIELD_DIMENSION[field] ?? null
}

/**
 * Every dimension a write touches.
 *
 * Takes the FULL field list rather than one field, because the worker's payload can carry
 * several changes and the gate previously surfaced only one of them. A pin checked against
 * whichever field happened to sort first would hold on single-field payloads — the ones a
 * test would naturally use — and silently let a multi-field payload through, which is the
 * exact shape of a decorative control.
 */
export function dimensionsForWrite(input: {
  fields?: Array<string | null | undefined> | null
  dimension?: AuthorityDimension | null
}): AuthorityDimension[] {
  const out = new Set<AuthorityDimension>()
  if (input.dimension) out.add(input.dimension)
  for (const f of input.fields ?? []) {
    const d = dimensionForField(f)
    if (d) out.add(d)
  }
  return [...out]
}

export interface PinDenial {
  dimension: AuthorityDimension
  reason: string
}

const PIN_LABEL: Record<AuthorityDimension, string> = {
  placement: 'placement',
  bids: 'bids',
  budget: 'budget',
}

/**
 * Decide whether the pins refuse this write. Returns the first offending dimension, or
 * null to allow.
 *
 * `isSuppression` exempts the BIDS pin only — see the header. It is the same flag the min
 * bound and the account halt already honour, so a suppression behaves identically at all
 * three checks rather than passing two and failing the third.
 */
export function pinDenial(
  pins: AuthorityPins,
  write: { dimensions: AuthorityDimension[]; isSuppression?: boolean; campaignId?: string | null },
): PinDenial | null {
  const pinned: Record<AuthorityDimension, boolean> = {
    placement: pins.pinPlacement,
    bids: pins.pinBids,
    budget: pins.pinBudget,
  }
  for (const d of write.dimensions) {
    if (!pinned[d]) continue
    if (d === 'bids' && write.isSuppression) continue
    const where = write.campaignId ? ` on ${write.campaignId}` : ''
    const note = pins.pinNote ? ` (${pins.pinNote})` : ''
    return {
      dimension: d,
      reason:
        `${PIN_LABEL[d]} is pinned${where}${note} — this campaign's ${PIN_LABEL[d]} ` +
        'is held by hand. Clear the pin in the Control Room to let automation write it again.',
    }
  }
  return null
}

/** True when any dimension is pinned — the cheap check the read surfaces use. */
export function hasAnyPin(pins: AuthorityPins): boolean {
  return pins.pinPlacement || pins.pinBids || pins.pinBudget
}

/** The pinned dimensions, in a stable order, for rendering. */
export function pinnedDimensions(pins: AuthorityPins): AuthorityDimension[] {
  const out: AuthorityDimension[] = []
  if (pins.pinPlacement) out.push('placement')
  if (pins.pinBids) out.push('bids')
  if (pins.pinBudget) out.push('budget')
  return out
}
