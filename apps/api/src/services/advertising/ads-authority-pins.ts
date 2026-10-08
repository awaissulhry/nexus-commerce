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
export type PinDimension = 'placement' | 'bids' | 'budget'

/**
 * ONE BRAIN AB-5 — every dimension a write can name (design 2026-10-08-ads-one-brain/DESIGN.md §3 target 2: "every write
 * names its lever"): the three a pin can hold, and the ones only the product brain's ownership judges at the write gate.
 *   state            a status change (pause, enable, archive) of a campaign, ad group, keyword, target or product ad
 *   negatives        a negative keyword or product target added, or one retired (its status)
 *   keywords         a keyword or target CREATED (its first bid is part of the create, not a bids change)
 *   structure        a campaign, an ad group or a product ad created
 *   portfolio        a campaign moved into or out of a portfolio, and a portfolio's own cap
 *   biddingStrategy  Amazon's bidding strategy of a campaign (its own lever; the bids PIN still holds it, below)
 * The pins below judge only their three (dimensionForField, dimensionsForWrite: unchanged); the gate's lever check reads
 * leverDimensionsForWrite.
 */
export type AuthorityDimension = PinDimension | 'state' | 'negatives' | 'keywords' | 'structure' | 'portfolio' | 'biddingStrategy'

const PIN_DIMENSIONS: ReadonlySet<string> = new Set<PinDimension>(['placement', 'bids', 'budget'])
const isPinDimension = (d: AuthorityDimension | null | undefined): d is PinDimension => !!d && PIN_DIMENSIONS.has(d)

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
const FIELD_DIMENSION: Record<string, PinDimension> = {
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
export function dimensionForField(field: string | null | undefined): PinDimension | null {
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
}): PinDimension[] {
  const out = new Set<PinDimension>()
  // AB-5 — a named dimension no pin holds (a create's, a negative's) adds nothing here: its fields still do.
  if (isPinDimension(input.dimension)) out.add(input.dimension)
  for (const f of input.fields ?? []) {
    const d = dimensionForField(f)
    if (d) out.add(d)
  }
  return [...out]
}

/**
 * ONE BRAIN AB-5 — field name → the lever dimension it changes, for the gate's one-owner-per-lever check. The pins' map
 * above plus the fields no pin holds: a status, a portfolio move, a portfolio's cap — and the bidding strategy as its own
 * lever. Anything absent (a name, a start or end date) changes no lever.
 */
const LEVER_FIELD_DIMENSION: Record<string, AuthorityDimension> = {
  ...FIELD_DIMENSION,
  biddingStrategy: 'biddingStrategy',
  status: 'state',
  portfolioId: 'portfolio',
  // A portfolio's cap (updatePortfolioWithSync's fields, the ads worker's PORTFOLIO_CAP_FIELDS).
  budgetAmount: 'portfolio',
  budgetCurrencyCode: 'portfolio',
  budgetPolicy: 'portfolio',
}

/** The dimensions a create or a negative names for itself: its fields (a first bid, a retire's status) are part of it. */
const OWN_LEVER_DIMENSIONS: ReadonlySet<AuthorityDimension> = new Set<AuthorityDimension>(['keywords', 'structure', 'negatives'])

/**
 * ONE BRAIN AB-5 — every lever dimension a write changes. A write that names a create or a negative (`keywords`,
 * `structure`, `negatives`) is that one only: a new keyword's first bid is part of the keyword, not a bids change, and a
 * negative's retire is a negative, not a state change. Otherwise the named dimension (the inline placement path) and each
 * field's. Pure.
 */
export function leverDimensionsForWrite(input: {
  fields?: Array<string | null | undefined> | null
  dimension?: AuthorityDimension | null
}): AuthorityDimension[] {
  if (input.dimension && OWN_LEVER_DIMENSIONS.has(input.dimension)) return [input.dimension]
  const out = new Set<AuthorityDimension>()
  if (input.dimension) out.add(input.dimension)
  for (const f of input.fields ?? []) {
    const d = f && Object.prototype.hasOwnProperty.call(LEVER_FIELD_DIMENSION, f) ? LEVER_FIELD_DIMENSION[f] : undefined
    if (d) out.add(d)
  }
  return [...out]
}

