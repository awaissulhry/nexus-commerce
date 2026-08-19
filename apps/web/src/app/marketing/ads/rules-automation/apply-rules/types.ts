/**
 * AR.S0 — the shapes this page merges, and the units they arrive in.
 *
 * Two deployed endpoints, merged on `Campaign.id`, plus a third that carries product-line
 * membership. Kept in its own file rather than inlined in the client so `slot-contract.ts` can
 * import it without importing the client, and so a later section widens a row type in ONE place.
 *
 *   GET /advertising/campaigns?limit=500                    identity · status · delivery · budget
 *   GET /advertising/control-room/guardrail-grid?limit=500  authority: gate · bounds · pins
 *   GET /advertising/scope-options                          product-line membership
 *
 * 🔴 The guardrail grid is already read by the Ad Manager and by the Control Room's Guardrails tab,
 * explicitly "so they cannot drift apart — they are the same rows". This page is the THIRD
 * consumer. Nothing here re-derives a governance fact that endpoint already computes.
 */

// ── the raw payloads, exactly as the API returns them ────────────────────────────────────────────

/**
 * `GET /advertising/campaigns`.
 *
 * 🔴 **`dailyBudget` is in EUROS.** Every money field around it — `minBidCents`, `maxBidCents`,
 * `trueProfitCents`, and the guardrail row's own `dailyBudgetCents` — is in cents, and this one
 * carries no unit in its name. Summing it as cents overstates the account by 100×. It is converted
 * once, at the boundary in `mergeRows`, and nothing downstream sees the euro value again.
 *
 * 🔴 **`spend` is an unlabelled ~30-day window.** Measured 2026-08-11: of the 70 campaigns with
 * stored spend > 0, 65 match the last-30-days window to the cent (8 match 7d, 30 match 60d). The
 * server re-derives it when `preset`/`startDate` are sent, and echoes the range it resolved.
 * **S0 renders no metric column, so it is simply not read** — S4 owns the date control, and must
 * send a key the server understands and display the echo rather than labelling the stored figure.
 */
export interface RawCampaign {
  id: string
  name: string
  type?: string | null
  adProduct?: string | null
  status: string
  marketplace?: string | null
  externalCampaignId?: string | null
  /** EUROS. See the note above. */
  dailyBudget?: number | null
  biddingStrategy?: string | null
  /** volatile — re-read it, never compare it against a number written down somewhere */
  deliveryStatus?: string | null
  deliveryReasons?: unknown
  portfolioId?: string | null
  minBidCents?: number | null
  maxBidCents?: number | null
  targetAcos?: number | null
  /** U11 — H10's "Bid Automation" column reads this. Real field; false on all 220 today. */
  bidAutomation?: boolean | null
  lastSyncedAt?: string | null
}

/** `GET /advertising/control-room/guardrail-grid` — one row per campaign, all 220. */
export interface RawGuardrailRow {
  id: string
  name: string
  marketplace?: string | null
  status?: string | null
  portfolioId?: string | null
  portfolioName?: string | null
  /** `liveBidWritesEnabled` — the per-campaign write gate. 82 of 220. */
  managed?: boolean | null
  minBidCents?: number | null
  maxBidCents?: number | null
  dailyBudgetCents?: number | null
  targetAcosPct?: number | null
  cpcCeiling?: unknown
  suppressedAt?: string | null
  suppressedBy?: string | null
  suppressedFloorCents?: number | null
  pins?: { placement?: boolean; bids?: boolean; budget?: boolean } | null
  pinnedDimensions?: string[] | null
  pinNote?: string | null
  pinnedBy?: string | null
  pinnedAt?: string | null
  boundRules?: unknown[] | null
}

export interface GuardrailPayload {
  rows?: RawGuardrailRow[]
  /**
   * 🔴 Counts `enabled AND scopeCampaignId=null AND scopePortfolioId=null` — it does NOT exclude
   * MARKET scope, so a market-scoped rule is counted as account-wide. Harmless today (all 8 scoped
   * rules are DISABLED, measured) and wrong the day one is enabled, at which point "22 rules govern
   * every campaign" becomes false for the 70 non-IT rows. Carried into `ApplyRulesTotals` with the
   * caveat attached rather than as a bare number, so S6 cannot inherit it silently.
   */
  accountWideRules?: number
  totals?: {
    campaigns?: number; managed?: number; withMinBid?: number; withMaxBid?: number
    pinned?: number; suppressed?: number
  }
}

