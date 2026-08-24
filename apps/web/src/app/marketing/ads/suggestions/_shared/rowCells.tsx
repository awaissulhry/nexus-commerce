'use client'

/**
 * SGX (2026-08-24) — split out of `SuggestionsClient.tsx`, which had grown to 2,447 lines holding
 * seven tabs. Moved VERBATIM: a relocation, not a rewrite, so `git log -L` over any symbol here
 * still reaches the SG commit that reasoned about it.
 */

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronRight, ExternalLink, RotateCcw } from 'lucide-react'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { HoverCard } from '../../campaigns/FilterDropdown'
import { ApproveHoverCard, type HoverContent } from '../ApproveHoverCard'
import { dash, eur, type SuggestionMetrics } from '../cells'
import { ACTION_LABEL, ACTION_TONE, ENTITY_LABEL, ENTITY_TONE, srcOf, type Priced, type Suggestion } from './types'

/* SG.7 — eur / dash / AcosCell / RoasCell moved verbatim to ./cells.tsx (the Recommendations
   view renders through the SAME components). The per-key readers below stay: only this grid's
   payload carries their shape. */
export const mInt = (m: SuggestionMetrics | null | undefined, k: 'impressions' | 'clicks' | 'orders') =>
  m ? <span className="h10-sug-num">{m[k].toLocaleString('en-IE')}</span> : dash()
export const mEur = (m: SuggestionMetrics | null | undefined, k: 'spendCents' | 'salesCents') =>
  m ? <span className="h10-sug-num">{eur(m[k])}</span> : dash()
export const mPct = (m: SuggestionMetrics | null | undefined, k: 'acos' | 'ctr' | 'cvr') => {
  if (!m) return dash()
  const v = m[k]
  return v == null ? dash('Not measurable — the denominator is 0 in this window') : <span className="h10-sug-num">{(v * 100).toFixed(2)}%</span>
}
export const mCpc = (m: SuggestionMetrics | null | undefined) => {
  if (!m) return dash()
  return m.cpcCents == null ? dash('Not measurable — no clicks in this window') : <span className="h10-sug-num">{eur(m.cpcCents)}</span>
}

// Impact — the € delta parsed from the proposed change ("€10.00 → €12.00" ⇒ +2.00).
export const parseEur = (raw: string): number => {
  let s = raw.trim()
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.') // 1.234,56 → 1234.56
  else if (s.includes(',')) s = s.replace(',', '.')
  return Number(s) || 0
}
export const eurDelta = (s: Suggestion): number | null => {
  const wc = s.proposedAction?.wouldChange
  if (!wc) return null
  const nums = [...wc.matchAll(/€\s*([\d.,]+)/g)].map((m) => parseEur(m[1]))
  return nums.length >= 2 ? nums[nums.length - 1] - nums[0] : null
}
export const harvestCount = (s: Suggestion): number => {
  const a = s.proposedAction ?? {}
  return a.type === 'harvest_and_negate' ? (a.wouldGraduate ?? 0) + (a.wouldNegate ?? 0) : 0
}
export const impactScore = (s: Suggestion): number => {
  const d = eurDelta(s)
  if (d != null) return Math.abs(d)
  const h = harvestCount(s)
  if (h) return h
  return typeof s.proposedAction?.value === 'number' ? s.proposedAction.value : 0
}

// Friendly trigger names for the provenance "signal" — fall back to a prettified raw value.
export const TRIGGER_LABEL: Record<string, string> = {
  CAMPAIGN_PERFORMANCE_BUDGET: 'Budget performance', CAC_SPIKE: 'CAC spike', AD_SPEND_PROFITABILITY_BREACH: 'Ad-spend over profit',
  SEARCH_TERM_CONVERTING: 'Converting search term', SEARCH_TERM_WASTING: 'Wasted search term',
  KEYWORD_HIGH_ACOS: 'High ACoS keyword', KEYWORD_SCALE_OPPORTUNITY: 'Scale opportunity', KEYWORD_LOW_CTR: 'Low-CTR keyword',
  KEYWORD_ZERO_IMPRESSIONS: 'Zero impressions', KEYWORD_WASTED_SPEND: 'Wasted keyword spend', KEYWORD_RISING_STAR: 'Rising-star keyword',
  AD_TARGET_UNDERPERFORMING: 'Underperforming target', AD_GROUP_UNDERPERFORMING: 'Underperforming ad group',
  CAMPAIGN_NO_SALES: 'No-sales campaign', CVR_DROP: 'Conversion-rate drop', NEW_TO_BRAND_WINNER: 'New-to-brand winner',
  CAMPAIGN_ROAS_DECLINING: 'Declining ROAS', SOV_BID: 'Share-of-voice signal', KEYWORD_RANK_BID: 'Keyword rank signal',
  SCHEDULE: 'Scheduled check',
}
export const prettyTrigger = (t: string | null): string => t ? (TRIGGER_LABEL[t] ?? t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())) : 'Rule match'

