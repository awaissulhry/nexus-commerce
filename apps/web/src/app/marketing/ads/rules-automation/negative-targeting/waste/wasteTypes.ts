/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the shapes the page reads from `/api/advertising/waste/*`, as the
 * API answers them (`apps/api/src/services/advertising/waste/{pure,stopped,row,history,write}.ts`; the code is the
 * contract). Money is in cents of the row's currency; a money key the server left out (no ad-spend permission) is
 * `undefined` and reads as a dash. Hrefs carry no `/w/<id>` prefix: the workspace `Link` adds it.
 */

export interface Ref { id: string; name: string; href?: string }

export type RowKind = 'KEYWORD' | 'TARGET' | 'TERM'
export type Match = 'EXACT' | 'PHRASE' | 'BROAD' | 'AUTO' | 'ASIN' | 'CATEGORY'
/** TURNED_ON_ELSEWHERE: kept paused, but Amazon serves it — someone switched it on outside Nexus. */
export type RowState = 'RUNNING' | 'PAUSED' | 'KEPT_PAUSED' | 'TURNED_ON_ELSEWHERE' | 'NEGATED' | 'PROTECTED'
export type OwnerKind = 'BRAIN' | 'RULE' | 'HARVEST' | 'PERSON' | 'CLAUDE' | 'NONE'
export interface Owner { kind: OwnerKind; name: string; id: string | null }
/** REMOVE_NEGATIVE: a clash "negative over our own keyword" — the fix is to remove that negative (`targetRowId`). */
export type VerbAction = 'PAUSE' | 'NEGATE_EXACT' | 'NEGATE_PHRASE' | 'NEGATE_ASIN' | 'REMOVE_NEGATIVE'
export type Where = 'adGroup' | 'campaign'
export interface Verb { action: VerbAction; where: Where; held: null | { label: string; reason: string }; targetRowId?: string | null }

export interface RowTest {
  met: boolean
  by: Ref | null
  sentence: string
  windowDays: number
  clicksNeeded: number
  spendBarCents?: number | null
  xCpaBar: number | null
  /** HONEST 15 — false: listed only for an ask, the page's test never ran on it (no checks are drawn). */
  judged?: false
  /** HONEST 18c — the last day its clicks and spend count (YYYY-MM-DD, 3 days ago): "60 days to 24 Oct". */
  settledThrough?: string
}

export interface RowNumbers {
  impressions: number
  clicks: number
  orders: number
  spendCents?: number
  salesCents?: number
  acosPct?: number | null
  cpcCents?: number | null
  xCpa?: number | null
}

export interface WasteRow {
  id: string
  kind: RowKind
  text: string
  match: Match
  channel: 'AMAZON'
  market: string
  currency: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  product: Ref | null
  productCount: number
  via: Ref | null
  state: RowState
  owner: Owner
  verb: Verb
  test: RowTest
  d: RowNumbers | null
  d90: { clicks: number; orders: number; spendCents?: number } | null
  spark?: number[]
  stockOutDays: number
  /** `rows`: how many rows this one ask covers (one ask, several places). */
  waiting: null | {
    approvalId: string; by: Ref; at: string; expiresAt: string | null; rows?: number
    /** NFIX — the ask is a change plan: its steps (approved together) and how many are not on this page. */
    plan?: { steps: number; offPage: number }
    /**
     * HONEST 10 — the ask's OWN change at this row (never the row's verb): its action, the negative's match (our keyword's
     * own for a pause), where it lands (null for a pause), its words, and for a pause whether it keeps it paused.
     * Absent on an older answer.
     */
    action?: VerbAction
    match?: Match | null
    level?: 'AD_GROUP' | 'CAMPAIGN' | null
    text?: string | null
    keepPaused?: boolean
    /** HONEST 18d — a removal: whether Amazon holds the negative (false: removing it changes Nexus only). */
    atAmazon?: boolean
    /** HONEST 11 — how many of this page's changes the ask holds (1: one change, which may cover several rows). */
    changes?: number
  }
  /** `by`: the person's name (HONEST 19). */
  skipped: null | { until: string; by: string | null; at: string | null }
  /** HONEST 18b — other live ad groups where its words SPENT in the window, not blocked there now. */
  stillServesIn: number
  lastChange: null | { action: string; at: string; by: Ref; changeId: string | null }
  /** HONEST 13 — a NEGATED term: the negative that blocks it here (its own words, match and level). */
  blockedBy?: ClashNegative | null
  /** Step 4 — a PROTECTED row: every protected term that keeps it safe (the page names the first) and what holds its verb
   *  once they are removed (`then`, null: it can stop). */
  protection?: RowProtection
  /** Step 4 — Remove protection and stop, still finishing on the server (WAITING), or not stopped and why (REFUSED). */
  followUp?: { status: 'WAITING' | 'REFUSED'; why: string | null; at: string }
  /** A clash the Owner should see (the Clashes tile lists exactly these rows), with why in plain words. */
  clash?: null | { kind: 'TURNED_ON' | 'NEG_OVER_OWN_KEYWORD' | 'BLOCKS_SOLD'; label: string; negative?: ClashNegative | null }
  /**
   * NFIX — listed only for what waits on it (an ask no wasting row carries: a phrase piece, a negative's removal, a paused
   * place). The server shows it under Waiting only; its verb is the ask's own.
   */
  askOnly?: true
}

