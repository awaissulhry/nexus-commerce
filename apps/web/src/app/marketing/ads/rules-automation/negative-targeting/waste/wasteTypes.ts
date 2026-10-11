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
  }
  skipped: null | { until: string; by: string | null; at: string | null }
  stillServesIn: number
  lastChange: null | { action: string; at: string; by: Ref; changeId: string | null }
  /** A clash the Owner should see (the Clashes tile lists exactly these rows), with why in plain words. */
  clash?: null | { kind: 'TURNED_ON' | 'NEG_OVER_OWN_KEYWORD' | 'BLOCKS_SOLD'; label: string; negative?: ClashNegative | null }
  /**
   * NFIX — listed only for what waits on it (an ask no wasting row carries: a phrase piece, a negative's removal, a paused
   * place). The server shows it under Waiting only; its verb is the ask's own.
   */
  askOnly?: true
}

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
  /** Kept paused, but switched on outside Nexus. */
  turnedOn?: number
  keywords: number
  terms: number
  waiting: number
  keptPaused: number
  negated: number
  clashes: number
  skipped: number
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
  stillServesIn: number
  places: number
  actions: { turnOn: ActionGate; removeNegative: ActionGate; release: ActionGate }
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
  rowId: string | null
}

export interface RowDetail { row: WasteRow | StoppedRow; runsIn: Place[]; blockedIn: Place[]; history: HistoryItem[] }

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** KEEP_UNTIL: a kept-paused keyword's end date (null = Always); its Undo puts the old end back. */
export type WasteAction = 'PAUSE' | 'NEGATE_EXACT' | 'NEGATE_PHRASE' | 'NEGATE_ASIN' | 'TURN_ON' | 'REMOVE_NEGATIVE' | 'RELEASE' | 'KEEP_UNTIL'
/** `adGroupId`: a negative in a named ad group of the same product ("Still bought elsewhere"). */
export interface WasteItem { rowId: string; action: WasteAction; where?: Where; keepUntil?: string | null; adGroupId?: string; targetRowId?: string }

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
}

export interface PreviewAnswer { steps: PreviewStep[]; blocked: number; planHash: string }

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
