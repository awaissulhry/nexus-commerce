'use client'

/**
 * Retail readiness — don't pay for traffic you can't convert. Live from
 * GET /retail-readiness: campaigns whose advertised products are out of stock,
 * lost the Buy Box, or are uncompetitive, with a verdict. One-click pause the
 * flagged campaigns (POST /retail-readiness/apply), or automate it permanently
 * with the Retail-guard rule.
 */

import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, RefreshCw, PauseCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'

interface Camp { campaignId: string; name: string; marketplace: string; status: string; products: number; outOfStock: number; lostBuyBox: number; uncompetitive: number; unknown: number; verdict: string; reason: string }

/** Alignment is inverted between the two grids — see the header comment in HealthTab. The four
 *  counts carried no `.l` and so are the only right-aligned columns. `.sub` becomes
 *  `.az-cell-sub`: the original exists ONLY as `.az-table .sub` and matches nothing in a
 *  `.nds-grid`. */
const RETAIL_COLUMNS: Array<Column<Camp>> = [
  { key: 'campaign', label: 'Campaign', render: (c) => <span style={{ fontWeight: 500 }}>{c.name}</span> },
  { key: 'market', label: 'Market', render: (c) => c.marketplace },
  { key: 'products', label: 'Products', align: 'right', render: (c) => c.products },
  { key: 'oos', label: 'OOS', align: 'right', render: (c) => <span style={{ color: c.outOfStock ? '#cc1100' : undefined }}>{c.outOfStock}</span> },
  { key: 'lostbb', label: 'Lost BB', align: 'right', render: (c) => <span style={{ color: c.lostBuyBox ? 'var(--amber)' : undefined }}>{c.lostBuyBox}</span> },
  { key: 'uncompetitive', label: 'Uncompetitive', align: 'right', render: (c) => c.uncompetitive },
  { key: 'verdict', label: 'Verdict', render: (c) => (c.verdict === 'pause' ? <span className="az-badge warn">min bid</span> : <span className="az-badge deliver">ok</span>) },
  { key: 'reason', label: 'Reason', render: (c) => <span className="az-cell-sub">{c.reason}</span> },
]
const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

export function RetailTab() {
  const [camps, setCamps] = useState<Camp[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/retail-readiness`, { cache: 'no-store' }).then((r) => r.json()).then((d) => setCamps(d.campaigns ?? [])).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(load, [])

  const [mkt, setMkt] = useState('All')
  const markets = useMemo(() => Array.from(new Set(camps.map((c) => c.marketplace).filter(Boolean))) as string[], [camps])
  const shown = useMemo(() => (mkt === 'All' ? camps : camps.filter((c) => c.marketplace === mkt)), [camps, mkt])
  const flagged = useMemo(() => shown.filter((c) => c.verdict === 'pause'), [shown])
  const totalOOS = shown.reduce((s, c) => s + (c.outOfStock ?? 0), 0)
  const totalBB = shown.reduce((s, c) => s + (c.lostBuyBox ?? 0), 0)

  const applyAll = async () => {
    if (!flagged.length) return
    if (typeof window !== 'undefined' && !window.confirm(`Drop ${flagged.length} campaign(s) advertising unsellable products to Min bid (~€0.02, restorable)?`)) return
    setBusy(true); setMsg('')
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/retail-readiness/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignIds: flagged.map((c) => c.campaignId) }) }).then((x) => x.json()).catch(() => null); setMsg(r ? `Min-bid ${r.paused ?? r.applied ?? flagged.length} campaign(s) (pending)` : 'Applied'); load() } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Wasting spend now</div><div className="v" style={{ color: flagged.length ? '#cc1100' : 'var(--green)' }}>{flagged.length}</div><div className="s">campaigns on unsellable products</div></div>
        <div className="az-stat"><div className="k">Out of stock</div><div className="v">{num(totalOOS)}</div><div className="s">advertised products</div></div>
        <div className="az-stat"><div className="k">Lost Buy Box</div><div className="v">{num(totalBB)}</div><div className="s">advertised products</div></div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}><ShieldAlert size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Retail readiness</span>
        <Listbox ariaLabel="Market" width={140} value={mkt} onChange={setMkt} options={[{ value: 'All', label: 'All markets' }, ...markets.map((m) => ({ value: m, label: m }))]} />
        <span style={{ flex: 1 }} />
        {flagged.length > 0 && <Button variant="primary" disabled={busy} onClick={() => void applyAll()}><PauseCircle size={14} />Min bid · {flagged.length} flagged</Button>}
        {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} />} label="Refresh" onClick={load} />
      </div>
      <DataGrid<Camp>
        rows={loading ? [] : shown}
        rowKey={(c) => c.campaignId}
        columns={RETAIL_COLUMNS}
        rowClassName={(c) => (c.verdict === 'pause' ? 'sel' : undefined)}
        emptyState={loading ? 'Loading…' : 'All advertised products are sellable.'}
      />
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Make this permanent: add the <b>Retail guard</b> automation (Library) to auto-pause &amp; auto-resume as stock and Buy Box change — every 15 minutes, hands-free.</div>
    </div>
  )
}