// Edit-before-apply preview: the budget/bid base (first € in wouldChange) + the projected result.
export const baseEur = (s: Suggestion): number | null => {
  const wc = s.proposedAction?.wouldChange
  if (!wc) return null
  const nums = [...wc.matchAll(/€\s*([\d.,]+)/g)].map((m) => parseEur(m[1]))
  return nums.length ? nums[0] : null
}
export const projectAfter = (s: Suggestion, value: number): number | null => {
  const base = baseEur(s); const op = s.proposedAction?.op
  if (op === 'setValue') return value
  if (base == null) return null
  if (op === 'incPct') return base * (1 + value / 100)
  if (op === 'decPct') return base * (1 - value / 100)
  return null
}
/** Does this action expose an editable numeric magnitude (budget/bid % or absolute set)? */
export const isEditable = (s: Suggestion): boolean => typeof s.proposedAction?.value === 'number' && ['incPct', 'decPct', 'setValue'].includes(s.proposedAction?.op ?? '')

/** Source cell — entity-type Tag + a breadcrumb (campaign ▸ ad group ▸ keyword) that deep-links
 *  to the exact sub-page. Hovering a target row states its facts (H10's hover pop-up: status,
 *  parent campaign, ad group, current base bid). */
export function SourceCell({ s }: { s: Suggestion }) {
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

export function ProposedCell({ s }: { s: Suggestion }) {
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

export function ImpactCell({ s }: { s: Suggestion }) {
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
export function StakeCell({ p }: { p: Priced | undefined }) {
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

export function RuleCell({ s }: { s: Suggestion }) {
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
export function BufferInput({ current, suggestedEur, stagedValue, isStaged, disabled, onChange, onRevert }: {
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
export const MT_BADGE: Record<string, { letter: string; cls: string; label: string }> = {
  EXACT: { letter: 'E', cls: 'mt-e', label: 'Exact' },
  BROAD: { letter: 'B', cls: 'mt-b', label: 'Broad' },
  PHRASE: { letter: 'P', cls: 'mt-p', label: 'Phrase' },
  NEGATIVE_EXACT: { letter: 'E', cls: 'mt-ne', label: 'NegativeExact' },
  NEGATIVE_PHRASE: { letter: 'P', cls: 'mt-ne', label: 'NegativePhrase' },
}
export const AD_PRODUCT_PILL: Record<string, string> = { SPONSORED_PRODUCTS: 'SP', SPONSORED_BRANDS: 'SB', SPONSORED_DISPLAY: 'SD' }

export interface HoverRow { badge: { letter: string; cls: string } | null; typeLabel: string; bid: string; campaign: string; adProduct: string | null; adGroup: string; note: string }

export function approveHoverContent(s: Suggestion): { title: string; sub: string; rows: HoverRow[]; headers?: HoverContent['headers'] } | null {
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
  /**
   * 🔴 SGX — placement fell straight through to `return null`, so hovering ✓ on the Placement tab
   * produced NOTHING while every other tab stated exactly what would happen. Verified on prod:
   * the wrapper was present, the card never rendered. A verb whose blast radius is a live bid
   * modifier is the last one that should be silent about it.
   */
  if (s.family === 'placement') {
    const lane = (a.placement ?? 'PLACEMENT_TOP').replace('PLACEMENT_', '').replace(/_/g, ' ').toLowerCase()
    const next = s.suggested?.placementPct
    const cur = s.current?.placementPct
    return {
      title,
      sub: `This campaign’s ${lane} bid modifier will be changed when changes are applied. Only this placement lane moves — the campaign’s other lanes are written back unchanged.`,
      headers: ['Placement', 'New modifier', 'Campaign', 'Marketplace', 'Notes'],
      // the lane rides in the badge slot: MT_BADGE has no entry for it, so it renders as plain
      // text under the "Placement" header rather than an unrelated match-type circle.
      rows: [rowFor(lane,
        next != null ? `${next}%` : '—',
        src.campaignName ?? src.label, null, src.marketplace ?? '—',
        cur != null ? `from ${cur}%` : 'Applicable',
      )],
    }
  }
  return null
}

/**
 * SG.9 — the family tabs' card is now the SHARED `ApproveHoverCard` (one implementation for
 * all seven tabs); this wrapper only supplies the family content and the Edit button.
 */
export function ApproveHover({ s, onEdit, children }: { s: Suggestion; onEdit: () => void; children: ReactNode }) {
  return (
    <ApproveHoverCard content={() => {
      const c = approveHoverContent(s)
      return c ? { ...c, action: { label: 'Edit Suggestion', onClick: onEdit } } : null
    }}>
      {children}
    </ApproveHoverCard>
  )
}

/** One node in the vertical provenance flow: eyebrow + title + sub, optional deep link. */
export function FlowNode({ eyebrow, title, sub, tone, href, last }: { eyebrow: string; title: ReactNode; sub?: ReactNode; tone?: TagTone; href?: string | null; last?: boolean }) {
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
