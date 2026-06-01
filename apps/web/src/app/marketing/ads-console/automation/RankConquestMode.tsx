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
import { campaignHref } from './useCampaignMap'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']
interface Target { id: string; text: string; kind: string; bidCents: number; status: string; campaignId: string; campaignName: string; marketplace: string | null; adGroupId: string; adGroupName: string }
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
        <select value={market} onChange={(e) => { setMarket(e.target.value); setAdGroupId('') }} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', font: 'inherit', cursor: 'pointer' }} aria-label="Market">{MARKETS.map((m) => <option key={m}>{m === 'All' ? 'All markets' : m}</option>)}</select>
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4><Crosshair size={14} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Target competitor ASINs</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          <label style={{ fontSize: 12.5 }}>Host ad group
            <select value={adGroupId} onChange={(e) => setAdGroupId(e.target.value)} style={{ display: 'block', marginTop: 4, minWidth: 320, maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit', cursor: 'pointer' }}>
              <option value="">{rows === null ? 'Loading…' : adGroups.length ? 'Select an ad group…' : 'No ad groups found'}</option>
              {adGroups.map((g) => <option key={g.adGroupId} value={g.adGroupId}>{g.campaignName} → {g.adGroupName}{g.marketplace ? ` (${g.marketplace})` : ''}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12.5 }}>Competitor ASINs <span style={{ color: 'var(--ink3)', fontWeight: 400 }}>(one per line or comma-separated)</span>
            <textarea value={asins} onChange={(e) => setAsins(e.target.value)} placeholder="B0XXXXXXXX, B0YYYYYYYY…" rows={3} style={{ display: 'block', marginTop: 4, width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', font: 'inherit', resize: 'vertical' }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12.5 }}>Bid €<input type="number" step="0.05" value={bid} onChange={(e) => setBid(e.target.value)} style={{ width: 80, marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit' }} /></label>
            <span style={{ fontSize: 11.5, color: 'var(--ink2)' }}>{validAsins.length} valid{invalidAsins.length ? ` · ${invalidAsins.length} invalid` : ''}</span>
            <span style={{ flex: 1 }} />
            <button className="az-btn dark" disabled={busy || !adGroupId || validAsins.length === 0} onClick={() => void create()}><Plus size={14} />{busy ? 'Creating…' : `Create ${validAsins.length} target(s)`}</button>
          </div>
          {msg && <div style={{ color: msg.includes('Created') ? 'var(--green)' : '#cc1100', fontSize: 12, fontWeight: 600 }}>{msg}</div>}
        </div>
      </div>

      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}>Conquesting targets you already run <span style={{ color: 'var(--ink2)', fontWeight: 500, fontSize: 12 }}>· {existing.length}</span></h4>
      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr><th className="l">Competitor ASIN</th><th className="l">Campaign · ad group</th><th className="l">Market</th><th>Bid</th><th className="l">Status</th></tr></thead>
          <tbody>
            {rows === null && <tr><td className="az-empty" colSpan={5}>Loading…</td></tr>}
            {rows !== null && existing.length === 0 && <tr><td className="az-empty" colSpan={5}>No conquesting (product) targets yet {market === 'All' ? '' : `in ${market}`}.</td></tr>}
            {existing.map((t) => (
              <tr key={t.id}>
                <td className="l" style={{ fontWeight: 500, fontFamily: 'monospace' }}>{t.text || '—'}</td>
                <td className="l"><a className="cn" href={campaignHref(t.campaignId)} target="_blank" rel="noopener noreferrer">{t.campaignName}</a><div className="sub">{t.adGroupName}</div></td>
                <td className="l"><span className="sub">{t.marketplace ?? '—'}</span></td>
                <td className="num">{eur(t.bidCents)}</td>
                <td className="l"><span className="az-badge">{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
