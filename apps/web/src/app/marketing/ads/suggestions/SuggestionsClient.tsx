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
import { Check, X, RefreshCw, Sparkles, Wifi, ChevronRight } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { Button } from '@/design-system/primitives/Button'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Select } from '@/design-system/primitives/Select'
import { EmptyState } from '@/design-system/components/EmptyState'
import { MetricStrip, type Metric } from '@/design-system/components/MetricStrip'
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
const ACTION_TONE: Record<string, TagTone> = { promote_to_exact: 'positive', harvest_and_negate: 'positive', add_negative_exact: 'warning', bid_apply: 'info', budget_apply: 'info', placement_apply: 'info', dayparting_apply: 'info' }
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }

const srcOf = (s: Suggestion): SuggestionSource => s.source ?? { href: null, label: s.entityName ?? s.entityId, marketplace: s.marketplace }

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

function RuleCell({ s }: { s: Suggestion }) {
  return (
    <span className="h10-sug-rule">
      <b title={s.ruleName ?? ''}>{s.ruleName ?? 'Rule'}</b>
      {s.marketplace ? <Tag tone="neutral">{s.marketplace}</Tag> : null}
    </span>
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
  const { toast } = useToast()

  const load = useCallback(async () => {
    try {
      const j = await fetch(`${getBackendUrl()}/api/advertising/suggestions?status=pending`).then((r) => r.json())
      setItems(Array.isArray(j?.items) ? j.items : [])
    } catch { setItems([]) } finally { setLoading(false) }
  }, [])
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

  const post = useCallback((id: string, kind: 'apply' | 'dismiss' | 'restore') =>
    fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/${kind}`, { method: 'POST' }).then((r) => r.ok).catch(() => false), [])

  // Undo a dismiss (single or bulk): restore the rows to pending, then reload to show them again.
  const restore = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => post(id, 'restore')))
    void load()
  }, [post, load])

  const act = useCallback(async (id: string, kind: 'apply' | 'dismiss') => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      if (await post(id, kind)) {
        setItems((cur) => cur.filter((s) => s.id !== id))
        if (kind === 'dismiss') toast(<>Suggestion dismissed · <button type="button" className="h10-sug-undo" onClick={() => void restore([id])}>Undo</button></>, 'info')
        else toast('Suggestion approved', 'success')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [post, toast, restore])

  // Bulk Approve / Dismiss — limited concurrency, live progress, per-row success/fail tally.
  const runBulk = useCallback(async (ids: string[], kind: 'apply' | 'dismiss', clear: () => void) => {
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
    const verb = kind === 'apply' ? 'Approved' : 'Dismissed'
    const base = `${verb} ${okIds.length} ${okIds.length === 1 ? 'suggestion' : 'suggestions'}${fail ? ` · ${fail} failed` : ''}`
    if (kind === 'dismiss' && okIds.length) toast(<>{base} · <button type="button" className="h10-sug-undo" onClick={() => void restore(okIds)}>Undo</button></>, fail ? 'error' : 'info')
    else toast(base, fail ? 'error' : 'success')
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
    if (Math.abs(netDelta) >= 0.005) tiles.push({ label: 'Net daily Δ', value: `${netDelta >= 0 ? '+' : '−'}€${Math.abs(netDelta).toFixed(2)}`, delta: { value: netDelta >= 0 ? 'increase' : 'decrease', positive: netDelta >= 0 } })
    if (harvest > 0) tiles.push({ label: 'Keywords to harvest', value: harvest })
    return tiles
  }, [items])

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

  const columns: GridColumn<Suggestion>[] = [
    { key: 'proposed', label: 'Proposed change', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.type ?? '', render: (s) => <ProposedCell s={s} /> },
    { key: 'impact', label: 'Impact', metric: true, sortable: true, tip: 'Daily € change (or keywords affected). Sort to triage the biggest moves first.', sortValue: impactScore, render: (s) => <ImpactCell s={s} /> },
    { key: 'rule', label: 'Rule', metric: false, sortable: true, sortValue: (s) => s.ruleName ?? '', render: (s) => <RuleCell s={s} /> },
    { key: 'when', label: 'When', metric: false, sortable: true, sortValue: (s) => new Date(s.createdAt).getTime(), render: (s) => <span className="h10-sug-when">{ago(s.createdAt)}</span> },
    {
      key: 'act', label: 'Actions', metric: false, sortable: false,
      render: (s) => (
        <span className="h10-sug-acts">
          <Button variant="primary" size="sm" disabled={!!busy[s.id]} onClick={() => act(s.id, 'apply')}><Check size={13} /> Approve</Button>
          <Button variant="secondary" size="sm" disabled={!!busy[s.id]} onClick={() => act(s.id, 'dismiss')}><X size={13} /> Dismiss</Button>
        </span>
      ),
    },
  ]

  return (
    <div className="h10-sug">
      <AdsPageHeader title="Suggestions" subtitle="Review and approve the actions your Manual rules propose." showDateRange={false} markets={[]} market="all" onMarketChange={() => {}} />
      {!loading && items.length > 0 && <MetricStrip metrics={metrics} />}
      <AdsDataGrid<Suggestion>
        rows={items}
        loading={loading}
        rowId={(s) => s.id}
        noun="suggestion"
        firstColLabel="Source"
        renderFirst={(s) => <SourceCell s={s} />}
        firstSortValue={(s) => srcOf(s).label}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        groupBy={groupBy}
        // The shared grid's frozen first column assumes the 40px checkbox gutter — keep selection
        // on (matches every console grid + sets up S.4 bulk). Bulk-action wiring lands in S.4.
        selectable
        customizable={false}
        defaultSort={{ key: 'when', dir: 'desc' }}
        selectionActions={(ids, clear) => (
          <span className="h10-bulkrow">
            <Button variant="primary" size="sm" disabled={bulkBusy} onClick={() => void runBulk(ids, 'apply', clear)}><Check size={13} /> Approve {ids.length}</Button>
            <Button variant="secondary" size="sm" disabled={bulkBusy} onClick={() => void runBulk(ids, 'dismiss', clear)}><X size={13} /> Dismiss {ids.length}</Button>
            {bulkProg && <span className="h10-sug-prog">{bulkProg.done}/{bulkProg.total}</span>}
          </span>
        )}
        toolbarLeft={
          <label className="h10-sug-group">
            <span>Group by</span>
            <Select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} aria-label="Group suggestions by">
              <option value="none">None</option>
              <option value="rule">Rule</option>
              <option value="campaign">Campaign</option>
              <option value="type">Type</option>
            </Select>
          </label>
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
            title="No suggestions right now"
            description={<>When a rule set to <em>Manual</em> finds something to do, its proposed change appears here for you to approve.</>}
          />
        }
      />
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
