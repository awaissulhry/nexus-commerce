'use client'

/**
 * Trading Desk — Settings (native). Connection + write-mode status from
 * GET /advertising/connections. Read view here; the sensitive two-step
 * "enable live writes" flow + diagnostics stay in the classic tools (↗) for now.
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, ShieldAlert, ExternalLink } from 'lucide-react'
import { marketplaceCode } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'

interface Conn { id: string; profileId: string; marketplace: string; mode: string; writesEnabledAt: string | null; lastWriteAt: string | null }
interface ConnResp { items: Conn[]; adsMode: 'sandbox' | 'live' | string }
const LEGACY = '/marketing/advertising'

export function SettingsClient({ initial }: { initial: ConnResp | null }) {
  const [data, setData] = useState<ConnResp | null>(initial)
  const [loading, setLoading] = useState(false)
  const refetch = useCallback(async () => {
    setLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null); setData(d as ConnResp) } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (!initial) void refetch() }, [initial, refetch])

  const live = data?.adsMode === 'live'
  const items = data?.items ?? []
  const enabled = items.filter((c) => c.mode === 'production' && c.writesEnabledAt).length

  return (
    <>
      <div className="top">
        <div><h1>Settings</h1><div className="sub">Connections · write-mode · diagnostics</div></div>
        <span className="spacer" />
        <button className="ctl" onClick={() => void refetch()} title="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
      </div>

      <div className="scroll">
        <div className="card" style={{ marginBottom: 14, borderColor: live ? 'var(--green)' : 'var(--amber)' }}>
          <div className="bd" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: live ? 'var(--green-soft)' : 'var(--amber-soft)' }}>
              {live ? <ShieldCheck size={22} style={{ stroke: 'var(--green)' }} /> : <ShieldAlert size={22} style={{ stroke: 'var(--amber)' }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 750, fontSize: 16 }}>{live ? 'Live writes mode' : 'Sandbox mode'}</div>
              <div className="note">{live
                ? `${enabled} connection(s) enabled for live writes — mutations go through the gated path (5-min undo + per-campaign allowlist).`
                : 'NEXUS_AMAZON_ADS_MODE=sandbox — writes update the DB + audit log only; no real Amazon Ads API calls.'}</div>
            </div>
            <span className={`pill ${live ? 'g' : 'a'}`} style={{ fontSize: 12 }}>{live ? 'LIVE' : 'SANDBOX'}</span>
          </div>
        </div>

        <div className="card">
          <div className="hd">Amazon Ads connections <span className="mut">· {items.length}</span></div>
          <div className="tablewrap"><table>
            <thead><tr><th className="l">Marketplace</th><th className="l">Profile</th><th>Mode</th><th>Live writes</th><th>Last write</th></tr></thead>
            <tbody>
              {!data && <tr><td colSpan={5} className="empty">Loading…</td></tr>}
              {data && items.length === 0 && <tr><td colSpan={5} className="empty">No Amazon Ads connections found.</td></tr>}
              {items.map((c) => (
                <tr key={c.id}>
                  <td className="l"><span className="cc az"><span className="dot" style={{ background: 'var(--az)' }} />{marketplaceCode(c.marketplace)}</span></td>
                  <td className="l"><span className="sub" style={{ fontFamily: 'monospace' }}>{c.profileId}</span></td>
                  <td>{c.mode === 'production' ? <span className="pill b">Production</span> : <span className="pill n">Sandbox</span>}</td>
                  <td>{c.writesEnabledAt ? <span className="pill g">Enabled</span> : <span className="pill n">Off</span>}</td>
                  <td className="num">{c.lastWriteAt ? new Date(c.lastWriteAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="legend" style={{ padding: '12px 14px' }}>
            <span>Enabling live writes uses a two-step confirmation (sensitive) — do it from the classic diagnostics for now.</span>
            <a href={`${LEGACY}/debug`} target="_blank" rel="noopener noreferrer" className="ctl" style={{ marginLeft: 'auto', display: 'inline-flex' }}>Diagnostics <ExternalLink size={12} /></a>
          </div>
        </div>

        <p className="foot-note">Budget caps, campaign tags &amp; the full live-write enable flow port here next. The classic <a href={LEGACY} target="_blank" rel="noopener noreferrer">Advertising</a> section stays available for anything not yet rebuilt.</p>
      </div>
    </>
  )
}
