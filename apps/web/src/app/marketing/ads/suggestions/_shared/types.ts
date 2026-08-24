/**
 * SGX (2026-08-24) — split out of `SuggestionsClient.tsx`, which had grown to 2,447 lines holding
 * seven tabs. Moved VERBATIM: a relocation, not a rewrite, so `git log -L` over any symbol here
 * still reaches the SG commit that reasoned about it.
 */

import type { TagTone } from '@/design-system/primitives/Tag'
import type { SuggestionMetrics } from '../cells'

/** Resolved deep-link for a suggestion's source entity (server-side S.1). */
export interface SuggestionSource {
  href: string | null
  label: string
  campaignId?: string
  campaignName?: string
  adGroupId?: string
  adGroupName?: string
  keyword?: string
  matchType?: string
  marketplace?: string | null
}

export interface SuggestionCurrent {
  bidCents?: number | null
  dailyBudgetEur?: number | null
  targetAcosPct?: number | null
  entityStatus?: string | null
  /** SGX — the placement lane's current bid modifier (%); 0 is a real reading, null unresolved */
  placementPct?: number | null
}
export interface SuggestionSuggested {
  bidCents?: number | null
  /** SGX — the top of a starting-bid RANGE when a harvest's destinations disagree on the bid */
  bidCentsMax?: number | null
  budgetEur?: number | null
  /** SGX — the projected placement bid modifier (%) */
  placementPct?: number | null
  destinations?: Array<{ campaignName: string | null; adProduct?: string | null; adGroupName: string | null; matchType: string; bidCents: number | null; note?: string }>
}

export interface Suggestion {
  id: string; ruleId: string; ruleName: string | null; ruleCriteria?: string | null
  /** SGX — the window `ruleCriteria` is measured over ("Last 7 Days, excluding the last 2 days").
   *  Without it the Reason reads as contradicting the metric columns, which are trailing 30 days. */
  ruleWindow?: string | null
  /** SG.2d — the ACoS threshold written into the producing rule, for the adaptive dot */
  ruleAcosPct?: number | null
  trigger: string | null; marketplace: string | null
  entityType: string; entityId: string; entityName: string | null
  proposedAction: { type?: string; wouldChange?: string; placement?: string; op?: string; value?: number; wouldGraduate?: number; wouldNegate?: number; scope?: string; matchType?: string }
  status: string; createdAt: string
  /** SG.0 — the type-tab family, computed by the server's one map. */
  family: string
  source?: SuggestionSource
  /** SG.2 — decision data, attached server-side (attachDecisionData). */
  metrics?: SuggestionMetrics | null
  current?: SuggestionCurrent
  suggested?: SuggestionSuggested
  /** SG.2f — market search volume (Brand Analytics, newest period); null = not covered */
  volume?: number | null
  /** SG.2f — the rule's performance window, from the engine's own table */
  lookback?: { label: string; why: string } | null
  /** SG.0 — the newest evaluation that still proposes this change */
  lastSeenAt?: string
  /** SG.3 — the write's actual fate (applied rows only): an apply returns at ENQUEUE */
  delivery?: { state: 'delivered' | 'pending' | 'refused' | 'failed' | 'unknown'; detail: string | null } | null
  /** SG.3 — the Change-Log handle the rollback service is keyed on; null = none offered */
  undo?: { actionLogId: string; rolledBack: boolean } | null
  /** 🔴 SGX — what an applied row ACTUALLY changed, from the stored proposal + the handler's own
   *  written value. The Applied tab used to render `current`/`suggested`, which are recomputed
   *  against TODAY — a change that never happened, printed beside a green Delivered chip. */
  appliedChange?: { from: string | null; to: string; note: string | null } | null
}

export type GroupKey = 'none' | 'rule' | 'campaign' | 'type'
export type Status = 'pending' | 'applied' | 'dismissed' | 'expired' | 'muted'

export const MARKETS = ['IT', 'DE', 'ES', 'FR']

/**
 * H10's tab order. `ai` has no stored rows yet — the honest producer is the AI-goal /
 * Autopilot store, wired in SG.4; until a goal is launched its true state is the empty state.
 * `other` appears only when it holds something: an empty bucket is not a tab.
 */
export const VIEWS: Array<{ key: string; label: string; family: string | null; noun: string }> = [
  { key: 'ai', label: 'A.I. Bids', family: null, noun: 'A.I. bid' },
  { key: 'bids', label: 'Bids', family: 'bids', noun: 'bid' },
  { key: 'new-keywords', label: 'New Keywords', family: 'new-keywords', noun: 'new-keyword' },
  { key: 'negatives', label: 'Negative Keywords', family: 'negatives', noun: 'negative-keyword' },
  { key: 'budget', label: 'Budget', family: 'budget', noun: 'budget' },
  { key: 'placement', label: 'Placement', family: 'placement', noun: 'placement' },
  // SG.4 — the Recommendations feed folds in as the 7th tab (operator decision 1);
  // /marketing/ads/recommendations redirects here and its nav row is gone.
  { key: 'recommendations', label: 'Recommendations', family: null, noun: 'recommendation' },
]

