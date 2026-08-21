'use client'

/**
 * SG.1 — the Suggestions page, rebuilt as the console's one review queue.
 *
 * The page is the halfway point of the rule pipeline: a rule on Manual control computes its
 * action and parks it here as an AdsRuleSuggestion; this page is where the operator audits the
 * math, approves the winners and dismisses the anomalies. H10's shape, on our substrate:
 *
 *   · type views (A.I. Bids · Bids · New Keywords · Negative Keywords · Budget · Placement),
 *     H10's tabs, as a SegmentedControl whose counts come from the SERVER's family map — every
 *     row carries `family`, computed once in ads-suggestions.service.ts, never re-derived here.
 *   · status tabs (Pending · Applied · Dismissed · Expired) — `expired` is SG.0's lifecycle:
 *     a pending row the engine stops re-proposing leaves the queue on its own.
 *   · ONE filter bar (`AdsFilterBar` + `buildScopeFilters` + `useMergedFilters`) with the scope
 *     grains resolved SERVER-side, so the grid, the money tiles and the pricing endpoint always
 *     describe the same rows.
 *   · a cursor poll + StaleBanner instead of the SSE bus (which carries 0.21% of writes and is
 *     blind to the engines) — the banner offers, it never reorders rows under a reading operator.
 *   · bulk approve/dismiss/restore through ONE server round trip with a PER-ROW outcome report
 *     that stays on screen until dismissed — a partial result names which rows were refused and
 *     why, instead of dissolving into a count (the W2 popover lesson).
 *
 * Everything shareable lives in the URL: ?view= ?status= ?market= ?line/portfolio/campaign/
 * adGroup= ?rule= ?row= — a copied link reproduces the view you are looking at.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check, X, RefreshCw, Sparkles, ChevronRight, ExternalLink, RotateCcw, Pause, Settings } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter, type FilterState } from '../campaigns/_grid/AdsDataGrid'
import { RecommendationsView } from './RecommendationsView'
import { AdsBidSettingsModal } from '../_shared/AdsBidSettingsModal'
import { HoverCard } from '../campaigns/FilterDropdown'
import { AdsFilterBar } from '../campaigns/_grid/AdsFilterBar'
import { buildScopeFilters, scopeToFilterState, scopePatchFromFilterState, type ScopeOptionsPayload, type ScopeValue } from '../rules-automation/_shared/scopeFilters'
import { useMergedFilters } from '../rules-automation/_shared/useMergedFilters'
import { useCursorPoll, useCursorBaseline } from '../rules-automation/_shared/useCursorPoll'
import { StaleBanner } from '../rules-automation/_shared/StaleBanner'
import { ScopeNotes } from '../rules-automation/_shared/ScopeNotes'
import { Button } from '@/design-system/primitives/Button'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Select } from '@/design-system/primitives/Select'
import { Input } from '@/design-system/primitives/Input'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Drawer } from '@/design-system/components/Drawer'
import { Tabs, type TabItem } from '@/design-system/components/Tabs'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { dash, eur, AcosCell, RoasCell, ACOS_DOT_TIP, ROAS_DOT_TIP, type SuggestionMetrics } from './cells'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './suggestions.css'

/** Resolved deep-link for a suggestion's source entity (server-side S.1). */
interface SuggestionSource {
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

interface SuggestionCurrent {
  bidCents?: number | null
  dailyBudgetEur?: number | null
  targetAcosPct?: number | null
  entityStatus?: string | null
}
interface SuggestionSuggested {
  bidCents?: number | null
  budgetEur?: number | null
  destinations?: Array<{ campaignName: string | null; adProduct?: string | null; adGroupName: string | null; matchType: string; bidCents: number | null; note?: string }>
}

interface Suggestion {
  id: string; ruleId: string; ruleName: string | null; ruleCriteria?: string | null
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
}

type GroupKey = 'none' | 'rule' | 'campaign' | 'type'
type Status = 'pending' | 'applied' | 'dismissed' | 'expired'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

/**
 * H10's tab order. `ai` has no stored rows yet — the honest producer is the AI-goal /
 * Autopilot store, wired in SG.4; until a goal is launched its true state is the empty state.
 * `other` appears only when it holds something: an empty bucket is not a tab.
 */
const VIEWS: Array<{ key: string; label: string; family: string | null; noun: string }> = [
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

/** SG.4 — one PROPOSED autopilot decision, as `/suggestions/ai-bids` serves it. */
interface AiDecision {
  id: string; at: string; module: string; cycle: string; action: string
  campaignId: string | null; campaignName: string | null
  before: Record<string, unknown> | null; after: Record<string, unknown> | null
  reason: string; planId: string; planName: string | null
}

/** Compact before→after reading for a decision's Json pair — only keys that CHANGED, "—" when
 *  neither side says anything (an unreadable change must not render as an empty confident cell).
 *  Known storage keys read back in operator units (the D2d law: no field paths, no cents). */
const AI_KEY_READERS: Record<string, { label: string; fmt: (v: unknown) => string }> = {
  bidCents: { label: 'Bid', fmt: (v) => (Number.isFinite(Number(v)) ? `€${(Number(v) / 100).toFixed(2)}` : String(v)) },
  dailyBudgetEur: { label: 'Budget', fmt: (v) => (Number.isFinite(Number(v)) ? `€${Number(v).toFixed(2)}` : String(v)) },
  budgetCents: { label: 'Budget', fmt: (v) => (Number.isFinite(Number(v)) ? `€${(Number(v) / 100).toFixed(2)}` : String(v)) },
}
function aiChangeText(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  const parts = keys
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
    .map((k) => {
      const r = AI_KEY_READERS[k]
      const read = (v: unknown) => (v == null ? '—' : r ? r.fmt(v) : String(v))
      return `${r?.label ?? k} ${read(before?.[k])} → ${read(after?.[k])}`
    })
  return parts.length ? parts.join(' · ') : '—'
}

/** Where "create a rule that feeds this tab" lives, per family — H10's empty-state CTA. */
const FAMILY_RULE_ROUTE: Record<string, { label: string; href: string }> = {
  bids: { label: 'Bid', href: '/marketing/ads/rules-automation/bid' },
  'new-keywords': { label: 'Keyword Harvest', href: '/marketing/ads/rules-automation/keyword-harvest' },
  negatives: { label: 'Negative Targeting', href: '/marketing/ads/rules-automation/negative-targeting' },
  budget: { label: 'Budget', href: '/marketing/ads/rules-automation/budget' },
  placement: { label: 'Placement', href: '/marketing/ads/rules-automation/placement' },
}

const ENTITY_LABEL: Record<string, string> = { CAMPAIGN: 'Campaign', AD_TARGET: 'Keyword/Target', SEARCH_TERM: 'Search term', MARKETPLACE: 'Marketplace', ACCOUNT: 'Account' }
const ENTITY_TONE: Record<string, TagTone> = { CAMPAIGN: 'info', AD_TARGET: 'neutral', SEARCH_TERM: 'neutral', MARKETPLACE: 'neutral', ACCOUNT: 'warning' }
const ACTION_LABEL: Record<string, string> = {
  budget_apply: 'Budget', placement_apply: 'Placement', bid_apply: 'Bid', dayparting_apply: 'Dayparting',
  add_negative_exact: 'Add negative', add_negative_phrase: 'Add negative (phrase)', promote_to_exact: 'Promote to exact',
  harvest_and_negate: 'Harvest & negate', lower_bid_to_floor: 'Bid to floor', bid_down: 'Bid down', bid_up: 'Bid up',
  adjust_ad_budget: 'Budget', set_daily_budget: 'Set budget', sync_negatives_across_campaigns: 'Sync negatives',
  pause_target: 'Pause target', enable_target: 'Enable target',
}
// Proposed-action sentiment → Tag tone. promote/harvest are wins (positive); negate/down are guarding (warning).
const ACTION_TONE: Record<string, TagTone> = {
  promote_to_exact: 'success', harvest_and_negate: 'success', add_negative_exact: 'warning', add_negative_phrase: 'warning',
  sync_negatives_across_campaigns: 'warning', bid_apply: 'info', budget_apply: 'info', placement_apply: 'info', dayparting_apply: 'info',
}
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }
const ageDays = (iso: string) => Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 86400000)

// `entityName` is an empty string on some rows rather than null, and `??` keeps an empty
// string — which renders a nameless row with nothing to click. Fall through to the id.
const srcOf = (s: Suggestion): SuggestionSource => s.source ?? { href: null, label: s.entityName || s.entityId, marketplace: s.marketplace }

/**
 * ACR.4.4 — what this proposal puts in play, from the priced-proposals service.
 * `spendAtStakeCents` is money the action would REDIRECT, not money it would save. Only
 * `recoverable` (spend that produced no sales at all) is honest to call recovery.
 */
interface Priced {
  spendAtStakeCents: number | null
  salesAtStakeCents: number | null
  recoverable: boolean
  direction: string
}
interface Pricing {
  pending: number
  priced: number
  spendAtStakeCents: number
  recoverableCents: number
  byId: Record<string, Priced>
}

/* SG.7 — eur / dash / AcosCell / RoasCell moved verbatim to ./cells.tsx (the Recommendations
   view renders through the SAME components). The per-key readers below stay: only this grid's
   payload carries their shape. */
const mInt = (m: SuggestionMetrics | null | undefined, k: 'impressions' | 'clicks' | 'orders') =>
  m ? <span className="h10-sug-num">{m[k].toLocaleString('en-IE')}</span> : dash()
const mEur = (m: SuggestionMetrics | null | undefined, k: 'spendCents' | 'salesCents') =>
  m ? <span className="h10-sug-num">{eur(m[k])}</span> : dash()
const mPct = (m: SuggestionMetrics | null | undefined, k: 'acos' | 'ctr' | 'cvr') => {
  if (!m) return dash()
  const v = m[k]
  return v == null ? dash('Not measurable — the denominator is 0 in this window') : <span className="h10-sug-num">{(v * 100).toFixed(2)}%</span>
}
const mCpc = (m: SuggestionMetrics | null | undefined) => {
  if (!m) return dash()
  return m.cpcCents == null ? dash('Not measurable — no clicks in this window') : <span className="h10-sug-num">{eur(m.cpcCents)}</span>
}

// Impact — the € delta parsed from the proposed change ("€10.00 → €12.00" ⇒ +2.00).
const parseEur = (raw: string): number => {
  let s = raw.trim()
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.') // 1.234,56 → 1234.56
  else if (s.includes(',')) s = s.replace(',', '.')
  return Number(s) || 0
}
const eurDelta = (s: Suggestion): number | null => {
  const wc = s.proposedAction?.wouldChange
  if (!wc) return null
  const nums = [...wc.matchAll(/€\s*([\d.,]+)/g)].map((m) => parseEur(m[1]))
  return nums.length >= 2 ? nums[nums.length - 1] - nums[0] : null
}
const harvestCount = (s: Suggestion): number => {
  const a = s.proposedAction ?? {}
  return a.type === 'harvest_and_negate' ? (a.wouldGraduate ?? 0) + (a.wouldNegate ?? 0) : 0
}
const impactScore = (s: Suggestion): number => {
  const d = eurDelta(s)
  if (d != null) return Math.abs(d)
  const h = harvestCount(s)
  if (h) return h
  return typeof s.proposedAction?.value === 'number' ? s.proposedAction.value : 0
}

// Friendly trigger names for the provenance "signal" — fall back to a prettified raw value.
const TRIGGER_LABEL: Record<string, string> = {
  CAMPAIGN_PERFORMANCE_BUDGET: 'Budget performance', CAC_SPIKE: 'CAC spike', AD_SPEND_PROFITABILITY_BREACH: 'Ad-spend over profit',
  SEARCH_TERM_CONVERTING: 'Converting search term', SEARCH_TERM_WASTING: 'Wasted search term',
  KEYWORD_HIGH_ACOS: 'High ACoS keyword', KEYWORD_SCALE_OPPORTUNITY: 'Scale opportunity', KEYWORD_LOW_CTR: 'Low-CTR keyword',
  KEYWORD_ZERO_IMPRESSIONS: 'Zero impressions', KEYWORD_WASTED_SPEND: 'Wasted keyword spend', KEYWORD_RISING_STAR: 'Rising-star keyword',
  AD_TARGET_UNDERPERFORMING: 'Underperforming target', AD_GROUP_UNDERPERFORMING: 'Underperforming ad group',
  CAMPAIGN_NO_SALES: 'No-sales campaign', CVR_DROP: 'Conversion-rate drop', NEW_TO_BRAND_WINNER: 'New-to-brand winner',
  CAMPAIGN_ROAS_DECLINING: 'Declining ROAS', SOV_BID: 'Share-of-voice signal', KEYWORD_RANK_BID: 'Keyword rank signal',
  SCHEDULE: 'Scheduled check',
}
const prettyTrigger = (t: string | null): string => t ? (TRIGGER_LABEL[t] ?? t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())) : 'Rule match'

