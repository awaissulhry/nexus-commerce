'use client'

/**
 * Amazon-Ads-faithful Targeting screen. Two sub-tabs:
 *  • Keywords & targets — account-wide AdTarget roster (GET /advertising/targets)
 *    with match-type badges, inline bid edit (POST /ad-targets/bulk-bid), status,
 *    and the standard metric columns.
 *  • Search terms — the search-term report (GET /advertising/reports/search-terms)
 *    with one-click harvesting: promote a term to an Exact/Phrase keyword
 *    (POST /advertising/search-terms/promote) or negate it (POST /negative-keywords).
 * Reuses the console substrate (chrome, Performance chart, Balham table, range).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, ChevronDown, RefreshCw, Plus, Ban, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { marketplaceCountryName } from '@/lib/marketplace-code'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'
import { Button, Input, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { PerformancePanel } from '../campaigns/PerformancePanel'

interface Targ {
  id: string; text: string; kind: string; matchType: string; bidCents: number; status: string
  campaignId: string; campaignName: string; externalCampaignId: string | null; marketplace: string | null
  adGroupId: string; externalAdGroupId: string | null; adGroupName: string
  impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null; roas: number | null; windowed?: boolean
}
interface ST {
  query: string; matchType: string | null; campaignId: string; adGroupId: string; marketplace: string; adProduct: string
  impressions: number; clicks: number; costUnits: number; salesCents: number; orders: number; acos: number | null; roas: number | null; ctr: number | null; cpc: number | null; isCandidate: boolean
}

/** Both specs are factories — every cell that edits or acts needs component state.
 *
 *  The SORT lives here now, as `sortValue` per column. It used to be a 12-case `switch` in a
 *  `useMemo` that had to be kept in step with fourteen `onClick={() => toggleSort('...')}`
 *  handlers by hand; a key typo'd in one place and not the other would sort by the wrong column
 *  silently. `sortable` + `sortValue` puts each column's ordering rule on the column.
 *
 *  Alignment inverts between `.az-table` and `.nds-grid`: the ten columns that carried no `.l`
 *  are the right-aligned ones. `.sub` → `.az-cell-sub`; `.az-badge` is unscoped and survives. */
