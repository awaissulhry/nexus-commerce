'use client'

/**
 * Rank Control — Conquesting mode. "Don't let any competitor near us": place your
 * ads ON competitor product pages by creating PRODUCT targets (their ASINs) in
 * your ad groups. Derives your campaigns/ad groups from /advertising/targets,
 * lists any conquesting (PRODUCT) targets you already run, and creates new ones
 * via /advertising/targets/create (kind PRODUCT, the competitor ASIN, your bid).
 * Targets are created queued/sandbox by the engine's default. Rows link to the
 * campaign.
 */

import { useEffect, useMemo, useState } from 'react'
import { Crosshair, RefreshCw, Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input, Textarea, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { campaignHref } from './useCampaignMap'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']
interface Target { id: string; text: string; kind: string; bidCents: number; status: string; campaignId: string; campaignName: string; marketplace: string | null; adGroupId: string; adGroupName: string }

/** Alignment inverts between the two grids — Bid was the only column with no `.l`. */
const CONQUEST_COLUMNS: Array<Column<Target>> = [
  { key: 'asin', label: 'Competitor ASIN', render: (t) => <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{t.text || '—'}</span> },
  { key: 'campaign', label: 'Campaign · ad group', render: (t) => (<>
      <a className="cn" href={campaignHref(t.campaignId)} target="_blank" rel="noopener noreferrer">{t.campaignName}</a>
      <div className="az-cell-sub">{t.adGroupName}</div>
    </>) },
  { key: 'market', label: 'Market', render: (t) => <span className="az-cell-sub">{t.marketplace ?? '—'}</span> },
  { key: 'bid', label: 'Bid', align: 'right', render: (t) => eur(t.bidCents) },
  { key: 'status', label: 'Status', render: (t) => <span className="az-badge">{t.status}</span> },
]
interface AdGroup { adGroupId: string; adGroupName: string; campaignId: string; campaignName: string; marketplace: string | null }

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const ASIN_RE = /^B0[A-Z0-9]{8}$/i

export function RankConquestMode() {
  const [market, setMarket] = useState('All')
  const [rows, setRows] = useState<Target[] | null>(null)
  const [adGroupId, setAdGroupId] = useState('')
  const [asins, setAsins] = useState('')
  const [bid, setBid] = useState('0.75')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => {
    setRows(null)
    void fetch(`${getBackendUrl()}/api/advertising/targets?windowDays=30&limit=400`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => setRows([]))
  }
  useEffect(load, [])

  const adGroups = useMemo(() => {
    const m = new Map<string, AdGroup>()
    for (const t of (rows ?? [])) if ((market === 'All' || t.marketplace === market) && !m.has(t.adGroupId)) m.set(t.adGroupId, { adGroupId: t.adGroupId, adGroupName: t.adGroupName, campaignId: t.campaignId, campaignName: t.campaignName, marketplace: t.marketplace })
    return [...m.values()].sort((a, b) => a.campaignName.localeCompare(b.campaignName))
  }, [rows, market])

  const existing = useMemo(() => (rows ?? []).filter((t) => t.kind === 'PRODUCT' && (market === 'All' || t.marketplace === market)), [rows, market])

  const parsedAsins = useMemo(() => [...new Set(asins.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))], [asins])
  const validAsins = parsedAsins.filter((a) => ASIN_RE.test(a))
  const invalidAsins = parsedAsins.filter((a) => !ASIN_RE.test(a))

  const create = async () => {
    if (!adGroupId || validAsins.length === 0) { setMsg(!adGroupId ? 'Pick an ad group.' : 'Enter at least one valid ASIN (B0…).'); return }
    setBusy(true); setMsg('')
    try {
      let ok = 0
      for (const asin of validAsins) {
        const r = await fetch(`${getBackendUrl()}/api/advertising/targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId, kind: 'PRODUCT', value: asin.toUpperCase(), bidEur: Number(bid) || 0.75 }) }).then((x) => x.ok).catch(() => false)
        if (r) ok++
      }
      setMsg(`Created ${ok}/${validAsins.length} conquesting target(s).${invalidAsins.length ? ` Skipped ${invalidAsins.length} invalid.` : ''}`)
      setAsins(''); load()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>Place your ads <b>on competitor product pages</b> by targeting their ASINs. Pick the ad group to host the targets, paste competitor ASINs, set a bid, and create them. New targets are queued (sandbox).</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 2px 12px', flexWrap: 'wrap' }}>
        <Listbox ariaLabel="Market" width={140} value={market} onChange={(v) => { setMarket(v); setAdGroupId('') }} options={MARKETS.map((m) => ({ value: m, label: m === 'All' ? 'All markets' : m }))} />
        <span style={{ flex: 1 }} />
        <ToolbarButton variant="boxed" icon={<RefreshCw size={15} />} label="Refresh" onClick={load} />
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4><Crosshair size={14} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Target competitor ASINs</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          <label style={{ fontSize: 12.5 }}>Host ad group
            <Listbox
              ariaLabel="Host ad group"
              width={420}
              value={adGroupId}
              onChange={setAdGroupId}
              options={[{ value: '', label: rows === null ? 'Loading…' : adGroups.length ? 'Select an ad group…' : 'No ad groups found' }, ...adGroups.map((g) => ({ value: g.adGroupId, label: `${g.campaignName} → ${g.adGroupName}${g.marketplace ? ` (${g.marketplace})` : ''}` }))]}
            />
          </label>
          <label style={{ fontSize: 12.5 }}>Competitor ASINs <span style={{ color: 'var(--ink3)', fontWeight: 400 }}>(one per line or comma-separated)</span>
            <Textarea value={asins} onChange={(e) => setAsins(e.target.value)} placeholder="B0XXXXXXXX, B0YYYYYYYY…" rows={3} style={{ marginTop: 4, minHeight: 76 }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>Bid<Input type="number" step="0.05" prefix="€" aria-label="Bid" value={bid} onChange={(e) => setBid(e.target.value)} style={{ width: 62 }} /></label>
            <span style={{ fontSize: 11.5, color: 'var(--ink2)' }}>{validAsins.length} valid{invalidAsins.length ? ` · ${invalidAsins.length} invalid` : ''}</span>
            <span style={{ flex: 1 }} />
            <Button variant="primary" disabled={busy || !adGroupId || validAsins.length === 0} onClick={() => void create()}><Plus size={14} />{busy ? 'Creating…' : `Create ${validAsins.length} target(s)`}</Button>
          </div>
          {msg && <div style={{ color: msg.includes('Created') ? 'var(--green)' : '#cc1100', fontSize: 12, fontWeight: 600 }}>{msg}</div>}
        </div>
      </div>

      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}>Conquesting targets you already run <span style={{ color: 'var(--ink2)', fontWeight: 500, fontSize: 12 }}>· {existing.length}</span></h4>
      <DataGrid<Target>
        rows={rows === null ? [] : existing}
        rowKey={(t) => t.id}
        columns={CONQUEST_COLUMNS}
        emptyState={rows === null ? 'Loading…' : `No conquesting (product) targets yet ${market === 'All' ? '' : `in ${market}`}.`}
      />
    </div>
  )
}