/** The cap fields a queued portfolio write can carry (updatePortfolioWithSync; the ads worker sends them as the cap). */
export const PORTFOLIO_CAP_FIELDS: readonly string[] = ['budgetAmount', 'budgetCurrencyCode', 'budgetPolicy', 'startDate', 'endDate']

/**
 * ONE BRAIN AB-5 — what a queued write tells the gate about its lever beyond its fields, built the same way by the ads
 * worker at dispatch and by the mutation layer's pre-ask (gateRefusedNow), so the two give the same answer: a negative's
 * status is the `negatives` lever (its retire); a portfolio's own write names its portfolio (`portfolioId`, judged on the
 * portfolio's campaigns, with no campaign) and, when it changes the cap or its dates, the `portfolio` lever. Pure.
 */
export function queuedWriteLever(w: {
  entityType: string
  entityId: string
  fields: ReadonlyArray<string | null | undefined>
  /** The written AD_TARGET is a negative. */
  negative?: boolean
}): { dimension?: AuthorityDimension; portfolioId?: string } {
  if (w.entityType === 'PORTFOLIO') {
    return { portfolioId: w.entityId, ...(w.fields.some((f) => !!f && PORTFOLIO_CAP_FIELDS.includes(f)) ? { dimension: 'portfolio' as const } : {}) }
  }
  return w.entityType === 'AD_TARGET' && w.negative === true ? { dimension: 'negatives' } : {}
}

export interface PinDenial {
  dimension: PinDimension
  reason: string
}

/**
 * The noun and its verb, per dimension. Two fields rather than one because "bids" is plural
 * and the other two are not: a single label produced "this campaign's bids is held by hand"
 * in the live deny reason, and a refusal an operator reads is not the place for broken
 * grammar — it undermines the sentence at the moment it most needs to be believed.
 */
const PIN_LABEL: Record<PinDimension, { noun: string; verb: string }> = {
  placement: { noun: 'placement', verb: 'is' },
  bids: { noun: 'bids', verb: 'are' },
  budget: { noun: 'budget', verb: 'is' },
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
  const pinned: Record<PinDimension, boolean> = {
    placement: pins.pinPlacement,
    bids: pins.pinBids,
    budget: pins.pinBudget,
  }
  for (const d of write.dimensions) {
    // AB-5 — a dimension no pin holds (a state change, a create, a negative…) is never pinned: see property 1 above.
    if (!isPinDimension(d) || !pinned[d]) continue
    if (d === 'bids' && write.isSuppression) continue
    const where = write.campaignId ? ` on ${write.campaignId}` : ''
    const note = pins.pinNote ? ` (${pins.pinNote})` : ''
    const { noun, verb } = PIN_LABEL[d]
    /**
     * PLC.3 — where to clear it is now dimension-specific.
     *
     * Substrate §4 moves each pin to its own dimension's page (`pinPlacement` → Placement,
     * `pinBids` → Bid, `pinBudget` → Budget). Placement's toggle SHIPPED in PLC.3, so naming only
     * the Control Room would send an operator to the wrong screen for the one dimension that has
     * a nearer control. Bids and budget keep pointing at the Control Room because their pages have
     * not shipped a toggle yet — and a refusal that names a control which does not exist is worse
     * than one that names a further-away control which does.
     */
    const clearAt = d === 'placement'
      ? 'Clear the pin on the Placement page (Rules & Automation → Placement, open the campaign) or in the Control Room'
      : 'Clear the pin in the Control Room'
    return {
      dimension: d,
      reason:
        `${noun} is pinned${where}${note} — this campaign's ${noun} ${verb} held by hand. ` +
        `${clearAt} to let automation write it again.`,
    }
  }
  return null
}

/** True when any dimension is pinned — the cheap check the read surfaces use. */
export function hasAnyPin(pins: AuthorityPins): boolean {
  return pins.pinPlacement || pins.pinBids || pins.pinBudget
}

/** The pinned dimensions, in a stable order, for rendering. */
export function pinnedDimensions(pins: AuthorityPins): PinDimension[] {
  const out: PinDimension[] = []
  if (pins.pinPlacement) out.push('placement')
  if (pins.pinBids) out.push('bids')
  if (pins.pinBudget) out.push('budget')
  return out
}
