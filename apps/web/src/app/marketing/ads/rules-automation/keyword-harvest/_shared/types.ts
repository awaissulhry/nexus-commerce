/**
 * Keyword Harvest page — the API's shapes, ONE place for the three lanes (TERMS, HTO, HRULES) (2026-10-11, wave 2).
 *
 * Source: `~/nexus-archive/2026-10-10-ads-pages/02-harvest/HCORE-API.md` and the engine on local/hv-core
 * (`apps/api/src/services/advertising/harvest/`), checked against real answers of the private stack (:4793). Every route
 * lives under `/api/advertising/harvest`. Money is in minor units of the row's market currency (`currency`), under money
 * keys that the server strips for a person without `financials.adspend.view` — so every money field here is OPTIONAL and
 * may be absent (never read an absent one as 0). `Ref.href` has NO `/w/<id>` prefix: the workspace `Link` adds it.
 *
 * The destination tree's types are the DestinationPicker's own (`rules-automation/_shared/destinationOptions.ts`, lane HDS):
 * re-exported here so a lane never declares them twice.
 */
import type { ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import type {
  DestinationAdGroup, DestinationCampaign, DestinationNewCampaign, DestinationPortfolio, DestinationStored, HarvestDestinations,
  HarvestHeld, HarvestMatch, HarvestRef, HarvestRole, HarvestTo,
} from '../../_shared/destinationOptions'
import type { BidRuleRow, BidRulesTotals } from '../../bid/rules/bidRulesModel'

export type {
  DestinationAdGroup, DestinationCampaign, DestinationNewCampaign, DestinationPortfolio, DestinationStored, HarvestDestinations,
  HarvestHeld, HarvestMatch, HarvestRef, HarvestRole, HarvestTo,
}

/** `{ id, name, href? }` — href without the `/w/<id>` prefix. */
export type Ref = HarvestRef

// ── candidates ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every state a candidate can be in. The default read lists the first seven. */
export const ALL_STATES = [
  'READY', 'NEEDS_DESTINATION', 'NEEDS_CAMPAIGN', 'HELD', 'WAITING', 'IN_FLIGHT', 'HARVESTED',
  'AT_HOME', 'OWNED_BY_SIBLING', 'BELOW_BAR', 'SKIPPED',
] as const
export type CandidateState = (typeof ALL_STATES)[number]

export type OwnerKind = 'BRAIN' | 'RULE' | 'PERSON' | 'NONE'
export type Verdict = 'better' | 'worse' | 'too-early'
export type SourceAction = 'negate' | 'standing' | 'kept' | 'skipped'
export type HoldKind = 'destination' | 'protected' | 'sibling' | 'source' | 'cap' | 'lever' | 'record' | 'bid' | 'home'

/** Why a term cannot go now: `label` ≤ 3 words (the chip), `reason` the sentence (the tooltip). */
export interface CandidateHold { kind: HoldKind; label: string; reason: string }

/** One ad group of the product where the term ran, and what a harvest does there. */
export interface CandidateSource {
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  role: HarvestRole | null
  clicks: number
  action: SourceAction
  why: string
}

export interface CandidateMetrics {
  windowDays: number
  impressions: number
  clicks: number
  orders: number
  spendCents?: number
  salesCents?: number
  acosPct?: number | null
  cpcCents?: number | null
}

export type CandidateDestination =
  | {
    kind: 'existing'
    how: 'stored' | 'playbook' | 'own' | 'ranked' | 'chosen' | string
    portfolio: Ref | null
    campaign: Ref
    adGroup: Ref
    match: HarvestMatch
    status: 'will-create' | 'already-there' | 're-enable'
  }
  | {
    kind: 'new'
    how: 'new'
    match: HarvestMatch
    plan: { name: string; adGroupName: string; portfolio: Ref | null; dailyBudgetCents?: number }
  }

/** A harvest request waiting for a person: a change set, or a harvest rule's ask (`kind: 'rule-ask'`, its suggestion id). */
export interface CandidateWaiting {
  approvalId: string
  kind?: 'request' | 'rule-ask'
  /** The request's tool, or `rule:<ruleId>` for a rule's ask. */
  tool?: string
  by: { kind: 'BRAIN' | 'PERSON' | 'CLAUDE' | 'RULE' | string; id: string | null; name?: string | null }
  at: string
  expiresAt: string | null
  /** How many terms this one request covers. */
  terms?: number
  /** A rule's ask its approval would refuse now (its rule changed, is off or gone): Approve held with `why`, Reject only. */
  stale?: { why: string } | null
}

export interface CandidateLastHarvest {
  harvestId: string
  at: string
  by: { kind: string; id: string | null }
  status: HarvestStatus | string
  verdict: Verdict | null
  /** M3: the undo's own answer, the same as /history's. */
  undo: { available: boolean; why: string | null }
  /** M3: the harvested keyword as it stands in Nexus now (state null: the harvest has no keyword). */
  keyword: { id?: string | null; state: 'ENABLED' | 'PAUSED' | 'ARCHIVED' | null } | null
  /** S7: why the check said Better / Worse (null: nothing to say). */
  judge: { why: string | null } | null
}

/** S7 (polish contract): the harvested keyword's own numbers since it landed. */
export interface SinceHarvest { days: number; clicks: number; orders: number; spendCents?: number; salesCents?: number; acosPct?: number | null }

/** GET /candidates — one row: one term of one product in one market, over every source of the product where it ran. */
export interface HarvestCandidateRow {
  /** `${market}|${productId}|${term}` — the product FAMILY ROOT id, the term lower case with single spaces. */
  id: string
  term: string
  kind: 'keyword' | 'asin'
  market: string
  /** B18: every amount of the row is in this currency (ISO, e.g. EUR). Null when no campaign names one. */
  currency: string | null
  product: Ref
  /** The main source (most clicks). */
  source: { portfolio: Ref | null; campaign: Ref; adGroup: Ref; role: HarvestRole | null } | null
  sources: CandidateSource[]
  metrics: CandidateMetrics
  bar: { by: 'strategy' | 'brain'; label: string; passes: boolean }
  state: CandidateState
  owner: { kind: OwnerKind; id: string | null; name: string }
  heldBy: CandidateHold | null
  destination: CandidateDestination | null
  /** The funnel blocks the add implies (only those to write). */
  funnel: Array<{ campaign: Ref; adGroup: Ref; match: HarvestMatch }>
  /** Null when not READY; absent without the money permission. */
  startBidCents?: number | null
  bidWhy: string | null
  skipped: null | { until: string | null; by: string | null; at: string | null }
  waiting: CandidateWaiting | null
  lastHarvest: CandidateLastHarvest | null
  /** S7: on HARVESTED rows, the keyword's own numbers in its destination since it landed (null: none yet). */
  sinceHarvest?: SinceHarvest | null
}

/** Counted over the scope filters (market, product, portfolio, campaign, ad group, kind, q), NOT the state filter. */
export interface CandidateTotals {
  candidates: number
  ready: number
  needDestination: number
  needCampaign: number
  held: number
  waiting: number
  inFlight: number
  harvested30d: number
  worse: number
  waitingToJudge: number
  skipped: number
  ownedBySibling: number
  belowBar: number
  atHome: number
  /** M4: the distinct harvest requests that wait AND can be approved now (one request can cover several terms). */
  waitingRequests: number
  /** The waiting requests that are out of date (stale rule asks — one term each): rejected, never approved. */
  waitingStale: number
  /** "Harvested" in the page's one window (60 days, the ledger's — re-audit NICE); counted by the Terms view. */
  harvestedWindow?: number
}

export interface CandidateCriteria {
  label: 'Ads strategy' | 'Brain test' | 'Ads strategy · Brain test' | string
  markets: Array<{
    market: string
    by: 'strategy' | 'brain'
    source: string | null
    minOrders: number | null
    minClicks: number | null
    maxAcosPct?: number | null
    windowDays: number
  }>
}

export interface CandidatesAnswer {
  markets: string[]
  rows: HarvestCandidateRow[]
  total: number
  page: number
  pageSize: number
  totals: CandidateTotals
  criteria: CandidateCriteria
  freshness: { dataDay: string | null; windowDays: number | null }
  /** Products left out (no campaign of their own in the market). */
  skipped: Array<{ market: string; productId: string; why: string }>
}

/** The query of GET /candidates. `market` is a code, a comma list or `all`. */
export interface CandidateQuery {
  market: string
  productId?: string | null
  portfolioId?: string | null
  campaignId?: string | null
  adGroupId?: string | null
  /** The page's filter bar: `portfolioIds`, `campaignIds`, `adGroupIds`, `productIds` (lists; OR inside, AND across). */
  lists?: ScopeApi | null
  /** Default: the first seven of `ALL_STATES`. `['all']` = every state. */
  state?: readonly (CandidateState | 'all')[] | null
  owner?: OwnerKind | null
  kind?: 'keyword' | 'asin' | null
  q?: string | null
  page?: number
  /** ≤ 500. Default 50. */
  pageSize?: number
  /** orders, acos, spend, clicks, cpc, term, state or product; `-` for descending. Default `-orders`. */
  sort?: string | null
}


// ── preview / apply ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One term of a change set. `to` absent = the suggested place. */
export interface PreviewItemInput {
  candidateId: string
  to?: HarvestTo
  match?: HarvestMatch
  /** ≥ 2, ≤ 10,000 minor units. Default: the bid brain's goal bid. */
  bidCents?: number
  /** false keeps the sources; true overrides the Owner's saved negateAtSource=false. */
  negateSource?: boolean
  /** false leaves the funnel blocks out. */
  funnel?: boolean
}
export interface NewCampaignInput {
  key: string
  productId: string
  match?: HarvestMatch
  name?: string
  /** ≥ 100 (Amazon's lowest daily budget). */
  dailyBudgetCents?: number
  portfolio?: { id: string } | { newPortfolio: string } | null
}
export interface NewPortfolioInput { key: string; name: string; capMonthlyCents?: number }

/** POST /preview body (writes nothing). ≤ 200 items, ≤ 20 new campaigns, ≤ 10 new portfolios. */
export interface PreviewBody {
  items: PreviewItemInput[]
  newCampaigns?: NewCampaignInput[]
  newPortfolios?: NewPortfolioInput[]
}

export type StepKind = 'portfolio' | 'portfolioCap' | 'campaign' | 'keyword' | 'enable' | 'sourceNegative' | 'funnelNegative'

/** One step of the change set. New entities have ids `new:<key>` / `new:<key>:group`. */
export interface PreviewStep {
  i: number
  kind: StepKind
  candidateId?: string
  term?: string
  portfolio?: Ref | null
  campaign?: Ref | null
  adGroup?: Ref | null
  match?: HarvestMatch
  bidCents?: number
  dailyBudgetCents?: number
  capMonthlyCents?: number
  from: string
  to: string
  after: number[]
  refusal: string | null
}

export interface PreviewItem {
  candidateId: string
  term: string
  productId: string
  market: string
  ok: boolean
  refusal: string | null
  hold: CandidateHold | null
  match: HarvestMatch
  destination: null
    | { kind: 'existing'; how: string; adGroup: Ref; campaign: Ref; portfolio: Ref | null; status: string }
    | { kind: 'new'; key: string; name: string }
  bidCents?: number | null
  bidWhy: string | null
  sources: Array<{ adGroup: Ref; campaign: Ref; action: string; negMatch: HarvestMatch; why: string }>
  funnel: Array<{ adGroup: Ref; campaign: Ref; action: string; negMatch: HarvestMatch; why: string }>
}

export interface PreviewAnswer {
  steps: PreviewStep[]
  items: PreviewItem[]
  approvals: { count: number; codes: number }
  /** Items are never dropped: each is ok or here, with its reason. */
  blocked: Array<{ candidateId: string; term: string; reason: string }>
  totals: { items: number; ok: number; keywords: number; enables: number; sourceNegatives: number; funnelNegatives: number; campaigns: number; portfolios: number }
  planHash: string
  raises: string[]
  effect: string
}

/** POST /apply body: the previewed body + its planHash. `approve: true` = the same person approves it in this click. */
export interface ApplyBody extends PreviewBody {
  planHash: string
  why?: string
  approve?: boolean
  code?: string
}

export type RequestStatus = 'queued' | 'scheduled' | 'runs_by_rule'

/** 202 of POST /apply and /undo: ONE apply-harvest request (an approval, never a direct write). */
export interface RequestAnswer {
  changeSetId: string
  status: RequestStatus
  expiresAt: string | null
  executeAfter?: string | null
  /** Present when `approve: true` was asked. */
  approve?: { ok: boolean; code?: string; error?: string }
}
export type ApplyAnswer = RequestAnswer
export type UndoAnswer = RequestAnswer
export interface UndoBody { harvestIds: string[]; why?: string; approve?: boolean; code?: string }

// ── skip / waiting ────────────────────────────────────────────────────────────────────────────────────────────────────

/** 7 days, 30 days, or for good (null). */
export type SkipDays = 7 | 30 | null
/** POST /skip and /unskip (Nexus only, at once; unskip is the undo). */
export interface SkipAnswer { changed: number; until: string | null; forGood: boolean; ids: string[]; refused: Array<{ id: string; why: string }> }

export interface WaitingDecision { approvalId: string; decide: 'approve' | 'reject'; code?: string }
/** POST /waiting/decide. `code` back = this one needs the approver's authenticator code. */
export interface DecideAnswer {
  results: Array<{ approvalId: string; ok: boolean; status?: string; executeAfter?: string | null; error?: string; code?: string }>
}

// ── history ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type HarvestStatus = 'WRITING' | 'CAMPAIGN_BUILT' | 'DONE' | 'HALF_DONE' | 'UNDO_PROPOSED' | 'UNDONE' | 'REFUSED' | 'FAILED'

export interface HistoryRow {
  harvestId: string
  candidateId: string
  term: string
  market: string
  product: Ref
  at: string
  by: { kind: string; id: string | null; name: string }
  changeSetId: string | null
  match: string
  status: HarvestStatus | string
  destination: { portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null } | null
  keyword: Ref | null
  sources: Array<{ adGroup: Ref; result: string | null; action: string }>
  funnel: Array<{ adGroup: Ref; match: string; result: string | null; action: string }>
  judge: { verdict: Verdict | null; judgeAfter: string | null; judgedAt: string | null; why: string | null }
  undo: { available: boolean; why: string | null }
}
export interface HistoryTotals { harvested: number; better: number; worse: number; tooEarly: number; undone: number }
export interface HistoryAnswer { rows: HistoryRow[]; totals: HistoryTotals }
export interface HistoryQuery {
  market: string
  productId?: string | null
  days?: number
  actor?: 'BRAIN' | 'PERSON' | 'CLAUDE' | 'RULE' | null
  verdict?: Verdict | 'none' | null
}

// ── rules (the Bid page's BidRuleRow shape; the brain first as id 'brain') ──────────────────────────────────────────────

export type HarvestRuleRow = BidRuleRow
export type HarvestRulesTotals = BidRulesTotals
export interface HarvestRulesAnswer { market: string | null; rules: HarvestRuleRow[]; totals: HarvestRulesTotals }
export interface RuleHistoryAnswer { id: string; name: string; days: number; harvests: HistoryRow[] }
/** POST /rules/preview as the page asks it: a saved rule (Claude's harvest-rules may also preview a draft's actions). */
export interface RulePreviewBody {
  ruleId: string
  limit?: number
}
export interface RulePreviewAnswer {
  market: string | null
  campaigns: number
  wouldHarvest: number
  held: number
  capPerDay: number
  sample: Array<{ candidateId: string; term: string; product: Ref; destination: unknown; startBidCents?: number | null; heldBy: CandidateHold | null }>
}
export interface RuleArchiveAnswer { id: string; name: string; archived: boolean; level: 'OFF'; already: boolean; expiredAsks: number }

// ── sources ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HarvestSourceRow {
  /** The ad group id. */
  id: string
  adGroup: Ref
  campaign: Ref
  portfolio: Ref | null
  product: Ref | null
  role: 'AUTO' | 'BROAD' | 'PHRASE' | 'PRODUCT' | null
  rules: Ref[]
  paused: null | { by: string; at: string }
  /** Over the answer's one window (`windowDays`): the terms it found, those that sold, those harvested. */
  terms: number
  sellingTerms: number
  harvested: number
}
export interface HarvestSourcesTotals { sources: number; paused: number; withRule: number; sellingGroups: number }
export interface HarvestSourcesAnswer { market: string; windowDays: number; rows: HarvestSourceRow[]; totals: HarvestSourcesTotals }
export interface SourcesAssignAnswer { id: string; ok: boolean; changed: number; error?: string }
export interface SourcesDetachAnswer { results: Array<{ id: string; ok: boolean; changed: number; error?: string }> }
/** The ad group ids paused now, already paused, not found. */
export interface SourcesPauseAnswer { paused: string[]; already: string[]; notFound: string[] }
export interface SourcesResumeAnswer { resumed: number }

