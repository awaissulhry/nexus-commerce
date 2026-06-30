'use client'
import { useMemo, useState } from 'react'
import { OpsCanvas } from '../_canvas/OpsCanvas'
import { useAccountGraph } from '../_canvas/useAccountGraph'
import './mission-control.css'

const KIND_LABEL: Record<string, string> = {
  market: 'Market',
  portfolio: 'Portfolio',
  campaign: 'Campaign',
  adgroup: 'Ad Group',
  target: 'Target',
}

export function MissionControlClient() {
  const { objects, loading, error } = useAccountGraph()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Default: expand all markets once data arrives (clean first paint, not empty).
  const markets = useMemo(() => objects.filter((o) => o.kind === 'market').map((o) => o.id), [objects])
  const expandedReady = expanded.size > 0 || markets.length === 0 ? expanded : new Set(markets)

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev.size === 0 ? markets : prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selected = objects.find((o) => o.id === selectedId) || null

  return (
    <div className="mc-root">
      <header className="mc-head">
        <div className="mc-titlewrap">
          <div className="mc-eyebrow">Nexus Ads</div>
          <h1 className="mc-title">Mission Control</h1>
        </div>
        <div className="mc-actions">
          <span className="mc-chip">All markets</span>
          <span className="mc-chip">Last 30 days</span>
          <span className="mc-chip mc-chip--auto">Autonomy: SUGGEST</span>
          <span className="mc-chip mc-chip--kill">Halt all</span>
        </div>
      </header>
      <div className="mc-body">
        <div className="mc-canvas-wrap">
          {loading && <div className="mc-state">Loading account graph…</div>}
          {!loading && error && <div className="mc-state mc-state--err">Couldn’t load: {error}</div>}
          {!loading && !error && objects.length === 0 && (
            <div className="mc-state">No campaigns found for this account yet.</div>
          )}
          {!loading && !error && objects.length > 0 && (
            <OpsCanvas
              objects={objects}
              expanded={expandedReady}
              onToggleExpand={toggle}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
        <aside className="mc-inspector" aria-label="Inspector">
          {selected ? (
            <div>
              <div className="mc-insp-kind">{KIND_LABEL[selected.kind] ?? selected.kind}</div>
              <div className="mc-insp-name">{selected.name}</div>
              <dl className="mc-insp-kv">
                <dt>Spend (30d)</dt>
                <dd>{typeof selected.spend === 'number' ? `€${Math.round(selected.spend).toLocaleString()}` : '—'}</dd>
                <dt>ACoS</dt>
                <dd>{typeof selected.acos === 'number' ? `${Math.round(selected.acos * 100)}%` : '—'}</dd>
                <dt>Health</dt>
                <dd>{selected.health ?? 'ok'}</dd>
              </dl>
              <div className="mc-insp-soon">Actions &amp; governing agents arrive in a later phase.</div>
            </div>
          ) : (
            <div className="mc-insp-empty">Select an object to inspect</div>
          )}
        </aside>
      </div>
    </div>
  )
}