// Edit-before-apply preview: the budget/bid base (first € in wouldChange) + the projected result.
const baseEur = (s: Suggestion): number | null => {
  const wc = s.proposedAction?.wouldChange
  if (!wc) return null
  const nums = [...wc.matchAll(/€\s*([\d.,]+)/g)].map((m) => parseEur(m[1]))
  return nums.length ? nums[0] : null
}
const projectAfter = (s: Suggestion, value: number): number | null => {
  const base = baseEur(s); const op = s.proposedAction?.op
  if (op === 'setValue') return value
  if (base == null) return null
  if (op === 'incPct') return base * (1 + value / 100)
  if (op === 'decPct') return base * (1 - value / 100)
  return null
}
/** Does this action expose an editable numeric magnitude (budget/bid % or absolute set)? */
const isEditable = (s: Suggestion): boolean => typeof s.proposedAction?.value === 'number' && ['incPct', 'decPct', 'setValue'].includes(s.proposedAction?.op ?? '')

/** Source cell — entity-type Tag + a breadcrumb (campaign ▸ ad group ▸ keyword) that deep-links
 *  to the exact sub-page. Hovering a target row states its facts (H10's hover pop-up: status,
 *  parent campaign, ad group, current base bid). */
function SourceCell({ s }: { s: Suggestion }) {
  const src = srcOf(s)
  const segs = [src.campaignName, src.adGroupName, src.keyword].filter(Boolean) as string[]
  if (segs.length === 0) segs.push(src.label)
  const crumb = (
    <span className="crumb">
      {segs.map((seg, i) => (
        <span className="seg" key={i}>
          {i > 0 && <ChevronRight size={11} className="sep" aria-hidden />}
          <span className={i === segs.length - 1 ? 'leaf' : 'anc'}>{seg}</span>
        </span>
      ))}
    </span>
  )
  const facts: Array<[string, string]> = []
  if (s.current?.entityStatus) facts.push(['Status', s.current.entityStatus])
  if (src.campaignName) facts.push(['Campaign', src.campaignName])
  if (src.adGroupName) facts.push(['Ad group', src.adGroupName])
  if (src.matchType) facts.push(['Match type', src.matchType])
  if (s.current?.bidCents != null) facts.push(['Current bid', eur(s.current.bidCents)])
  if (s.current?.dailyBudgetEur != null) facts.push(['Daily budget', `€${s.current.dailyBudgetEur.toFixed(2)}`])
  // The one-line cell may ellipsize ancestors — the title carries the whole path.
  const path = segs.join(' › ')
  const body = src.href
    ? <Link href={src.href} className="lnk" title={`Open ${path}`}>{crumb}</Link>
    : <span className="lnk dead" title={`${path} — source no longer available`}>{crumb}</span>
  // SG.2b — H10's circular match-type badge (E/B/P; A for auto clauses) before the term.
  const match = (src.matchType ?? '').toUpperCase()
  const badge = match ? (match.startsWith('AUTO') ? 'A' : match[0]) : null
  return (
    <span className="h10-sug-src">
      <Tag tone={ENTITY_TONE[s.entityType] ?? 'neutral'}>{ENTITY_LABEL[s.entityType] ?? s.entityType}</Tag>
      {badge && <i className={`h10-sug-mt mt-${badge.toLowerCase()}`} title={`Match type: ${match}`} aria-hidden>{badge}</i>}
      {facts.length > 0 ? <HoverCard rows={facts} placement="below" delay={450}>{body}</HoverCard> : body}
    </span>
  )
}

function ProposedCell({ s }: { s: Suggestion }) {
  const a = s.proposedAction ?? {}
  const kind = ACTION_LABEL[a.type ?? ''] ?? a.type ?? '—'
  const tone = ACTION_TONE[a.type ?? ''] ?? 'neutral'
  let detail: ReactNode = null
  if (a.type === 'harvest_and_negate') {
    detail = <span className="wc">promote {a.wouldGraduate ?? 0} · negate {a.wouldNegate ?? 0}</span>
  } else {
    const place = a.placement ? a.placement.replace('PLACEMENT_', '').replace(/_/g, ' ').toLowerCase() : ''
    detail = <>{place && <span className="pl">{place}</span>}{a.wouldChange ? <span className="wc">{a.wouldChange}</span> : null}</>
  }
  return <span className="h10-sug-prop"><Tag tone={tone}>{kind}</Tag>{detail}</span>
}

function ImpactCell({ s }: { s: Suggestion }) {
  const d = eurDelta(s)
  if (d != null) {
    const dir = d > 0 ? 'up' : d < 0 ? 'down' : ''
    const sign = d > 0 ? '+' : d < 0 ? '−' : ''
    return <span className={`h10-sug-impact ${dir}`}>{sign}€{Math.abs(d).toFixed(2)}</span>
  }
  const h = harvestCount(s)
  if (h) return <span className="h10-sug-impact">{h} targets</span>
  return <span className="h10-sug-impact muted">—</span>
}

/**
 * The € at stake, and the ♦ that separates recovery from a trade.
 * A row with no price is NOT shown as €0 — a confident zero would sort real decisions below it.
 */
function StakeCell({ p }: { p: Priced | undefined }) {
  if (!p) return <span className="h10-sug-stake muted" title="Not priced — this proposal's entity has no trailing spend to resolve against">—</span>
  if (p.spendAtStakeCents == null) {
    return <span className="h10-sug-stake muted" title="This proposal's target carries no 30-day performance grain, so there is nothing to price it against">not priced</span>
  }
  const cls = p.recoverable ? 'waste' : p.direction === 'increase' ? 'up' : ''
  return (
    <span
      className={`h10-sug-stake ${cls}`}
      title={
        p.recoverable
          ? `${eur(p.spendAtStakeCents)} of trailing spend that produced no sales at all — pure recovery.`
          : p.direction === 'increase'
            ? `${eur(p.spendAtStakeCents)} of additional spend this would put in play.`
            : `${eur(p.spendAtStakeCents)} of trailing spend this would redirect. It produced ${eur(p.salesAtStakeCents ?? 0)} of sales, so cutting it is a trade, not a saving.`
      }
    >
      {p.recoverable && <span className="dia" aria-label="pure waste">♦</span>}
      {p.direction === 'increase' ? '+' : ''}{eur(p.spendAtStakeCents)}
    </span>
  )
}

function RuleCell({ s }: { s: Suggestion }) {
  return (
    <span className="h10-sug-rule">
      <b title={s.ruleName ?? ''}>{s.ruleName ?? 'Rule'}</b>
      {s.marketplace ? <Tag tone="neutral">{s.marketplace}</Tag> : null}
    </span>
  )
}

/**
 * SG.2b — H10's staging buffer input. Idle: the CURRENT value, read-only. Staged for apply:
 * fills with the SUGGESTED value and becomes editable (the operator's override), with ↺
 * restoring the suggestion. Pause rows have nothing to type — the input greys out.
 */
function BufferInput({ current, suggestedEur, stagedValue, isStaged, disabled, onChange, onRevert }: {
  current: string
  suggestedEur: number | null
  stagedValue: number | undefined
  isStaged: boolean
  disabled?: boolean
  onChange: (v: number | undefined) => void
  onRevert: () => void
}) {
  const shown = isStaged ? (stagedValue != null ? String(stagedValue) : suggestedEur != null ? suggestedEur.toFixed(2) : '') : current
  const edited = isStaged && stagedValue != null && suggestedEur != null && Math.abs(stagedValue - suggestedEur) >= 0.005
  return (
    <span className={`h10-sug-buf${isStaged ? ' on' : ''}${edited ? ' edited' : ''}`}>
      <span className="cur">€</span>
      <input
        type="text"
        inputMode="decimal"
        value={shown}
        readOnly={!isStaged}
        disabled={disabled}
        aria-label={isStaged ? 'Value to apply — edit to override the suggestion' : 'Current value'}
        title={isStaged ? 'The value Apply will set — edit to override the suggestion' : 'Current value (✓ the row to stage the suggested value)'}
        onChange={(e) => {
          const n = Number(e.target.value.replace(',', '.'))
          onChange(e.target.value.trim() === '' || !Number.isFinite(n) ? undefined : n)
        }}
      />
      {edited && (
        <button type="button" className="rv" title="Restore the suggested value" aria-label="Restore the suggested value" onClick={onRevert}>
          <RotateCcw size={12} />
        </button>
      )}
    </span>
  )
}

/**
 * SG.2f — H10's approve-hover card: hovering ✓ states EXACTLY what will happen — one row per
 * destination entity (Type badge · Bid · To Campaign · To Ad Group · Notes) under the rule's
 * name and a one-line explainer, with Edit Suggestion opening the drawer. Portaled above the
 * button (the ✓ lives in a right-pinned sticky cell, so the card must escape the table's
 * stacking context), and it stays open while the pointer is over the card itself so the Edit
 * button is clickable.
 */
const MT_BADGE: Record<string, { letter: string; cls: string; label: string }> = {
  EXACT: { letter: 'E', cls: 'mt-e', label: 'Exact' },
  BROAD: { letter: 'B', cls: 'mt-b', label: 'Broad' },
  PHRASE: { letter: 'P', cls: 'mt-p', label: 'Phrase' },
  NEGATIVE_EXACT: { letter: 'E', cls: 'mt-ne', label: 'NegativeExact' },
  NEGATIVE_PHRASE: { letter: 'P', cls: 'mt-ne', label: 'NegativePhrase' },
}
const AD_PRODUCT_PILL: Record<string, string> = { SPONSORED_PRODUCTS: 'SP', SPONSORED_BRANDS: 'SB', SPONSORED_DISPLAY: 'SD' }

interface HoverRow { badge: { letter: string; cls: string } | null; typeLabel: string; bid: string; campaign: string; adProduct: string | null; adGroup: string; note: string }

