'use client'

/**
 * ES2 / S.2 / S.3 — Suggestions page. Manual-control rules are propose-only: each proposed
 * action lands here as an AdsRuleSuggestion the operator can Approve (apply live) or Dismiss.
 *
 * Rendered through the shared AdsDataGrid (the one H10 console grid) on the design system
 * (Button · Tag · EmptyState · MetricStrip · Select). Every Source cell deep-links to the
 * campaign / ad-group / search-term the suggestion came from (S.1 `source`). S.3 adds a
 * summary MetricStrip, Type/Marketplace/Rule filters, Group-by (Rule/Campaign/Type), and an
 * Impact column you can sort by. Reads/writes the ES1 endpoints (GET /advertising/suggestions ·
 * POST /suggestions/:id/apply · /dismiss).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Check, X, RefreshCw, Sparkles, Wifi, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { Button } from '@/design-system/primitives/Button'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Select } from '@/design-system/primitives/Select'
import { Input } from '@/design-system/primitives/Input'
import { Kbd } from '@/design-system/primitives/Kbd'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Drawer } from '@/design-system/components/Drawer'
import { MetricStrip, type Metric } from '@/design-system/components/MetricStrip'
import { Tabs } from '@/design-system/components/Tabs'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
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

interface Suggestion {
  id: string; ruleId: string; ruleName: string | null; trigger: string | null; marketplace: string | null
  entityType: string; entityId: string; entityName: string | null
  proposedAction: { type?: string; wouldChange?: string; placement?: string; op?: string; value?: number; wouldGraduate?: number; wouldNegate?: number }
  status: string; createdAt: string
  source?: SuggestionSource
}

type GroupKey = 'none' | 'rule' | 'campaign' | 'type'

const ENTITY_LABEL: Record<string, string> = { CAMPAIGN: 'Campaign', AD_TARGET: 'Keyword/Target', SEARCH_TERM: 'Search term', MARKETPLACE: 'Marketplace' }
const ENTITY_TONE: Record<string, TagTone> = { CAMPAIGN: 'info', AD_TARGET: 'neutral', SEARCH_TERM: 'neutral', MARKETPLACE: 'neutral' }
const ACTION_LABEL: Record<string, string> = { budget_apply: 'Budget', placement_apply: 'Placement', bid_apply: 'Bid', dayparting_apply: 'Dayparting', add_negative_exact: 'Add negative', promote_to_exact: 'Promote to exact', harvest_and_negate: 'Harvest & negate' }
// Proposed-action sentiment → Tag tone. promote/harvest are wins (positive); negate/down are guarding (warning).
const ACTION_TONE: Record<string, TagTone> = { promote_to_exact: 'success', harvest_and_negate: 'success', add_negative_exact: 'warning', bid_apply: 'info', budget_apply: 'info', placement_apply: 'info', dayparting_apply: 'info' }
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }

// `entityName` is an empty string on some rows rather than null (two pending targets today), and
// `??` keeps an empty string — which renders a nameless row with nothing to click. Fall through
// to the id, which is at least identifying.
const srcOf = (s: Suggestion): SuggestionSource => s.source ?? { href: null, label: s.entityName || s.entityId, marketplace: s.marketplace }

/**
 * ACR.4.4 — what this proposal puts in play, from the priced-proposals service.
 *
 * `spendAtStakeCents` is money the action would REDIRECT, not money it would save — the
 * service is emphatic about this and the UI must not quietly upgrade it. Only `recoverable`
 * (spend that produced no sales at all) is honest to call recovery, and it is the only thing
 * that earns the ♦.
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

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`
const eur0 = (cents: number) => `€${Math.round(cents / 100).toLocaleString('en-IE')}`

// Impact — the € delta parsed from the proposed change ("€10.00 → €12.00" ⇒ +2.00). Lets the
// operator sort the biggest-money moves to the top. Harvest cards have no €, so they score on count.
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
}
const prettyTrigger = (t: string | null): string => t ? (TRIGGER_LABEL[t] ?? t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())) : 'Rule match'

// Edit-before-apply preview: the budget/bid base (first € in wouldChange) + the projected result for a new magnitude.
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

/** Source cell — entity-type Tag + a breadcrumb (campaign ▸ ad group ▸ keyword) that deep-links to the exact sub-page. */
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
  return (
    <span className="h10-sug-src">
      <Tag tone={ENTITY_TONE[s.entityType] ?? 'neutral'}>{ENTITY_LABEL[s.entityType] ?? s.entityType}</Tag>
      {src.href
        ? <Link href={src.href} className="lnk" title={`Open ${src.label}`}>{crumb}</Link>
        : <span className="lnk dead" title="Source no longer available">{crumb}</span>}
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
 *
 * A row with no price is NOT shown as €0. 37 of the 150 pending proposals point at a target
 * with no trailing grain behind it, and a confident zero would sort every one of them below a
 * 30-cent decision — the exact failure this column exists to end.
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

/** Detail drawer — provenance flow (Signal → Rule → Action → Target, the target a deep link),
 *  optional edit-before-apply for budget/bid magnitudes, and the approve/dismiss actions. */
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
          {st === 'dismissed' && <Button variant="primary" size="sm" disabled={busy} onClick={doRestore}><RotateCcw size={14} /> Restore</Button>}
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

        {/* ACR.4.4 — what this decision is worth, in the service's own terms. The sentence
            matters as much as the figure: an operator who reads "at stake" as "saved" will
            approve every proposal to cut a winner. */}
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
          <div><dt>Created</dt><dd>{ago(suggestion.createdAt)}</dd></div>
          {suggestion.trigger ? <div><dt>Trigger</dt><dd>{suggestion.trigger}</dd></div> : null}
          <div><dt>Status</dt><dd>{suggestion.status}</dd></div>
        </dl>
      </div>
    </Drawer>
  )
}

