'use client'

/**
 * ES2 — Suggestions page. Manual-control rules are propose-only: each proposed action lands here
 * as an AdsRuleSuggestion the operator can Approve (apply live) or Dismiss. Reads/writes the
 * ES1 endpoints (GET /advertising/suggestions · POST /suggestions/:id/apply · /dismiss).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X, RefreshCw, Sparkles, Wifi } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import './suggestions.css'

interface Suggestion {
  id: string; ruleId: string; ruleName: string | null; trigger: string | null; marketplace: string | null
  entityType: string; entityId: string; entityName: string | null
  proposedAction: { type?: string; wouldChange?: string; placement?: string; op?: string; value?: number; wouldGraduate?: number; wouldNegate?: number }
  status: string; createdAt: string
}

const ENTITY_LABEL: Record<string, string> = { CAMPAIGN: 'Campaign', AD_TARGET: 'Keyword/Target', SEARCH_TERM: 'Search term', MARKETPLACE: 'Marketplace' }
const ACTION_LABEL: Record<string, string> = { budget_apply: 'Budget', placement_apply: 'Placement', bid_apply: 'Bid', dayparting_apply: 'Dayparting', add_negative_exact: 'Add negative', promote_to_exact: 'Promote to exact', harvest_and_negate: 'Harvest & negate' }
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }

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

  const act = async (id: string, kind: 'apply' | 'dismiss') => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/${kind}`, { method: 'POST' })
      if (r.ok) setItems((cur) => cur.filter((s) => s.id !== id))
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }

  const proposed = (s: Suggestion) => {
    const a = s.proposedAction ?? {}
    const kind = ACTION_LABEL[a.type ?? ''] ?? a.type ?? '—'
    // Harvest cards carry a batch (promote N / negate M) rather than a single change.
    if (a.type === 'harvest_and_negate') {
      return <><b>{kind}</b><span className="wc"> promote {a.wouldGraduate ?? 0} · negate {a.wouldNegate ?? 0}</span></>
    }
    const place = a.placement ? ` · ${a.placement.replace('PLACEMENT_', '').replace(/_/g, ' ').toLowerCase()}` : ''
    return <><b>{kind}{place}</b>{a.wouldChange ? <span className="wc"> {a.wouldChange}</span> : null}</>
  }

  return (
    <div className="h10-sug">
      <AdsPageHeader title="Suggestions" subtitle="Review and approve the actions your Manual rules propose." showDateRange={false} markets={[]} market="all" onMarketChange={() => {}} />
      <div className="h10-sug-bar">
        <span className="cnt">{loading ? '' : `${items.length} pending`}{live && <span className="live"><Wifi size={12} /> Live</span>}</span>
        <button type="button" className="h10-sug-refresh" onClick={() => { setLoading(true); void load() }}><RefreshCw size={14} /> Refresh</button>
      </div>

      {loading ? (
        <div className="h10-sug-msg">Loading suggestions…</div>
      ) : items.length === 0 ? (
        <div className="h10-sug-empty">
          <span className="ic"><Sparkles size={26} /></span>
          <b>No suggestions right now</b>
          <p>When a rule set to <em>Manual</em> finds something to do, its proposed change appears here for you to approve.</p>
        </div>
      ) : (
        <div className="h10-sug-table">
          <div className="h10-sug-h">
            <span className="rule">Rule</span><span className="ent">Applies to</span><span className="prop">Proposed change</span><span className="when">When</span><span className="act">Actions</span>
          </div>
          {items.map((s) => (
            <div className="h10-sug-r" key={s.id}>
              <span className="rule"><b title={s.ruleName ?? ''}>{s.ruleName ?? 'Rule'}</b>{s.marketplace ? <span className="mkt">{s.marketplace}</span> : null}</span>
              <span className="ent"><span className="et">{ENTITY_LABEL[s.entityType] ?? s.entityType}</span><span className="en" title={s.entityName ?? s.entityId}>{s.entityName ?? s.entityId}</span></span>
              <span className="prop">{proposed(s)}</span>
              <span className="when">{ago(s.createdAt)}</span>
              <span className="act">
                <button type="button" className="approve" disabled={!!busy[s.id]} onClick={() => act(s.id, 'apply')}><Check size={14} /> Approve</button>
                <button type="button" className="dismiss" disabled={!!busy[s.id]} onClick={() => act(s.id, 'dismiss')}><X size={14} /> Dismiss</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