// ── the page's contracts between lanes ────────────────────────────────────────────────────────────────────────────────

/** TERMS → HTO: what `<HarvestToWindow/>` (`keyword-harvest/harvest-to/index.ts`) harvests — the ticked rows. */
export type HarvestToSource = { rows: HarvestCandidateRow[] }
/** 'suggested' = every term to its own suggested place (one review); 'choose' = one destination for all. */
export type HarvestToMode = 'suggested' | 'choose'
/** The props of `<HarvestToWindow/>` (contract in HARVEST-WAVE2.md). */
export interface HarvestToWindowProps {
  open: boolean
  source: HarvestToSource
  mode: HarvestToMode
  market: string
  productId?: string | null
  /** Where the focus goes when the window closes (a grid cell). */
  returnFocusTo?: () => HTMLElement | null
  onClose(): void
  /** Once, when the window closes after a change set was asked; then `onClose`. */
  onDone(): void
}

/** A tile a view reports (the Rules and Sources views, lane HRULES): its id is the `?show=` value that filters it. */
export interface ViewTile {
  id: string
  label: string
  value: number
  tone: 'success' | 'primary' | 'warning' | 'danger'
  /** Clicking it filters (false: nothing to show, it only counts). */
  filters: boolean
}
/** What the Rules and Sources views report after each read (`onTotals`): at least their tiles. */
export interface ViewReport { tiles: readonly ViewTile[] }