function approveHoverContent(s: Suggestion): { title: string; sub: string; rows: HoverRow[] } | null {
  const src = srcOf(s)
  const a = s.proposedAction ?? {}
  const rowFor = (matchType: string | undefined, bid: string, campaign: string | null, adProduct: string | null | undefined, adGroup: string | null, note: string): HoverRow => {
    const mb = matchType ? MT_BADGE[matchType.toUpperCase()] : undefined
    return {
      badge: mb ? { letter: mb.letter, cls: mb.cls } : null,
      typeLabel: mb?.label ?? (matchType ?? '—'),
      bid, campaign: campaign ?? '—',
      adProduct: adProduct ? (AD_PRODUCT_PILL[adProduct] ?? null) : null,
      adGroup: adGroup ?? '—', note,
    }
  }
  const title = `Rule: ${s.ruleName ?? 'Manual rule'}`
  if (s.family === 'new-keywords') {
    if (a.type === 'harvest_and_negate') {
      return {
        title,
        sub: 'An account-wide harvest sweep — the rule’s own mapping decides the ad groups when changes are applied.',
        rows: [rowFor(undefined, '—', 'Account-wide', null, 'per the rule’s mapping', `promote ${a.wouldGraduate ?? 0} · negate ${a.wouldNegate ?? 0}`)],
      }
    }
    const ds = s.suggested?.destinations ?? []
    return {
      title,
      sub: 'This search term, along with all bid adjustments, will be added to the following entities when changes are applied.',
      rows: ds.length
        ? ds.map((d) => rowFor(d.matchType, d.bidCents != null ? eur(d.bidCents) : '—', d.campaignName, d.adProduct, d.adGroupName, d.note ?? 'Applicable'))
        : [rowFor('EXACT', s.suggested?.bidCents != null ? eur(s.suggested.bidCents) : '—', src.campaignName ?? null, null, src.adGroupName ?? null, 'Applicable')],
    }
  }
  if (s.family === 'negatives') {
    const ds = s.suggested?.destinations ?? []
    return {
      title,
      sub: 'This search term will be negated in the following entities when changes are applied.',
      rows: ds.length
        ? ds.map((d) => rowFor(d.matchType, '-', d.campaignName, d.adProduct, d.adGroupName ?? 'Campaign-wide', d.note ?? 'Applicable'))
        : [rowFor('NEGATIVE_EXACT', '-', src.campaignName ?? null, null, src.adGroupName ?? null, 'Applicable')],
    }
  }
  if (s.family === 'bids') {
    if (s.proposedAction?.type === 'pause_target' || s.proposedAction?.type === 'enable_target') {
      return {
        title,
        sub: 'This target’s state will change at Amazon when changes are applied.',
        rows: [rowFor(src.matchType, '—', src.campaignName ?? null, null, src.adGroupName ?? null, s.proposedAction.type === 'pause_target' ? 'Enabled → Paused' : 'Paused → Enabled')],
      }
    }
    return {
      title,
      sub: 'This target’s bid will be changed when changes are applied.',
      rows: [rowFor(
        src.matchType,
        s.suggested?.bidCents != null ? eur(s.suggested.bidCents) : '—',
        src.campaignName ?? null, null, src.adGroupName ?? null,
        s.current?.bidCents != null ? `from ${eur(s.current.bidCents)}` : 'Applicable',
      )],
    }
  }
  if (s.family === 'budget') {
    return {
      title,
      sub: 'This campaign’s daily budget will be changed when changes are applied.',
      rows: [rowFor(undefined,
        s.suggested?.budgetEur != null ? `€${s.suggested.budgetEur.toFixed(2)}` : '—',
        src.campaignName ?? src.label, null, '—',
        s.current?.dailyBudgetEur != null ? `from €${s.current.dailyBudgetEur.toFixed(2)}` : 'Applicable',
      )],
    }
  }
  return null
}

