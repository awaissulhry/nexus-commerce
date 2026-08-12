/**
 * HV.1 — the seam.
 *
 * Seven sections follow this one. Each gets a slot in `KeywordHarvestClient`, in order, each
 * importing from its own file and rendering null until its session lands. This file is the typed
 * contract between them, and it exists so that **a later session adds one file and one import line
 * and nobody restructures the client.**
 *
 * Three rules the sections inherit:
 *
 *   1. **Hidden, not disabled.** A section whose data does not exist yet renders nothing. A
 *      disabled button that will never enable is the same defect class as the Delete button on
 *      `RuleListTab.tsx:120`, which says "this cannot be undone" and mutates `useState`.
 *   2. **A blank is not a zero.** `acosPct` and `cpcCents` are `number | null` in this contract
 *      rather than `number`, deliberately: "not measured" and a real `0.00` must never render the
 *      same, and a section that defaults the null to 0 has invented a measurement.
 *   3. **Promote and negate-at-source are ONE decision, not two.** In `applyHarvest` the H.3
 *      isolation negative fires only when a `destinations` map moved the keyword elsewhere — so
 *      "promoted into the source" and "did not negate the source" are one defect. HV.3 and HV.4
 *      must not be able to ship one without the other, which is why they share this contract.
 */

import type { ReactNode } from 'react'

export type HvGrain = 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'
export type HvKind = 'keyword' | 'product'

/**
 * The four candidate states. There is no fifth and there is no blank.
 *
 * 🔴 `local-only` is a STATUS, not an absence. 210 of the account's 2,129 positive keywords carry
 * no Amazon id, and **209 of those 210 were written by the harvest engine**, each one reporting
 * success. A row that says "already exact" when the keyword never reached Amazon is the same lie
 * as an empty grid under a badge of 5.
 */
export type HvStatus = 'new' | 'already-exact-here' | 'exact-elsewhere' | 'local-only'

export interface HarvestRow {
  id: string
  term: string
  termKey: string
  market: string
  kind: HvKind
  campaign: { id: string | null; name: string; externalId: string; targetingType: string | null; status: string | null }
  adGroup: { id: string | null; name: string; externalId: string }
  metrics: {
    impressions: number
    clicks: number
    spendCents: number
    orders: number
    salesCents: number
    /** null = no sales to divide by. NOT zero. */
    acosPct: number | null
    /** the bid this term has EARNED: cost ÷ clicks. null = never clicked. NOT zero. */
    cpcCents: number | null
  }
  /**
   * Which match types actually produced this term's orders — the column that tells a tautology
   * from a discovery. `previewHarvest` has no match-type filter, so a term that matched an EXACT
   * keyword is offered as a candidate to create that same keyword.
   */
  matchedVia: Array<{ matchType: string; orders: number }>
  exactMatchedOnly: boolean
  status: HvStatus
  existing: { rows: number; atAmazon: number; bidCents: number | null; adGroups: string[] } | null
  /** D5 — read-only here. Refusing to propose a negated term is HV.4; the inventory is session 7's. */
  negatedIn: { rows: number; blocking: number; campaignLevel: number }
  /** HV.3 — where this would go, and what that decides. `null` only when the row has no local ad group. */
  destination: ResolvedDestination | null
}

/** HV.3 — how a destination came to be what it is. C9: show the evidence, or say there is none. */
export type HvDestSource = 'stored' | 'resolved-unique' | 'resolved-ambiguous' | 'none'

/**
 * The candidate's status **relative to its destination** — a different question from HV.1's
 * source-relative `status`, and it never replaces it on screen.
 *
 * HV.1 asked *"does this keyword exist where the traffic came from?"* — a fact about the account.
 * This asks *"would promoting create anything?"* — a fact about a decision, and undecidable until
 * a destination exists, which for 7 of today's 8 candidates it does not.
 */
export type HvDestStatus =
  | 'undecided' | 'no-destination' | 'will-create'
  | 'already-at-destination' | 'destination-local-only' | 'would-duplicate'

export interface DestinationCandidate {
  adGroupId: string
  adGroupName: string
  campaignId: string
  /** 🔴 Always render campaign › ad group. Ad group names REPEAT across campaigns in this account. */
  campaignName: string
  campaignStatus: string | null
  role: 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT' | null
  /** why it is ranked here — composed server-side so the client never infers the evidence */
  why: string
  maxBidCents: number | null
  minBidCents: number | null
  holdsTerm: boolean
  holdsTermAtAmazon: boolean
}

export interface ResolvedDestination {
  createType: 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
  source: HvDestSource
  chosen: DestinationCandidate | null
  shortlist: DestinationCandidate[]
  status: HvDestStatus
  /**
   * 🔴 The §4.1 coupling. False whenever the keyword would land in the ad group that discovered it
   * — which is what `applyHarvest` does with no destinations map, i.e. every harvest ever run here.
   */
  wouldNegateAtSource: boolean
  /** the sentence the page prints, composed server-side so it cannot be phrased two ways */
  negateReason: string
  competingAdGroups: Array<{ id: string; name: string; campaignName: string }>
}