/** Step 4 — one protected term (the Control Room's protected terms) that keeps a row safe. */
export interface ProtectionTerm {
  id: string
  term: string
  match: 'EXACT' | 'PREFIX' | 'CONTAINS'
  /** null: every market. */
  market: string | null
  /** null: every campaign. */
  campaign: Ref | null
  reason: string | null
}
export interface RowProtection { terms: ProtectionTerm[]; then: { label: string; reason: string } | null }
/** What else a protected term keeps safe over its scope (counts, no money). */
export interface AlsoKeeps { count: number; terms: Array<{ text: string; kind: RowKind; places: number; wasting: boolean }> }

/** The negative that blocks our own keyword (a clash): the fix is to remove it. */
export interface ClashNegative {
  rowId: string
  text: string
  match: Match
  level: 'AD_GROUP' | 'CAMPAIGN'
  campaign: Ref
  adGroup: Ref | null
  owner: Owner
}

export interface WasteTotals {
  wasting: number
  /** One currency: the wasting spend; null when the rows bill in several (then the split, never a sum). */
  wastingSpendCents?: number | null
  /** The one currency of the wasting rows; null when several. */
  currency?: string | null
  wastingSpendByCurrency?: Record<string, number>
  wastingSpendNote?: string | null
  /** HONEST 18c — the windows (days) of the rows the wasting spend sums, lowest first. Absent from an older server. */
  wastingWindows?: number[]
  /** Kept paused, but switched on outside Nexus. */
  turnedOn?: number
  keywords: number
  terms: number
  waiting: number
  keptPaused: number
  negated: number
  clashes: number
  skipped: number
  /** Step 4 — wasting rows a protected term keeps safe (show=protected). Absent from an older server. */
  protected?: number
}

export interface WasteCriteria { sentence: string; source: 'rule' | 'strategy' | 'default'; windowDays: number; settledThrough: string; ordersThrough: string }
export interface WasteFreshness { searchTermsThrough: string | null; keywordsThrough: string | null; readAt: string }

export interface RowsAnswer {
  rows: WasteRow[]
  total: number
  page: number
  pageSize: number
  totals: WasteTotals
  criteria: WasteCriteria
  freshness: WasteFreshness
}

export interface IdsAnswer { ids: string[]; total: number; truncated: boolean }

export type StoppedState = 'KEPT_PAUSED' | 'PAUSED' | 'NEGATED' | 'TURNED_ON_ELSEWHERE' | 'NOT_AT_AMAZON'
export interface ActionGate { allowed: boolean; why: string }