function ApproveHover({ s, onEdit, children }: { s: Suggestion; onEdit: () => void; children: ReactNode }) {
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const showT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = () => {
    clearTimeout(hideT.current)
    showT.current = setTimeout(() => {
      const r = wrapRef.current?.getBoundingClientRect()
      if (!r) return
      setPos({ bottom: window.innerHeight - r.top + 8, right: Math.max(16, window.innerWidth - r.right) })
    }, 280)
  }
  const hide = () => {
    clearTimeout(showT.current)
    hideT.current = setTimeout(() => setPos(null), 180)
  }
  useEffect(() => () => { clearTimeout(showT.current); clearTimeout(hideT.current) }, [])
  const content = pos ? approveHoverContent(s) : null
  return (
    <span ref={wrapRef} className="h10-sug-ahwrap" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {pos && content && createPortal(
        <div className="h10-sug-ahover" style={{ bottom: pos.bottom, right: pos.right }} role="tooltip" onMouseEnter={() => clearTimeout(hideT.current)} onMouseLeave={hide}>
          <b className="ti">{content.title}</b>
          <p className="sub">{content.sub}</p>
          <div className="tbl" role="table">
            <div className="hd" role="row"><span>Type</span><span>Bid</span><span>To Campaign</span><span>To Ad Group</span><span>Notes</span></div>
            {content.rows.map((r, i) => (
              <div className="rw" role="row" key={i}>
                <span className="ty">{r.badge && <i className={`h10-sug-mt ${r.badge.cls}`} aria-hidden>{r.badge.letter}</i>}{r.typeLabel}</span>
                <span className="bd">{r.bid}</span>
                <span className="cp">{r.adProduct && <i className="h10-sug-adp" aria-hidden>{r.adProduct}</i>}{r.campaign}</span>
                <span className="ag">{r.adGroup}</span>
                <span className="nt">{r.note}</span>
              </div>
            ))}
          </div>
          <div className="ft">
            <button type="button" className="h10-am-btn primary" onClick={onEdit}>Edit Suggestion</button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}

/** One node in the vertical provenance flow: eyebrow + title + sub, optional deep link. */
function FlowNode({ eyebrow, title, sub, tone, href, last }: { eyebrow: string; title: ReactNode; sub?: ReactNode; tone?: TagTone; href?: string | null; last?: boolean }) {
  const body = <><span className="ey">{eyebrow}</span><b className="ti">{title}</b>{sub ? <span className="sub">{sub}</span> : null}</>
  return (
    <>
      <div className={`h10-sug-fnode${tone ? ` t-${tone}` : ''}`}>
        {href ? <Link href={href} className="lk">{body}<ExternalLink size={13} className="ext" /></Link> : body}
      </div>
      {!last && <span className="h10-sug-fconn" aria-hidden />}
    </>
  )
}

/** Detail drawer — provenance flow (Signal → Rule → Action → Target), edit-before-apply, decide. */
function SuggestionDrawer({ suggestion, priced, busy, onClose, onAct }: {
  suggestion: Suggestion
  priced?: Priced
  busy: boolean
  onClose: () => void
  onAct: (id: string, kind: 'apply' | 'dismiss' | 'restore', overrideValue?: number) => Promise<void>
}) {
  const a = suggestion.proposedAction ?? {}
  const src = srcOf(suggestion)
  const st = suggestion.status
  const editable = isEditable(suggestion)
  const [edit, setEdit] = useState<string>(editable && a.value != null ? String(a.value) : '')
  const editNum = edit.trim() === '' ? null : Number(edit)
  const overridden = editable && editNum != null && Number.isFinite(editNum) && editNum !== a.value
  const projected = overridden && editNum != null ? projectAfter(suggestion, editNum) : null
  const base = baseEur(suggestion)
  const unit = a.op === 'incPct' || a.op === 'decPct' ? '%' : a.op === 'setValue' ? '€' : ''
  const kindLabel = ACTION_LABEL[a.type ?? ''] ?? a.type ?? '—'

  const doApply = () => { void onAct(suggestion.id, 'apply', overridden && editNum != null ? editNum : undefined).then(onClose) }
  const doDismiss = () => { void onAct(suggestion.id, 'dismiss').then(onClose) }
  const doRestore = () => { void onAct(suggestion.id, 'restore').then(onClose) }

  return (
    <Drawer
      open
      onClose={onClose}
      title={<span className="h10-sug-dh"><Tag tone={ENTITY_TONE[suggestion.entityType] ?? 'neutral'}>{ENTITY_LABEL[suggestion.entityType] ?? suggestion.entityType}</Tag> {src.label}</span>}
      footer={
        <div className="h10-sug-dfoot">
          {src.href && <Link href={src.href} className="open"><ExternalLink size={14} /> Open source</Link>}
          <span className="grow" />
          {st === 'pending' && (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={doDismiss}><X size={14} /> Dismiss</Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={doApply}><Check size={14} /> {overridden ? 'Approve edit' : 'Approve'}</Button>
            </>
          )}
          {(st === 'dismissed' || st === 'expired') && <Button variant="primary" size="sm" disabled={busy} onClick={doRestore}><RotateCcw size={14} /> Restore</Button>}
        </div>
      }
    >
      <div className="h10-sug-dbody">
        {/* Provenance — why it surfaced, what it changes, where it lands */}
        <div className="h10-sug-flow">
          <FlowNode eyebrow="Signal" title={prettyTrigger(suggestion.trigger)} sub={suggestion.marketplace ? `Marketplace ${suggestion.marketplace}` : undefined} />
          <FlowNode eyebrow="Rule" title={suggestion.ruleName ?? 'Manual rule'} sub="Manual control · propose-only" />
          <FlowNode eyebrow="Proposed action" title={kindLabel} sub={a.type === 'harvest_and_negate' ? `promote ${a.wouldGraduate ?? 0} · negate ${a.wouldNegate ?? 0}` : a.wouldChange} tone={ACTION_TONE[a.type ?? '']} />
          <FlowNode eyebrow="Applies to" title={src.label} sub={ENTITY_LABEL[suggestion.entityType] ?? suggestion.entityType} href={src.href} last />
        </div>

        {/* ACR.4.4 — what this decision is worth, in the service's own terms. */}
        {priced && priced.spendAtStakeCents != null && (
          <div className={`h10-sug-stakebox${priced.recoverable ? ' waste' : ''}`}>
            <h4>
              {priced.recoverable ? <><span className="dia">♦</span> Pure waste</> : priced.direction === 'increase' ? 'Additional spend' : 'Spend at stake'}
              <b>{priced.direction === 'increase' ? '+' : ''}{eur(priced.spendAtStakeCents)}</b>
            </h4>
            <p>
              {priced.recoverable
                ? <>Trailing 30-day spend on this target that produced <b>no sales at all</b>. Redirecting it costs nothing you are currently earning.</>
                : priced.direction === 'increase'
                  ? <>Trailing 30-day spend this would add to. It is an investment, not a saving — the board counts it separately for that reason.</>
                  : <>Trailing 30-day spend this would <b>redirect</b>, not save. It produced {eur(priced.salesAtStakeCents ?? 0)} of sales, so cutting it trades revenue away with the spend.</>}
            </p>
          </div>
        )}

        {/* SG.3 — an applied row states its write's FATE, not just that it was approved */}
        {st === 'applied' && (
          <div className="h10-sug-dlblock">
            <h4>
              Delivery
              <span className={`h10-sug-dl ${{ delivered: 'ok', pending: 'pd', refused: 'rf', failed: 'fl', unknown: 'uk' }[suggestion.delivery?.state ?? 'unknown']}`}>
                {{ delivered: 'Delivered', pending: 'Pending', refused: 'Refused', failed: 'Failed', unknown: '—' }[suggestion.delivery?.state ?? 'unknown']}
              </span>
            </h4>
            <p>
              {suggestion.delivery?.detail
                ?? (suggestion.delivery?.state === 'delivered' ? 'The change reached Amazon.'
                  : suggestion.delivery?.state === 'pending' ? 'Queued — the drain worker has not settled this write yet.'
                  : 'This row predates delivery tracking — its fate was not recorded.')}
              {' '}The receipt lives in the <Link className="h10-sug-lnk" href="/marketing/ads/changelog">Change Log</Link>.
            </p>
          </div>
        )}

        {/* Edit-before-apply — adjust the magnitude; the rule's own min/max still clamp on the server */}
        {st === 'pending' && editable && (
          <div className="h10-sug-edit">
            <h4>Adjust before applying</h4>
            <label className="fld">
              <span>{a.op === 'decPct' ? 'Decrease by' : a.op === 'incPct' ? 'Increase by' : 'Set to'}</span>
              <Input inputMode="decimal" value={edit} onChange={(e) => setEdit(e.target.value)} suffix={unit === '%' ? '%' : undefined} prefix={unit === '€' ? '€' : undefined} aria-label="Override value" />
            </label>
            <p className="hint">
              {projected != null
                ? <>New result: <b>€{projected.toFixed(2)}</b>{base != null ? <> (from €{base.toFixed(2)})</> : null}</>
                : <>Proposed: {a.wouldChange ?? `${a.value ?? ''}${unit}`}. Edit to override — the rule’s min/max still apply.</>}
            </p>
          </div>
        )}

        {/* Meta */}
        <dl className="h10-sug-meta">
          <div><dt>First proposed</dt><dd>{ago(suggestion.createdAt)}</dd></div>
          {suggestion.trigger ? <div><dt>Trigger</dt><dd>{suggestion.trigger}</dd></div> : null}
          <div><dt>Status</dt><dd>{suggestion.status}{suggestion.status === 'expired' ? ' — the engine stopped proposing this; restore to keep it anyway' : ''}</dd></div>
        </dl>
      </div>
    </Drawer>
  )
}

/** The bulk outcome report — OUTSIDE the selection popover so a partial result survives it. */
interface BulkReport {
  verb: string
  ok: number
  fail: number
  refusals: Array<{ id: string; label: string; error: string }>
  undoIds?: string[]
}

function SuggestionsInner() {
  const router = useRouter()
  const params = useSearchParams()
  const { toast } = useToast()

  // ── URL state — the source of truth for everything shareable ──────────────
  const view = params.get('view') ?? 'bids'
  const status = (['pending', 'applied', 'dismissed', 'expired'].includes(params.get('status') ?? '') ? params.get('status') : 'pending') as Status
  const market = params.get('market') ?? 'all'
  const scope: ScopeValue = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
    adGroup: params.get('adGroup') ?? '',
  }
  const ruleParam = params.get('rule') ?? ''
  const rowParam = params.get('row')

  const writeUrl = useCallback((patch: Record<string, string>, opts?: { history?: boolean }) => {
    const next = new URLSearchParams(params.toString())
    const DEFAULTS: Record<string, string> = { view: 'bids', status: 'pending', market: 'all' }
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === DEFAULTS[k]) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    // replace for filters/views (three clicks must not stack three history entries);
    // push for opening a drawer, so Back closes it.
    if (opts?.history) router.push(qs ? `?${qs}` : '?', { scroll: false })
    else router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  // ── data ──────────────────────────────────────────────────────────────────
  const [items, setItems] = useState<Suggestion[]>([])
  const [families, setFamilies] = useState<Record<string, number>>({})
  /** The tab pills — PENDING counts per family (the queue), whatever status is on screen. */
  const [pendingFamilies, setPendingFamilies] = useState<Record<string, number> | null>(null)
  // SG.4 — the A.I. Bids tab: PROPOSED autopilot decisions (source ≠ 'rule-setting'). Count on
  // the pill; rows fetched lazily on entering the view. null = not fetched, never a confident 0.
  const [aiBidsCount, setAiBidsCount] = useState<number | null>(null)
  const [aiItems, setAiItems] = useState<AiDecision[] | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  // SG.5 — the Bid Settings gear (shared modal; mounts on the bid-relevant views).
  const [bidSettingsOpen, setBidSettingsOpen] = useState(false)
  /**
   * SG.7 — the A.I. view's Filters card, so the tab wears the page's one anatomy (tabs →
   * Filters → grid). Honest facets only: a decision carries its campaign, module, action and
   * plan — no scope grains (the notesSlot states why), cut client-side at this volume.
   */
  const [aiFilterState, setAiFilterState] = useState<FilterState>({})
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [pricing, setPricing] = useState<Pricing | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [group, setGroup] = useState<GroupKey>('none')
  /**
   * SG.2b — H10's STAGING BUFFER, adopted exactly from the reference recording:
   *
   *   ✓ stages an ACCEPT — the row's value input fills with the suggested value and becomes
   *     editable (↺ restores the suggestion); nothing is written yet.
   *   ✕ stages a REMOVAL ("Remove suggestion until a new one is generated").
   *   [Apply N Changes] commits the WHOLE staged batch — accepts (with any inline overrides)
   *     and removals together, one server round trip. [Discard Changes] clears the buffer.
   *
   * The pending grid therefore has NO checkbox column — the verbs are the selection. The
   * Dismissed/Expired tabs keep checkboxes for bulk Restore.
   */
  type StagedEntry = { kind: 'apply' | 'remove'; value?: number }
  const [staged, setStaged] = useState<Map<string, StagedEntry>>(new Map())
  const stage = useCallback((id: string, kind: 'apply' | 'remove') => {
    setStaged((cur) => {
      const next = new Map(cur)
      const existing = next.get(id)
      if (existing?.kind === kind) next.delete(id) // second click un-stages
      else next.set(id, { kind }) // switching verb replaces (drops any typed override)
      return next
    })
  }, [])
  const setStagedValue = useCallback((id: string, value: number | undefined) => {
    setStaged((cur) => {
      const e = cur.get(id)
      if (!e || e.kind !== 'apply') return cur
      const next = new Map(cur)
      next.set(id, { kind: 'apply', value })
      return next
    })
  }, [])
  /** the Dismissed/Expired tabs' checkbox selection (bulk Restore) — separate from staging */
  const [sel, setSel] = useState<Set<string>>(new Set())
  useEffect(() => { setSel(new Set()); setStaged(new Map()) }, [view, status])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkReport, setBulkReport] = useState<BulkReport | null>(null)
  const [reload, setReload] = useState(0)
  /**
   * Bumped after every successful decide of our own, WITHOUT bumping `reload`: the cursor
   * baseline re-reads (so the StaleBanner cannot cry about our own write) while the rows stay
   * exactly where the operator's j/k position left them — a refetch mid-triage would re-sort
   * the queue under their cursor.
   */
  const [baselineKey, setBaselineKey] = useState(0)

  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.campaigns)) setOptions(d as ScopeOptionsPayload) })
      .catch(() => { /* the pickers degrade to empty; the grid does not depend on them */ })
    return () => { alive = false }
  }, [])

  const scopeQs = useMemo(() => {
    const q = new URLSearchParams()
    if (market !== 'all') q.set('market', market)
    if (scope.line) q.set('line', scope.line)
    if (scope.portfolio) q.set('portfolio', scope.portfolio)
    if (scope.campaign) q.set('campaign', scope.campaign)
    if (scope.adGroup) q.set('adGroup', scope.adGroup)
    return q.toString()
  }, [market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  const load = useCallback(async () => {
    try {
      // ONE fetch per status+scope: every row carries its server-computed `family`, so switching
      // type tabs is a client-side cut and the tab counts (`families`) describe the same fetch.
      // limit=1000 is the endpoint's ceiling; `total` beside it is what keeps a capped list honest.
      const j = await fetch(`${getBackendUrl()}/api/advertising/suggestions?status=${status}&limit=1000${scopeQs ? `&${scopeQs}` : ''}`).then((r) => r.json())
      setItems(Array.isArray(j?.items) ? j.items : [])
      setTotal(typeof j?.total === 'number' ? j.total : null)
      setFamilies(j?.families && typeof j.families === 'object' ? j.families : {})
    } catch { setItems([]); setTotal(null); setFamilies({}) } finally { setLoading(false) }
    // The tab pills are the QUEUE (pending counts), independent of the status on screen —
    // switching to Applied must not blank the numbers on the tabs. Fails soft to null (no pill),
    // never to 0: an unfetchable count is unknown, and 0 is a real answer.
    try {
      const c = await fetch(`${getBackendUrl()}/api/advertising/suggestions/count`).then((r) => r.json())
      setPendingFamilies(c?.families && typeof c.families === 'object' ? c.families : null)
      setAiBidsCount(typeof c?.aiBids === 'number' ? c.aiBids : null)
    } catch { setPendingFamilies(null) }
    // ACR.4.4 — pricing is a separate, slower call and only means anything for pending rows.
    // Fetched AFTER the list and never awaited by it: an unpriced grid is a degraded page, an
    // empty one is a broken page. It carries the SAME scope params, resolved by the same server
    // function, so the tiles cannot describe different rows from the grid.
    if (status !== 'pending') { setPricing(null); return }
    try {
      const p = await fetch(`${getBackendUrl()}/api/advertising/suggestions/pricing${scopeQs ? `?${scopeQs}` : ''}`).then((r) => r.json())
      setPricing(p?.byId ? (p as Pricing) : null)
    } catch { setPricing(null) }
  }, [status, scopeQs])
  useEffect(() => { setLoading(true); void load() }, [load, reload])

  // SG.4 — the A.I. view's rows, fetched on entry (and on Refresh via `reload`). Read-only:
  // no decision approve/dismiss route exists; the verbs live on the plan in AI Advertising.
  useEffect(() => {
    if (view !== 'ai') return
    let alive = true
    setAiLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/suggestions/ai-bids`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setAiItems(Array.isArray(j?.items) ? j.items : []) })
      .catch(() => { if (alive) setAiItems(null) })
      .finally(() => { if (alive) setAiLoading(false) })
    return () => { alive = false }
  }, [view, reload])

  // After a write the acted rows are patched out locally (a full reload would lose the j/k
  // position), but the tab pills come from /count — refetch just that, so the pills tell the
  // server's truth instead of holding the pre-write number until the next full load.
  const refreshCounts = useCallback(async () => {
    try {
      const c = await fetch(`${getBackendUrl()}/api/advertising/suggestions/count`, { cache: 'no-store' }).then((r) => r.json())
      setPendingFamilies(c?.families && typeof c.families === 'object' ? c.families : null)
    } catch { /* the pill keeps its last honest value; the next load corrects it */ }
  }, [])

  // ── live updates: cursor poll + StaleBanner, never the SSE bus ────────────
  // The cursor is a fingerprint of the QUEUE's membership (account-wide — a queue change outside
  // the current scope still matters, because the tab counts include it). Paused while the drawer
  // is open or a bulk write is in flight (RA.SPINE S2).
  const cursorUrl = `${getBackendUrl()}/api/advertising/suggestions/cursor`
  const baseline = useCursorBaseline<{ pending: number; fp: string }>(cursorUrl, {}, `${reload}:${baselineKey}`)
  const detail = rowParam ? items.find((s) => s.id === rowParam) ?? null : null
  const { stale } = useCursorPoll<{ pending: number; fp: string }>({
    url: cursorUrl, params: {}, baseline, enabled: !detail && !bulkBusy,
  })

  // SG.7 — the A.I. facets, from the loaded rows (an option that matches nothing is a lie).
  const aiFilters = useMemo<GridFilter[]>(() => {
    const rows = aiItems ?? []
    const opts = (get: (r: AiDecision) => string | null, labelOf?: (v: string, r: AiDecision) => string) => {
      const seen = new Map<string, string>()
      for (const r of rows) { const v = get(r); if (v && !seen.has(v)) seen.set(v, labelOf ? labelOf(v, r) : v) }
      return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
    }
    return [
      { key: 'aiCampaign', label: 'Campaign', kind: 'select', wide: true, searchable: true, placeholder: 'All campaigns', options: opts((r) => r.campaignId, (v, r) => r.campaignName ?? v), value: (r) => (r as AiDecision).campaignId ?? '' },
      { key: 'aiModule', label: 'Module', kind: 'select', placeholder: 'All modules', options: opts((r) => r.module), value: (r) => (r as AiDecision).module },
      { key: 'aiAction', label: 'Action', kind: 'select', placeholder: 'All actions', options: opts((r) => r.action, (v) => v.replace(/_/g, ' ').toLowerCase()), value: (r) => (r as AiDecision).action },
      { key: 'aiPlan', label: 'Plan', kind: 'select', placeholder: 'All plans', options: opts((r) => r.planId, (v, r) => r.planName ?? v), value: (r) => (r as AiDecision).planId },
    ]
  }, [aiItems])

  // ── the view cut (client-side, over the server-attached family) ───────────
  const activeView = VIEWS.find((v) => v.key === view) ?? (view === 'other' ? { key: 'other', label: 'Other', family: 'other', noun: 'other' } : VIEWS[1])
  const viewRows = useMemo(
    () => (activeView.family ? items.filter((s) => s.family === activeView.family) : []),
    [items, activeView.family],
  )

  const post = useCallback((id: string, kind: 'apply' | 'dismiss' | 'restore', body?: Record<string, unknown>) =>
    fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/${kind}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' })
      .then(async (r): Promise<{ ok: boolean; refused?: boolean; error?: string }> =>
        (r.ok ? (await r.json()) as { ok: boolean; refused?: boolean; error?: string } : { ok: false, error: `HTTP ${r.status}` }))
      .catch((): { ok: boolean; refused?: boolean; error?: string } => ({ ok: false, error: 'network' })), [])

  // Undo a dismiss (single or bulk): restore the rows to pending, then reload.
  const restore = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => post(id, 'restore')))
    setReload((n) => n + 1)
  }, [post])

  const act = useCallback(async (id: string, kind: 'apply' | 'dismiss' | 'restore', overrideValue?: number) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const body = kind === 'apply' && overrideValue != null ? { value: overrideValue } : undefined
      const res = await post(id, kind, body)
      if (res.ok) {
        setItems((cur) => cur.filter((s) => s.id !== id))
        // The row left THIS status's population: keep `total` honest (it feeds the truncation
        // notice, which otherwise reads "Showing 0 of 1 — capped" after a local removal) and
        // re-baseline the cursor so the StaleBanner cannot announce our own write.
        setTotal((t) => (t == null ? t : Math.max(0, t - 1)))
        setBaselineKey((n) => n + 1)
        void refreshCounts()
        if (kind === 'dismiss') toast(<>Removed — back when a new suggestion is generated · <button type="button" className="h10-am-link" onClick={() => void restore([id])}>Undo</button></>, 'info', { duration: 8000 })
        else if (kind === 'restore') toast('Restored to pending', 'success')
        else toast(<>Change applied{overrideValue != null ? ' with your edit' : ''}. It may take a few minutes to complete — view it in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.</>, 'success')
      } else if (res.refused) {
        // SG.0 — a refusal is a governed stop, in the server's words. The row STAYS pending.
        toast(<>Refused — {res.error ?? 'the write gate declined this action'}</>, 'danger')
      } else if (res.error) {
        toast(`Could not ${kind}: ${res.error}`, 'danger')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [post, toast, restore, refreshCounts])

  /**
   * SG.2 — the pause verb (H10's third icon). A REAL status write on the underlying target —
   * allowed because it is operator-clicked (the no-pause policy binds the engine) — so it is
   * two-step: first click ARMS the button (amber, 3.5s), second click executes. A refusal at
   * the gate comes back in the server's words and the row stays pending.
   */
  const [armedPause, setArmedPause] = useState<string | null>(null)
  useEffect(() => {
    if (!armedPause) return
    const t = setTimeout(() => setArmedPause(null), 3500)
    return () => clearTimeout(t)
  }, [armedPause])
  const pauseTarget = useCallback(async (id: string) => {
    setArmedPause(null)
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/pause-target`, { method: 'POST' })
        .then(async (r): Promise<{ ok: boolean; refused?: boolean; error?: string }> =>
          (r.ok ? (await r.json()) as { ok: boolean; refused?: boolean; error?: string } : { ok: false, error: (await r.json().catch(() => null) as { error?: string } | null)?.error ?? `HTTP ${r.status}` }))
        .catch((): { ok: boolean; refused?: boolean; error?: string } => ({ ok: false, error: 'network' }))
      if (res.ok) {
        setItems((cur) => cur.filter((s) => s.id !== id))
        setTotal((t) => (t == null ? t : Math.max(0, t - 1)))
        setBaselineKey((n) => n + 1)
        void refreshCounts()
        toast('Target paused — the suggestion is set aside under Dismissed', 'success')
      } else if (res.refused) {
        toast(<>Pause refused — {res.error}</>, 'danger')
      } else {
        toast(`Could not pause: ${res.error}`, 'danger')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [toast, refreshCounts])

  /**
   * SG.3 — Undo an applied change, two-step like every real Amazon write here: the FIRST click
   * fetches the rollback preview (eligibility in the service's own words + how many rows the
   * change set reverses together) and arms the button; the SECOND click executes. An ineligible
   * change never arms — the reason lands as a toast instead of a doomed request.
   */
  const [armedUndo, setArmedUndo] = useState<{ id: string; note: string } | null>(null)
  useEffect(() => {
    if (!armedUndo) return
    const t = setTimeout(() => setArmedUndo(null), 6000)
    return () => clearTimeout(t)
  }, [armedUndo])
  const armUndo = useCallback(async (s: Suggestion) => {
    if (!s.undo) return
    setBusy((b) => ({ ...b, [s.id]: true }))
    try {
      const p = await fetch(`${getBackendUrl()}/api/advertising/changes/${s.undo.actionLogId}/undo-preview`, { cache: 'no-store' })
        .then((r) => r.json()).catch(() => null) as { eligible?: boolean; reason?: string; groupedWith?: number } | null
      if (!p?.eligible) {
        toast(p?.reason ?? 'No undo is offered for this row here', 'info')
        return
      }
      setArmedUndo({ id: s.id, note: p.groupedWith && p.groupedWith > 1 ? `Reverses ${p.groupedWith} grouped changes together — click again to undo` : 'Click again to undo this change at Amazon' })
    } finally { setBusy((b) => { const n = { ...b }; delete n[s.id]; return n }) }
  }, [toast])
  const doUndo = useCallback(async (s: Suggestion) => {
    if (!s.undo) return
    setArmedUndo(null)
    setBusy((b) => ({ ...b, [s.id]: true }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes/${s.undo.actionLogId}/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: `undo from the Suggestions queue (suggestion ${s.id})` }),
      })
      const j = await r.json().catch(() => null) as { ok?: boolean; reversed?: number; reason?: string; error?: string } | null
      if (r.ok && j?.ok !== false) {
        setItems((cur) => cur.map((x) => (x.id === s.id && x.undo ? { ...x, undo: { ...x.undo, rolledBack: true } } : x)))
        setBaselineKey((n) => n + 1)
        toast(<>Change undone{j?.reversed && j.reversed > 1 ? ` (${j.reversed} grouped rows reversed)` : ''}. The reversal is a change like any other — it is in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.</>, 'success')
      } else {
        toast(j?.reason ?? j?.error ?? 'The undo was declined', 'danger')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[s.id]; return n }) }
  }, [toast])

  /** One bulk call; shared by the staged batch and the Restore-N path. The per-row outcome
   *  report renders OUTSIDE any popover so a partial result survives it (W2). */
  const runOps = useCallback(async (
    ops: Array<{ id: string; kind: 'apply' | 'dismiss' | 'restore'; value?: number; resultBidCents?: number; resultBudgetEur?: number }>,
    onDone?: () => void,
  ) => {
    if (!ops.length || bulkBusy) return
    setBulkBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions/bulk`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
      })
      const j = (await r.json()) as { okCount?: number; results?: Array<{ id: string; kind: string; ok: boolean; refused?: boolean; error?: string }> }
      if (!r.ok) { toast(`Could not apply the changes: ${(j as { error?: string })?.error ?? r.status}`, 'danger'); return }
      const results = j.results ?? []
      const okIds = results.filter((x) => x.ok).map((x) => x.id)
      const labelById = new Map(items.map((s) => [s.id, srcOf(s).label]))
      const refusals = results.filter((x) => !x.ok).map((x) => ({ id: x.id, label: labelById.get(x.id) ?? x.id, error: x.error ?? 'failed' }))
      setItems((cur) => cur.filter((s) => !okIds.includes(s.id)))
      setTotal((t) => (t == null ? t : Math.max(0, t - okIds.length)))
      setBaselineKey((n) => n + 1)
      void refreshCounts()
      const appliedOk = results.filter((x) => x.ok && x.kind === 'apply').length
      const removedOk = results.filter((x) => x.ok && x.kind === 'dismiss').map((x) => x.id)
      const restoredOk = results.filter((x) => x.ok && x.kind === 'restore').length
      if (refusals.length === 0) {
        if (appliedOk > 0) {
          // H10's own honest copy — an apply is enqueued, not instant, and the receipt lives
          // in the Change Log.
          toast(<>
            Applied {appliedOk} {appliedOk === 1 ? 'change' : 'changes'}{removedOk.length ? <> · removed {removedOk.length}</> : null}.
            Changes may take a few minutes to complete — view them in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.
          </>, 'success')
        } else if (removedOk.length) {
          toast(<>Removed {removedOk.length} — back when a new suggestion is generated · <button type="button" className="h10-am-link" onClick={() => void restore(removedOk)}>Undo</button></>, 'info', { duration: 8000 })
        } else if (restoredOk) {
          toast(`Restored ${restoredOk} to pending`, 'success')
        }
      } else {
        setBulkReport({
          verb: appliedOk || ops.some((o) => o.kind === 'apply') ? 'Applied' : restoredOk ? 'Restored' : 'Removed',
          ok: okIds.length, fail: refusals.length, refusals,
          undoIds: removedOk.length ? removedOk : undefined,
        })
      }
      onDone?.()
    } catch { toast('Could not apply the changes', 'danger') } finally { setBulkBusy(false) }
  }, [bulkBusy, items, toast, restore, refreshCounts])

  /** Commit the staged buffer: accepts (with inline overrides that differ from the projection)
   *  and removals, one batch — H10's [Apply N Changes]. */
  const applyStaged = useCallback(() => {
    const ops: Array<{ id: string; kind: 'apply' | 'dismiss'; resultBidCents?: number; resultBudgetEur?: number }> = []
    for (const [id, e] of staged) {
      if (e.kind === 'remove') { ops.push({ id, kind: 'dismiss' }); continue }
      const row = items.find((s) => s.id === id)
      const projBid = row?.suggested?.bidCents ?? null
      const projBud = row?.suggested?.budgetEur ?? null
      const op: { id: string; kind: 'apply'; resultBidCents?: number; resultBudgetEur?: number } = { id, kind: 'apply' }
      if (e.value != null && projBid != null && Math.round(e.value * 100) !== projBid) op.resultBidCents = Math.round(e.value * 100)
      else if (e.value != null && projBud != null && e.value !== projBud) op.resultBudgetEur = e.value
      ops.push(op)
    }
    void runOps(ops, () => setStaged(new Map()))
  }, [staged, items, runOps])

  // SG.2e — the summary band is GONE (operator, twice): H10 puts nothing between the tabs and
  // Filters, and the money facts already live on the rows — the € at stake column, the ♦
  // pure-waste marker, and the waste-first default ordering.

  // ── the one filter bar: scope grains + page facets ────────────────────────
  const adGroupOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of items) {
      const src = srcOf(s)
      if (src.adGroupId && !seen.has(src.adGroupId)) {
        seen.set(src.adGroupId, `${src.adGroupName ?? src.adGroupId}${src.campaignName ? ` · ${src.campaignName}` : ''}`)
      }
    }
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [items])

  const ruleOptions = useMemo(() => {
    // One option per rule ID; the label is the live name the API resolved onto the row.
    // 🔴 Keyed on ruleId, never ruleName — a renamed rule must stay ONE option (B4).
    const seen = new Map<string, string>()
    for (const s of items) if (s.ruleId && !seen.has(s.ruleId)) seen.set(s.ruleId, s.ruleName ?? 'Rule')
    return [...seen].map(([value, label]) => ({ value, label }))
  }, [items])

  const stakeOf = useCallback((r: unknown) => pricing?.byId[(r as Suggestion).id]?.spendAtStakeCents ?? -1, [pricing])

  const filters = useMemo<GridFilter[]>(() => [
    ...buildScopeFilters({ options, market, value: scope, adGroupOptions }),
    /**
     * SG.2e — Status lives in the FILTERS card, exactly where H10 puts it (their Bids filter
     * card defaults to "Active"; ours to Pending). The status-tab row is gone on the
     * operator's instruction. `__`-prefixed: URL-owned, the server resolves it (it drives the
     * fetch), no client accessor, and a saved preset can never carry it.
     */
    {
      key: '__status', label: 'Status', kind: 'select', placeholder: 'Pending',
      options: [
        { value: 'applied', label: 'Applied' },
        { value: 'dismissed', label: 'Dismissed' },
        { value: 'expired', label: 'Expired' },
      ],
      tip: 'Pending is the live queue. Applied / Dismissed / Expired are its history — Dismissed rows return on their own when the engine generates a new suggestion.',
    },
    {
      key: 'rule', label: 'Rule', kind: 'select', options: ruleOptions, placeholder: 'All rules',
      wide: true, searchable: true, value: (r) => (r as Suggestion).ruleId ?? '',
    },
    {
      key: 'fSpend', label: 'Spend', kind: 'range', unit: '€',
      tip: 'The entity’s trailing 30-day ad spend. Rows with no performance data never match a set range.',
      value: (r) => { const m = (r as Suggestion).metrics; return m ? m.spendCents / 100 : NaN },
    },
    {
      key: 'fSales', label: 'Sales', kind: 'range', unit: '€',
      tip: 'The entity’s trailing 30-day attributed sales. Rows with no performance data never match a set range.',
      value: (r) => { const m = (r as Suggestion).metrics; return m ? m.salesCents / 100 : NaN },
    },
    {
      key: 'fAcos', label: 'ACoS', kind: 'range', unit: '%',
      tip: 'The entity’s trailing 30-day ACoS. Rows where ACoS is not measurable never match a set range.',
      value: (r) => { const m = (r as Suggestion).metrics; return m?.acos != null ? m.acos * 100 : NaN },
    },
    {
      key: 'stake', label: '€ at stake', kind: 'range', unit: '€',
      tip: 'Trailing 30-day spend the action would redirect, in euros. Unpriced rows never match a range.',
      value: (r) => stakeOf(r) / 100,
    },
    {
      key: 'age', label: 'Age (days)', kind: 'range', unit: '',
      tip: 'Days since this change was FIRST proposed. The engine re-confirms pending rows on every evaluation; ones it stops proposing expire on their own.',
      value: (r) => ageDays((r as Suggestion).createdAt),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [options, market, scope.line, scope.portfolio, scope.campaign, scope.adGroup, adGroupOptions, ruleOptions, stakeOf])

  const urlValues = useMemo<FilterState>(
    () => ({ ...scopeToFilterState(scope), rule: ruleParam, __status: status === 'pending' ? '' : status }),
    [scope.line, scope.portfolio, scope.campaign, scope.adGroup, ruleParam, status], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const onUrlChange = useCallback((patch: Record<string, string>) => {
    writeUrl({ ...scopePatchFromFilterState(patch), rule: patch.rule ?? '', status: patch.__status ?? '', row: '' })
  }, [writeUrl])
  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange })

  const scopeNotes = useMemo(() => {
    const notes: string[] = []
    if (scope.portfolio && options) {
      const orphans = (options as ScopeOptionsPayload & { campaignsWithoutPortfolio?: number }).campaignsWithoutPortfolio
      if (typeof orphans === 'number' && orphans > 0) {
        notes.push(`${orphans} campaigns carry no portfolio at all — a portfolio view can never show their suggestions`)
      }
    }
    return notes
  }, [scope.portfolio, options])

  // ── grid ──────────────────────────────────────────────────────────────────
  const groupBy = useMemo(() => {
    if (group === 'none') return undefined
    return (s: Suggestion): { key: string; label: string } => {
      if (group === 'rule') return { key: s.ruleId, label: s.ruleName ?? 'Rule' }
      if (group === 'campaign') { const src = srcOf(s); return { key: src.campaignId ?? s.entityId, label: src.campaignName ?? src.label } }
      return { key: s.proposedAction?.type ?? 'other', label: ACTION_LABEL[s.proposedAction?.type ?? ''] ?? 'Other' }
    }
  }, [group])

  // Unpriced rows sort to the BOTTOM in either direction (-1 sentinel) — "we could not price
  // this" is not "this is worth nothing".
  const stakeSort = (s: Suggestion): number => pricing?.byId[s.id]?.spendAtStakeCents ?? -1

  // The default order is the PRICING SERVICE's order — recoverable first, then by size — not raw
  // € descending: pure upside before trades. Clicking "€ at stake" still sorts by € alone.
  const ordered = useMemo(() => {
    if (status !== 'pending' || !pricing) return viewRows
    return [...viewRows].sort((a, b) => {
      const pa = pricing.byId[a.id], pb = pricing.byId[b.id]
      return Number(!!pb?.recoverable) - Number(!!pa?.recoverable)
        || (pb?.spendAtStakeCents ?? -1) - (pa?.spendAtStakeCents ?? -1)
    })
  }, [viewRows, pricing, status])

  /**
   * SG.2 — the column model, per view.
   *
   *   Source (pinned LEFT, the grid's frozen first column)
   *   Proposed change · the view's VALUE columns (Current → Suggested, so the change reads
   *   left-to-right) · the 30-day METRIC set (Impressions · Clicks · Spend · Sales · Orders ·
   *   ACoS · ROAS · CTR · CVR · CPC — the decision evidence; the long tail default-hidden
   *   behind Customize) · € at stake · Impact · Rule · When ·
   *   the DECISION columns (✓ ✕ ⏸), pinned RIGHT so they stay reachable however wide the
   *   metrics scroll (freezeRight — the operator's ask, and H10's shape).
   */
  const fam = activeView.family
  const isPending = status === 'pending'
  /** the delta half of H10's "Suggested Change" — new value beside a colored arrow + delta */
  const suggestedChange = (cur: number | null, next: number | null, unit: 'cents' | 'eur') => {
    if (next == null) return dash('Needs a current value to project from')
    const fmt = (v: number) => (unit === 'cents' ? eur(v) : `€${v.toFixed(2)}`)
    if (cur == null) return <b className="h10-sug-sugval">{fmt(next)}</b>
    const d = next - cur
    if (Math.abs(d) < (unit === 'cents' ? 1 : 0.005)) return <b className="h10-sug-sugval">{fmt(next)}</b>
    return (
      <span className="h10-sug-change">
        <b className="h10-sug-sugval">{fmt(next)}</b>
        <span className={`d ${d < 0 ? 'down' : 'up'}`}>{d < 0 ? '↓' : '↑'} {fmt(Math.abs(d))}</span>
      </span>
    )
  }
  const isPauseRow = (s: Suggestion) => s.proposedAction?.type === 'pause_target' || s.proposedAction?.type === 'enable_target'
  const dmy = (iso: string) => new Date(iso).toLocaleDateString('en-GB')
  const metricTip = (what: string) => `${what}, trailing 30 days, for the entity this suggestion touches. “—” = no performance rows in the window — absence, not zero.`

  /**
   * SG.2f — the column library, assembled PER FAMILY below to the operator's exact lists
   * ("we're not supposed to add irrelevant columns … depending on the type of the page").
   * Everything not in a family's visible list is reachable through Customize (defaultHidden).
   */
  const C: Record<string, GridColumn<Suggestion>> = {
    adGroup: {
      key: 'adGroup', label: 'Ad Group', metric: false, sortable: true,
      tip: 'The ad group this target lives in — opens in a new tab.',
      sortValue: (s) => srcOf(s).adGroupName ?? '',
      render: (s) => {
        const src = srcOf(s)
        if (!src.adGroupName) return dash('No ad group resolves for this row')
        return src.campaignId && src.adGroupId ? (
          <span className="h10-sug-agx">
            <a href={`/marketing/ads/campaigns/${src.campaignId}/ad-groups/${src.adGroupId}?tab=targets`} target="_blank" rel="noopener noreferrer" title={`Open ${src.adGroupName} in a new tab`}>
              {src.adGroupName} <ExternalLink size={11} aria-hidden />
            </a>
          </span>
        ) : <span>{src.adGroupName}</span>
      },
    },
    spend: { key: 'spend', label: 'Spend', metric: true, sortable: true, tip: metricTip('Ad spend'), sortValue: (s) => s.metrics?.spendCents ?? null, render: (s) => mEur(s.metrics, 'spendCents') },
    sales: { key: 'sales', label: 'Sales', metric: true, sortable: true, tip: metricTip('Attributed sales (7-day window)'), sortValue: (s) => s.metrics?.salesCents ?? null, render: (s) => mEur(s.metrics, 'salesCents') },
    acos: { key: 'acos', label: 'ACoS', metric: true, sortable: true, tip: `${metricTip('ACoS (spend ÷ sales)')} Dot: ${ACOS_DOT_TIP}.`, sortValue: (s) => s.metrics?.acos ?? null, render: (s) => <AcosCell m={s.metrics} /> },
    roas: { key: 'roas', label: 'ROAS', metric: true, sortable: true, tip: `${metricTip('ROAS (sales ÷ spend)')} Dot: ${ROAS_DOT_TIP}.`, sortValue: (s) => s.metrics?.roas ?? null, render: (s) => <RoasCell m={s.metrics} /> },
    impr: { key: 'impr', label: 'Impressions', metric: true, sortable: true, tip: metricTip('Impressions'), sortValue: (s) => s.metrics?.impressions ?? null, render: (s) => mInt(s.metrics, 'impressions') },
    clicks: { key: 'clicks', label: 'Clicks', metric: true, sortable: true, tip: metricTip('Clicks'), sortValue: (s) => s.metrics?.clicks ?? null, render: (s) => mInt(s.metrics, 'clicks') },
    ctr: { key: 'ctr', label: 'CTR', metric: true, sortable: true, tip: metricTip('Click-through rate'), sortValue: (s) => s.metrics?.ctr ?? null, render: (s) => mPct(s.metrics, 'ctr') },
    cvr: { key: 'cvr', label: 'CVR', metric: true, sortable: true, tip: metricTip('Conversion rate (orders ÷ clicks)'), sortValue: (s) => s.metrics?.cvr ?? null, render: (s) => mPct(s.metrics, 'cvr') },
    cpc: { key: 'cpc', label: 'CPC', metric: true, sortable: true, tip: metricTip('Average cost per click'), sortValue: (s) => s.metrics?.cpcCents ?? null, render: (s) => mCpc(s.metrics) },
    orders: { key: 'orders', label: 'PPC Orders', metric: true, sortable: true, tip: metricTip('Attributed orders'), sortValue: (s) => s.metrics?.orders ?? null, render: (s) => mInt(s.metrics, 'orders') },
    volume: {
      key: 'volume', label: 'Search Volume', metric: true, sortable: true,
      tip: 'The whole market’s searches for this term (Brand Analytics, newest period). “—” = the feed does not cover this query — absence, not zero.',
      sortValue: (s) => s.volume ?? null,
      render: (s) => s.volume != null ? <span className="h10-sug-num">{s.volume.toLocaleString('en-IE')}</span> : dash('Not covered by the Brand Analytics feed'),
    },
    lookback: {
      key: 'lookback', label: 'Lookback Period', metric: false, sortable: true,
      tip: 'The window of Amazon performance data this rule computes from — read from the same table the engine reads, never a copy.',
      sortValue: (s) => s.lookback?.label ?? '',
      render: (s) => s.lookback ? <span className="h10-sug-lb" title={s.lookback.why}>{s.lookback.label}</span> : dash('This rule’s trigger reads no performance window'),
    },
    rule: { key: 'rule', label: 'Rule', metric: false, sortable: true, sortValue: (s) => s.ruleName ?? '', render: (s) => <RuleCell s={s} /> },
    reason: {
      key: 'reason', label: 'Reason', metric: false, sortable: true,
      tip: 'Why this surfaced — the rule’s own criteria, in operator units. Falls back to the trigger when the rule states no criteria.',
      sortValue: (s) => s.ruleCriteria ?? prettyTrigger(s.trigger),
      render: (s) => <span className="h10-sug-reason" title={s.ruleCriteria ?? prettyTrigger(s.trigger)}>{s.ruleCriteria ?? prettyTrigger(s.trigger)}</span>,
    },
    dateAdded: {
      key: 'dateAdded', label: 'Date Added', metric: false, sortable: true,
      tip: 'When the engine last generated or re-confirmed this suggestion. Suggestion Created is the FIRST time it was proposed.',
      sortValue: (s) => s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : null,
      render: (s) => s.lastSeenAt ? <span className="h10-sug-when" title={ago(s.lastSeenAt)}>{dmy(s.lastSeenAt)}</span> : dash(),
    },
    created: {
      key: 'created', label: 'Suggestion Created', metric: false, sortable: true,
      tip: 'When this change was FIRST proposed. Pending rows the engine stops re-proposing expire on their own.',
      sortValue: (s) => new Date(s.createdAt).getTime(),
      render: (s) => <span className="h10-sug-when" title={ago(s.createdAt)}>{dmy(s.createdAt)}</span>,
    },
    proposed: { key: 'proposed', label: 'Proposed change', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.type ?? '', render: (s) => <ProposedCell s={s} /> },
    impact: { key: 'impact', label: 'Impact', metric: true, sortable: true, tip: 'Daily € change (or keywords affected). Sort to triage the biggest moves first.', sortValue: impactScore, render: (s) => <ImpactCell s={s} /> },
    tacos: { key: 'tacos', label: 'Target ACoS', tip: 'The campaign’s own target ACoS.', metric: true, sortable: true, sortValue: (s) => s.current?.targetAcosPct ?? null, render: (s) => s.current?.targetAcosPct != null ? <span className="h10-sug-num">{s.current.targetAcosPct.toFixed(0)}%</span> : dash('No target ACoS set on the campaign') },
    stake: {
      key: 'stake', label: '€ at stake', metric: true, sortable: true,
      tip: 'Trailing 30-day spend this action would redirect — not money saved. ♦ marks spend that produced no sales at all, the only case where cutting it is pure recovery.',
      sortValue: stakeSort,
      render: (s) => <StakeCell p={pricing?.byId[s.id]} />,
    },
    curBid: {
      key: 'curBid', label: 'Current Bid', metric: true, sortable: true, width: 132,
      tip: 'The live bid. ✓ the row and this becomes the value Apply will set — editable, ↺ restores the suggestion.',
      sortValue: (s) => s.current?.bidCents ?? null,
      render: (s) => {
        if (s.current?.bidCents == null) return dash('The target no longer resolves locally')
        if (!isPending) return <span className="h10-sug-num">{eur(s.current.bidCents)}</span>
        const st = staged.get(s.id)
        return (
          <BufferInput
            current={(s.current.bidCents / 100).toFixed(2)}
            suggestedEur={s.suggested?.bidCents != null ? s.suggested.bidCents / 100 : null}
            stagedValue={st?.kind === 'apply' ? st.value : undefined}
            isStaged={st?.kind === 'apply'}
            disabled={isPauseRow(s)}
            onChange={(v) => setStagedValue(s.id, v)}
            onRevert={() => setStagedValue(s.id, undefined)}
          />
        )
      },
    },
    sugBid: {
      key: 'sugBid', label: 'Suggested Change', tip: 'The projected new bid and its delta — the rule’s action against the current bid. Its min/max still clamp at apply time.',
      metric: true, sortable: true, sortValue: (s) => s.suggested?.bidCents ?? null,
      render: (s) => isPauseRow(s)
        ? <span className="h10-sug-pausechg">Enabled → Paused</span>
        : suggestedChange(s.current?.bidCents ?? null, s.suggested?.bidCents ?? null, 'cents'),
    },
    startBid: { key: 'startBid', label: 'Starting Bid', tip: 'The bid the new exact target would launch with.', metric: true, sortable: true, sortValue: (s) => s.suggested?.bidCents ?? null, render: (s) => s.suggested?.bidCents != null ? <b className="h10-sug-sugval">{eur(s.suggested.bidCents)}</b> : dash('The rule sets no starting bid') },
    curBud: {
      key: 'curBud', label: 'Current Budget', metric: true, sortable: true, width: 132,
      tip: 'The live daily budget. ✓ the row and this becomes the value Apply will set — editable, ↺ restores the suggestion.',
      sortValue: (s) => s.current?.dailyBudgetEur ?? null,
      render: (s) => {
        if (s.current?.dailyBudgetEur == null) return dash('The campaign no longer resolves locally')
        if (!isPending) return <span className="h10-sug-num">€{s.current.dailyBudgetEur.toFixed(2)}</span>
        const st = staged.get(s.id)
        return (
          <BufferInput
            current={s.current.dailyBudgetEur.toFixed(2)}
            suggestedEur={s.suggested?.budgetEur ?? null}
            stagedValue={st?.kind === 'apply' ? st.value : undefined}
            isStaged={st?.kind === 'apply'}
            onChange={(v) => setStagedValue(s.id, v)}
            onRevert={() => setStagedValue(s.id, undefined)}
          />
        )
      },
    },
    sugBud: {
      key: 'sugBud', label: 'Suggested Change', tip: 'The projected new daily budget and its delta (€1 floor as at apply time).',
      metric: true, sortable: true, sortValue: (s) => s.suggested?.budgetEur ?? null,
      render: (s) => suggestedChange(s.current?.dailyBudgetEur ?? null, s.suggested?.budgetEur ?? null, 'eur'),
    },
    scope: { key: 'scope', label: 'Scope', tip: 'Where the negative lands. Ad group is the default — the path that measurably reaches Amazon; campaign-wide only when the rule says so explicitly.', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.scope ?? 'AD_GROUP', render: (s) => <Tag tone="neutral">{s.proposedAction?.scope === 'CAMPAIGN' ? 'Campaign' : 'Ad group'}</Tag> },
  }
  const hidden = (c: GridColumn<Suggestion>): GridColumn<Suggestion> => ({ ...c, defaultHidden: true })

  /**
   * The family assemblies — the operator's exact lists, in their order; everything else via
   * Customize. Bids gets the Ad Group column (open-in-new-tab); keyword tabs get Search Volume
   * and the date pair; the harvest tab gets Lookback Period; no family carries columns that
   * don't answer its own decision.
   */
  const familyCols: GridColumn<Suggestion>[] =
    fam === 'bids' ? [
      C.adGroup, C.spend, C.sales, C.acos, C.rule, C.curBid, C.cpc, C.sugBid, C.reason,
      hidden(C.roas), hidden(C.impr), hidden(C.clicks), hidden(C.ctr), hidden(C.cvr), hidden(C.orders),
      hidden(C.tacos), ...(isPending ? [hidden(C.stake)] : []), hidden(C.created), hidden(C.dateAdded), hidden(C.impact),
    ] : fam === 'negatives' ? [
      C.spend, C.rule, C.dateAdded, C.reason, C.volume, C.impr, C.ctr, C.cpc, C.cvr, C.orders,
      C.clicks, C.created, C.sales, C.acos, C.roas,
      hidden(C.scope), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : fam === 'new-keywords' ? [
      C.lookback, C.rule, C.dateAdded, C.volume, C.created, C.reason, C.spend, C.sales, C.acos,
      C.clicks, C.ctr, C.cpc, C.orders, C.startBid,
      hidden(C.roas), hidden(C.cvr), hidden(C.impr), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : fam === 'budget' ? [
      C.curBud, C.sugBud, C.spend, C.sales, C.acos, C.roas, C.rule, C.reason, C.created,
      hidden(C.impr), hidden(C.clicks), hidden(C.dateAdded), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : [
      C.proposed, C.spend, C.sales, C.acos, C.rule, C.reason, C.created,
      hidden(C.roas), hidden(C.impr), hidden(C.clicks), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact), hidden(C.dateAdded),
    ]

  const DECISION_W = 52
  const columns: GridColumn<Suggestion>[] = [
    ...familyCols,
    // H10's decision columns: each verb is its OWN narrow icon column, PINNED RIGHT — on
    // pending they STAGE (the fill is the staged state); [Apply N Changes] commits the batch.
    // Hovering ✓ opens the action card stating EXACTLY what will land where (SG.2f).
    ...(status === 'pending' ? [
      {
        key: 'ok', label: '✓', tip: 'Stage this change for Apply — hover for exactly what will happen. Click again to un-stage.', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
        render: (s: Suggestion) => {
          const on = staged.get(s.id)?.kind === 'apply'
          return (
            <ApproveHover s={s} onEdit={() => writeUrl({ row: s.id }, { history: true })}>
              <button type="button" className={`h10-sug-iconbtn ok${on ? ' on' : ''}`} disabled={!!busy[s.id]} aria-pressed={on} aria-label={on ? 'Staged to apply — click to un-stage' : 'Stage this change for Apply'} onClick={() => stage(s.id, 'apply')}>
                <Check size={14} />
              </button>
            </ApproveHover>
          )
        },
      } as GridColumn<Suggestion>,
      {
        key: 'no', label: '✕', tip: 'Remove suggestion until a new one is generated — stages with Apply. Click again to un-stage.', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
        render: (s: Suggestion) => {
          const on = staged.get(s.id)?.kind === 'remove'
          return (
            <button type="button" className={`h10-sug-iconbtn no${on ? ' on' : ''}`} disabled={!!busy[s.id]} aria-pressed={on} aria-label={on ? 'Staged to remove — click to un-stage' : 'Remove until a new suggestion is generated'} title={on ? 'Staged to remove — click to un-stage' : 'Remove suggestion until a new one is generated'} onClick={() => stage(s.id, 'remove')}>
              <X size={14} />
            </button>
          )
        },
      } as GridColumn<Suggestion>,
      {
        key: 'pz', label: '⏸', tip: 'Pause the underlying keyword/target at Amazon and set this suggestion aside. Click once to arm, again to confirm.', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
        render: (s: Suggestion) => s.entityType === 'AD_TARGET' ? (
          <button
            type="button"
            className={`h10-sug-iconbtn pz${armedPause === s.id ? ' armed' : ''}`}
            disabled={!!busy[s.id]}
            aria-label={armedPause === s.id ? 'Click again to pause this target' : 'Pause the underlying target'}
            title={armedPause === s.id ? 'Click again to PAUSE this target at Amazon' : 'Pause the underlying target (click twice)'}
            onClick={() => (armedPause === s.id ? void pauseTarget(s.id) : setArmedPause(s.id))}
          >
            <Pause size={14} />
          </button>
        ) : dash('Only a keyword/target row can pause its target'),
      } as GridColumn<Suggestion>,
    ] : status === 'applied' ? [
      {
        key: 'dl', label: 'Delivery', metric: false, sortable: true, freezeRight: true, width: 118,
        tip: 'The write’s actual fate. An approve is ENQUEUED — the write gate and the drain worker settle it afterwards: Delivered reached Amazon; Refused is the gate’s governed stop (its reason on hover); Failed dead-lettered; Pending is still in flight.',
        sortValue: (s: Suggestion) => s.delivery?.state ?? 'unknown',
        render: (s: Suggestion) => {
          const d = s.delivery ?? { state: 'unknown' as const, detail: null }
          const M: Record<string, { cls: string; label: string }> = {
            delivered: { cls: 'ok', label: 'Delivered' }, pending: { cls: 'pd', label: 'Pending' },
            refused: { cls: 'rf', label: 'Refused' }, failed: { cls: 'fl', label: 'Failed' }, unknown: { cls: 'uk', label: '—' },
          }
          const m = M[d.state]
          return <span className={`h10-sug-dl ${m.cls}`} title={d.detail ?? (d.state === 'unknown' ? 'This row predates delivery tracking — its fate was not recorded' : undefined)}>{m.label}</span>
        },
      } as GridColumn<Suggestion>,
      {
        key: 'act', label: 'Undo', metric: false, sortable: false, freezeRight: true, width: 96,
        tip: 'Reverses the change at Amazon through the rollback service (24h window; a grouped change reverses with its whole set). Refused/failed applies offer Restore instead — the write never landed.',
        render: (s: Suggestion) => {
          if (s.delivery?.state === 'refused' || s.delivery?.state === 'failed') {
            return (
              <button type="button" className="h10-sug-iconbtn" disabled={!!busy[s.id]} aria-label="Restore to pending — this write never landed" title="Restore to pending — this write never landed at Amazon" onClick={() => void act(s.id, 'restore')}>
                <RotateCcw size={14} />
              </button>
            )
          }
          if (s.undo?.rolledBack) return <span className="h10-sug-applied">Undone</span>
          if (!s.undo) return dash('No undo is offered for this row here — the change may still exist; it just has no handle from this queue')
          const armed = armedUndo?.id === s.id
          return (
            <button
              type="button"
              className={`h10-sug-iconbtn${armed ? ' pz armed' : ''}`}
              disabled={!!busy[s.id]}
              aria-label={armed ? armedUndo!.note : 'Undo this change (click twice)'}
              title={armed ? armedUndo!.note : 'Undo this change at Amazon — first click previews, second executes'}
              onClick={() => (armed ? void doUndo(s) : void armUndo(s))}
            >
              <RotateCcw size={14} />
            </button>
          )
        },
      } as GridColumn<Suggestion>,
    ] : [
      {
        key: 'act', label: 'Restore', metric: false, sortable: false, freezeRight: true, width: 84,
        render: (s: Suggestion) => (
          <button type="button" className="h10-sug-iconbtn" disabled={!!busy[s.id]} aria-label="Restore to pending" title="Restore to pending" onClick={() => void act(s.id, 'restore')}>
            <RotateCcw size={14} />
          </button>
        ),
      } as GridColumn<Suggestion>,
    ]),
  ]


  // H10's page-level tab bar: bold labels, a count pill per tab (the PENDING queue), the A.I.
  // tab marked with its icon. `count: null` (no pill) when the count is genuinely unknown —
  // the A.I. store wires in SG.4, and an unfetched /count must not print a confident 0.
  const viewTabs = useMemo<TabItem[]>(() => {
    const pillFor = (family: string | null): number | null =>
      family == null ? null : pendingFamilies == null ? null : (pendingFamilies[family] ?? 0)
    const tabs: TabItem[] = VIEWS.map((v) => ({
      id: v.key,
      label: v.label,
      // SG.4 — the A.I. pill counts PROPOSED autopilot decisions (its own store, from /count's
      // aiBids). Recommendations is a computed feed with no stored pending set — no pill.
      count: v.key === 'ai' ? aiBidsCount : pillFor(v.family),
      icon: v.key === 'ai' ? <Sparkles size={15} /> : undefined,
    }))
    if ((pendingFamilies?.other ?? 0) > 0 || (families.other ?? 0) > 0 || view === 'other') {
      tabs.push({ id: 'other', label: 'Other', count: pillFor('other') })
    }
    return tabs
  }, [pendingFamilies, families, view, aiBidsCount])

  const familyCta = activeView.family ? FAMILY_RULE_ROUTE[activeView.family] : undefined

  return (
    <div className="h10-sug">
      <AdsPageHeader
        title="Suggestions"
        subtitle="The review queue — audit the math, approve the winners, dismiss the anomalies."
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => writeUrl({ market: m })}
        showLearn={false}
        showDataSync={false}
        /* Suggestions are point-in-time proposals, not a time series — no date range. */
        showDateRange={false}
      />

      <div className="h10-sug-views">
        <Tabs
          size="lg"
          tabs={viewTabs}
          active={activeView.key}
          onChange={(v) => writeUrl({ view: v, row: '' })}
        />
        <StaleBanner stale={stale} subject="The queue" onRefresh={() => setReload((n) => n + 1)} />
      </div>

      {view === 'recommendations' ? (
        /* SG.4/SG.7 — the AI + 5-engine impact feed, folded in from /marketing/ads/
           recommendations (which now redirects here) and rebuilt on the page's one anatomy:
           the SAME Filters card + grid as every family view, ?status/?row shared with them. */
        <RecommendationsView status={status === 'applied' ? 'applied' : 'pending'} rowParam={rowParam} writeUrl={writeUrl} />
      ) : view === 'ai' ? (
        /* SG.4 — PROPOSED autopilot decisions, read-only BY DESIGN: no decision approve/
           dismiss route exists yet, so the verbs live on the plan in AI Advertising and this
           tab tells that truth instead of rendering buttons that cannot act.
           SG.7 — the same Filters card as every other view sits above the grid; when the
           store is empty the grid card carries the EmptyState CTA (the family views' shape). */
        <>
          <AdsFilterBar
            filters={aiFilters}
            value={aiFilterState}
            onChange={setAiFilterState}
            defaultOpen
            notesSlot={<ScopeNotes notes={['A.I. decisions carry only their campaign — the product line / portfolio / ad group grains do not apply here']} />}
          />
          <AdsDataGrid<AiDecision>
            rows={aiItems ?? []}
            loading={aiLoading}
            rowId={(r) => r.id}
            /* read-only grid: no verbs exist, so no checkbox column promising bulk ones
               (AdsDataGrid defaults selectable TRUE — the FB.3c trap) */
            selectable={false}
            noun="A.I. bid decision"
            firstColLabel="Campaign"
            renderFirst={(r) => <span className="h10-sug-src"><Tag tone="info">{r.module}</Tag><span className="h10-sug-agx">{r.campaignName ?? r.planName ?? 'account-wide'}</span></span>}
            firstSortValue={(r) => r.campaignName ?? r.planName ?? ''}
            columns={[
              { key: 'action', label: 'Action', metric: false, sortable: true, sortValue: (r) => r.action, render: (r) => <Tag tone="neutral">{r.action.replace(/_/g, ' ').toLowerCase()}</Tag> },
              { key: 'change', label: 'Change', metric: false, render: (r) => <span className="h10-sug-reason" title={aiChangeText(r.before, r.after)}>{aiChangeText(r.before, r.after)}</span> },
              { key: 'reason', label: 'Reason', metric: false, render: (r) => <span className="h10-sug-reason" title={r.reason}>{r.reason}</span> },
              { key: 'plan', label: 'Plan', metric: false, sortable: true, sortValue: (r) => r.planName ?? '', render: (r) => <span className="h10-sug-agx"><Link href="/marketing/ads/ai-advertising" title="Operate this plan in AI Advertising">{r.planName ?? r.planId}</Link></span> },
              { key: 'cycle', label: 'Cycle', metric: false, sortable: true, sortValue: (r) => r.cycle, render: (r) => <span className="h10-sug-when">{r.cycle}</span> },
              { key: 'at', label: 'Proposed', metric: false, sortable: true, sortValue: (r) => r.at, render: (r) => <span className="h10-sug-when">{new Date(r.at).toLocaleDateString('en-GB')}</span> },
            ]}
            filters={aiFilters}
            filterState={aiFilterState}
            onFilterStateChange={setAiFilterState}
            hideFilterPanel
            toolbarLeft={<span className="h10-sug-when">Read-only — approve or decline these on the plan in <Link href="/marketing/ads/ai-advertising">AI Advertising</Link></span>}
            toolbarRight={
              <span className="h10-sug-toolbar">
                <Button variant="secondary" size="sm" onClick={() => setBidSettingsOpen(true)}><Settings size={13} /> Bid Settings</Button>
                <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Refresh</Button>
              </span>
            }
            defaultSort={{ key: 'at', dir: 'desc' }}
            emptyNode={
              /* Honest state: no plan is proposing anything. The tab's true content is this
                 sentence and the door to AI Advertising — inside the grid card, the family shape. */
              <EmptyState
                icon={<Sparkles size={26} />}
                title="No A.I. bid suggestions yet"
                description={<>A.I. bid suggestions come from <Link className="h10-sug-lnk" href="/marketing/ads/ai-advertising">AI Advertising</Link> goals. Launch a goal and its proposed bids will queue here for your approval.</>}
              />
            }
            reportLabel="A.I. bid decisions"
          />
        </>
      ) : (
        <>
          {bulkReport && (
            <div className="h10-sug-report" role="status">
              <b>{bulkReport.verb} {bulkReport.ok} · {bulkReport.fail} refused</b>
              <ul>
                {bulkReport.refusals.slice(0, 8).map((r) => <li key={r.id}><span className="nm">{r.label}</span> — {r.error}</li>)}
                {bulkReport.refusals.length > 8 && <li>…and {bulkReport.refusals.length - 8} more</li>}
              </ul>
              <span className="h10-sug-repacts">
                {bulkReport.undoIds?.length ? <button type="button" className="h10-am-link" onClick={() => { void restore(bulkReport.undoIds!); setBulkReport(null) }}>Undo the {bulkReport.ok}</button> : null}
                <button type="button" className="h10-am-link" onClick={() => setBulkReport(null)}>Dismiss</button>
              </span>
            </div>
          )}

          <AdsFilterBar
            filters={filters}
            value={filterState}
            onChange={setFilterState}
            defaultOpen
            notesSlot={<ScopeNotes notes={scopeNotes} />}
          />

          <AdsDataGrid<Suggestion>
            rows={ordered}
            loading={loading}
            rowId={(s) => s.id}
            noun="suggestion"
            firstColLabel="Source"
            renderFirst={(s) => <SourceCell s={s} />}
            firstSortValue={(s) => srcOf(s).label}
            columns={columns}
            /* SG.7 — the grid needs the filter DEFINITIONS as well as the state: without
               `filters` it returns rows uncut and the panel's client facets (Rule, the metric
               ranges) silently filter nothing (BidClient is the reference wiring). Scope +
               __status keys carry no `value` accessor, so the grid skips them — they stay
               server-resolved. */
            filters={filters}
            filterState={filterState}
            onFilterStateChange={setFilterState}
            hideFilterPanel
            groupBy={groupBy}
            /* pending: the ✓/✕ verbs ARE the selection (H10 has no checkbox column there);
               dismissed/expired keep checkboxes for bulk Restore */
            selectable={status === 'dismissed' || status === 'expired'}
            selected={sel}
            onSelectedChange={setSel}
            searchable
            searchPlaceholder="Search terms & keywords…"
            pagerCentered
            customizable
            storageKey={`suggestions-grid-${activeView.key}-v1`}
            defaultSort={status === 'pending' ? undefined : { key: 'when', dir: 'desc' }}
            onRowClick={(s) => writeUrl({ row: s.id }, { history: true })}
            keyboardNav={!detail}
            onRowKey={(s, k) => {
              if (status === 'pending') {
                if (k === 'a') stage(s.id, 'apply')
                else if (k === 'e') stage(s.id, 'remove')
                else if (k === 'p' && s.entityType === 'AD_TARGET') {
                  if (armedPause === s.id) void pauseTarget(s.id)
                  else setArmedPause(s.id)
                }
              } else if ((status === 'dismissed' || status === 'expired') && k === 'r') void act(s.id, 'restore')
            }}
            toolbarLeft={
              <>
                {/* H10's master pair — ALWAYS visible: Discard Changes clears the staged
                    buffer; Apply N Changes commits accepts + removals in ONE batch. Disabled
                    at 0 — ticking the row verbs is what arms them. */}
                {status === 'pending' ? (
                  <span className="h10-sug-applybar">
                    <button type="button" className="h10-am-link" disabled={staged.size === 0 || bulkBusy} onClick={() => setStaged(new Map())}>
                      Discard Changes
                    </button>
                    <Button variant="primary" size="sm" disabled={staged.size === 0 || bulkBusy} onClick={applyStaged}>
                      <Check size={13} /> Apply {staged.size} {staged.size === 1 ? 'Change' : 'Changes'}
                    </Button>
                  </span>
                ) : status === 'dismissed' || status === 'expired' ? (
                  <span className="h10-sug-applybar">
                    <Button variant="secondary" size="sm" disabled={sel.size === 0 || bulkBusy} onClick={() => void runOps([...sel].map((id) => ({ id, kind: 'restore' as const })), () => setSel(new Set()))}>
                      <RotateCcw size={13} /> Restore {sel.size}
                    </Button>
                  </span>
                ) : null}
                {/* A truncated list must SAY it is truncated (B4): the endpoint caps at 1000. */}
                {total != null && total > items.length && (
                  <span className="h10-sug-trunc" role="status">
                    Showing {items.length.toLocaleString('en-IE')} of {total.toLocaleString('en-IE')} — this list is capped
                  </span>
                )}
                <label className="h10-sug-group">
                  <span>Group by</span>
                  <Select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} aria-label="Group suggestions by">
                    <option value="none">None</option>
                    <option value="rule">Rule</option>
                    <option value="campaign">Campaign</option>
                    <option value="type">Type</option>
                  </Select>
                </label>
              </>
            }
            toolbarRight={
              <span className="h10-sug-toolbar">
                {activeView.key === 'bids' && (
                  <Button variant="secondary" size="sm" onClick={() => setBidSettingsOpen(true)}><Settings size={13} /> Bid Settings</Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Refresh</Button>
              </span>
            }
            emptyNode={
              <EmptyState
                icon={<Sparkles size={26} />}
                title={status === 'applied' ? 'No applied suggestions yet'
                  : status === 'dismissed' ? 'Nothing dismissed'
                  : status === 'expired' ? 'Nothing has expired'
                  : `No ${activeView.noun} suggestions right now`}
                description={status === 'pending'
                  ? familyCta
                    ? <span className="h10-sug-ctawrap">Create a {familyCta.label} rule set to <em>Manual</em> — its proposed changes will queue here for your approval.<br /><Link className="h10-am-btn primary h10-sug-cta" href={familyCta.href}>Create Rule</Link></span>
                    : <>When a rule set to <em>Manual</em> finds something to do, its proposed change appears here for you to approve.</>
                  : status === 'applied' ? 'Suggestions you approve will be listed here.'
                  : status === 'expired' ? 'A pending suggestion the engine stops re-proposing expires on its own and lands here — the queue only ever holds the engine’s current opinion.'
                  : 'Suggestions you remove land here, and come back on their own when the engine generates a new one. You can also restore them by hand.'}
              />
            }
          />
        </>
      )}

      {detail && <SuggestionDrawer suggestion={detail} priced={pricing?.byId[detail.id]} busy={!!busy[detail.id]} onClose={() => writeUrl({ row: '' })} onAct={act} />}

      <AdsBidSettingsModal open={bidSettingsOpen} onClose={() => setBidSettingsOpen(false)} markets={MARKETS} />
    </div>
  )
}

/** The Suggestions page. The ads routes are standalone (AppShell) and sit outside the root
 *  ToastProvider, so we provide one here for the approve/dismiss + bulk-undo toasts. */
export function SuggestionsClient() {
  return (
    <ToastProvider>
      <SuggestionsInner />
    </ToastProvider>
  )
}
