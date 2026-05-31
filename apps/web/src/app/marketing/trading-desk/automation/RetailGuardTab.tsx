'use client'

/**
 * Automation ▸ Retail guard (Pacvue's retail-aware execution). Surfaces
 * campaigns advertising unsellable products (out-of-stock / lost Buy Box /
 * uncompetitive price) from /advertising/retail-readiness and pauses them
 * (one-click or bulk) via /retail-readiness/apply. Fully-automatic pausing is
 * the retail-guard cron (NEXUS_ADS_RETAIL_GUARD_APPLY).
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, PackageX, Pause } from 'lucide-react'
import { marketplaceCode } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'

interface CR { campaignId: string; name: string; marketplace: string | null; status: string; products: number; outOfStock: number; lostBuyBox: number; uncompetitive: number; unknown: number; verdict: 'pause' | 'watch' | 'ok'; reason: string }
interface Result { campaigns: CR[]; summary: { pause: number; watch: number; ok: number; atRiskSpendNote: string } }

const vp = (v: string) => (v === 'pause' ? 'r' : v === 'watch' ? 'a' : 'g')
const vl = (v: string) => (v === 'pause' ? 'Unsellable' : v === 'watch' ? 'At risk' : 'OK')

export function RetailGuardTab() {
  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/retail-readiness`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null); setData(d as Result) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const pause = async (ids: string[], key: string) => {
    if (ids.length === 0) return
    if (key === 'all' && !confirm(`Pause ${ids.length} campaign(s) advertising unsellable products?`)) return
    setBusy(key)
    try { await fetch(`${getBackendUrl()}/api/advertising/retail-readiness/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignIds: ids }) }); await load() } finally { setBusy(null) }
  }

  const atRisk = (data?.campaigns ?? []).filter((c) => c.verdict !== 'ok')
  const pauseIds = (data?.campaigns ?? []).filter((c) => c.verdict === 'pause' && c.status === 'ENABLED').map((c) => c.campaignId)

  return (
    <>
      <div className="statrow">
        <div className="stat"><div className="sv" style={{ color: 'var(--red)' }}>{data?.summary.pause ?? '—'}</div><div className="sl">Unsellable</div></div>
        <div className="stat"><div className="sv" style={{ color: 'var(--amber)' }}>{data?.summary.watch ?? '—'}</div><div className="sl">At risk</div></div>
        <div className="stat"><div className="sv" style={{ color: 'var(--green)' }}>{data?.summary.ok ?? '—'}</div><div className="sl">Retail-ready</div></div>
        <div className="stat" style={{ display: 'flex', alignItems: 'center' }}><button className="btn ok" disabled={pauseIds.length === 0 || busy === 'all'} onClick={() => void pause(pauseIds, 'all')}><Pause size={14} />Pause all unsellable ({pauseIds.length})</button></div>
      </div>

      <div className="card">
        <div className="hd"><PackageX size={15} style={{ stroke: 'var(--brand)' }} /> Retail readiness <span className="mut">· stock · Buy Box · price</span><span className="spacer" style={{ flex: 1 }} /><button className="ctl" onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div>
        <div className="tablewrap"><table>
          <thead><tr><th className="l">Campaign</th><th>Mkt</th><th>Verdict</th><th className="l">Reason</th><th></th></tr></thead>
          <tbody>
            {!data && <tr><td colSpan={5} className="empty">Loading…</td></tr>}
            {data && atRisk.length === 0 && <tr><td colSpan={5} className="empty">✓ No campaigns advertising unsellable products — all retail-ready.</td></tr>}
            {atRisk.map((c) => (
              <tr key={c.campaignId}>
                <td className="l"><div style={{ fontWeight: 650, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div></td>
                <td className="l">{marketplaceCode(c.marketplace)}</td>
                <td><span className={`pill ${vp(c.verdict)}`}>{vl(c.verdict)}</span></td>
                <td className="l"><span className="sub">{c.reason}</span></td>
                <td><button className="iact" disabled={busy === c.campaignId || c.status !== 'ENABLED'} onClick={() => void pause([c.campaignId], c.campaignId)}>{c.status === 'ENABLED' ? 'Pause' : 'Paused'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="legend" style={{ padding: '12px 14px' }}><span>Pauses route through the gated path (sandbox = DB-only + audit). For automatic pausing every cycle, enable the retail-guard cron (<code>NEXUS_ADS_RETAIL_GUARD_APPLY=1</code>).</span></div>
      </div>
    </>
  )
}