/**
 * `GET /advertising/scope-options` — small on purpose. ~220 campaigns, 12 portfolios, 13 product
 * lines, so any grain's reach is resolved CLIENT-SIDE, which is why a reach preview can never
 * disagree with what enforcement does.
 */
export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

// ── the merged row ───────────────────────────────────────────────────────────────────────────────

/**
 * One campaign, identity and authority together. This is the grain the whole page is true at: even
 * at market / portfolio / line grain the client holds these rows and derives the aggregates from
 * them, so a group total and a drill-down can never disagree.
 */
export interface CampaignRow {
  id: string
  name: string
  market: string
  status: string
  /** volatile; read in the same minute as everything else on the page */
  deliveryStatus: string | null
  type: string
  externalCampaignId: string | null
  /** converted from the payload's EUROS exactly once, here */
  dailyBudgetCents: number
  biddingStrategy: string | null
  bidAutomation: boolean | null
  portfolioId: string | null
  portfolioName: string | null
  /** every product line this campaign advertises — a campaign can be in more than one */
  lineIds: string[]
  // ── authority, from the guardrail grid ──
  /** the write gate. Measured 2026-08-12: 82 of 220, and every one of them is ENABLED. */
  managed: boolean
  minBidCents: number | null
  maxBidCents: number | null
  pinned: boolean
  pins: { placement: boolean; bids: boolean; budget: boolean }
  suppressedAt: string | null
  suppressedBy: string | null
  /** true when the guardrail grid had no row for this campaign — never silently zero */
  authorityMissing: boolean
  /**
   * AR.S1 — from the GUARDRAIL grid, not the campaigns payload: the campaigns payload's
   * `targetAcos` carries the 30% engine fallback on every row (§4's "the 30.00%"), which is a
   * default wearing a setting's clothes. `null` here means genuinely unset.
   */
  targetAcosPct: number | null
  /** how many rules are BOUND to this campaign (scope pinned to it) — 0 almost everywhere */
  boundRules: number
}

/**
 * 🔴 The one mapping this page is NOT allowed to reinvent.
 *
 * The old grid read `c.minMaxBid` — a key the payload does not contain (`'minMaxBid' in items[0]`
 * is **false**, probed live) — and therefore rendered "None" on all 220 rows, forever. The correct
 * derivation already exists at `…/ads/campaigns/CampaignsGrid.tsx:850-856` and is copied verbatim
 * here so S2/S3 inherit it right rather than re-deriving it from the same wrong name.
 *
 * S0 renders no bid column. This lives here so that the first section that does cannot get it wrong.
 */
export const centsToEur = (v: number | null | undefined): number | null => (v == null ? null : v / 100)

export const minMaxBid = (r: { minBidCents: number | null; maxBidCents: number | null }):
{ min: number | null; max: number | null } | null =>
  (r.minBidCents != null || r.maxBidCents != null)
    ? { min: centsToEur(r.minBidCents), max: centsToEur(r.maxBidCents) }
    : null

// ── labels ───────────────────────────────────────────────────────────────────────────────────────

// U11d — `STRATEGY_LABEL` removed. It said "Up & down" where the Ad Manager's said "Up and Down",
// for the same Amazon value, on two pages an operator reads side by side. The one map now lives in
// `ads/_shared/CampaignRowCells.tsx` as `STRAT_LABEL`.

export const STATUS_LABEL: Record<string, string> = {
  ENABLED: 'Enabled', PAUSED: 'Paused', ARCHIVED: 'Archived',
}

export const DELIVERY_LABEL: Record<string, string> = {
  DELIVERING: 'Delivering', NOT_DELIVERING: 'Not delivering',
}

/** The four production Amazon Ads markets. `all` is the account-wide view the header already offers. */
export const MARKETS = ['IT', 'DE', 'FR', 'ES']
