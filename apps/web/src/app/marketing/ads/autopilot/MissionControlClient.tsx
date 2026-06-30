'use client'
import { useMemo, useState } from 'react'
import { OpsCanvas } from '../_canvas/OpsCanvas'
import { useAccountGraph } from '../_canvas/useAccountGraph'
import { useCampaignDetail } from '../_canvas/useCampaignDetail'
import { eur, eur2, pct, intl, roas, ago } from '../_canvas/format'
import { resolveCampaigns, stageActions, type ActionSpec, type Staged, type CampaignInput } from '../_canvas/actions'
import { getBackendUrl } from '@/lib/backend-url'
import type { OpsObject } from '../_canvas/types'
import { ActionBar } from './ActionBar'
import { DiffModal } from './DiffModal'
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
  const localId = o.kind === 'campaign' ? o.id.replace(/^c:/, '') : null
  const { adGroups, ordersTotal, loading: agLoading } = useCampaignDetail(localId)
  // Orders aren't in the campaigns list payload; for a campaign we derive them by
  // summing its ad-groups' ordersCount (lazy-fetched on select). Markets/portfolios
  // keep the aggregate from the list (orders absent there → shown as "—").
  const orders = o.kind === 'campaign' ? ordersTotal ?? undefined : d.orders
  const ctr = d.impressions ? (d.clicks ?? 0) / d.impressions : undefined
  const cvr = d.clicks && orders != null ? orders / d.clicks : undefined
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
    ['Orders', intl(orders)],
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
      {o.kind === 'campaign' && (
        <div className="mc-insp-ags">
          <div className="mc-insp-ags-h">Ad groups{adGroups.length ? ` · ${adGroups.length}` : ''}</div>
          {agLoading && <div className="mc-insp-ags-empty">Loading…</div>}
          {!agLoading && adGroups.length === 0 && <div className="mc-insp-ags-empty">No ad groups</div>}
          {!agLoading &&
            adGroups.map((a) => (
              <div className="mc-insp-ag" key={a.id}>
                <span className={`mc-ag-dot mc-ag-dot--${(a.status ?? '').toUpperCase() === 'ENABLED' ? 'on' : 'off'}`} />
                <span className="mc-ag-name" title={a.name}>
                  {a.name}
                </span>
                <span className="mc-ag-num">{eur((Number(a.spendCents) || 0) / 100)}</span>
                <span className="mc-ag-num">{pct(typeof a.acos === 'number' ? a.acos : Number(a.acos) || undefined)}</span>
                <span className="mc-ag-num">{intl(Number(a.ordersCount) || 0)}</span>
              </div>
            ))}
        </div>
      )}
      <div className="mc-insp-soon">Actions &amp; governing agents arrive in a later phase.</div>
    </div>
  )
}

export function MissionControlClient() {
  const { objects, loading, error } = useAccountGraph()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const onSelectNode = (id: string, additive: boolean) => {
    setSelectedId(id)
    setSelectedIds((prev) => {
      if (!additive) return new Set([id])
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  // P3.1 — actions: resolve selection → campaigns, stage → diff preview → gated apply.
  const [staged, setStaged] = useState<Staged | null>(null)
  const [dryRun, setDryRun] = useState(true)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const scopeCampaigns = useMemo(() => resolveCampaigns(objects, selectedIds), [objects, selectedIds])

  const onStage = (spec: ActionSpec) => {
    const camps: CampaignInput[] = scopeCampaigns.map((o) => ({
      id: o.id.replace(/^c:/, ''),
      name: o.name,
      dailyBudget: o.detail?.dailyBudget,
      status: o.detail?.status,
    }))
    if (camps.length === 0) return
    setResult(null)
    setStaged(stageActions(camps, spec))
  }

  const patchJson = async (path: string, body: Record<string, unknown>) => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      return r.ok && (j as { ok?: boolean })?.ok !== false
    } catch {
      return false
    }
  }

  const onConfirm = async () => {
    if (!staged) return
    if (dryRun) {
      setResult(`Dry-run: ${staged.changes.length} change(s) previewed — nothing applied.`)
      return
    }
    setApplying(true)
    let ok = 0
    let denied = 0
    for (const c of staged.changes) {
      const success = await patchJson(c.path, { ...c.body, applyImmediately: true, reason: 'Mission Control bulk action' })
      if (success) ok++
      else denied++
    }
    setApplying(false)
    setResult(`${ok} applied · ${denied} denied (gate-blocked or error).`)
  }

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
              selectedIds={selectedIds}
              onSelectNode={onSelectNode}
            />
          )}
          {scopeCampaigns.length > 0 && (
            <ActionBar
              count={scopeCampaigns.length}
              onStage={onStage}
              onClear={() => setSelectedIds(new Set())}
            />
          )}
        </div>
        <aside className="mc-inspector" aria-label="Inspector">
          {selected ? <InspectorBody o={selected} /> : <div className="mc-insp-empty">Select an object to inspect</div>}
        </aside>
      </div>
      {staged && (
        <DiffModal
          staged={staged}
          dryRun={dryRun}
          onToggleDryRun={() => setDryRun((v) => !v)}
          onConfirm={onConfirm}
          onCancel={() => {
            setStaged(null)
            setResult(null)
          }}
          applying={applying}
          result={result}
        />
      )}
    </div>
  )
}