export interface StoppedRow {
  id: string
  kind: RowKind
  text: string
  match: Match
  level: 'AD_GROUP' | 'CAMPAIGN' | null
  market: string
  currency: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref | null
  product: Ref | null
  owner: Owner
  since: string | null
  sinceSource: 'hold' | 'record' | 'brain' | 'harvest' | 'first-seen' | null
  /** NFIX — how "Since" is known, or why it is not (`since` null: the page shows "—" with this on hover). */
  sinceWhy?: string | null
  keptPaused: null | { by: Ref; at: string; until: string | null; reason: string | null }
  spendBeforeCents?: number | null
  state: StoppedState
  /** HONEST 18b — other live ad groups where its words SPENT since the stop (the window when the stop day is unknown). */
  stillServesIn: number
  places: number
  actions: { turnOn: ActionGate; removeNegative: ActionGate; release: ActionGate }
  /** Step 4 — "Did it work?"; null when the stop day is not known or the days before it are older than Nexus keeps. */
  effect?: StopEffect | null
}

export interface StoppedTotals { all: number; kept: number; paused: number; negated: number; turnedOn: number; stillBought: number; notAtAmazon: number; inactive: number }

export interface StoppedAnswer { rows: StoppedRow[]; total: number; page: number; pageSize: number; totals: StoppedTotals }

export type Delivery = 'WAITING' | 'SENT' | 'LIVE' | 'UNDONE' | 'FAILED' | 'CANCELLED' | 'REFUSED'
export type HistoryAction = 'paused' | 'kept' | 'released' | 'turned_on' | 'negated' | 'removed' | 'refused' | 'skipped'

export interface HistoryItem {
  at: string
  action: HistoryAction
  text: string
  kind: RowKind
  rowId: string | null
  campaign: Ref
  adGroup: Ref | null
  product: Ref | null
  by: Ref
  why: string | null
  changeId: string | null
  changeSetId: string | null
  delivery: Delivery
  undo: { available: boolean; why: string }
}

export type PlaceState = 'RUNNING' | 'PAUSED' | 'KEPT_PAUSED' | 'PROTECTED' | 'NEGATED' | 'NOT_AT_AMAZON'
export interface Place {
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref | null
  match: Match
  state: PlaceState
  owner: Owner
  d: RowNumbers | null
  /** HONEST 18c — the days `d` covers, to the answer's settledThrough. */
  windowDays?: number
  rowId: string | null
  /** HONEST 8 — Spends here: why the row's own verb there may not run (the server re-checks it on send); absent: it may. */
  held?: { label: string; reason: string }
}