const targetColumns = (ctx: {
  edit: Record<string, string>
  setEdit: React.Dispatch<React.SetStateAction<Record<string, string>>>
  saveBid: (t: Targ) => void | Promise<void>
  busy: string | null
}): Array<Column<Targ>> => [
  { key: 'text', label: 'Keyword / target', sortable: true, sortValue: (t) => t.text,
    render: (t) => (<><div style={{ fontWeight: 500 }}>{t.text}</div><div className="az-cell-sub">{MATCH_LABEL[t.kind] ?? t.kind}</div></>) },
  { key: 'match', label: 'Match', sortable: true, sortValue: (t) => t.matchType,
    render: (t) => <span className="az-badge paused">{MATCH_LABEL[t.matchType] ?? t.matchType}</span> },
  { key: 'campaign', label: 'Campaign', sortable: true, sortValue: (t) => t.campaignName,
    render: (t) => (<>{t.campaignName}<div className="az-cell-sub">{marketplaceCountryName(t.marketplace) || ''}</div></>) },
  { key: 'status', label: 'Status', sortable: true, sortValue: (t) => t.status, render: (t) => statusBadge(t.status) },
  { key: 'bidCents', label: 'Bid', align: 'right', sortable: true, sortValue: (t) => t.bidCents, render: (t) => (
    ctx.edit[t.id] != null
      ? <Input autoFocus aria-label="Bid" type="number" step="0.01" prefix="€" style={{ width: 62, textAlign: 'right' }} value={ctx.edit[t.id]}
          onChange={(e) => ctx.setEdit((x) => ({ ...x, [t.id]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter') void ctx.saveBid(t); if (e.key === 'Escape') ctx.setEdit((x) => { const y = { ...x }; delete y[t.id]; return y }) }}
          onBlur={() => void ctx.saveBid(t)} disabled={ctx.busy === t.id} />
      : <Button variant="quiet" size="sm" onClick={() => ctx.setEdit((x) => ({ ...x, [t.id]: (t.bidCents / 100).toFixed(2) }))}>{eur(t.bidCents)}</Button>
  ) },
  { key: 'impressions', label: 'Impressions', align: 'right', sortable: true, sortValue: (t) => t.impressions, render: (t) => num(t.impressions) },
  { key: 'clicks', label: 'Clicks', align: 'right', sortable: true, sortValue: (t) => t.clicks, render: (t) => num(t.clicks) },
  { key: 'ctr', label: 'CTR', align: 'right', sortable: true, sortValue: (t) => (t.impressions > 0 ? t.clicks / t.impressions : -1),
    render: (t) => pct(t.impressions > 0 ? t.clicks / t.impressions : null, 2) },
  { key: 'spendCents', label: 'Spend', align: 'right', sortable: true, sortValue: (t) => t.spendCents, render: (t) => eur(t.spendCents) },
  { key: 'cpc', label: 'CPC', align: 'right', sortable: true, sortValue: (t) => (t.clicks > 0 ? t.spendCents / t.clicks : -1),
    render: (t) => eur(t.clicks > 0 ? t.spendCents / t.clicks : null) },
  { key: 'orders', label: 'Orders', align: 'right', sortable: true, sortValue: (t) => t.orders, render: (t) => num(t.orders) },
  { key: 'salesCents', label: 'Sales', align: 'right', sortable: true, sortValue: (t) => t.salesCents, render: (t) => eur(t.salesCents) },
  { key: 'acos', label: 'ACOS', align: 'right', sortable: true, sortValue: (t) => t.acos ?? -1, render: (t) => pct(t.acos) },
  { key: 'roas', label: 'ROAS', align: 'right', sortable: true, sortValue: (t) => t.roas ?? -1, render: (t) => (t.roas == null ? '—' : `${t.roas.toFixed(1)}×`) },
]

const searchTermColumns = (ctx: {
  campMap: Record<string, string>
  done: Record<string, string>
  busy: string | null
  promote: (r: ST, m: 'EXACT' | 'PHRASE') => void | Promise<void>
  negate: (r: ST) => void | Promise<void>
}): Array<Column<ST>> => [
  { key: 'query', label: 'Search term', render: (r) => (<><span style={{ fontWeight: 500 }}>{r.query}</span>{r.isCandidate && <span className="az-badge warn" style={{ marginLeft: 8 }}>waste</span>}</>) },
  { key: 'match', label: 'Match', render: (r) => (r.matchType ? <span className="az-badge paused">{MATCH_LABEL[r.matchType] ?? r.matchType}</span> : '—') },
  { key: 'campaign', label: 'Campaign', render: (r) => (<>{ctx.campMap[r.campaignId] ?? <span className="az-cell-sub">{r.campaignId}</span>}<div className="az-cell-sub">{marketplaceCountryName(r.marketplace) || ''}</div></>) },
  { key: 'impressions', label: 'Impressions', align: 'right', render: (r) => num(r.impressions) },
  { key: 'clicks', label: 'Clicks', align: 'right', render: (r) => num(r.clicks) },
  { key: 'spend', label: 'Spend', align: 'right', render: (r) => eur(Math.round(r.costUnits * 100)) },
  { key: 'orders', label: 'Orders', align: 'right', render: (r) => num(r.orders) },
  { key: 'sales', label: 'Sales', align: 'right', render: (r) => eur(r.salesCents) },
  { key: 'acos', label: 'ACOS', align: 'right', render: (r) => pct(r.acos) },
  { key: 'harvest', label: 'Harvest', width: 230, render: (r) => {
    const k = `${r.query}:${r.campaignId}`; const d = ctx.done[k]; const b = ctx.busy === k
    return d
      ? <span className="az-badge deliver"><Check size={12} /> {d === 'neg' ? 'Negated' : d === 'exact' ? 'Added exact' : 'Added phrase'}</span>
      : (<span style={{ display: 'inline-flex', gap: 6 }}>
          <Button size="sm" disabled={b} onClick={() => void ctx.promote(r, 'EXACT')} title="Add as exact keyword"><Plus size={13} />Exact</Button>
          <Button size="sm" disabled={b} onClick={() => void ctx.promote(r, 'PHRASE')} title="Add as phrase keyword"><Plus size={13} />Phrase</Button>
          <Button size="sm" disabled={b} onClick={() => void ctx.negate(r)} title="Add as negative exact"><Ban size={13} />Negate</Button>
        </span>)
  } },
]

const TABS = [{ k: 'targeting', label: 'Keywords & targets' }, { k: 'searchterms', label: 'Search terms' }]
const RANGES = [{ d: 7, label: 'Last 7 days' }, { d: 14, label: 'Last 14 days' }, { d: 30, label: 'Last 30 days' }, { d: 60, label: 'Last 60 days' }, { d: 90, label: 'Last 90 days' }]
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
/** Pure in its argument; hoisted so the module-level column spec can reach it. */
const statusBadge = (s: string) => s === 'ENABLED' ? <span className="az-badge deliver">Delivering</span> : <span className="az-badge paused">{s.charAt(0) + s.slice(1).toLowerCase()}</span>
const MATCH_LABEL: Record<string, string> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad', ASIN: 'Product', CATEGORY_REFINEMENT: 'Category', CATEGORY: 'Category', AUTO: 'Auto' }

export function TargetingClient({ initialTargets }: { initialTargets: Targ[] }) {
  const [tab, setTab] = useState('targeting')
  const [days, setDays] = useState(30)


  // ── keywords/targets tab ──────────────────────────────────────────────
  const [targets, setTargets] = useState<Targ[]>(initialTargets)
  const [tLoading, setTLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const refetchTargets = useCallback(async () => {
    setTLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/targets?windowDays=${days}&limit=500`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ rows: [] }))
      setTargets((d.rows ?? []) as Targ[])
    } finally { setTLoading(false) }
  }, [days])
  useEffect(() => { void refetchTargets() }, [refetchTargets])
  useMarketingEvents(useCallback(() => { if (tab === 'targeting') void refetchTargets() }, [tab, refetchTargets]))

  /** Filter only. The SORT moved into the column spec as `sortValue` per column, which is where
   *  a column's own ordering rule belongs — it replaces a 12-case `switch` that had to be kept
   *  in step with the header row by hand. `DataGrid` owns the sort state from `initialSort`. */
  const tFiltered = useMemo(() => {
    if (!search.trim()) return targets
    const q = search.toLowerCase()
    return targets.filter((t) => t.text.toLowerCase().includes(q) || t.campaignName.toLowerCase().includes(q))
  }, [targets, search])

  const saveBid = async (t: Targ) => {
    const v = edit[t.id]; if (v == null) return
    const n = parseFloat(v)
    if (!Number.isFinite(n) || n < 0.05) { setEdit((e) => { const x = { ...e }; delete x[t.id]; return x }); return }
    setBusy(t.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [{ adTargetId: t.id, bidCents: Math.round(n * 100) }] }) })
      setEdit((e) => { const x = { ...e }; delete x[t.id]; return x }); void refetchTargets()
    } finally { setBusy(null) }
  }

  // ── search terms tab ──────────────────────────────────────────────────
  const [st, setSt] = useState<ST[]>([])
  const [stLoading, setStLoading] = useState(false)
  const [stLoaded, setStLoaded] = useState(false)
  const [minSpend, setMinSpend] = useState('0')
  const [hasOrders, setHasOrders] = useState<'any' | 'some' | 'none'>('any')
  const [campMap, setCampMap] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Record<string, 'exact' | 'phrase' | 'neg'>>({})

  const refetchST = useCallback(async () => {
    setStLoading(true)
    try {
      const qs = new URLSearchParams({ lookbackDays: String(days), sortBy: 'spend', limit: '200' })
      if (Number(minSpend) > 0) qs.set('minSpend', minSpend)
      if (hasOrders !== 'any') qs.set('hasOrders', hasOrders)
      const d = await fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?${qs}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
      setSt((d.items ?? []) as ST[]); setStLoaded(true)
    } finally { setStLoading(false) }
  }, [days, minSpend, hasOrders])
  useEffect(() => { if (tab === 'searchterms') void refetchST() }, [tab, refetchST])
  useEffect(() => {
    if (tab !== 'searchterms' || Object.keys(campMap).length) return
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const m: Record<string, string> = {}
      for (const c of (d.items ?? [])) if (c.externalCampaignId) m[c.externalCampaignId] = c.name
      setCampMap(m)
    }).catch(() => {})
  }, [tab, campMap])

  const promote = async (r: ST, matchType: 'EXACT' | 'PHRASE') => {
    const key = `${r.query}:${r.campaignId}`; setBusy(key)
    try {
      const bidEur = r.cpc && r.cpc > 0 ? Math.max(0.1, Math.round(r.cpc * 100) / 100) : 0.5
      const res = await fetch(`${getBackendUrl()}/api/advertising/search-terms/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: r.query, externalAdGroupId: r.adGroupId, matchType, bidEur }) })
      if (res.ok) setDone((d) => ({ ...d, [key]: matchType === 'EXACT' ? 'exact' : 'phrase' }))
    } finally { setBusy(null) }
  }
  const negate = async (r: ST) => {
    const key = `${r.query}:${r.campaignId}`; setBusy(key)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId, keywordText: r.query, matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: r.marketplace }) })
      if (res.ok) setDone((d) => ({ ...d, [key]: 'neg' }))
    } finally { setBusy(null) }
  }


  return (
    <div className="az-wrap">
      <div className="az-tabs">
        {TABS.map((t) => <button key={t.k} className={`az-tab ${tab === t.k ? 'on' : ''}`} onClick={() => setTab(t.k)}>{tab === t.k && <span className="ck">✔</span>}{t.label}</button>)}
      </div>

      <div className="az-listhead">
        <span className="title">{tab === 'targeting' ? 'Keywords & targets' : 'Search terms'} <ChevronDown size={18} /></span>
        {tab === 'targeting' && <Input leadingIcon={<Search size={15} />} placeholder="Find a keyword or target" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />}
        <span style={{ flex: 1 }} />
      </div>

      <PerformancePanel adProduct="" days={days} />

      <div className="az-tbar2">
        {tab === 'searchterms' && <>
          <span className="ctl" style={{ cursor: 'default', gap: 8 }}>Min spend<Input type="number" step="1" min="0" aria-label="Minimum spend" prefix="€" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} style={{ width: 56 }} /></span>
          <span className="ctl" style={{ cursor: 'default', gap: 8 }}>Orders
            <Listbox
              ariaLabel="Orders filter"
              width={170}
              value={hasOrders}
              onChange={(v) => setHasOrders(v as 'any' | 'some' | 'none')}
              options={[{ value: 'any', label: 'Any' }, { value: 'some', label: 'With orders' }, { value: 'none', label: 'No orders (waste)' }]}
            />
          </span>
        </>}
        <Listbox
          ariaLabel="Date range"
          width={150}
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={RANGES.map((r) => ({ value: String(r.d), label: r.label }))}
        />
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} className={(tab === 'targeting' ? tLoading : stLoading) ? 'az-spin' : ''} />} label="Refresh" onClick={() => { if (tab === 'targeting') void refetchTargets(); else void refetchST() }} />
      </div>

      {tab === 'targeting' ? (
        <DataGrid<Targ>
            rows={tFiltered}
            rowKey={(t) => t.id}
            columns={targetColumns({ edit, setEdit, saveBid, busy })}
            initialSort={{ key: 'spendCents', dir: 'desc' }}
            emptyState={tLoading ? 'Loading…' : 'No keywords or targets yet.'}
          />
      ) : (
        <DataGrid<ST>
            rows={st}
            rowKey={(r) => `${r.query}:${r.campaignId}`}
            columns={searchTermColumns({ campMap, done, busy, promote, negate })}
            emptyState={stLoading ? 'Loading search terms…' : stLoaded ? 'No search terms match these filters.' : 'Loading…'}
          />
      )}

      <div className="az-pager">
        <span className="count">{tab === 'targeting' ? `${tFiltered.length} keywords & targets` : `${st.length} search terms`} · last {days} days{(tab === 'targeting' ? tLoading : stLoading) ? ' · updating…' : ''}</span>
      </div>
    </div>
  )
}
