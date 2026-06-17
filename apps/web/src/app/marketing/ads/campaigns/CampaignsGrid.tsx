'use client'

/**
 * CBN.2 — Ad Manager (campaigns grid), pixel-matched to Helium 10 Ads. CBN.2a = the grid
 * core: toolbar + metrics/edit column modes + rows from our real campaigns + selection.
 * Filter bar, Bulk Actions modal, inline-edit (Discard/Apply) layer in CBN.2b/c.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Settings2, Download, Wand2, Plus, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Camp {
  id: string; name: string; marketplace: string | null; status: string; adProduct?: string | null
  biddingStrategy?: string | null; dailyBudget?: string | number | null
  spend?: number; sales?: number; acos?: number | null; roas?: number | null
  impressions?: number; clicks?: number; ppcOrders?: number; orders?: number
}
type Mode = 'metrics' | 'edit'
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * (v <= 1 ? 100 : 1)).toFixed(2)}%`)

const METRIC_COLS = ['Spend', 'Sales', 'ACoS', 'ROAS', 'Impressions', 'Clicks', 'CPC', 'CVR', 'CTR', 'PPC Orders'] as const
const EDIT_COLS = ['Target ACoS', 'Bid Automation', 'Min/Max Budget', 'Rules', 'Bidding Strategy', 'Start Date'] as const

const STRAT_LABEL: Record<string, string> = { LEGACY_FOR_SALES: 'Down only', AUTO_FOR_SALES: 'Up and Down', MANUAL: 'Fixed' }

export function CampaignsGrid() {
  const [rows, setRows] = useState<Camp[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('metrics')
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setRows((d.items ?? []) as Camp[]))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter((c) => c.name.toLowerCase().includes(q)) : rows
  }, [rows, search])

  const allSel = filtered.length > 0 && filtered.every((c) => sel.has(c.id))
  const toggleAll = () => setSel(allSel ? new Set() : new Set(filtered.map((c) => c.id)))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const cell = (c: Camp, col: string) => {
    const spend = num(c.spend), sales = num(c.sales), clicks = num(c.clicks), impr = num(c.impressions), orders = num(c.ppcOrders ?? c.orders)
    switch (col) {
      case 'Spend': return eur(spend)
      case 'Sales': return eur(sales)
      case 'ACoS': return c.acos == null ? (sales ? `${((spend / sales) * 100).toFixed(2)}%` : '—') : pct(c.acos)
      case 'ROAS': return c.roas == null ? (spend ? (sales / spend).toFixed(2) : '—') : (c.roas as number).toFixed(2)
      case 'Impressions': return impr.toLocaleString()
      case 'Clicks': return clicks.toLocaleString()
      case 'CPC': return clicks ? eur(spend / clicks) : '—'
      case 'CVR': return clicks ? `${((orders / clicks) * 100).toFixed(2)}%` : '—'
      case 'CTR': return impr ? `${((clicks / impr) * 100).toFixed(2)}%` : '—'
      case 'PPC Orders': return orders ? orders.toLocaleString() : '0'
      case 'Target ACoS': return '30.00%'
      case 'Bid Automation': return <span className="h10-toggle off" aria-hidden />
      case 'Min/Max Budget': return c.dailyBudget ? eur(num(c.dailyBudget)) : 'None - None'
      case 'Rules': return <span className="h10-rulecount">0 ⚙</span>
      case 'Bidding Strategy': return STRAT_LABEL[c.biddingStrategy ?? ''] ?? 'Down only'
      case 'Start Date': return '—'
      default: return '—'
    }
  }

  const cols = mode === 'metrics' ? METRIC_COLS : EDIT_COLS

  return (
    <div className="h10-am">
      {/* filter bar placeholder (CBN.2b) */}
      <div className="h10-am-filters">
        <div className="h10-am-search"><Search size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search campaigns…" /></div>
        <div className="seg">
          <button type="button" className={mode === 'metrics' ? 'on' : ''} onClick={() => setMode('metrics')}>Metrics</button>
          <button type="button" className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>Edit Campaigns</button>
        </div>
        <span className="grow" />
        <span className="h10-am-presethint">Filters + Save Preset — next (CBN.2b)</span>
      </div>

      {/* toolbar */}
      <div className="h10-am-toolbar">
        <span className="cnt">{sel.size > 0 ? <b>Selected {sel.size}</b> : `Viewing 1-${Math.min(filtered.length, 500)} of ${rows.length} Campaigns`}</span>
        {sel.size > 0 && <>
          <button type="button" className="h10-am-btn">Bulk Actions</button>
          <button type="button" className="h10-am-btn">Edit Campaigns</button>
          <button type="button" className="h10-am-btn">Enable</button>
          <button type="button" className="h10-am-btn">Pause</button>
        </>}
        <span className="grow" />
        <button type="button" className="h10-am-btn"><Settings2 size={13} /> Customize</button>
        <button type="button" className="h10-am-btn"><Download size={13} /> Export Data</button>
        <Link href="/marketing/ads/rules-automation" className="h10-am-btn"><Wand2 size={13} /> Create Rule</Link>
        <Link href="/marketing/ads-console/campaign-builder/guided" className="h10-am-btn primary"><Plus size={13} /> Campaign</Link>
      </div>

      {/* grid */}
      <div className="h10-am-grid">
        <table>
          <thead>
            <tr>
              <th className="ck"><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /></th>
              <th className="nm">Campaign</th>
              {cols.map((c) => <th key={c} className="num">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={cols.length + 2} className="empty">Loading campaigns…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={cols.length + 2} className="empty">No campaigns.</td></tr>
            ) : filtered.map((c) => (
              <tr key={c.id} className={sel.has(c.id) ? 'on' : ''}>
                <td className="ck"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></td>
                <td className="nm">
                  <span className={`dot ${c.status === 'ENABLED' ? 'live' : ''}`} />
                  <span className="badge">{c.adProduct === 'SPONSORED_BRANDS' ? 'SB' : c.adProduct === 'SPONSORED_DISPLAY' ? 'SD' : 'SP'}</span>
                  <span className="t" title={c.name}>{c.name}</span>
                  {c.marketplace && <span className="mk">{c.marketplace}</span>}
                </td>
                {cols.map((col) => <td key={col} className="num">{cell(c, col)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
