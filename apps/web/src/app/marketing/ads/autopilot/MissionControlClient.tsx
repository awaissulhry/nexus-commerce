'use client'
import { useMemo, useState } from 'react'
import { OpsCanvas } from '../_canvas/OpsCanvas'
import { useAccountGraph } from '../_canvas/useAccountGraph'
import { eur, eur2, pct, intl, roas, ago } from '../_canvas/format'
import type { OpsObject } from '../_canvas/types'
import './mission-control.css'

const KIND_LABEL: Record<string, string> = {
  market: 'Market',
  portfolio: 'Portfolio',
  campaign: 'Campaign',
  adgroup: 'Ad Group',
  target: 'Target',
}

function InspectorBody({ o }: { o: OpsObject }) {
  const d = o.detail ?? {}
  const ctr = d.impressions ? (d.clicks ?? 0) / d.impressions : undefined
  const cvr = d.clicks ? (d.orders ?? 0) / d.clicks : undefined
  const cpc = d.clicks ? (o.spend ?? 0) / d.clicks : undefined
  const metrics: Array<[string, string]> = [
    ['Spend', eur(o.spend)],
    ['Sales', eur(d.sales)],
    ['ACoS', pct(o.acos)],
    ['ROAS', roas(d.roas)],
    ['Impressions', intl(d.impressions)],
    ['Clicks', intl(d.clicks)],
    ['CTR', pct(ctr)],
    ['CVR', pct(cvr)],
    ['CPC', eur2(cpc)],
    ['Orders', intl(d.orders)],
    ['True profit', eur(d.trueProfitCents != null ? d.trueProfitCents / 100 : undefined)],
    ['Margin', pct(d.marginPct)],
  ]
  const sub = [d.status, d.adType, typeof d.dailyBudget === 'number' ? `${eur(d.dailyBudget)}/day` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <div>
      <div className="mc-insp-kind">{KIND_LABEL[o.kind] ?? o.kind}</div>
      <div className="mc-insp-name">{o.name}</div>
      {o.kind === 'campaign' && sub && <div className="mc-insp-sub">{sub}</div>}
      {d.lastSyncedAt && <div className="mc-insp-fresh">● Reports as of {ago(d.lastSyncedAt)}</div>}
      <div className="mc-insp-grid">
        {metrics.map(([k, v]) => (
          <div className="mc-insp-cell" key={k}>
            <div className="mc-insp-cell-k">{k}</div>
            <div className="mc-insp-cell-v">{v}</div>
          </div>
        ))}
      </div>
      <div className="mc-insp-soon">Actions &amp; governing agents arrive in a later phase.</div>
    </div>
  )
}

export function MissionControlClient() {
  const { objects, loading, error } = useAccountGraph()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
          {selected ? <InspectorBody o={selected} /> : <div className="mc-insp-empty">Select an object to inspect</div>}
        </aside>
      </div>
    </div>
  )
}