export interface HvCensus {
  candidates: number
  byKind: { keyword: number; product: number }
  newByKind: { keyword: number; product: number }
  new: number
  alreadyExactHere: number
  exactElsewhere: number
  localOnly: number
  negatedAlready: number
  exactMatchedOnly: number
  atOneOrder: {
    candidates: number
    withoutKeywordInSource: number
    noExactMatch: number
    spendCents: number
    salesCents: number
    acosPct: number | null
    singleOrder: number
    repeatedValues: Array<{ salesCents: number; terms: number }>
  }
  negativeCandidates: { count: number; spendCents: number }
  productCandidates: { graduations: number; negatives: number }
  /** HV.3 — how destinations resolved across the whole candidate set, and the §4.1 coupling. */
  destinations: {
    stored: number
    resolvedUnique: number
    ambiguous: number
    none: number
    wouldNegate: number
    wouldNotNegate: number
    wouldDuplicate: number
  }
}

export interface HvFreshness {
  newestTermDate: string | null
  ageDays: number | null
  newestRowWrittenAt: string | null
  rows: number
}

/** HV.2 — the five criteria that decide what counts as a candidate. */
export interface HarvestCriteria {
  minOrders: number
  minClicks: number
  /** null = no ceiling. NOT 0 — a 0% ceiling would admit nothing. */
  maxAcosPct: number | null
  windowDays: number
  excludeExactMatched: boolean
}

export type HvPolicyGrain = 'account' | 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'

/**
 * The criteria in force, and where each half came from.
 *
 * 🔴 `inForce` is what the grid applied. `policy.criteria` is what would apply with no URL
 * override at all. They differ exactly on `overridden`. Keeping the two apart in the contract is
 * what stops a later section rendering a temporary filter as if it were a saved decision.
 */
export interface HvCriteriaState {
  inForce: HarvestCriteria
  policy: {
    criteria: HarvestCriteria
    source: HvPolicyGrain | 'default'
    sourceScopeId: string | null
    hasOwn: boolean
    saveGrain: HvPolicyGrain
    saveScopeId: string | null
    updatedAt: string | null
    updatedBy: string | null
  }
  overridden: string[]
}

/**
 * What each criterion removed, in the order they were applied.
 *
 * `removedNew` is the count of removals whose status was `new` — the only status representing a
 * keyword that does not exist yet, which is the point of the page. It exists because the shipped
 * defaults remove the account's ONE genuinely-new candidate, and a criteria bar that took the
 * page's only real finding off the screen without saying so would be worse than no bar.
 */
export interface HvAttrition {
  base: number
  baseLabel: string
  steps: Array<{ key: string; label: string; removed: number; remaining: number; removedNew: number }>
}

export interface HvScopeState {
  market: string
  line: string
  portfolio: string
  campaign: string
  adGroup: string
  boundBy: HvGrain | null
}

/**
 * What every slot receives. Identical for all seven, so a section cannot quietly widen what it
 * takes and make the client its dependency.
 */
export interface HvSlotProps {
  scope: HvScopeState
  census: HvCensus | null
  rows: HarvestRow[]
  /**
   * HV.2 — the criteria in force, the stored policy behind them, and which the URL is overriding.
   * Every later section reasons about these same numbers: HV.3's destination and HV.4's write must
   * act on exactly the candidate set the operator was looking at when they decided.
   */
  criteria: HvCriteriaState | null
  /** What each criterion removed. HV.2's own bar renders it; later sections may cite it. */
  attrition: HvAttrition | null
  /** The negation threshold, which this page never controls — Negative Targeting owns it (D4). */
  minSpendEur: number
  freshness: HvFreshness | null
  loading: boolean
  /** patch the URL — the single writer of page state, so every view stays linkable */
  push: (patch: Record<string, string>) => void
  /** the candidate the URL is focused on (`?row=<term>`), or null. HV.3 opens its panel from this. */
  row: string | null
  /** re-run the page's read after a write lands. HV.4 onward call it; HV.1 never does. */
  reload: () => void
}

/**
 * Write actions the candidate grid will accept, declared on day one and supplied by nobody yet.
 *
 * HV.4 (promote + negate-at-source as one transaction) and HV.7 (the queue) inject these; HV.1
 * passes `null` for both and the grid renders no selection bar and no row menu. That is the seam
 * that lets those sections ship without opening this client.
 *
 * 🔴 There is deliberately no "approve" that is separate from "promote". A promotion writes a
 * keyword AND its isolation negative, and the two are one transaction in `applyHarvest` — a
 * contract offering them separately would let a later section ship half of it.
 */
export interface HvWriteActions {
  selectionActions: ((ids: string[], clear: () => void) => ReactNode) | null
  onRowAction: ((row: HarvestRow) => void) | null
}

export const NO_WRITE_ACTIONS: HvWriteActions = { selectionActions: null, onRowAction: null }
