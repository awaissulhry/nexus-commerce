'use client'

/**
 * ES2 / S.2 — Suggestions page. Manual-control rules are propose-only: each proposed action
 * lands here as an AdsRuleSuggestion the operator can Approve (apply live) or Dismiss.
 *
 * Rendered through the shared AdsDataGrid (the one H10 console grid) on the design system
 * (Button · Tag · EmptyState). Every Source cell deep-links to the campaign / ad-group /
 * search-term the suggestion came from — resolved server-side (S.1) into `suggestion.source`.
 * Reads/writes the ES1 endpoints (GET /advertising/suggestions · POST /suggestions/:id/apply · /dismiss).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, X, RefreshCw, Sparkles, Wifi, ChevronRight } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../campaigns/_grid/AdsDataGrid'
import { Button } from '@/design-system/primitives/Button'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { EmptyState } from '@/design-system/components/EmptyState'
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

const ENTITY_LABEL: Record<string, string> = { CAMPAIGN: 'Campaign', AD_TARGET: 'Keyword/Target', SEARCH_TERM: 'Search term', MARKETPLACE: 'Marketplace' }
const ENTITY_TONE: Record<string, TagTone> = { CAMPAIGN: 'info', AD_TARGET: 'neutral', SEARCH_TERM: 'neutral', MARKETPLACE: 'neutral' }
const ACTION_LABEL: Record<string, string> = { budget_apply: 'Budget', placement_apply: 'Placement', bid_apply: 'Bid', dayparting_apply: 'Dayparting', add_negative_exact: 'Add negative', promote_to_exact: 'Promote to exact', harvest_and_negate: 'Harvest & negate' }
// Proposed-action sentiment → Tag tone. promote/harvest are wins (positive); negate/down are guarding (warning).
const ACTION_TONE: Record<string, TagTone> = { promote_to_exact: 'positive', harvest_and_negate: 'positive', add_negative_exact: 'warning', bid_apply: 'info', budget_apply: 'info', placement_apply: 'info', dayparting_apply: 'info' }
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }

const srcOf = (s: Suggestion): SuggestionSource => s.source ?? { href: null, label: s.entityName ?? s.entityId, marketplace: s.marketplace }

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

function RuleCell({ s }: { s: Suggestion }) {
  return (
    <span className="h10-sug-rule">
      <b title={s.ruleName ?? ''}>{s.ruleName ?? 'Rule'}</b>
      {s.marketplace ? <Tag tone="neutral">{s.marketplace}</Tag> : null}
    </span>
  )
}

export function SuggestionsClient() {
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [live, setLive] = useState(false)

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

  const act = useCallback(async (id: string, kind: 'apply' | 'dismiss') => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/${kind}`, { method: 'POST' })
      if (r.ok) setItems((cur) => cur.filter((s) => s.id !== id))
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [])

  const columns: GridColumn<Suggestion>[] = [
    { key: 'proposed', label: 'Proposed change', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.type ?? '', render: (s) => <ProposedCell s={s} /> },
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
      <AdsDataGrid<Suggestion>
        rows={items}
        loading={loading}
        rowId={(s) => s.id}
        noun="suggestion"
        firstColLabel="Source"
        renderFirst={(s) => <SourceCell s={s} />}
        firstSortValue={(s) => srcOf(s).label}
        columns={columns}
        // The shared grid's frozen first column assumes the 40px checkbox gutter — keep selection
        // on (matches every console grid + sets up S.4 bulk). Bulk-action wiring lands in S.4.
        selectable
        customizable={false}
        defaultSort={{ key: 'when', dir: 'desc' }}
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
