/**
 * BID.S0 — the typed seam between this page and the nine sections that follow it.
 *
 * S0 builds the page; S1–S9 fill it. Each later section is meant to be **one new file and one
 * import line**, never a restructuring of `BidClient`. That only holds if the props they render
 * against are declared now, before anyone needs them — a contract written after the fact is just a
 * description of whatever the first section happened to do.
 *
 * The build order (page study §11, and the brief):
 *
 *   S2  grid columns: band · suggested · bidder · sparkline
 *   S3  the bid curve drawer            (`?target=`)
 *   S1  the bidder band                 (header strip)
 *   S5  bounds — floor/ceiling at four grains
 *   S8  activity — changes, refusals, failures
 *   S4  editing + the staged tray
 *   S6  bidder assignment + goal
 *   S7  rules as exceptions             (replaces the provisional rule list)
 *   S9  notifications
 *
 * 🔴 **S0 is read-only and so is this contract.** `NO_WRITE_ACTIONS` exists so that the grid's
 * write-capable props are passed explicitly as absent rather than omitted — the difference between
 * "this page has not got round to writes" and "this page does not write" is the whole of S0's
 * safety story, and an omitted prop cannot say the second thing.
 */

import type { BidCursor, BidTargetRow, BidCampaignRow, BidGridPayload, BidView } from './types'

export type { BidCursor, BidTargetRow, BidCampaignRow, BidGridPayload, BidView }

/** The four grains the scope bar binds. Market is NOT here — `AdsPageHeader` owns it. */
export interface BidScope {
  market: string
  line: string
  portfolio: string
  campaign: string
}

/**
 * What every section receives. Additive only: a section that needs something new adds a field
 * here and `BidClient` fills it, rather than the section reaching into the client's internals.
 */
export interface BidSlotProps {
  scope: BidScope
  view: BidView
  data: BidGridPayload | null
  rows: BidTargetRow[]
  campaigns: BidCampaignRow[]
  loading: boolean
  /** write a patch into the URL; '' or a default value deletes the param */
  push: (patch: Record<string, string>) => void
  /** force a refetch — the staged tray (S4) and the assignment editor (S6) will need it */
  reload: () => void
  /** reserved params, parsed by nobody in S0 and declared from day one so a link survives */
  reserved: {
    /** S6 — bidder assignment */
    bidder: string | null
    /** S2 — bid-state chips: at-floor | suppressed | out-of-band | unexplained | failing */
    state: string | null
    /** S3 — opens the bid-curve drawer for one AdTarget */
    target: string | null
  }
  /** the poll cursor and whether the server has moved since this payload was read */
  refresh: { stale: boolean; lastCheckedAt: string | null; cursor: BidCursor | null }
  /** S5 (additive) — the scope-options payload, for the bounds panel's grain pickers. */
  options: import('./BidScopeBar').ScopeOptionsPayload | null
}

/**
 * The grid's write-capable props, explicitly absent.
 *
 * S4 replaces this object; until then every one of these is `null` at the point of use, so a
 * reviewer can see that the read-only property is stated rather than inferred from what is missing.
 */
export const NO_WRITE_ACTIONS = {
  selectionActions: null,
  onRowAction: null,
  editMode: null,
} as const