/** SG.4/SG.8 — one autopilot decision, as `/advertising/ai-decisions` serves it. */
export interface AiDecision {
  id: string; at: string; module: string; cycle: string; action: string
  campaignId: string | null; campaignName: string | null
  before: Record<string, unknown> | null; after: Record<string, unknown> | null
  reason: string; planId: string; planName: string | null
  /** PROPOSED | APPLIED | SKIPPED | DENIED | DISMISSED — the decided views chip on it */
  status: string
  /** a disabled plan's proposals are stale; approve refuses them server-side */
  planEnabled: boolean
  /** SG.9 — the write's real fate, joined from OutboundSyncQueue. null = no handle (or nothing
   *  was written yet); an APPLIED status alone only means the write was ENQUEUED. */
  delivery?: { state: 'delivered' | 'pending' | 'refused' | 'failed' | 'unknown'; detail: string | null } | null
  /** SG.10 — the Change-Log handle this decision can be reversed through; null = none offered */
  undo?: { actionLogId: string; rolledBack: boolean } | null
}

/** Where "create a rule that feeds this tab" lives, per family — H10's empty-state CTA. */
export const FAMILY_RULE_ROUTE: Record<string, { label: string; href: string }> = {
  bids: { label: 'Bid', href: '/marketing/ads/rules-automation/bid' },
  'new-keywords': { label: 'Keyword Harvest', href: '/marketing/ads/rules-automation/keyword-harvest' },
  negatives: { label: 'Negative Targeting', href: '/marketing/ads/rules-automation/negative-targeting' },
  budget: { label: 'Budget', href: '/marketing/ads/rules-automation/budget' },
  placement: { label: 'Placement', href: '/marketing/ads/rules-automation/placement' },
}

export const ENTITY_LABEL: Record<string, string> = { CAMPAIGN: 'Campaign', AD_TARGET: 'Keyword/Target', SEARCH_TERM: 'Search term', MARKETPLACE: 'Marketplace', ACCOUNT: 'Account' }
export const ENTITY_TONE: Record<string, TagTone> = { CAMPAIGN: 'info', AD_TARGET: 'neutral', SEARCH_TERM: 'neutral', MARKETPLACE: 'neutral', ACCOUNT: 'warning' }
export const ACTION_LABEL: Record<string, string> = {
  budget_apply: 'Budget', placement_apply: 'Placement', bid_apply: 'Bid', dayparting_apply: 'Dayparting',
  add_negative_exact: 'Add negative', add_negative_phrase: 'Add negative (phrase)', promote_to_exact: 'Promote to exact',
  harvest_and_negate: 'Harvest & negate', lower_bid_to_floor: 'Bid to floor', bid_down: 'Bid down', bid_up: 'Bid up',
  adjust_ad_budget: 'Budget', set_daily_budget: 'Set budget', sync_negatives_across_campaigns: 'Sync negatives',
  pause_target: 'Pause target', enable_target: 'Enable target',
}
// Proposed-action sentiment → Tag tone. promote/harvest are wins (positive); negate/down are guarding (warning).
export const ACTION_TONE: Record<string, TagTone> = {
  promote_to_exact: 'success', harvest_and_negate: 'success', add_negative_exact: 'warning', add_negative_phrase: 'warning',
  sync_negatives_across_campaigns: 'warning', bid_apply: 'info', budget_apply: 'info', placement_apply: 'info', dayparting_apply: 'info',
}
export const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }
export const ageDays = (iso: string) => Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 86400000)

// `entityName` is an empty string on some rows rather than null, and `??` keeps an empty
// string — which renders a nameless row with nothing to click. Fall through to the id.
export const srcOf = (s: Suggestion): SuggestionSource => s.source ?? { href: null, label: s.entityName || s.entityId, marketplace: s.marketplace }

/**
 * ACR.4.4 — what this proposal puts in play, from the priced-proposals service.
 * `spendAtStakeCents` is money the action would REDIRECT, not money it would save. Only
 * `recoverable` (spend that produced no sales at all) is honest to call recovery.
 */
export interface Priced {
  spendAtStakeCents: number | null
  salesAtStakeCents: number | null
  recoverable: boolean
  direction: string
}
export interface Pricing {
  pending: number
  priced: number
  spendAtStakeCents: number
  recoverableCents: number
  byId: Record<string, Priced>
}


/** The bulk outcome report — OUTSIDE the selection popover so a partial result survives it. */
export interface BulkReport {
  verb: string
  ok: number
  fail: number
  refusals: Array<{ id: string; label: string; error: string }>
  undoIds?: string[]
}