export interface RowDetail {
  row: WasteRow | StoppedRow; runsIn: Place[]; blockedIn: Place[]; history: HistoryItem[]
  /** HONEST 18a — the live ad groups, other than the row's own, a negative blocks NOW (ad groups, not negatives). */
  blockedAdGroups?: number
  /** HONEST 18c — the last day the numbers' clicks and spend count (YYYY-MM-DD). */
  settledThrough?: string
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** KEEP_UNTIL: a kept-paused keyword's end date (null = Always); its Undo puts the old end back. UNPROTECT (step 4): one
 *  protected term that keeps the row safe is removed (`protectionId`), before the row's own verb. */
export type WasteAction = 'PAUSE' | 'NEGATE_EXACT' | 'NEGATE_PHRASE' | 'NEGATE_ASIN' | 'TURN_ON' | 'REMOVE_NEGATIVE' | 'RELEASE' | 'KEEP_UNTIL' | 'UNPROTECT'
/**
 * `adGroupId`: a negative in a named ad group of the same product ("Still bought elsewhere"). Words view: `rowId` a word
 * (`word:<market>|<word>`), NEGATE_PHRASE, one step per place; `scope` the filter-bar lists its row was read with.
 */
export interface WasteItem { rowId: string; action: WasteAction; where?: Where; keepUntil?: string | null; adGroupId?: string; targetRowId?: string; protectionId?: string; scope?: Readonly<Record<string, string | undefined>> }

export interface PreviewStep {
  rowId: string
  action: WasteAction
  text: string | null
  place: { portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null }
  from: string | null
  to: string | null
  lands: 'amazon' | 'nexus' | 'approval' | null
  runsAt: string | null
  refusal: null | { code: string; label: string }
  raise: boolean
  needsCode: boolean
  tool: string | null
  summary: string | null
  /** Where it lands: the ad group, or the whole campaign. */
  level?: 'AD_GROUP' | 'CAMPAIGN' | null
  /** Archived at Amazon: it cannot come back (a removal). */
  final?: boolean
  /** Step 4 — a NEGATE_* step: what it would block; null where its place cannot be read; absent on other steps. */
  reach?: Reach | null
  /** Step 4 — UNPROTECT: the protected term it removes, and what else it keeps safe. */
  protection?: ProtectionTerm & { alsoKeeps?: AlsoKeeps }
  /** Step 4 — it waits for its row's UNPROTECT (a negative of a protected term): sent once the removal ran. */
  after?: 'UNPROTECT'
}

/** `reach`: the steps that are sent, together (each term once); null when none adds a negative. */
export interface PreviewAnswer { steps: PreviewStep[]; blocked: number; planHash: string; reach?: ReachTotal | null }

/** Step 4 — the negatives that wait for a protected term's removal: the server sends them once it ran, as the approver. */
export interface FollowUpView {
  approvalId: string
  status: 'WAITING' | 'SENDING' | 'SENT' | 'REFUSED' | 'CANCELLED'
  changeSetId: string | null
  rowIds: string[]
  /** Per row: asked and approved (`sent`), where it lands then (Amazon, or Nexus only), or why not. */
  results: Array<{ rowId: string; sent: boolean; why: string | null; lands?: 'amazon' | 'nexus' | null }>
  why: string | null
  createdAt: string
  endedAt: string | null
  /** The negatives' change set now: in its undo window (scheduled), or ran (executed). */
  changeSet?: { status: string; executeAfter: string | null } | null
}

export interface ApplyAnswer {
  changeSetId?: string | null
  status?: 'queued' | 'waiting' | 'applied'
  executeAfter?: string
  expiresAt?: string | null
  needsCode?: boolean
  approve?: { ok: boolean; code?: string; error?: string }
  steps?: PreviewStep[]
  blocked?: number
  error?: string
  code?: string
  planHash?: string
  /** Step 4 — the removal's follow-up: the negatives Nexus sends once the protection is removed. */
  followUp?: FollowUpView
}

export interface DecideResult { approvalId: string; decide: 'approve' | 'reject'; ok: boolean; status?: string; executeAfter?: string; code?: string; error?: string }

/**
 * NFIX — GET /waste/waiting/:id: every step of a request that waits. The approvals service decides a request whole: a
 * change plan's steps are approved (or rejected) TOGETHER, the ones this page does not show included.
 */
export interface WaitingStep {
  step: number
  tool: string
  words: string
  onPage: boolean
  status: string
  where: { name: string; href: string | null } | null
  changes: Array<{ label: string; from: string | null; to: string | null }>
  changeCount: number
  summary: string | null
  hidden: string | null
}
export interface WaitingSteps { approvalId: string; status: string; plan: boolean; title: string | null; steps: WaitingStep[]; offPage: number }

// ── step 4: what a negative blocks, what a stop saved ─────────────────────────────────────────────────

/** What one negative would block over the page's window (apps/api … waste/reach.ts). Money is absent without ad spend. */
export interface Reach {
  windowDays: number
  currency: string
  terms: number
  spendCents?: number
  clicks: number
  orders: number
  salesCents?: number
  /** Terms with an order in the window that it would block, the most orders first (at most 10). */
  sold: Array<{ text: string; orders: number }>
}

/** Several negatives together: each term once; money per currency when there are several (`currency` null). */
export interface ReachTotal {
  windowDays: number | null
  currency: string | null
  terms: number
  spendCents?: number | null
  clicks: number
  orders: number
  salesCents?: number | null
  currencies: Array<{ currency: string; spendCents?: number; salesCents?: number }>
}

export type EffectVerdict = 'TOO_EARLY' | 'SAVED' | 'STILL_SPENDS'
/** "Did it work?" (apps/api … waste/effect.ts): no money before 14 days; `words` never hold money. */
export interface StopEffect {
  since: string
  days: number
  verdict: EffectVerdict
  beforePerDayCents?: number | null
  afterCents?: number | null
  savedCents?: number | null
  words: string
}