function SuggestionsInner() {
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [live, setLive] = useState(false)
  const [group, setGroup] = useState<GroupKey>('none')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProg, setBulkProg] = useState<{ done: number; total: number } | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [status, setStatus] = useState<'pending' | 'applied' | 'dismissed'>('pending')
  const [pricing, setPricing] = useState<Pricing | null>(null)
  /**
   * B4 — how many rows the server HAS, against how many it sent. The endpoint caps at 1000; when
   * `count < total` the grid is showing a prefix and has to say so, because a silently truncated
   * list reads as a complete one. It had already happened: the cap was 300 and 306 were pending.
   */
  const [total, setTotal] = useState<number | null>(null)
  /**
   * B4 — deep link from the Rules & Automation grid's Activity cell (`?rule=<name>`), seeding the
   * Rule filter this page already has. Without it a count of "125 waiting" landed the operator on
   * all 306 rows with no way back to the 125.
   *
   * ⚠ Keyed on the rule NAME, because that is what the existing filter matches on. Two rules can
   * share a name in this account, so a deep link can show both — correct for the filter as built,
   * and better than a number that leads nowhere.
   */
  const ruleParam = useSearchParams().get('rule')
  const { toast } = useToast()

  const load = useCallback(async () => {
    try {
      // limit=300 (the endpoint's ceiling), not the default 100. With 150 pending, the default
      // showed 100 rows under a "Spend at stake" tile computed over all 150 — the grid and the
      // money disagreeing about which rows they describe.
      // B4 — 1000, the endpoint's raised ceiling. It was 300 and 306 were pending, so six rows
      // existed that no view in the product could reach. `total` below is the untruncated count.
      const j = await fetch(`${getBackendUrl()}/api/advertising/suggestions?status=${status}&limit=1000`).then((r) => r.json())
      setItems(Array.isArray(j?.items) ? j.items : [])
      setTotal(typeof j?.total === 'number' ? j.total : null)
    } catch { setItems([]); setTotal(null) } finally { setLoading(false) }
    // ACR.4.4 — pricing is a separate, slower call and only means anything for pending rows.
    // It is fetched AFTER the list and never awaited by it: an unpriced grid is a degraded
    // page, an empty one is a broken page, and a 30-day aggregate must not be able to cause
    // the second.
    if (status !== 'pending') { setPricing(null); return }
    try {
      const p = await fetch(`${getBackendUrl()}/api/advertising/suggestions/pricing`).then((r) => r.json())
      setPricing(p?.byId ? (p as Pricing) : null)
    } catch { setPricing(null) }
  }, [status])
  useEffect(() => { void load() }, [load])

  // F2 — live-refresh: when a rule fires (a Manual rule may add a suggestion), reload (debounced).
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let es: EventSource | null = null
    try {
      es = new EventSource(`${getBackendUrl()}/api/advertising/execution-events`)
      es.addEventListener('ping', () => setLive(true))
      es.addEventListener('automation.rule.fired', () => {
        if (debounce.current) clearTimeout(debounce.current)
        debounce.current = setTimeout(() => void load(), 1200)
      })
      es.onerror = () => setLive(false)
    } catch { /* SSE unavailable → polling/refresh still works */ }
    return () => { es?.close(); if (debounce.current) clearTimeout(debounce.current) }
  }, [load])

  const post = useCallback((id: string, kind: 'apply' | 'dismiss' | 'restore', body?: Record<string, unknown>) =>
    fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/${kind}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' }).then((r) => r.ok).catch(() => false), [])

  // Undo a dismiss (single or bulk): restore the rows to pending, then reload to show them again.
  const restore = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => post(id, 'restore')))
    void load()
  }, [post, load])

  const act = useCallback(async (id: string, kind: 'apply' | 'dismiss' | 'restore', overrideValue?: number) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const body = kind === 'apply' && overrideValue != null ? { value: overrideValue } : undefined
      if (await post(id, kind, body)) {
        setItems((cur) => cur.filter((s) => s.id !== id))
        if (kind === 'dismiss') toast(<>Suggestion dismissed · <button type="button" className="h10-sug-undo" onClick={() => void restore([id])}>Undo</button></>, 'info')
        else if (kind === 'restore') toast('Restored to pending', 'success')
        else toast(overrideValue != null ? 'Approved with your edit' : 'Suggestion approved', 'success')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [post, toast, restore])

  // Bulk Approve / Dismiss — limited concurrency, live progress, per-row success/fail tally.
  const runBulk = useCallback(async (ids: string[], kind: 'apply' | 'dismiss' | 'restore', clear: () => void) => {
    if (!ids.length || bulkBusy) return
    setBulkBusy(true); setBulkProg({ done: 0, total: ids.length })
    const okIds: string[] = []; let fail = 0; let i = 0
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++]
        if (await post(id, kind)) okIds.push(id); else fail++
        setBulkProg((p) => (p ? { ...p, done: p.done + 1 } : p))
      }
    }
    await Promise.all([worker(), worker(), worker()])
    setItems((cur) => cur.filter((s) => !okIds.includes(s.id)))
    clear(); setBulkBusy(false); setBulkProg(null)
    const verb = kind === 'apply' ? 'Approved' : kind === 'restore' ? 'Restored' : 'Dismissed'
    const base = `${verb} ${okIds.length} ${okIds.length === 1 ? 'suggestion' : 'suggestions'}${fail ? ` · ${fail} failed` : ''}`
    if (kind === 'dismiss' && okIds.length) toast(<>{base} · <button type="button" className="h10-sug-undo" onClick={() => void restore(okIds)}>Undo</button></>, fail ? 'danger' : 'info')
    else toast(base, fail ? 'danger' : 'success')
  }, [bulkBusy, post, toast, restore])

  // Summary tiles — addressable impact at a glance.
  const metrics = useMemo<Metric[]>(() => {
    const campaigns = new Set(items.map((s) => srcOf(s).campaignId).filter(Boolean))
    const netDelta = items.reduce((sum, s) => sum + (eurDelta(s) ?? 0), 0)
    const harvest = items.reduce((sum, s) => sum + harvestCount(s), 0)
    const tiles: Metric[] = [
      { label: 'Pending', value: items.length },
      { label: 'Campaigns affected', value: campaigns.size },
    ]
    // ACR.4.4 — the two figures that turn a list into a ranked decision. Recoverable leads
    // because it is the only one that is pure upside; "at stake" is the wider number and
    // includes bid-downs on keywords that ARE selling, which are trades.
    if (pricing) {
      tiles.push({ label: 'Pure waste', value: eur0(pricing.recoverableCents) })
      tiles.push({ label: 'Spend at stake', value: eur0(pricing.spendAtStakeCents) })
    }
    if (Math.abs(netDelta) >= 0.005) tiles.push({ label: 'Net daily Δ', value: `${netDelta >= 0 ? '+' : '−'}€${Math.abs(netDelta).toFixed(2)}`, delta: { value: netDelta >= 0 ? 'increase' : 'decrease', positive: netDelta >= 0 } })
    if (harvest > 0) tiles.push({ label: 'Keywords to harvest', value: harvest })
    return tiles
  }, [items, pricing])

  // Filters — populated from the data in view.
  const filters = useMemo<GridFilter[]>(() => {
    const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter(Boolean) as string[])]
    const types = uniq(items.map((s) => s.proposedAction?.type))
    const mkts = uniq(items.map((s) => s.marketplace))
    const rules = uniq(items.map((s) => s.ruleName))
    return [
      { key: 'type', label: 'Type', kind: 'select', options: types.map((t) => ({ value: t, label: ACTION_LABEL[t] ?? t })), placeholder: 'All types', value: (r) => (r as Suggestion).proposedAction?.type ?? '' },
      { key: 'mkt', label: 'Marketplace', kind: 'select', options: mkts.map((m) => ({ value: m, label: m })), placeholder: 'All markets', value: (r) => (r as Suggestion).marketplace ?? '' },
      { key: 'rule', label: 'Rule', kind: 'select', options: rules.map((r) => ({ value: r, label: r })), placeholder: 'All rules', wide: true, searchable: true, value: (r) => (r as Suggestion).ruleName ?? '' },
    ]
  }, [items])

  const groupBy = useMemo(() => {
    if (group === 'none') return undefined
    return (s: Suggestion): { key: string; label: string } => {
      if (group === 'rule') return { key: s.ruleId, label: s.ruleName ?? 'Rule' }
      if (group === 'campaign') { const src = srcOf(s); return { key: src.campaignId ?? s.entityId, label: src.campaignName ?? src.label } }
      return { key: s.proposedAction?.type ?? 'other', label: ACTION_LABEL[s.proposedAction?.type ?? ''] ?? 'Other' }
    }
  }, [group])

  // Unpriced rows sort to the BOTTOM in either direction (-1 sentinel), because "we could not
  // price this" is not "this is worth nothing" and must never occupy the top of a board whose
  // whole purpose is to rank by money.
  const stakeSort = (s: Suggestion): number => pricing?.byId[s.id]?.spendAtStakeCents ?? -1

  /**
   * The default order is the PRICING SERVICE's order — recoverable first, then by size — not
   * raw € descending.
   *
   * Sorting purely by € put the six biggest rows at the top as bid-downs on keywords that are
   * SELLING (€230.20, €159.60, …), with every pure-waste row buried beneath them. Both orderings
   * are defensible, but the service argues explicitly for this one: an operator working top-down
   * should meet the decisions that are pure upside before the ones that involve a trade. Two of
   * our own components disagreeing about how to rank the same list is worse than either answer.
   *
   * The grid preserves `rows` order when no sort is set, so this is the opening view; clicking
   * "€ at stake" still sorts by € alone, which is what that header should mean.
   */
  const ordered = useMemo(() => {
    if (status !== 'pending' || !pricing) return items
    return [...items].sort((a, b) => {
      const pa = pricing.byId[a.id], pb = pricing.byId[b.id]
      return Number(!!pb?.recoverable) - Number(!!pa?.recoverable)
        || (pb?.spendAtStakeCents ?? -1) - (pa?.spendAtStakeCents ?? -1)
    })
  }, [items, pricing, status])

  const columns: GridColumn<Suggestion>[] = [
    { key: 'proposed', label: 'Proposed change', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.type ?? '', render: (s) => <ProposedCell s={s} /> },
    ...(status === 'pending' ? [{
      key: 'stake',
      label: '€ at stake',
      metric: true,
      sortable: true,
      tip: 'Trailing 30-day spend this action would redirect — not money saved. ♦ marks spend that produced no sales at all, the only case where cutting it is pure recovery.',
      sortValue: stakeSort,
      render: (s: Suggestion) => <StakeCell p={pricing?.byId[s.id]} />,
    } as GridColumn<Suggestion>] : []),
    { key: 'impact', label: 'Impact', metric: true, sortable: true, tip: 'Daily € change (or keywords affected). Sort to triage the biggest moves first.', sortValue: impactScore, render: (s) => <ImpactCell s={s} /> },
    { key: 'rule', label: 'Rule', metric: false, sortable: true, sortValue: (s) => s.ruleName ?? '', render: (s) => <RuleCell s={s} /> },
    { key: 'when', label: 'When', metric: false, sortable: true, sortValue: (s) => new Date(s.createdAt).getTime(), render: (s) => <span className="h10-sug-when">{ago(s.createdAt)}</span> },
    {
      key: 'act', label: 'Actions', metric: false, sortable: false,
      render: (s) => status === 'applied' ? (
        <span className="h10-sug-applied"><Check size={13} /> Applied</span>
      ) : status === 'dismissed' ? (
        <span className="h10-sug-acts"><Button variant="secondary" size="sm" disabled={!!busy[s.id]} onClick={() => act(s.id, 'restore')}><RotateCcw size={13} /> Restore</Button></span>
      ) : (
        <span className="h10-sug-acts">
          <Button variant="primary" size="sm" disabled={!!busy[s.id]} onClick={() => act(s.id, 'apply')}><Check size={13} /> Approve</Button>
          <Button variant="secondary" size="sm" disabled={!!busy[s.id]} onClick={() => act(s.id, 'dismiss')}><X size={13} /> Dismiss</Button>
        </span>
      ),
    },
  ]

  const detail = detailId ? items.find((s) => s.id === detailId) ?? null : null

  return (
    <div className="h10-sug">
      <AdsPageHeader title="Suggestions" subtitle="Review and approve the actions your Manual rules propose." showDateRange={false} markets={[]} market="all" onMarketChange={() => {}} />
      <Tabs
        className="h10-sug-tabs"
        tabs={[{ id: 'pending', label: 'Pending' }, { id: 'applied', label: 'Applied' }, { id: 'dismissed', label: 'Dismissed' }]}
        active={status}
        onChange={(id) => { setStatus(id as 'pending' | 'applied' | 'dismissed'); setLoading(true); setDetailId(null) }}
      />
      {status === 'pending' && !loading && items.length > 0 && <MetricStrip metrics={metrics} />}
      {status !== 'applied' && !loading && items.length > 0 && (
        <p className="h10-sug-kbd"><Kbd>j</Kbd><Kbd>k</Kbd> move · {status === 'pending' ? <><Kbd>a</Kbd> approve · <Kbd>e</Kbd> dismiss</> : <><Kbd>r</Kbd> restore</>} · <Kbd>o</Kbd> open</p>
      )}
      <AdsDataGrid<Suggestion>
        rows={ordered}
        loading={loading}
        rowId={(s) => s.id}
        noun="suggestion"
        firstColLabel="Source"
        renderFirst={(s) => <SourceCell s={s} />}
        firstSortValue={(s) => srcOf(s).label}
        columns={columns}
        filters={filters}
        // B4 — seed from ?rule=, so the Activity cell's "125 waiting" lands on those 125.
        initialFilters={ruleParam ? { rule: ruleParam } : undefined}
        filtersDefaultOpen={!!ruleParam}
        groupBy={groupBy}
        // The shared grid's frozen first column assumes the 40px checkbox gutter — keep selection
        // on (matches every console grid + sets up S.4 bulk). Bulk-action wiring lands in S.4.
        selectable
        customizable={false}
        // Pending opens in `ordered` (pure waste first, then by size) — no defaultSort, because
        // the grid preserves row order when none is set. 150 rows sorted newest-first is the
        // undifferentiated list nobody acted on. Applied/dismissed keep the chronological view,
        // where "what did I just do" is the actual question.
        defaultSort={status === 'pending' ? undefined : { key: 'when', dir: 'desc' }}
        onRowClick={(s) => setDetailId(s.id)}
        keyboardNav={!detail}
        onRowKey={(s, k) => {
          if (status === 'pending') { if (k === 'a') void act(s.id, 'apply'); else if (k === 'e') void act(s.id, 'dismiss') }
          else if (status === 'dismissed' && k === 'r') void act(s.id, 'restore')
        }}
        selectionActions={status === 'applied' ? undefined : (ids, clear) => (
          <span className="h10-bulkrow">
            {status === 'dismissed' ? (
              <Button variant="primary" size="sm" disabled={bulkBusy} onClick={() => void runBulk(ids, 'restore', clear)}><RotateCcw size={13} /> Restore {ids.length}</Button>
            ) : (
              <>
                <Button variant="primary" size="sm" disabled={bulkBusy} onClick={() => void runBulk(ids, 'apply', clear)}><Check size={13} /> Approve {ids.length}</Button>
                <Button variant="secondary" size="sm" disabled={bulkBusy} onClick={() => void runBulk(ids, 'dismiss', clear)}><X size={13} /> Dismiss {ids.length}</Button>
              </>
            )}
            {bulkProg && <span className="h10-sug-prog">{bulkProg.done}/{bulkProg.total}</span>}
          </span>
        )}
        toolbarLeft={
          <>
            {/* 🔴 B4 — a truncated list must SAY it is truncated. The endpoint caps the page, and
                when it does, every tile and count above describes a prefix while reading as the
                whole. This had already bitten silently: the cap was 300 with 306 pending. */}
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
            {live && <span className="h10-sug-live"><Wifi size={12} /> Live</span>}
            <Button variant="secondary" size="sm" onClick={() => { setLoading(true); void load() }}><RefreshCw size={13} /> Refresh</Button>
          </span>
        }
        emptyNode={
          <EmptyState
            icon={<Sparkles size={26} />}
            title={status === 'applied' ? 'No applied suggestions yet' : status === 'dismissed' ? 'Nothing dismissed' : 'No suggestions right now'}
            description={status === 'pending'
              ? <>When a rule set to <em>Manual</em> finds something to do, its proposed change appears here for you to approve.</>
              : status === 'applied' ? 'Suggestions you approve will be listed here.' : 'Suggestions you dismiss will be listed here — you can restore them.'}
          />
        }
      />
      {detail && <SuggestionDrawer suggestion={detail} priced={pricing?.byId[detail.id]} busy={!!busy[detail.id]} onClose={() => setDetailId(null)} onAct={act} />}
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
